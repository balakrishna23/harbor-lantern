import { db } from "../src/db.mjs";

const pendingContact = db.prepare(`
  SELECT id, full_name, workflow_stage, identity_status, linkedin_url
  FROM candidates
  WHERE identity_status = 'confirmed'
    AND linkedin_url IS NOT NULL AND linkedin_url <> ''
    AND (work_email IS NULL OR work_email = '' OR email_status <> 'valid')
`).all();

console.log('Confirmed candidates needing contact waterfall:', pendingContact.length);
pendingContact.forEach(c => console.log(`  Candidate ${c.id}: ${c.full_name} | stage: ${c.workflow_stage}`));
