#!/usr/bin/env node
/**
 * Drives LinkedIn Sales Navigator from your own logged-in Brave session to
 * find candidates Clay's indexed search misses, then auto-confirms clean
 * matches through the same scoreIdentityMatch used everywhere else in the
 * pipeline. See src/browser-agent.mjs for the decision logic and
 * docs/BROWSER_AGENT.md for setup (Brave must be running with
 * --remote-debugging-port — run scripts/launch-brave-debug.mjs first).
 *
 * Deliberately paced and audited rather than run headless at Clay-swarm
 * volume: every find is logged to browser_leads before any decision is
 * made, so `scripts/audit-browser-confirmations.mjs` gives you something
 * concrete to spot-check against.
 *
 * --workers=N (default 1, max 16) runs N tabs concurrently, each with its own
 * independent claim/search/decide loop. Safe to parallelize: claimCandidates
 * uses a BEGIN IMMEDIATE transaction, so two workers can never be handed the
 * same candidate, and each worker gets its own Playwright page — no shared
 * UI state between tabs. The real cost of more workers isn't correctness,
 * it's that concurrent activity from one Sales Navigator account is a
 * bigger automation signature than a single paced stream; requested
 * explicitly, at the user's chosen risk level, after flagging that tradeoff.
 * Per-candidate delay is unchanged per worker (not also shortened) so risk
 * scales with worker count alone, not compounded with faster individual pacing.
 */
import { db, audit } from "../src/db.mjs";
import { claimCandidates, runSupervisorCheck, browserDiscoveryClaimOptions } from "../src/pipeline-orchestrator.mjs";
import {
  connectToBrave, findOrOpenSalesNavigatorPage, applySearchFilters, openFilteredSearchPage, searchCandidateOnSalesNavigator,
  normalizeBrowserLead, recordBrowserLead, applyBrowserLeadDecision, searchCanaryPasses,
  SearchUnavailableError, RateLimitedError, BROWSER_AGENT_EXIT
} from "../src/browser-agent.mjs";
import { verifyCandidateAcademics, applyAcademicVerificationDecision } from "../src/academic-resolver.mjs";
import { exportConfirmedCheckpoint } from "./export-checkpoint.mjs";
import { exportCombinedSheet } from "./export-combined.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    return [key, val === undefined ? true : val];
  })
);

const limit = Number(args.limit || 50);
const batchSize = Math.min(Number(args["batch-size"] || process.env.BROWSER_BATCH_SIZE || 8), 25);
const delayMinMs = Number(args["delay-min"] || process.env.BROWSER_SEARCH_DELAY_MIN_MS || 15000);
const delayMaxMs = Number(args["delay-max"] || process.env.BROWSER_SEARCH_DELAY_MAX_MS || 45000);
const workerCount = Math.min(Math.max(Number(args.workers || process.env.BROWSER_AGENT_WORKERS || 1), 1), 16);
// The academic/.edu.au/.gov.au web-search fallback runs on every Sales
// Navigator miss (~95% of candidates) but found zero confirmed matches
// across this entire session — it's pure dead weight on the critical path
// of every worker's loop. Kept as an opt-out (default: still runs) rather
// than deleted, since the user has toggled this decision once already.
const skipAcademicFallbackRaw = args["skip-academic-fallback"] ?? process.env.BROWSER_SKIP_ACADEMIC_FALLBACK;
const skipAcademicFallback = skipAcademicFallbackRaw === true || skipAcademicFallbackRaw === "true";
const thresholds = {
  high: Number(process.env.MATCH_HIGH_THRESHOLD || 85),
  manual: Number(process.env.MATCH_MANUAL_THRESHOLD || 60)
};
// A search round: when set, every candidate not searched since this UTC
// timestamp ('YYYY-MM-DD HH:MM:SS', same format as browser_leads.created_at)
// is eligible again — including identity_unresolved ones — exactly once.
const attemptedSince = args["attempted-since"] || process.env.BROWSER_ATTEMPTED_SINCE || null;
const claimOptions = browserDiscoveryClaimOptions(attemptedSince);

// "Not found" results are held back and only written once a canary search
// (someone already confirmed) succeeds right after them — see
// searchCanaryPasses. Exit codes tell scripts/auto-run-browser-agent.mjs
// what happened so it can cool down instead of burning the queue.
const NOT_FOUND_COMMIT_EVERY = 20;
const UNAVAILABLE_STREAK_LIMIT = 3;
let halt = null;
const searchFailures = new Map(); // candidate id -> SearchUnavailable count in this run // { code, reason } once any worker detects a run-wide problem

const canaries = db.prepare(`SELECT id, full_name, first_name, last_name FROM candidates
  WHERE identity_status = 'confirmed' AND identity_provider = 'browser_agent_salesnav'
    AND first_name <> '' AND last_name <> '' ORDER BY id LIMIT 2`).all();

let stopRequested = false;
process.on("SIGINT", () => {
  console.log("\n[Browser Agent] SIGINT received — finishing in-flight candidates, then stopping.");
  stopRequested = true;
});

function randomDelay() {
  const ms = delayMinMs + Math.random() * Math.max(0, delayMaxMs - delayMinMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Shared, mutable counters. Safe without locking: Node is single-threaded —
// concurrent workers interleave at `await` points, not mid-statement, so a
// plain `state.processed += 1` between awaits can't race.
// Returns a claimed candidate to the queue untouched (its pre-claim stage, no
// browser_leads row), so a search that didn't really happen is retried later
// instead of being recorded as "not found".
function releaseCandidate(candidate) {
  db.prepare(`UPDATE candidates SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND workflow_stage = 'claiming_browser_discovery'`).run(candidate.workflow_stage, candidate.id);
}

function commitNotFound(candidate) {
  recordBrowserLead(db, { candidateId: candidate.id, normalized: null, raw: null });
  db.prepare("UPDATE candidates SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(candidate.id);
}

// Writes the held-back "not found" results only if a canary search passes
// right now; otherwise releases them and halts the whole run.
async function settleNotFound(page, worker, label) {
  if (!worker.pendingNotFound.length) return;
  const pending = worker.pendingNotFound.splice(0);
  if (halt) { pending.forEach(releaseCandidate); return; }
  let ok = false;
  try {
    ok = await searchCanaryPasses(page, canaries);
  } catch (error) {
    if (!(error instanceof RateLimitedError)) throw error;
    halt ||= { code: BROWSER_AGENT_EXIT.RATE_LIMITED, reason: error.message };
  }
  if (ok) {
    pending.forEach(commitNotFound);
    console.log(`[${label}]   (canary passed — recorded ${pending.length} not-found result(s))`);
  } else {
    pending.forEach(releaseCandidate);
    halt ||= { code: BROWSER_AGENT_EXIT.SEARCH_BROKEN, reason: "canary search for an already-confirmed nurse found nothing" };
    console.error(`[${label}]   !! ${halt.reason} — returned ${pending.length} held result(s) to the queue and stopping the run.`);
  }
}

async function processOneCandidate(page, candidate, state, label, worker) {
  try {
    console.log(`[${label}] Searching Sales Navigator for #${candidate.id} ${candidate.full_name}...`);
    const raw = await searchCandidateOnSalesNavigator(page, candidate);
    worker.unavailableStreak = 0;
    const normalized = normalizeBrowserLead(raw);

    if (!normalized?.linkedinUrl) {
      if (skipAcademicFallback) {
        console.log(`[${label}]   -> No healthcare match in Australia (held until the next canary check).`);
        worker.pendingNotFound.push(candidate);
        if (worker.pendingNotFound.length >= NOT_FOUND_COMMIT_EVERY) await settleNotFound(page, worker, label);
      } else {
        recordBrowserLead(db, { candidateId: candidate.id, normalized, raw });
        console.log(`[${label}]   -> No Sales Navigator match found. Checking other places (university/.edu.au/.gov.au web presence)...`);
        const academicResult = await verifyCandidateAcademics(candidate);
        if (academicResult.isAcademicVerified) {
          applyAcademicVerificationDecision(db, candidate, academicResult, audit);
          state.confirmed += 1;
          console.log(`[${label}]   -> CONFIRMED via academic/web search (score ${academicResult.academicMatchScore}): ${academicResult.verifiedUrls[0]}`);
        } else {
          console.log(`[${label}]   -> Not found there either.`);
          db.prepare("UPDATE candidates SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(candidate.id);
        }
      }
    } else {
      recordBrowserLead(db, { candidateId: candidate.id, normalized, raw });
      const result = applyBrowserLeadDecision(db, candidate, normalized, thresholds, audit);
      if (result.decision === "confirmed") {
        state.confirmed += 1;
        console.log(`[${label}]   -> CONFIRMED (score ${result.score}): ${normalized.linkedinUrl}`);
      } else {
        console.log(`[${label}]   -> Found but not auto-confirmed (score ${result.score}${result.conflicts?.length ? `, conflicts: ${result.conflicts.join("; ")}` : ""}): ${normalized.linkedinUrl}`);
      }
    }
  } catch (error) {
    // Nothing is recorded for a search that didn't actually complete — the
    // candidate goes back to the queue (previously it was parked in
    // manual_review, and a broken page could end up as "not found").
    releaseCandidate(candidate);
    if (error instanceof RateLimitedError) {
      halt ||= { code: BROWSER_AGENT_EXIT.RATE_LIMITED, reason: error.message };
      console.error(`[${label}]   !! LinkedIn rate limit hit — stopping the run.`);
    } else if (error instanceof SearchUnavailableError) {
      worker.unavailableStreak += 1;
      // Claims go lowest-id first, so a candidate whose search always fails
      // would be re-claimed forever; after a second failure in this run it's
      // parked in browser_search_failed (outside the claim stages) for review.
      const failures = (searchFailures.get(candidate.id) || 0) + 1;
      searchFailures.set(candidate.id, failures);
      if (failures >= 2) {
        db.prepare("UPDATE candidates SET workflow_stage = 'browser_search_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(candidate.id);
      }
      console.error(`[${label}]   -> Search didn't load for #${candidate.id} (${error.message}); ${failures >= 2 ? "parked as browser_search_failed" : "returned to queue"}.`);
      if (worker.unavailableStreak >= UNAVAILABLE_STREAK_LIMIT) {
        // Maybe just this tab: re-apply the filter once, then decide via canary.
        await applySearchFilters(page, { geography: "Australia" }).catch(() => {});
        if (!(await searchCanaryPasses(page, canaries).catch(() => false))) {
          halt ||= { code: BROWSER_AGENT_EXIT.SEARCH_BROKEN, reason: `${worker.unavailableStreak} searches in a row didn't load and the canary failed` };
        }
        worker.unavailableStreak = 0;
      }
    } else {
      console.error(`[${label}]   -> Error searching #${candidate.id}: ${error.message}; returned to queue.`);
    }
    return;
  }
  state.processed += 1;
}

async function runWorker(page, label, state, perWorkerLimit) {
  const worker = { pendingNotFound: [], unavailableStreak: 0 };
  let ownProcessed = 0;
  try {
    while (ownProcessed < perWorkerLimit && state.processed < limit && !stopRequested && !halt) {
      const claimSize = Math.min(batchSize, perWorkerLimit - ownProcessed, limit - state.processed);
      if (claimSize <= 0) break;
      const claimed = claimCandidates(db, { ...claimOptions, claimingStage: "claiming_browser_discovery", limit: claimSize });
      if (!claimed.length) {
        console.log(`[${label}] No more candidates needing LinkedIn discovery.`);
        break;
      }
      console.log(`[${label}] Claimed ${claimed.length} candidate(s): ${claimed.map((c) => `#${c.id} ${c.full_name}`).join(", ")}\n`);

      for (const [i, candidate] of claimed.entries()) {
        if (stopRequested || halt) {
          claimed.slice(i).forEach(releaseCandidate);
          break;
        }
        await processOneCandidate(page, candidate, state, label, worker);
        ownProcessed += 1;
        if (ownProcessed >= perWorkerLimit || state.processed >= limit || stopRequested) {
          claimed.slice(i + 1).forEach(releaseCandidate);
          break;
        }
        await randomDelay();
      }
      exportConfirmedCheckpoint(db);
      exportCombinedSheet();
    }
  } finally {
    await settleNotFound(page, worker, label);
  }
}

async function prepareWorkerPage(context, existingPage, index) {
  // Every tab, including the reused one, starts from a fresh filtered search
  // page — the reused tab may be parked on a profile or an unfiltered search.
  const page = index === 0 ? existingPage : await context.newPage();
  await openFilteredSearchPage(page);
  return page;
}

async function main() {
  console.log("===============================================================");
  console.log("   HCRHUB BROWSER AGENT — LINKEDIN SALES NAVIGATOR DISCOVERY");
  console.log("===============================================================");
  console.log(`Batch size: ${batchSize} | Limit: ${limit} | Delay: ${delayMinMs}-${delayMaxMs}ms | Workers: ${workerCount} | Auto-confirm threshold: ${thresholds.high}`);
  console.log("===============================================================\n");

  const { browser, context } = await connectToBrave();
  const firstPage = await findOrOpenSalesNavigatorPage(context);
  console.log(`[Browser Agent] Attached to Sales Navigator tab: ${firstPage.url()}\n`);

  // Geography narrows meaningfully without excluding real matches. A
  // Current-job-title filter was tried and dropped: the AHPRA sheet's
  // "profession" field is always the literal string "Nurse", but Sales
  // Navigator's title filter matches what someone actually wrote on their
  // own profile ("Clinical Nurse Consultant", "Nurse Practitioner",
  // "Midwife", "Nurse Unit Manager", ...) — a strict "Nurse" filter risks
  // silently excluding real matches that scoreIdentityMatch would otherwise
  // have caught and verified after the fact anyway.
  console.log(`[Browser Agent] Preparing ${workerCount} worker tab(s) with Geography=Australia filter...`);
  const pages = [];
  for (let i = 0; i < workerCount; i++) {
    const page = await prepareWorkerPage(context, firstPage, i);
    pages.push(page);
    console.log(`[Browser Agent] Worker ${i + 1}/${workerCount} tab ready.`);
  }
  console.log();

  const { staleRecovered } = runSupervisorCheck(db);
  if (staleRecovered > 0) console.log(`[Supervisor] Recovered ${staleRecovered} stale lease(s).\n`);

  // Prove search actually works before claiming anyone.
  try {
    if (!canaries.length) throw new Error("no confirmed candidates available to use as a canary");
    if (!(await searchCanaryPasses(pages[0], canaries))) {
      halt = { code: BROWSER_AGENT_EXIT.SEARCH_BROKEN, reason: "start-up canary search found nothing" };
    }
  } catch (error) {
    halt = error instanceof RateLimitedError
      ? { code: BROWSER_AGENT_EXIT.RATE_LIMITED, reason: error.message }
      : { code: BROWSER_AGENT_EXIT.SEARCH_BROKEN, reason: error.message };
  }
  if (halt) console.error(`[Browser Agent] Not starting: ${halt.reason}`);
  else console.log(`[Browser Agent] Start-up canary passed (search is working). Round: ${attemptedSince || "first attempt only"}\n`);

  const state = { processed: 0, confirmed: 0 };
  const perWorkerLimit = Math.ceil(limit / workerCount);
  if (!halt) await Promise.all(pages.map((page, i) => runWorker(page, `Worker ${i + 1}`, state, perWorkerLimit)));

  // Close the extra worker tabs this run opened (index 0 is the shared
  // Sales Navigator tab reused across every run — leave it). Playwright
  // controlling a page over CDP doesn't close it when the script exits;
  // across many repeated invocations (this script gets relaunched by
  // scripts/auto-run-browser-agent.mjs every batch) that leaked one tab per
  // extra worker per run. Confirmed live: Brave accumulated 20+ processes
  // and froze while still answering the CDP health check, causing a silent
  // multi-hour stall — orphaned tabs from repeated runs are a likely
  // contributor.
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close().catch(() => {});
  }

  const { stats: finalStats } = runSupervisorCheck(db);
  console.log("\n===============================================================");
  console.log("   BROWSER AGENT RUN COMPLETE");
  console.log("===============================================================");
  console.log(`Searched: ${state.processed} | Auto-confirmed this run: ${state.confirmed}`);
  console.log(`Total confirmed: ${finalStats.identity_confirmed} | Total with LinkedIn: ${finalStats.with_linkedin}`);
  console.log("Run scripts/audit-browser-confirmations.mjs to spot-check what was confirmed and why.");
  if (halt) console.log(`STOPPED EARLY: ${halt.reason} (exit code ${halt.code})`);
  console.log("===============================================================\n");

  if (browser) {
    await browser.close().catch(() => {});
  }
  process.exit(halt ? halt.code : 0);
}

main().catch((err) => {
  console.error("Fatal browser agent error:", err);
  process.exit(1);
});
