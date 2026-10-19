import { db } from "../src/db.mjs";

console.log("\n=== FULL PIPELINE AUDIT ===");

// 1. Total registry breakdown
const reg = db.prepare(`
  SELECT registration_status, COUNT(*) as cnt 
  FROM candidates GROUP BY registration_status
`).all();
console.log("\n-- Registry Breakdown --");
reg.forEach(r => console.log(JSON.stringify(r)));

// 2. Identity stage breakdown
const stages = db.prepare(`
  SELECT workflow_stage, COUNT(*) as cnt 
  FROM candidates GROUP BY workflow_stage ORDER BY cnt DESC
`).all();
console.log("\n-- Workflow Stages --");
stages.forEach(s => console.log(JSON.stringify(s)));

// 3. LinkedIn discovery hit/miss analysis
const discoveryTotal = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE id IN (SELECT DISTINCT candidate_id FROM enrichment_jobs WHERE kind = 'identity')`).get();
const linkedinHits   = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE linkedin_url IS NOT NULL AND linkedin_url <> '' AND id IN (SELECT DISTINCT candidate_id FROM enrichment_jobs WHERE kind='identity')`).get();
const linkedinMiss   = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE (linkedin_url IS NULL OR linkedin_url = '') AND id IN (SELECT DISTINCT candidate_id FROM enrichment_jobs WHERE kind='identity')`).get();
console.log("\n-- LinkedIn Discovery --");
console.log(`Attempted: ${discoveryTotal.cnt}, Hits: ${linkedinHits.cnt}, Miss: ${linkedinMiss.cnt}`);

// 4. Of candidates WITH linkedin, how many passed AHPRA gate?
const withUrl   = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE linkedin_url IS NOT NULL AND linkedin_url <> ''`).get();
const confirmed = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status = 'confirmed'`).get();
const rejected  = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status = 'rejected'`).get();
console.log("\n-- AHPRA Verification Gate --");
console.log(`With LinkedIn URL: ${withUrl.cnt}, Confirmed (score>=85): ${confirmed.cnt}, Rejected: ${rejected.cnt}, Manual Review: ${withUrl.cnt - confirmed.cnt - rejected.cnt}`);

// 5. Contact waterfall breakdown
const contacted   = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed'`).get();
const hasEmail    = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND email_status='valid'`).get();
const noEmail     = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND (work_email IS NULL OR work_email='' OR email_status<>'valid')`).get();
const hasPhone    = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND mobile_phone IS NOT NULL AND mobile_phone<>''`).get();
const hasBoth     = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND email_status='valid' AND mobile_phone IS NOT NULL AND mobile_phone<>''`).get();
const hasNeither  = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND (work_email IS NULL OR work_email='') AND (mobile_phone IS NULL OR mobile_phone='')`).get();
const hasAusMob   = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND mobile_phone LIKE '+614%'`).get();
const hasAnyContact = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE identity_status='confirmed' AND (email_status='valid' OR (mobile_phone IS NOT NULL AND mobile_phone<>''))`).get();
console.log("\n-- Contact Waterfall Results --");
console.log(`Targeted for contact: ${contacted.cnt}`);
console.log(`Got valid email: ${hasEmail.cnt}`);
console.log(`No email found: ${noEmail.cnt}`);
console.log(`Got mobile phone: ${hasPhone.cnt}`);
console.log(`Got both (golden record): ${hasBoth.cnt}`);
console.log(`Got neither (unreachable): ${hasNeither.cnt}`);
console.log(`Australian mobile (+614): ${hasAusMob.cnt}`);
console.log(`At least one contact (reachability): ${hasAnyContact.cnt}`);

// 6. Email loss reasons — candidates with no email
const noEmailCandidates = db.prepare(`
  SELECT id, full_name, mobile_phone, workflow_stage, recruiter_notes
  FROM candidates 
  WHERE identity_status='confirmed' AND (work_email IS NULL OR work_email='')
  ORDER BY id
`).all();
console.log("\n-- No-Email Confirmed Candidates --");
noEmailCandidates.forEach(c => console.log(`ID ${c.id}: ${c.full_name} | phone: ${c.mobile_phone || 'NONE'} | stage: ${c.workflow_stage}`));

// 7. Totally unreachable candidates
const unreachable = db.prepare(`
  SELECT id, full_name, workflow_stage, linkedin_url
  FROM candidates 
  WHERE identity_status='confirmed' 
    AND (work_email IS NULL OR work_email='') 
    AND (mobile_phone IS NULL OR mobile_phone='')
  ORDER BY id
`).all();
console.log("\n-- UNREACHABLE Confirmed Candidates (no email AND no phone) --");
unreachable.forEach(c => console.log(`ID ${c.id}: ${c.full_name} | stage: ${c.workflow_stage}`));
console.log(`Total unreachable: ${unreachable.length}`);

// 8. Credit economics
const credits = db.prepare(`SELECT SUM(credits) as total FROM credit_ledger WHERE entry_type='actual'`).get();
const emailCredits = db.prepare(`SELECT SUM(credits) as total FROM credit_ledger WHERE kind='email' AND entry_type='actual'`).get();
const phoneCredits = db.prepare(`SELECT SUM(credits) as total FROM credit_ledger WHERE kind='phone' AND entry_type='actual'`).get();
const identityCredits = db.prepare(`SELECT SUM(credits) as total FROM credit_ledger WHERE kind='identity' AND entry_type='actual'`).get();
console.log("\n-- Credit Economics --");
console.log(`Total credits: ${credits.total}`);
console.log(`Identity (LinkedIn discovery): ${identityCredits.total}`);
console.log(`Email waterfall: ${emailCredits.total}`);
console.log(`Phone waterfall: ${phoneCredits.total}`);

// 9. Campaign ready
const campaignReady = db.prepare(`SELECT COUNT(*) as cnt FROM candidates WHERE workflow_stage='campaign_ready'`).get();
const campaignEligible = db.prepare(`
  SELECT id, full_name, employer, current_title, work_email, mobile_phone
  FROM candidates WHERE workflow_stage='campaign_ready' ORDER BY id
`).all();
console.log(`\n-- Campaign Ready: ${campaignReady.cnt} --`);
campaignEligible.forEach(c => console.log(`ID ${c.id}: ${c.full_name} | ${c.employer} | ${c.work_email} | ${c.mobile_phone || '-'}`));

db.close();
