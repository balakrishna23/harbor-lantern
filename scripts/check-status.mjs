import { db } from '../src/db.mjs';
import fs from 'node:fs';

const total = db.prepare('SELECT count(*) as c FROM candidates').get().c;
const confirmed = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed'").get().c;
const withEmail = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND work_email IS NOT NULL AND work_email != ''").get().c;
const withPhone = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND mobile_phone IS NOT NULL AND mobile_phone != ''").get().c;
const unresolved = db.prepare("SELECT count(*) as c FROM candidates WHERE workflow_stage = 'contact_unresolved'").get().c;
const confirmedPendingContact = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status = 'confirmed' AND (work_email IS NULL OR work_email = '') AND (workflow_stage != 'contact_unresolved' OR workflow_stage IS NULL)").get().c;
const unreviewed = db.prepare("SELECT count(*) as c FROM candidates WHERE identity_status != 'confirmed' AND (identity_status = 'unreviewed' OR identity_status IS NULL)").get().c;
const credits = db.prepare("SELECT sum(credits) as total FROM credit_ledger WHERE entry_type = 'actual'").get().total;

console.log(JSON.stringify({
  totalCandidates: total,
  confirmedIdentities: confirmed,
  verifiedEmails: withEmail,
  verifiedPhones: withPhone,
  contactUnresolved: unresolved,
  confirmedPendingContact,
  unreviewedRegistered: unreviewed,
  creditsSpentTracked: credits
}, null, 2));

const csvPath = './exports/hcrhub_all_enriched_combined.csv';
if (fs.existsSync(csvPath)) {
  const content = fs.readFileSync(csvPath, 'utf8');
  const lines = content.trim().split('\n');
  console.log(`\nCSV exists: ${csvPath}, header + ${lines.length - 1} rows\n`);
  console.log('--- ALL ROWS IN CSV ---');
  lines.forEach((l, i) => console.log(`${i}: ${l}`));
}
