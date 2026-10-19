import { db } from "../src/db.mjs";

const res = db.prepare(`
  UPDATE candidates
  SET workflow_stage = 'source_imported', updated_at = CURRENT_TIMESTAMP
  WHERE workflow_stage IN ('identity_discovery_queued', 'claiming_discovery', 'claiming_contact')
     OR workflow_stage LIKE 'claiming_%'
`).run();

console.log(`Reset ${res.changes} candidates back to 'source_imported'`);
