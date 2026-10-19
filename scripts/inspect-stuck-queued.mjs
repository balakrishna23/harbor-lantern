import { db } from '../src/db.mjs';

const stuck = db.prepare(`
  SELECT id, full_name, email_status, work_email, mobile_phone, business_phone, workflow_stage
  FROM candidates
  WHERE workflow_stage IN ('phone_queued', 'email_queued')
`).all();

console.log(`Found ${stuck.length} candidates in queued stages:`);
for (const c of stuck) {
  // Check if all their enrichment_jobs are completed
  const jobs = db.prepare('SELECT kind, status FROM enrichment_jobs WHERE candidate_id = ? ORDER BY id DESC').all(c.id);
  const running = jobs.filter(j => j.status === 'running' || j.status === 'queued');
  console.log(`Candidate ${c.id} (${c.full_name}): email=${c.work_email} phone=${c.mobile_phone} stage=${c.workflow_stage} active_jobs=${running.length}`);
}
