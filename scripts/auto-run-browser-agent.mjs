#!/usr/bin/env node
/**
 * "Auto mode": keeps launching scripts/run-browser-agent.mjs in batches,
 * back to back, until every candidate needing LinkedIn discovery has been
 * processed — instead of a human (or Claude) re-invoking one batch at a
 * time. Meant to be started once and left running for hours.
 *
 * Self-heals the one thing that reliably breaks an unattended run: Brave's
 * CDP debug port going away (crash, sleep, manual close). Before each batch
 * it checks the port and relaunches via scripts/launch-brave-debug.mjs if
 * needed, so the loop survives a dropped browser instead of crash-looping.
 */
import { execFileSync } from "node:child_process";
import { db } from "../src/db.mjs";
import { claimEligibility, browserDiscoveryClaimOptions } from "../src/pipeline-orchestrator.mjs";
import { BROWSER_AGENT_EXIT } from "../src/browser-agent.mjs";

const BATCH_LIMIT = Number(process.env.BROWSER_AUTO_BATCH_LIMIT || 50);
const ATTEMPTED_SINCE = process.env.BROWSER_ATTEMPTED_SINCE || null;
// After a rate limit, LinkedIn needs a stretch of genuinely zero traffic
// (incident 13: slowing down alone did not clear it), then a small 1-worker
// probe batch before going back to full parallelism.
const RATE_LIMIT_COOLDOWN_MS = Number(process.env.BROWSER_RATE_LIMIT_COOLDOWN_MS || 45 * 60000);
const SEARCH_BROKEN_COOLDOWN_MS = Number(process.env.BROWSER_SEARCH_BROKEN_COOLDOWN_MS || 20 * 60000);
const PROBE_BATCH_LIMIT = 20;
// Start paused (minutes) and/or with a 1-worker probe — for relaunching while
// a rate-limit cooldown from a previous process is still running.
const START_AFTER_MS = Number(process.env.BROWSER_START_AFTER_MIN || 0) * 60000;
const START_WITH_PROBE = process.env.BROWSER_START_WITH_PROBE === "true";
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || "http://127.0.0.1:9222";
const BETWEEN_BATCH_PAUSE_MS = Number(process.env.BROWSER_AUTO_BATCH_PAUSE_MS || 15000);
const WORKERS = Number(process.env.BROWSER_AGENT_WORKERS || 1);
const DELAY_MIN_MS = Number(process.env.BROWSER_SEARCH_DELAY_MIN_MS || 7000);
const DELAY_MAX_MS = Number(process.env.BROWSER_SEARCH_DELAY_MAX_MS || 18000);

let stopRequested = false;
process.on("SIGINT", () => {
  console.log("\n[Auto Runner] SIGINT received — will stop after the current batch finishes.");
  stopRequested = true;
});
// The outer loop has died silently (no error, no log line at all) more
// than once overnight, always between batches — consistent with an
// external SIGTERM this process had no handler for (Node's default
// SIGTERM behavior is immediate, silent termination). This won't prevent
// that if it's really an external kill, but it turns a completely silent
// death into at least one logged line for next time's diagnosis.
process.on("SIGTERM", () => {
  console.log("\n[Auto Runner] SIGTERM received — exiting now (no handler can prevent this, but at least it's logged).");
  process.exit(0);
});
process.on("exit", (code) => {
  console.log(`[Auto Runner] process 'exit' event fired with code ${code}.`);
});

// Uses claimCandidates' own WHERE clause (claimEligibility), not a copy.
// A hand-maintained copy once drifted (missing the registration_status
// filter) and kept reporting "2 still queued" forever after the real queue
// was empty, spinning the outer loop uselessly for over an hour.
function remainingCount() {
  const { whereClause, params } = claimEligibility(browserDiscoveryClaimOptions(ATTEMPTED_SINCE));
  return db.prepare(`SELECT COUNT(*) n FROM candidates WHERE ${whereClause}`).get(...params).n;
}

async function cdpReachable() {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureBrave() {
  if (await cdpReachable()) return true;
  console.log("[Auto Runner] CDP unreachable — relaunching Brave via scripts/launch-brave-debug.mjs...");
  try {
    execFileSync(process.execPath, ["scripts/launch-brave-debug.mjs"], { stdio: "inherit" });
  } catch (error) {
    console.error("[Auto Runner] launch-brave-debug.mjs exited with an error:", error.message);
  }
  return cdpReachable();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("===============================================================");
  console.log("   AUTO MODE — running browser-agent batches until queue empty");
  console.log("===============================================================");
  console.log(`Round: ${ATTEMPTED_SINCE ? `re-search everyone not searched since ${ATTEMPTED_SINCE} UTC` : "first attempt only"}`);
  let batchNumber = 0;
  let consecutiveFailures = 0;
  let consecutiveBroken = 0;
  let probeNext = START_WITH_PROBE;
  // Each rate limit permanently halves the worker count for this process
  // (6 → 3 → 2 → 1) and doubles the next cooldown (capped at 4h): hitting
  // LinkedIn's limit repeatedly risks the Sales Navigator account itself.
  let workerCount = WORKERS;
  let rateLimits = 0;
  if (START_AFTER_MS) {
    console.log(`[Auto Runner] Waiting ${START_AFTER_MS / 60000} min before the first batch (cooldown carried over from a previous run).`);
    await sleep(START_AFTER_MS);
  }

  while (!stopRequested) {
    const remaining = remainingCount();
    if (remaining === 0) {
      console.log("\n[Auto Runner] No candidates left needing LinkedIn discovery. Auto mode complete.");
      break;
    }

    batchNumber += 1;
    console.log(`\n[Auto Runner] --- Batch ${batchNumber} --- ${remaining} candidate(s) still queued for discovery.`);

    const braveOk = await ensureBrave();
    if (!braveOk) {
      consecutiveFailures += 1;
      console.log(`[Auto Runner] Brave/CDP still unreachable after relaunch attempt (failure ${consecutiveFailures}). Waiting 60s before retry.`);
      if (consecutiveFailures >= 5) {
        console.error("[Auto Runner] 5 consecutive Brave relaunch failures — pausing 30 min, then trying again. Check Brave manually.");
        consecutiveFailures = 0;
        await sleep(30 * 60000);
        continue;
      }
      await sleep(60000);
      continue;
    }

    const workers = probeNext ? 1 : workerCount;
    const batchLimit = probeNext ? PROBE_BATCH_LIMIT : BATCH_LIMIT;
    if (probeNext) console.log(`[Auto Runner] Probe batch after rate-limit cooldown: 1 worker, ${PROBE_BATCH_LIMIT} candidates.`);
    try {
      execFileSync(process.execPath, [
        "scripts/run-browser-agent.mjs",
        `--limit=${Math.min(batchLimit, remaining)}`,
        "--batch-size=20",
        `--delay-min=${DELAY_MIN_MS}`,
        `--delay-max=${DELAY_MAX_MS}`,
        `--workers=${workers}`
      ], { stdio: "inherit" });
      consecutiveFailures = 0;
      consecutiveBroken = 0;
      probeNext = false;
    } catch (error) {
      if (error.status === BROWSER_AGENT_EXIT.RATE_LIMITED) {
        rateLimits += 1;
        workerCount = Math.max(1, Math.floor(workerCount / 2));
        const cooldown = Math.min(RATE_LIMIT_COOLDOWN_MS * 2 ** (rateLimits - 1), 4 * 3600000);
        console.error(`[Auto Runner] LinkedIn rate limit (#${rateLimits} this run) — no traffic for ${cooldown / 60000} min, then a 1-worker probe; continuing with ${workerCount} worker(s) after that.`);
        probeNext = true;
        await sleep(cooldown);
        continue;
      }
      if (error.status === BROWSER_AGENT_EXIT.SEARCH_BROKEN) {
        consecutiveBroken += 1;
        const wait = Math.min(SEARCH_BROKEN_COOLDOWN_MS * consecutiveBroken, 60 * 60000);
        console.error(`[Auto Runner] Search isn't working (canary failed, ${consecutiveBroken} time(s) in a row) — nothing was recorded as not-found. Waiting ${wait / 60000} min. If this repeats, check Brave is still logged in to Sales Navigator.`);
        await sleep(wait);
        continue;
      }
      consecutiveFailures += 1;
      console.error(`[Auto Runner] Batch ${batchNumber} exited with an error (failure ${consecutiveFailures}): ${error.message}`);
      if (consecutiveFailures >= 5) {
        // Keep going (the user wants this to run until the data is done),
        // but back off hard instead of crash-looping.
        console.error("[Auto Runner] 5 consecutive batch failures — pausing 30 min, then trying again.");
        consecutiveFailures = 0;
        await sleep(30 * 60000);
      }
    }

    if (stopRequested) break;
    await sleep(BETWEEN_BATCH_PAUSE_MS);
  }

  console.log("\n[Auto Runner] Stopped.");
}

main().catch((err) => {
  console.error("Fatal auto-runner error:", err);
  process.exit(1);
});
