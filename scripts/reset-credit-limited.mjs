import { db } from "../src/db.mjs";

console.log("Checking how many candidates were affected by the credit limit error...");

// Let's count candidates in identity_unresolved with IDs >= 150
const affected = db.prepare(`
  SELECT count(*) as cnt
  FROM candidates
  WHERE workflow_stage = 'identity_unresolved' AND id >= 150
`).get();

console.log(`Candidates marked identity_unresolved above ID 150: ${affected.cnt}`);

// Reset them back to 'manual_review' or 'source_imported' so that when credits are replenished or increased, they can actually be searched properly!
const updated = db.prepare(`
  UPDATE candidates
  SET workflow_stage = 'manual_review', updated_at = CURRENT_TIMESTAMP
  WHERE workflow_stage = 'identity_unresolved' AND id >= 150
`).run();

console.log(`Reset ${updated.changes} candidates back to 'manual_review' (clean state for future runs).`);

// Also clean up any uncompleted or failed enrichment_jobs above ID 150
const deletedJobs = db.prepare(`
  DELETE FROM enrichment_jobs
  WHERE candidate_id >= 150 AND kind = 'identity'
`).run();
console.log(`Cleaned up ${deletedJobs.changes} credit-limited enrichment jobs so they can run fresh.`);
