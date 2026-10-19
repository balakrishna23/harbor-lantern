#!/usr/bin/env node
import { db } from "../src/db.mjs";
import { toCsv } from "../src/csv.mjs";
import { exportConfirmedCheckpoint } from "./export-checkpoint.mjs";
import { exportCombinedSheet } from "./export-combined.mjs";
import {
  claimCandidates,
  runVerificationBatch,
  runSupervisorCheck
} from "../src/pipeline-orchestrator.mjs";

const API_BASE = "http://127.0.0.1:4173";
const CONTACT_BATCH_SIZE = 5;
const DISCOVERY_BATCH_SIZE = 5;

console.log("===============================================================");
console.log("   HCRHUB AUTONOMOUS RUNNER: CONTINUOUS UNTIL CREDITS EXHAUSTED");
console.log("===============================================================");
console.log("Workflow: Discovery -> AHPRA Verification -> Contact Cascade");
console.log("Master Combined Sheet: exports/hcrhub_all_enriched_combined.csv");
console.log("===============================================================\n");

async function checkClayStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/clay/status`);
    if (!res.ok) return { connected: false };
    return await res.json();
  } catch {
    return { connected: false };
  }
}

async function checkCredits() {
  try {
    const res = await fetch(`${API_BASE}/api/clay/credits`);
    if (!res.ok) return { available: true };
    const data = await res.json();
    console.log("[Clay Credits Telemetry]", JSON.stringify(data));
    if (data.hasWorkspaceCredits === false || data.exhaustedMessage) {
      return { available: false, message: data.exhaustedMessage || "Workspace credits exhausted" };
    }
    return { available: true, ...data };
  } catch (e) {
    console.log("[Clay Credits Check Warning]", e.message);
    return { available: true };
  }
}

async function enrichContactBatch(candidateIds) {
  console.log(`\n[Contact Worker] Starting contact batch for ${candidateIds.length} candidate(s):`, candidateIds);

  const startRes = await fetch(`${API_BASE}/api/clay/contact/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      candidateIds,
      name: `Continuous Batch ${new Date().toISOString().slice(11, 19)}`,
      force: true
    })
  });

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Failed to start contact batch: ${startRes.status} ${errText}`);
  }

  const { batchId, taskId } = await startRes.json();
  console.log(`[Contact Worker] Batch #${batchId} started (Task: ${taskId}). Polling progress...`);

  for (let poll = 0; poll < 60; poll++) {
    await new Promise((r) => setTimeout(r, 6000));
    const res = await fetch(`${API_BASE}/api/clay/tasks/${taskId}`);
    const data = await res.json();
    const raw = JSON.parse(data.content[0].text);

    console.log(`[Task ${taskId}] Processed ${raw.processedEntities}/${raw.totalEntities} (Complete: ${raw.isComplete})`);

    if (raw.isComplete) {
      console.log(`[Task ${taskId}] Completed! Parsing results...`);
      const rows = [];
      for (let idx = 0; idx < raw.entities.length; idx++) {
        const entity = raw.entities[idx];
        const candidateId = candidateIds[idx];
        const enrichments = Object.values(entity.enrichments || {})[0];
        let val = {};
        try { val = JSON.parse(enrichments.value || "{}"); } catch {}

        const workEmail = val["Work Email"] || "";
        const mobilePhone = val["Mobile Phone"] || "";
        const org = val["Enrich person"]?.org || "";
        const title = val["Enrich person"]?.title || "";

        console.log(`  -> Candidate #${candidateId}: Email=${workEmail || "N/A"} | Phone=${mobilePhone || "N/A"} | Employer=${org || "N/A"}`);
        rows.push({
          candidate_id: candidateId,
          work_email: workEmail,
          email_status: workEmail ? "valid" : "unverified",
          mobile_phone: mobilePhone,
          employer: org,
          current_title: title,
          provider_reference: `${taskId}:${entity.entityId}`,
          actual_credits: 3.3
        });
      }

      const csv = toCsv(rows, [
        "candidate_id", "work_email", "email_status", "mobile_phone",
        "employer", "current_title", "provider_reference", "actual_credits"
      ]);

      const importRes = await fetch(`${API_BASE}/api/enrichment/results`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchId, csvText: csv })
      });
      const importData = await importRes.json();
      console.log(`[Results Ingested] Batch #${batchId} Import result:`, importData);

      // Export checkpoint & master combined
      exportConfirmedCheckpoint(db);
      exportCombinedSheet();
      return { success: true, count: rows.length };
    }
  }

  throw new Error(`Timeout waiting for task ${taskId} to complete.`);
}

async function runDiscoveryAndVerificationBatch(batchSize = DISCOVERY_BATCH_SIZE) {
  // 1. Claim candidates atomically
  let claimed = claimCandidates(db, {
    sourceStage: ["source_imported", "manual_review"],
    claimingStage: "claiming_discovery",
    limit: batchSize,
    cohort: "ACT"
  });

  if (!claimed.length) {
    // Try any cohort if ACT unreviewed is complete
    claimed = claimCandidates(db, {
      sourceStage: ["source_imported", "manual_review"],
      claimingStage: "claiming_discovery",
      limit: batchSize
    });
  }

  if (!claimed.length) {
    return { processed: 0, confirmed: 0 };
  }

  const ids = claimed.map((c) => c.id);
  console.log(`\n[Discovery Worker] Claimed ${ids.length} candidate(s) for LinkedIn discovery:`, ids);

  try {
    const startRes = await fetch(`${API_BASE}/api/clay/identity/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        candidateIds: ids,
        subroutineName: "Person LinkedIn URL",
        name: `Discovery Batch ${new Date().toISOString().slice(11, 19)}`
      })
    });

    if (!startRes.ok) {
      const errText = await startRes.text();
      // Reset claiming stage so candidates aren't locked
      db.prepare(`UPDATE candidates SET workflow_stage = 'manual_review' WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
      throw new Error(`Discovery failed to start: ${startRes.status} ${errText}`);
    }

    const { batchId, taskId } = await startRes.json();
    console.log(`[Discovery Worker] Batch #${batchId} started (Task: ${taskId}). Polling...`);

    for (let poll = 0; poll < 60; poll++) {
      await new Promise((r) => setTimeout(r, 6000));
      const res = await fetch(`${API_BASE}/api/clay/tasks/${taskId}`);
      const data = await res.json();
      const raw = JSON.parse(data.content[0].text);

      console.log(`[Discovery Task ${taskId}] Processed ${raw.processedEntities}/${raw.totalEntities} (Complete: ${raw.isComplete})`);

      if (raw.isComplete) {
        console.log(`[Discovery Task ${taskId}] Completed! Parsing discovered URLs...`);
        const rows = [];
        for (let idx = 0; idx < raw.entities.length; idx++) {
          const entity = raw.entities[idx];
          const candidateId = ids[idx];
          const enrichments = Object.values(entity.enrichments || {})[0];
          let val = {};
          try { val = JSON.parse(enrichments.value || "{}"); } catch {}
          const linkedinUrl = val["LinkedIn URL"] || val.url || "";
          console.log(`  -> Candidate #${candidateId}: LinkedIn=${linkedinUrl || "Not found"}`);
          rows.push({
            candidate_id: candidateId,
            linkedin_url: linkedinUrl,
            provider_reference: `${taskId}:${entity.entityId}`,
            actual_credits: 2.2
          });
        }

        const csv = toCsv(rows, ["candidate_id", "linkedin_url", "provider_reference", "actual_credits"]);
        await fetch(`${API_BASE}/api/enrichment/results`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ batchId, csvText: csv })
        });

        // 2. Verification Worker: score candidates against licensed AHPRA data.
        // A high score with zero conflicts is routed to "pending_confirmation",
        // not auto-confirmed — a recruiter must confirm it via the review UI/API.
        const verified = runVerificationBatch(db, ids);
        const pending = verified.filter((v) => v.decision === "pending_confirmation");
        console.log(`[Verification Worker] Evaluated ${ids.length} candidates -> ${pending.length} flagged for recruiter confirmation (score >= 85, awaiting human sign-off).`);

        exportConfirmedCheckpoint(db);
        exportCombinedSheet();
        return { processed: ids.length, pendingConfirmation: pending.length };
      }
    }

    throw new Error(`Discovery timed out for task ${taskId}`);
  } catch (err) {
    // Free leases on error
    db.prepare(`UPDATE candidates SET workflow_stage = 'manual_review' WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    throw err;
  }
}

async function main() {
  let isConnected = false;

  // 1. Check Clay Connection
  while (!isConnected) {
    const status = await checkClayStatus();
    if (status.connected) {
      isConnected = true;
      console.log("[Clay Connection] Connected! Active tools:", status.tools.length);
      break;
    }

    console.log(`[Waiting for Clay Authorization] Clay is not connected.`);
    console.log(`Please switch to your Brave browser tab and click 'Authorize' on the Clay consent screen.`);
    console.log(`Retrying in 6 seconds...\n`);
    await new Promise((r) => setTimeout(r, 6000));
  }

  // 2. Supervisor Initial Recovery
  const { staleRecovered, stats: initialStats } = runSupervisorCheck(db);
  if (staleRecovered > 0) {
    console.log(`[Supervisor] Recovered ${staleRecovered} stale candidate lease(s).`);
  }
  console.log(`\n[Database Telemetry] Confirmed: ${initialStats.identity_confirmed} | Emails Verified: ${initialStats.email_verified} | Total: ${initialStats.total_candidates}`);

  // 3. Autonomous Multi-Agent Loop
  let totalEnrichedThisRun = 0;
  let hasCredits = true;

  while (hasCredits) {
    // Check credits before every cycle
    const creditInfo = await checkCredits();
    if (creditInfo.available === false) {
      console.log(`\n[Credits Exhausted] ${creditInfo.message || "Clay credits depleted"}. Stopping pipeline.`);
      hasCredits = false;
      break;
    }

    // Step A: Check for candidates with confirmed LinkedIn URLs who lack verified emails
    const pendingContact = db.prepare(`
      SELECT id, full_name, linkedin_url
      FROM candidates
      WHERE identity_status = 'confirmed'
        AND linkedin_url IS NOT NULL AND linkedin_url <> ''
        AND (work_email IS NULL OR work_email = '' OR email_status <> 'valid')
      ORDER BY id ASC
      LIMIT ?
    `).all(CONTACT_BATCH_SIZE);

    if (pendingContact.length > 0) {
      const ids = pendingContact.map((c) => c.id);
      try {
        const result = await enrichContactBatch(ids);
        totalEnrichedThisRun += result.count;
        continue; // Immediately loop to check credits and continue
      } catch (err) {
        console.error("[Contact Batch Error]", err.message);
        if (/workspace credits exhausted|no credits available|insufficient credits|quota exceeded|out of credits/i.test(err.message)) {
          console.log("[Credits Stopped] External Clay credit limit reached during contact cascade.");
          hasCredits = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
    }

    // Step B: If no confirmed candidates are waiting, discover and verify new registered candidates
    try {
      const discoveryResult = await runDiscoveryAndVerificationBatch(DISCOVERY_BATCH_SIZE);
      if (discoveryResult.processed === 0) {
        console.log("\n[Complete] All candidates in the database have been reviewed and enriched!");
        break;
      }
      console.log(`[Cycle Complete] Discovered ${discoveryResult.processed} candidates, ${discoveryResult.pendingConfirmation} flagged for recruiter confirmation.`);
    } catch (err) {
      console.error("[Discovery Batch Error]", err.message);
      if (/workspace credits exhausted|no credits available|insufficient credits|quota exceeded|out of credits/i.test(err.message)) {
        console.log("[Credits Stopped] External Clay credit limit reached during discovery.");
        hasCredits = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  // 4. Export Final Combined Sheet
  const combined = exportCombinedSheet();
  const { stats: finalStats } = runSupervisorCheck(db);

  console.log("\n===============================================================");
  console.log("   AUTONOMOUS ENRICHMENT CYCLE COMPLETE");
  console.log("===============================================================");
  console.log(`Master Sheet Path: ${combined.path}`);
  console.log(`Total Confirmed Candidates in Sheet: ${combined.total}`);
  console.log(`Total Email Verified: ${finalStats.email_verified}`);
  console.log(`Total Phone Numbers: ${finalStats.with_phone}`);
  console.log(`Newly Enriched in this Run: ${totalEnrichedThisRun}`);
  console.log("===============================================================\n");
}

if (process.argv[1]?.endsWith("run-until-credits-exhausted.mjs")) {
  main().catch((err) => {
    console.error("Fatal pipeline error:", err);
    process.exit(1);
  });
}
