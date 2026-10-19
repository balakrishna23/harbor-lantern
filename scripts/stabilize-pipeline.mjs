import { db } from "../src/db.mjs";

console.log("=== STABILIZING PIPELINE ===");

// 1. Mark 247-251 as identity_unresolved since their identity job completed with no LinkedIn URL
db.prepare(`
  UPDATE candidates
  SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP
  WHERE id IN (247, 248, 249, 250, 251)
`).run();
console.log("Marked candidates 247-251 as identity_unresolved.");

// 2. Find any other candidates in manual_review or identity_discovery_queued that already have completed identity jobs
const completedIdentityWithoutLinkedIn = db.prepare(`
  SELECT c.id, c.full_name
  FROM candidates c
  JOIN enrichment_jobs j ON j.candidate_id = c.id AND j.kind = 'identity' AND j.status = 'completed'
  WHERE (c.linkedin_url IS NULL OR c.linkedin_url = '')
    AND c.workflow_stage IN ('manual_review', 'identity_discovery_queued')
`).all();

if (completedIdentityWithoutLinkedIn.length > 0) {
  const ids = completedIdentityWithoutLinkedIn.map(c => c.id);
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`
    UPDATE candidates
    SET workflow_stage = 'identity_unresolved', updated_at = CURRENT_TIMESTAMP
    WHERE id IN (${placeholders})
  `).run(...ids);
  console.log(`Updated ${ids.length} candidates with completed identity (no LinkedIn) to identity_unresolved: ${ids.join(', ')}`);
}

// 3. Resolve stuck phone_queued / email_queued candidates
// Candidates who have completed contact jobs or whose contact attempts finished
const queuedCandidates = db.prepare(`
  SELECT id, full_name, work_email, email_status, mobile_phone, business_phone, workflow_stage
  FROM candidates
  WHERE workflow_stage IN ('phone_queued', 'email_queued')
`).all();

console.log(`Found ${queuedCandidates.length} candidates in phone_queued/email_queued:`);
for (const c of queuedCandidates) {
  const activeJobs = db.prepare(`
    SELECT count(*) as cnt FROM enrichment_jobs
    WHERE candidate_id = ? AND status IN ('queued', 'running')
  `).get(c.id);

  // If no active jobs or jobs are from earlier batches (older than 20 mins)
  if (activeJobs.cnt === 0) {
    let targetStage = 'contact_unresolved';
    if (c.email_status === 'valid') {
      targetStage = 'campaign_ready';
    } else if (c.mobile_phone || c.business_phone) {
      targetStage = 'contact_unresolved'; // Has phone! Contact reachability established
    }
    db.prepare(`
      UPDATE candidates
      SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(targetStage, c.id);
    console.log(`  Candidate ${c.id} (${c.full_name}): updated to ${targetStage} (email: ${c.work_email || 'none'}, phone: ${c.mobile_phone || 'none'})`);
  }
}

// 4. Any candidates stuck in claiming_ stages from killed workers
const claimingStuck = db.prepare(`
  SELECT id, workflow_stage FROM candidates WHERE workflow_stage LIKE 'claiming_%'
`).all();
if (claimingStuck.length > 0) {
  for (const c of claimingStuck) {
    const isContact = c.workflow_stage.includes('contact');
    const target = isContact ? 'identity_confirmed' : 'manual_review';
    db.prepare("UPDATE candidates SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(target, c.id);
  }
  console.log(`Reset ${claimingStuck.length} candidates from claiming_* stages.`);
}

console.log("\n=== PIPELINE STAGE SUMMARY ===");
const stages = db.prepare(`
  SELECT workflow_stage, COUNT(*) as cnt
  FROM candidates
  GROUP BY workflow_stage
  ORDER BY cnt DESC
`).all();
stages.forEach(s => console.log(`  ${s.workflow_stage}: ${s.cnt}`));

db.close();
