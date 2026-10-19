import { db } from "../src/db.mjs";

const stuckIds = [118, 121, 127];

for (const id of stuckIds) {
  db.prepare(`
    UPDATE candidates
    SET email_status = 'unverified',
        workflow_stage = 'contact_unresolved',
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);
}

console.log("Resolved candidates 118, 121, 127 to contact_unresolved");
