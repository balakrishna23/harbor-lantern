import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import readXlsxFile from 'read-excel-file/node';
import { normalizeCandidate } from './domain.mjs';
import { personNameVariants, personNamesMatch } from './name-variants.mjs';
import { parseCsv } from './csv.mjs';

const text = value => String(value ?? '').trim();
const header = value => text(value).toLowerCase().replace(/[_\s]+/g, ' ');
export const nameTokens = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t && !['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'mx', 'sir'].includes(t));

export function linkedinProfileUrl(value) {
  try {
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || !/(^|\.)linkedin\.com$/i.test(url.hostname) || url.username || url.password || url.port) return null;
    const match = url.pathname.match(/^\/in\/([^/]+)\/?$/);
    if (!match || /[\\/\s?#]/.test(decodeURIComponent(match[1]))) return null;
    return `https://www.linkedin.com/in/${match[1]}`;
  } catch { return null; }
}

function mapped(row) {
  const values = new Map(Object.entries(row).map(([k, v]) => [header(k), v]));
  return (...keys) => keys.map(k => values.get(header(k))).find(v => v != null && text(v)) ?? '';
}

export function normalizeLocationProfile(row, source) {
  const get = mapped(row);
  const rawFirst = get('first_name', 'firstname', 'given name');
  const rawLast = get('last_name', 'lastname', 'surname', 'family name');
  const fullName = text(get('full name', 'name') || [rawFirst, get('middle_name'), rawLast].filter(Boolean).join(' '));
  const issues = [];
  if (typeof rawFirst === 'number' || typeof rawLast === 'number' || /\d/.test(fullName) || nameTokens(fullName).length < 2) issues.push('Invalid or incomplete name');
  const originalUrl = text(get('url', 'linkedin url', 'linkedin', 'profile url'));
  const url = linkedinProfileUrl(originalUrl);
  if (!url) issues.push('Missing or invalid LinkedIn profile URL');
  return {
    id: crypto.createHash('sha256').update(url || JSON.stringify(source)).digest('hex').slice(0, 24),
    fullName, url, originalUrl, title: text(get('job_title', 'current title', 'title')),
    employer: text(get('company_name', 'employer', 'company')), location: text(get('city', 'location')),
    registrationNumber: text(get('registration number', 'ahpra number')).replace(/\s+/g, '').toUpperCase(),
    sources: [source], issues
  };
}

export async function readLocationFiles(files) {
  const profiles = new Map();
  const sources = [];
  let inputRows = 0;
  for (const filename of files) {
    const absolute = path.resolve(filename);
    const bytes = await fs.readFile(absolute);
    const fileHash = crypto.createHash('sha256').update(bytes).digest('hex');
    let sheets;
    if (/\.xlsx$/i.test(filename)) {
      const book = await readXlsxFile(bytes);
      sheets = Array.isArray(book[0]?.data) ? book.map(s => ({ name: s.sheet, matrix: s.data })) : [{ name: 'Sheet1', matrix: book }];
    } else if (/\.csv$/i.test(filename)) {
      sheets = [{ name: 'CSV', records: parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, '')) }];
    } else throw new Error(`Unsupported location file: ${filename}. Use .xlsx or .csv`);
    for (const sheet of sheets) {
      const matrix = sheet.matrix;
      if (matrix?.length) {
        const headers = matrix[0].map(text);
        if (new Set(headers.map(header)).size !== headers.length) throw new Error(`Duplicate column headers in ${filename}/${sheet.name}`);
        sheet.records = matrix.slice(1).map(values => Object.fromEntries(headers.map((h, i) => [h, values[i]])));
      }
      const records = sheet.records || [];
      if (records.length) {
        const columns = Object.keys(records[0]).map(header);
        if (!columns.some(h => ['url', 'linkedin url', 'linkedin', 'profile url'].includes(h))) throw new Error(`No profile URL column in ${filename}/${sheet.name}`);
      }
      let count = 0;
      records.forEach((row, i) => {
        if (!Object.values(row).some(v => text(v))) return;
        inputRows++; count++;
        const p = normalizeLocationProfile(row, { file: absolute, fileHash, sheet: sheet.name, row: i + 2 });
        const existing = profiles.get(p.id);
        if (existing) {
          existing.sources.push(...p.sources);
          // Differences are evidence to review, never silently pick the first spelling.
          if (nameTokens(existing.fullName).join(' ') !== nameTokens(p.fullName).join(' ')) existing.issues.push('Conflicting names for the same LinkedIn URL');
          if (existing.registrationNumber && p.registrationNumber && existing.registrationNumber !== p.registrationNumber) existing.issues.push('Conflicting registration numbers for the same LinkedIn URL');
          existing.registrationNumber ||= p.registrationNumber;
          existing.issues = [...new Set([...existing.issues, ...p.issues])];
        } else profiles.set(p.id, p);
      });
      sources.push({ file: absolute, fileHash, sheet: sheet.name, rows: count });
    }
  }
  return { profiles: [...profiles.values()], sources, inputRows, duplicateRows: inputRows - profiles.size };
}

export function isRegisteredRn(row) {
  return /^registered$/i.test(text(row.registrationStatus)) && /^nurse$/i.test(text(row.profession))
    && /^registered nurse\s*\(division 1\),\s*general$/i.test(text(row.registrationType));
}

/** One streaming pass over a chosen source import. The working candidate table
 * can retain older ACT facts, so matching and eligibility use preserved source rows. */
export function matchLocationProfiles(db, profiles, importId) {
  const buckets = new Map();
  const byNumber = new Map();
  for (const p of profiles) {
    p.candidates = [];
    if (p.issues.some(i => i.includes('name'))) continue;
    // Every reading of the display name is a lookup key, so credentials after the
    // surname, or a surname inside an unclosed bracket, still reach the register.
    for (const last of new Set(personNameVariants(p.fullName).map(v => v.split(' ').at(-1)))) {
      if (!buckets.has(last)) buckets.set(last, []);
      buckets.get(last).push(p);
    }
    if (p.registrationNumber) {
      if (!byNumber.has(p.registrationNumber)) byNumber.set(p.registrationNumber, []);
      byNumber.get(p.registrationNumber).push(p);
    }
  }
  const found = new Map(profiles.map(p => [p.id, new Map()]));
  let registerRows = 0;
  for (const record of db.prepare('SELECT candidate_id, source_row, registration_number, source_record FROM registrations WHERE import_id = ?').iterate(importId)) {
    registerRows++;
    const raw = JSON.parse(record.source_record);
    const get = mapped(raw);
    const fullName = text(get('health practitioner', 'full name') || [get('first name'), get('middle name'), get('last name')].filter(Boolean).join(' '));
    const alternativeName = text(get('alternative name'));
    const possible = new Set([...(buckets.get(nameTokens(fullName).at(-1)) || []), ...(buckets.get(nameTokens(alternativeName).at(-1)) || []), ...(byNumber.get(record.registration_number) || [])]);
    if (!possible.size) continue;
    const c = normalizeCandidate(raw);
    for (const p of possible) {
      const numberMatch = p.registrationNumber && p.registrationNumber === c.ahpraNumber;
      const nameMatch = personNamesMatch(fullName, p.fullName) || (alternativeName && personNamesMatch(alternativeName, p.fullName));
      if (!numberMatch && (!nameMatch || (p.registrationNumber && p.registrationNumber !== c.ahpraNumber))) continue;
      const map = found.get(p.id);
      let candidate = map.get(record.candidate_id);
      if (!candidate) {
        candidate = { candidateId: record.candidate_id, registrationNumber: c.ahpraNumber, fullName, alternativeName,
          qualifications: c.qualifications, eligible: false, nameMatch: Boolean(nameMatch), numberMatch: Boolean(numberMatch), registrations: [] };
        map.set(record.candidate_id, candidate);
      }
      const reg = { sourceRow: record.source_row, registrationStatus: c.registrationStatus, registrationType: c.registrationType, registrationExpiry: c.registrationExpiry, profession: c.profession };
      candidate.registrations.push(reg);
      candidate.eligible ||= isRegisteredRn(reg);
      if (c.qualifications && !candidate.qualifications.includes(c.qualifications)) candidate.qualifications += `\n${c.qualifications}`;
    }
  }
  for (const p of profiles) {
    p.candidates = [...found.get(p.id).values()];
    const eligible = p.candidates.filter(c => c.eligible);
    p.matchStatus = p.issues.length ? 'input_review' : !p.candidates.length ? 'no_register_match'
      : !eligible.length ? 'no_registered_rn_match' : eligible.length > 1 ? 'multiple_register_matches' : 'possible_register_match';
    p.verificationStatus = p.issues.length || !eligible.length ? 'not_queued' : 'pending_school_check';
  }
  return { registerRows, counts: Object.fromEntries([...new Set(profiles.map(p => p.matchStatus))].map(s => [s, profiles.filter(p => p.matchStatus === s).length])) };
}
