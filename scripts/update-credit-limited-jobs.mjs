import { db } from "../src/db.mjs";

console.log("Updating enrichment_jobs status for affected candidates...");

const updatedJobs = db.prepare(`
  UPDATE enrichment_jobs
  SET status = 'credit_limit_reached', error_message = 'Monthly user credit limit reached in Clay', updated_at = CURRENT_TIMESTAMP
  WHERE candidate_id >= 150 AND kind = 'identity' AND status = 'completed'
`).run();

console.log(`Updated ${updatedJobs.changes} jobs to 'credit_limit_reached'.`);

// Check current workflow stages
const stages = db.prepare(`
  SELECT workflow_stage, count(*) as cnt FROM candidates GROUP BY workflow_stage ORDER BY cnt DESC
`).all();
console.log("Current workflow stages:", stages);
