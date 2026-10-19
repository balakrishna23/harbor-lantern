import fs from 'node:fs/promises';
import path from 'node:path';
import { toCsv } from './csv.mjs';
import { atomicCheckpoint } from './extraction-bot-state.mjs';

export async function writeLocationReport(report, directory) {
  await fs.mkdir(directory, { recursive: true });
  const atomicWrite = async (filename, content) => {
    const destination = path.join(directory, filename);
    atomicCheckpoint(destination, content);
  };
  const summary = { ...report.summary, verificationCounts: Object.fromEntries([...new Set(report.profiles.map(p => p.verification?.status || p.verificationStatus))]
    .map(s => [s, report.profiles.filter(p => (p.verification?.status || p.verificationStatus) === s).length])) };
  summary.databaseCounts = Object.fromEntries([...new Set(report.profiles.map(p => p.databaseWrite?.status).filter(Boolean))]
    .map(s => [s, report.profiles.filter(p => p.databaseWrite?.status === s).length]));
  report.summary = summary;
  const rows = report.profiles.map(p => ({ profile_id: p.id, name: p.fullName, linkedin_url: p.url || p.originalUrl,
    location: p.location, job_title: p.title, employer: p.employer, match_status: p.matchStatus,
    eligible_register_candidates: p.candidates.filter(c => c.eligible).length,
    verification_status: p.verification?.status || p.verificationStatus, confirmed_candidate_id: p.verification?.candidateId || '',
    database_status: p.databaseWrite?.status || '', database_reason: p.databaseWrite?.reason || '',
    reason: p.verification?.reason || p.issues.join('; '),
    register_names: p.candidates.map(c => c.fullName).join(' | '), registration_numbers: p.candidates.map(c => c.registrationNumber).join(' | '),
    register_qualifications: p.candidates.map(c => c.qualifications).join(' | '),
    profile_education: p.verification?.evidence?.education?.map(e => `${e.school}${e.endYear ? ` (${e.endYear})` : ''}`).join(' | ') || '',
    source_rows: p.sources.map(s => `${s.originalFilename || path.basename(s.file)} / ${s.sheet} / ${s.row}`).join(' | '), source_occurrences: p.sources.length,
    checked_at: p.verification?.checkedAt || '', register_source: report.register.filename
  }));
  const columns = ['profile_id', 'name', 'linkedin_url', 'location', 'job_title', 'employer', 'match_status', 'eligible_register_candidates',
    'verification_status', 'confirmed_candidate_id', 'database_status', 'database_reason', 'reason', 'register_names', 'registration_numbers', 'register_qualifications',
    'profile_education', 'source_rows', 'source_occurrences', 'checked_at', 'register_source'];
  const pairs = report.profiles.flatMap(p => p.candidates.map(c => ({ profile_id: p.id, name: p.fullName, linkedin_url: p.url,
    candidate_id: c.candidateId, register_name: c.fullName, registration_number: c.registrationNumber, eligible_registered_rn: c.eligible,
    register_qualifications: c.qualifications, registration_types: c.registrations.map(r => r.registrationType).join('; '),
    registration_statuses: c.registrations.map(r => r.registrationStatus).join('; '), source_rows: c.registrations.map(r => r.sourceRow).join('; ') })));
  // JSON is the resumable source of truth. CSV files are spreadsheet-friendly views.
  await atomicWrite('report.json', JSON.stringify(report, null, 2));
  await atomicWrite('results.csv', '\uFEFF' + toCsv(rows, columns));
  await atomicWrite('confirmed.csv', '\uFEFF' + toCsv(rows.filter(r => r.verification_status === 'confirmed'), columns));
  await atomicWrite('review.csv', '\uFEFF' + toCsv(rows.filter(r => r.verification_status !== 'confirmed'), columns));
  const pairColumns = ['profile_id', 'name', 'linkedin_url', 'candidate_id', 'register_name', 'registration_number', 'eligible_registered_rn', 'register_qualifications', 'registration_types', 'registration_statuses', 'source_rows'];
  await atomicWrite('register-candidates.csv', '\uFEFF' + toCsv(pairs, pairColumns));
  await atomicWrite('summary.json', JSON.stringify(summary, null, 2));
  return summary;
}
