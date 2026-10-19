import { db } from "../src/db.mjs";

console.log("Checking enrichment jobs backwards to find when credits ran out...");

const jobs = db.prepare(`
  SELECT id, batch_id, candidate_id, provider_reference, created_at
  FROM enrichment_jobs
  WHERE kind = 'identity' AND status = 'completed'
  ORDER BY id DESC
  LIMIT 200
`).all();

// Sample every 10 jobs
for (let i = 0; i < jobs.length; i += 10) {
  const j = jobs[i];
  if (!j.provider_reference) continue;
  try {
    const res = await fetch(`http://127.0.0.1:4173/api/clay/tasks/${j.provider_reference}`);
    const d = await res.json();
    const raw = JSON.parse(d.content[0].text);
    const first = raw.entities?.[0]?.enrichments;
    const val = first ? Object.values(first)[0] : null;
    console.log(`Job #${j.id} (Candidate #${j.candidate_id}, Time: ${j.created_at}): Status = ${val?.runnerStatus || 'OK'}, Error = ${val?.error || 'None'}`);
    if (val?.runnerStatus !== 'ERROR_WORKSPACE_SALES_REP_CREDIT_LIMIT_REACHED') {
      console.log(`--> Found boundary! Credits ran out near Candidate #${j.candidate_id}`);
      break;
    }
  } catch (e) {
    console.log(`Error checking job ${j.id}:`, e.message);
  }
}
