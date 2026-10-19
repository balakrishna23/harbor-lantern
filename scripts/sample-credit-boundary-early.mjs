import { db } from "../src/db.mjs";

const checkIds = [180, 150, 120, 100, 80, 60, 40];

for (const cid of checkIds) {
  const j = db.prepare(`
    SELECT id, candidate_id, provider_reference, created_at
    FROM enrichment_jobs
    WHERE kind = 'identity' AND candidate_id >= ?
    ORDER BY candidate_id ASC
    LIMIT 1
  `).get(cid);

  if (!j?.provider_reference) continue;

  try {
    const res = await fetch(`http://127.0.0.1:4173/api/clay/tasks/${j.provider_reference}`);
    const d = await res.json();
    const raw = JSON.parse(d.content[0].text);
    const val = Object.values(raw.entities?.[0]?.enrichments || {})[0];
    console.log(`Candidate #${j.candidate_id} (Time: ${j.created_at}): Status = ${val?.runnerStatus || 'SUCCESS'}, Error = ${val?.error || 'None'}`);
  } catch (e) {
    console.log(`Error on candidate ${cid}:`, e.message);
  }
}
