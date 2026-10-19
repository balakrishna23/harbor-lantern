import { db } from '../src/db.mjs';

const queued = db.prepare(`
  SELECT id, full_name, linkedin_url, workflow_stage, work_email, mobile_phone
  FROM candidates
  WHERE workflow_stage = 'phone_queued'
`).all();

console.log('=== PHONE QUEUED CANDIDATES (count: ' + queued.length + ') ===');
queued.forEach(c => console.log(c.id, c.full_name, c.workflow_stage, c.work_email, c.mobile_phone));

// Also check enrichment jobs for them
if (queued.length > 0) {
  const ids = queued.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  const jobs = db.prepare(`SELECT candidate_id, kind, status, provider_reference, updated_at FROM enrichment_jobs WHERE candidate_id IN (${placeholders}) ORDER BY candidate_id, id DESC`).all(...ids);
  console.log('=== ENRICHMENT JOBS FOR PHONE QUEUED ===');
  jobs.forEach(j => console.log(JSON.stringify(j)));
}
