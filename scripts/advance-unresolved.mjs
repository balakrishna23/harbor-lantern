import { db } from "../src/db.mjs";

const res = db.prepare(`
  UPDATE candidates 
  SET workflow_stage = 'academic_unresolved', updated_at = CURRENT_TIMESTAMP 
  WHERE id BETWEEN 17 AND 31 AND workflow_stage != 'source_imported'
`).run();

console.log("Updated rows to academic_unresolved:", res.changes);

const counts = db.prepare(`
  SELECT workflow_stage, COUNT(id) as count 
  FROM candidates 
  GROUP BY workflow_stage
`).all();

console.log("Current workflow stage distribution:", counts);
