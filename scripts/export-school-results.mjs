// Snapshot export of every LinkedIn school-verification result, one row per checked profile.
// Reads comparison reports (source of truth) plus the live candidate record from the database.
// Usage: node scripts/export-school-results.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toCsv } from '../src/csv.mjs';

const root = path.resolve(import.meta.dirname, '..');
const resultsDir = path.join(root, 'data/location-agent-results');
const jobsDir = path.join(root, 'data/location-agents');
const db = new DatabaseSync(path.join(root, 'data/hcrhub.sqlite'), { readOnly: true });
const candidateById = db.prepare('SELECT * FROM candidates WHERE id=?');
const dbCheck = db.prepare('SELECT database_status, reason, updated_at FROM school_verification_checks WHERE run_id=? AND profile_id=?');

const yn = v => v == null ? '' : v ? 'yes' : 'no';
const flat = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
// LinkedIn education snippet lines: school, degree/field, dates, then grade/notes.
const describeEducation = e => {
  const [, degree = '', dates = '', ...rest] = flat(e.snippet);
  return { degree, dates, notes: rest.join(' / ') };
};
const status = p => p.verification?.status || p.verificationStatus;

const rows = [];
for (const jobId of fs.readdirSync(resultsDir)) {
  const reportPath = path.join(resultsDir, jobId, 'report.json');
  if (!fs.existsSync(reportPath)) continue;
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const job = JSON.parse(fs.readFileSync(path.join(jobsDir, `${jobId}.json`), 'utf8'));
  for (const p of report.profiles.filter(p => p.verification)) {
    const v = p.verification, ev = v.evidence || {};
    const chosenId = v.candidateId || (p.candidates.filter(c => c.eligible).length === 1 ? p.candidates.find(c => c.eligible).candidateId : null);
    const chosen = p.candidates.find(c => c.candidateId === chosenId);
    const chosenCheck = v.checks?.find(c => c.candidateId === chosenId);
    const reg = chosen?.registrations?.find(r => /registered nurse/i.test(r.registrationType)) || chosen?.registrations?.[0];
    const cand = chosenId ? candidateById.get(chosenId) : null;
    const stored = dbCheck.get(jobId, p.id);
    const pairs = chosenCheck?.pairs || [];
    const education = ev.education || [];
    rows.push({
      run_name: job.name,
      run_id: jobId,
      profile_id: p.id,
      spreadsheet_name: p.fullName,
      linkedin_opened_name: ev.fullName || '',
      linkedin_input_url: p.url,
      linkedin_final_url: (ev.finalUrl || '').replace(/\/details\/education\/?(?:\?.*)?$/, '/'),
      linkedin_location: p.location,
      linkedin_job_title: p.title,
      linkedin_employer: p.employer,
      register_match_status: p.matchStatus,
      register_candidates_total: p.candidates.length,
      register_candidates_eligible_rn: p.candidates.filter(c => c.eligible).length,
      school_verification_result: v.status,
      result_reason: v.reason || '',
      confirmed: yn(v.status === 'confirmed'),
      candidate_id: chosenId || '',
      register_name: chosen?.fullName || '',
      register_alternative_name: chosen?.alternativeName || '',
      registration_number: chosen?.registrationNumber || '',
      registration_type: reg?.registrationType || '',
      registration_status: reg?.registrationStatus || '',
      registration_expiry: reg?.registrationExpiry || '',
      register_suburb: cand?.suburb || '',
      register_state: cand?.state || '',
      register_postcode: cand?.postcode || '',
      register_qualifications: chosen?.qualifications?.replace(/^[•\s]+/, '').replace(/\s*•\s*/g, ' | ') || '',
      school_check_status: chosenCheck?.schoolStatus || '',
      name_match: yn(chosenCheck?.nameMatch),
      middle_name_conflict: yn(chosenCheck?.middleConflict),
      graduation_year_conflict: yn(chosenCheck?.yearConflict),
      matched_register_school: pairs.map(x => x.register.school).join(' | '),
      matched_register_degree: pairs.map(x => x.register.degree || '').join(' | '),
      matched_register_year: pairs.map(x => x.register.year || '').join(' | '),
      matched_linkedin_school: pairs.map(x => x.profile.school).join(' | '),
      matched_linkedin_degree: pairs.map(x => describeEducation(x.profile).degree).join(' | '),
      matched_linkedin_end_year: pairs.map(x => x.profile.endYear || '').join(' | '),
      year_difference: pairs.map(x => x.register.year && x.profile.endYear ? Math.abs(x.register.year - Number(x.profile.endYear)) : '').join(' | '),
      linkedin_education_count: education.length,
      linkedin_education_all: education.map(e => {
        const d = describeEducation(e);
        return [e.school, d.degree, d.dates].filter(Boolean).join(' / ');
      }).join(' | '),
      all_register_candidates: p.candidates.map(c => {
        const check = v.checks?.find(k => k.candidateId === c.candidateId);
        return `${c.fullName} [${c.registrationNumber}, id ${c.candidateId}, ${c.eligible ? 'eligible RN' : 'not eligible'}${check ? `, ${check.schoolStatus}, name ${yn(check.nameMatch)}` : ''}]`;
      }).join(' | '),
      all_register_qualifications: p.candidates.map(c => `${c.fullName}: ${c.qualifications?.replace(/^[•\s]+/, '').replace(/\s*•\s*/g, '; ') || '(none)'}`).join(' | '),
      database_write_status: stored?.database_status || p.databaseWrite?.status || '',
      database_write_reason: stored?.reason || p.databaseWrite?.reason || '',
      db_identity_status: cand?.identity_status || '',
      db_workflow_stage: cand?.workflow_stage || '',
      db_match_confidence: cand?.match_confidence || '',
      db_linkedin_url: cand?.linkedin_url || '',
      education_read_status: ev.status || '',
      read_transport: ev.transport || '',
      checked_at: v.checkedAt || '',
      source_file_rows: p.sources.map(s => `${s.originalFilename || path.basename(s.file)} row ${s.row}`).join(' | '),
      register_source: report.register.filename
    });
  }
}
db.close();

const order = ['confirmed', 'education_conflict', 'ambiguous_identity', 'identity_conflict', 'school_not_corroborated', 'register_school_unavailable', 'education_unavailable'];
const rank = s => (order.indexOf(s) + 1) || order.length + 1;
rows.sort((a, b) => rank(a.school_verification_result) - rank(b.school_verification_result) || a.checked_at.localeCompare(b.checked_at));

const date = new Date().toLocaleDateString('en-CA');
const out = path.join(root, 'outputs/school-matching-results', `school-matching-results-${date}.csv`);
fs.writeFileSync(out, '﻿' + toCsv(rows, Object.keys(rows[0])));
const counts = Object.groupBy(rows, r => r.school_verification_result);
console.log(out);
console.log(rows.length, 'rows', Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v.length])));
