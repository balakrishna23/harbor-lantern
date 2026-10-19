#!/usr/bin/env node
import { db } from "../src/db.mjs";
import {
  claimCandidates,
  runDiscoveryBatch,
  runVerificationBatch,
  runSupervisorCheck
} from "../src/pipeline-orchestrator.mjs";
import { exportConfirmedCheckpoint } from "./export-checkpoint.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    return [key, val === undefined ? true : val];
  })
);

const cohort = args.cohort || "ACT";
const limit = Number(args.limit || 25);
const batchSize = Math.min(Number(args["batch-size"] || 5), 10);
const dryRun = Boolean(args["dry-run"]);
const singlePass = args["single-pass"] === true || args["single-pass"] === "true";

console.log("===============================================================");
console.log("   HCRHUB AUTONOMOUS MULTI-AGENT ENRICHMENT PIPELINE");
console.log("===============================================================");
console.log(`Cohort: ${cohort} | Target Limit: ${limit} | Batch Size: ${batchSize} | DryRun: ${dryRun}`);
console.log("===============================================================\n");

async function main() {
  let processedCount = 0;

  // 1. Run supervisor recovery
  const { staleRecovered, stats: initialStats } = runSupervisorCheck(db);
  if (staleRecovered > 0) {
    console.log(`[Supervisor] Recovered ${staleRecovered} stale worker leases.`);
  }

  console.log("[Pipeline Telemetry Initial State]");
  console.log(`  Total: ${initialStats.total_candidates} | Registered: ${initialStats.registered}`);
  console.log(`  Confirmed Identities: ${initialStats.identity_confirmed} | Verified Emails: ${initialStats.email_verified}\n`);

  while (processedCount < limit) {
    // Stage 1: Discovery Worker claims registered candidates
    const claimSize = Math.min(batchSize, limit - processedCount);
    const claimed = claimCandidates(db, {
      sourceStage: ["source_imported", "manual_review"],
      claimingStage: "claiming_discovery",
      limit: claimSize,
      cohort
    });

    if (!claimed.length) {
      console.log(`[Discovery Worker] No more unreviewed registered candidates found for cohort '${cohort}'.`);
      break;
    }

    console.log(`[Discovery Worker] Claimed ${claimed.length} candidate(s): ${claimed.map((c) => `#${c.id} (${c.full_name})`).join(", ")}`);

    // In local/offline/dry-run or without live Clay task, discovery marks candidate profiles
    const discovered = await runDiscoveryBatch(db, claimed, { dryRun });
    console.log(`[Discovery Worker] Discovery processed ${discovered.length} record(s).`);

    // Stage 2: Verification Worker evaluates discovered profiles. A high score
    // with zero conflicts is NOT auto-confirmed here — it is routed to
    // "pending_confirmation" for a recruiter to confirm via the review UI/API.
    const discoveredIds = claimed.map((c) => c.id);
    const verified = runVerificationBatch(db, discoveredIds);
    const pending = verified.filter((v) => v.decision === "pending_confirmation");
    console.log(`[Verification Worker] Evaluated ${verified.length} profile(s): ${pending.length} flagged for recruiter confirmation (score >= 85, awaiting human sign-off).`);

    processedCount += claimed.length;

    // Supervisor Check & Auto-Checkpoint Export
    const { stats: currentStats } = runSupervisorCheck(db);
    console.log(`[Supervisor Progress] Processed ${processedCount}/${limit} | Confirmed Total: ${currentStats.identity_confirmed}\n`);

    if (singlePass) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Export updated checkpoint
  const exportPath = exportConfirmedCheckpoint(db);
  console.log(`\n[Checkpoint Export] Updated master export at: ${exportPath}`);

  const { stats: finalStats } = runSupervisorCheck(db);
  console.log("\n===============================================================");
  console.log("   PIPELINE CYCLE COMPLETE");
  console.log("===============================================================");
  console.log(`Total Candidates: ${finalStats.total_candidates}`);
  console.log(`Confirmed Identities: ${finalStats.identity_confirmed}`);
  console.log(`Verified Work Emails: ${finalStats.email_verified}`);
  console.log(`With Mobile Phone: ${finalStats.with_phone}`);
  console.log("===============================================================\n");
}

main().catch((err) => {
  console.error("Pipeline fatal error:", err);
  process.exit(1);
});
