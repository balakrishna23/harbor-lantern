import { AU_INSTITUTION_DOMAINS, parseCandidateQualifications } from './qualification-parser.mjs';
import { linkedinProfileUrl } from './location-sheet-match.mjs';
import { cleanPersonName, personNamesMatch } from './name-variants.mjs';

const normal = value => String(value || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&amp;|&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const placeholders = /^(unknown|institute unknown|other( not recognised)?|not specified|n a|unspecified|not applicable|education|nursing|general|australia)$/;
const EXTRA_ALIASES = {
  'nimhans': 'National Institute of Mental Health and Neurosciences',
  'kerala university of health and allied sciences': 'Kerala University of Health Sciences',
  'daemen university': 'Daemen College'
};
const aliases = new Map([
  ...Object.entries(AU_INSTITUTION_DOMAINS).flatMap(([alias, v]) => [[normal(alias), normal(v.name)], [normal(v.name), normal(v.name)]]),
  ...Object.entries(EXTRA_ALIASES).map(([alias, name]) => [normal(alias), normal(name)])
]);
export function schoolKey(value) {
  const key = normal(value);
  if (!key || placeholders.test(key) || key.split(' ').length < 2 && !aliases.has(key)) return null;
  return aliases.get(key) || key;
}

// Variant rules strip only presentation noise: brackets, campus/dash suffixes,
// a leading "The", trailing country/state and dates. A variant must keep a
// distinctive word, so "College of Nursing" alone can never match.
const TOKEN_FORMS = { st: 'saint', mt: 'mount', univ: 'university', uni: 'university' };
const REGIONS = ['australia', 'new zealand', 'nz', 'india', 'nepal', 'philippines', 'bhutan', 'england', 'scotland', 'wales', 'uk',
  'united kingdom', 'ireland', 'sri lanka', 'pakistan', 'bangladesh', 'china', 'zimbabwe', 'kenya', 'nigeria', 'ghana', 'usa', 'us',
  'united states', 'united states of america', 'canada', 'act', 'nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'nt', 'au', 'aus',
  'new south wales', 'queensland', 'tasmania', 'western australia', 'south australia', 'northern territory']
  .map(r => r.split(' ')).sort((a, b) => b.length - a.length);
const DIRECTIONAL = new Set(['north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'new', 'upper', 'lower']);
const GENERIC = new Set(['university', 'college', 'school', 'institute', 'of', 'the', 'and', 'for', 'in', 'nursing', 'health', 'sciences',
  'science', 'technology', 'hospital', 'medical', 'centre', 'center', 'tafe', 'education', 'polytechnic', 'academy', 'faculty',
  'department', 'campus', 'training', 'registered', 'nurse', 'nurses', 'general', 'studies', 'community', 'national', 'international',
  'royal', 'saint', 'further', 'higher', 'allied', 'medicine', 'midwifery', 'professional', 'australian', 'state', 'city', 'public']);
const DATE = /^(?:19|20)\d{2}$|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/;

function stripTrailingRegion(tokens) {
  for (const region of REGIONS) {
    const start = tokens.length - region.length;
    if (start >= 2 && region.every((t, i) => tokens[start + i] === t) && !DIRECTIONAL.has(tokens[start - 1])) {
      const rest = tokens.slice(0, start);
      while (rest.length && ['of', 'in', 'the'].includes(rest.at(-1))) rest.pop();
      return rest;
    }
  }
  return tokens;
}

/** All comparable keys for one written school name; the plain key comes first. */
export function schoolKeys(value) {
  const raw = String(value || '');
  const keys = new Set();
  const plain = schoolKey(raw);
  if (plain) keys.add(plain);
  const pieces = new Set([raw, raw.replace(/\([^)]*\)/g, ' '), ...[...raw.matchAll(/\(([^)]*)\)/g)].map(m => m[1])]);
  for (const piece of [...pieces]) {
    pieces.add(piece.split(/\s[-–—]\s|[–—]|,/)[0]);
    pieces.add(piece.split(/-(?=[A-Z])/)[0]);
  }
  for (const piece of pieces) {
    let tokens = normal(piece).split(' ').filter(Boolean).map(t => TOKEN_FORMS[t] || t);
    const dateAt = tokens.findIndex((t, i) => i >= 2 && DATE.test(t));
    if (dateAt > 0) tokens = tokens.slice(0, dateAt);
    if (tokens[0] === 'the') tokens = tokens.slice(1);
    tokens = stripTrailingRegion(tokens);
    const key = schoolKey(tokens.join(' '));
    if (key && (key === plain || key.split(' ').some(t => !GENERIC.has(t) && !DIRECTIONAL.has(t)))) keys.add(key);
  }
  return keys;
}

// Optimal string alignment distance capped at 2 (only "≤ 1" is ever used).
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[a.length][b.length];
}
/** One misspelt long word ("Eduaction", "Gyelpo", "Neuroscience/s"), never a
 * directional or short word, in names that otherwise agree word for word. */
function oneTypoApart(a, b) {
  const x = a.split(' '), y = b.split(' ');
  if (x.length !== y.length || a.length < 12) return false;
  const diff = x.map((t, i) => [t, y[i]]).filter(([s, t]) => s !== t);
  if (diff.length !== 1) return false;
  const [[s, t]] = diff;
  return s.length >= 5 && t.length >= 5 && !DIRECTIONAL.has(s) && !DIRECTIONAL.has(t) && !/\d/.test(s + t) && editDistance(s, t) <= 1;
}
/** 'exact' | 'variant' | 'typo' | null */
export function schoolMatch(profileKeys, registerKeys) {
  const [p0] = profileKeys, [r0] = registerKeys;
  if (p0 && p0 === r0) return 'exact';
  for (const k of profileKeys) if (registerKeys.has(k)) return 'variant';
  for (const k of profileKeys) for (const r of registerKeys) if (oneTypoApart(k, r)) return 'typo';
  return null;
}

export function registerSchools(qualifications) {
  return parseCandidateQualifications(qualifications).map(q => {
    // Read the source institution, avoiding broad substring canonicalisation.
    const institution = q.raw.replace(/^[•\s]+/, '').split(',')[1]?.trim();
    const keys = schoolKeys(institution);
    return { school: institution || '', key: [...keys][0] || null, keys, year: q.year, degree: q.degree };
  }).filter(q => q.key);
}

export function verifySchoolEvidence(profile, evidence) {
  const base = { status: 'manual_review', candidateId: null, checkedAt: evidence.checkedAt || new Date().toISOString(), evidence, checks: [] };
  if (profile.issues?.length) return { ...base, reason: profile.issues.join('; ') };
  if (linkedinProfileUrl(evidence.sourceUrl) !== profile.url) return { ...base, status: 'identity_conflict', reason: 'Education evidence belongs to another input URL' };
  if (evidence.status !== 'ok') return { ...base, status: evidence.status || 'education_unavailable', reason: evidence.reason || 'Profile education could not be read' };
  const eligible = profile.candidates.filter(c => c.eligible);
  if (!eligible.length) return { ...base, status: 'no_registered_rn_match', reason: 'No eligible registered nurse in the selected register extract' };
  if (!evidence.fullName || !personNamesMatch(profile.fullName, evidence.fullName)) return { ...base, status: 'identity_conflict', reason: 'Opened profile name does not match the spreadsheet' };
  const education = (evidence.education || []).map(e => ({ e, keys: schoolKeys(e.school) })).filter(x => x.keys.size);
  if (!education.length) return { ...base, status: 'education_unavailable', reason: 'No usable school visible in the education section' };
  const shownName = cleanPersonName(evidence.fullName);
  for (const candidate of eligible) {
    const schools = registerSchools(candidate.qualifications);
    const pairs = education.flatMap(({ e, keys }) => schools.flatMap(s => {
      const match = schoolMatch(keys, s.keys);
      if (!match) return [];
      const { keys: _, ...register } = s;
      return [{ register, profile: e, match }];
    }));
    const dated = pairs.filter(p => p.register.year && p.profile.endYear && Number.isFinite(Number(p.profile.endYear)));
    const yearConflict = dated.length > 0 && dated.every(p => Math.abs(p.register.year - Number(p.profile.endYear)) > 2);
    const middleTokens = value => cleanPersonName(value).split(' ').slice(1, -1);
    const regMiddle = middleTokens(candidate.fullName), profileMiddle = middleTokens(shownName);
    const middleConflict = regMiddle.length > 0 && regMiddle.length === profileMiddle.length && regMiddle.some((token, i) => token[0] !== profileMiddle[i][0]);
    const nameMatch = [candidate.fullName, candidate.alternativeName].filter(Boolean).some(n => personNamesMatch(n, evidence.fullName));
    base.checks.push({ candidateId: candidate.candidateId, schoolStatus: !schools.length ? 'register_school_unavailable' : pairs.length ? 'school_corroborated' : 'school_not_corroborated',
      nameMatch, middleConflict, yearConflict, pairs });
  }
  const corroborated = base.checks.filter(c => c.schoolStatus === 'school_corroborated');
  // A second candidate with missing register education cannot be eliminated by school evidence.
  const unknownCompetitor = base.checks.some(c => c.schoolStatus === 'register_school_unavailable');
  if (corroborated.length === 1 && !unknownCompetitor && corroborated[0].nameMatch && !corroborated[0].middleConflict && !corroborated[0].yearConflict) {
    return { ...base, status: 'confirmed', candidateId: corroborated[0].candidateId, reason: 'One registered RN has a matching name and school, with no recorded conflict' };
  }
  const status = corroborated.length > 1 || corroborated.length === 1 && unknownCompetitor ? 'ambiguous_identity'
    : corroborated.some(c => c.yearConflict || c.middleConflict || !c.nameMatch) ? 'education_conflict'
    : base.checks.every(c => c.schoolStatus === 'register_school_unavailable') ? 'register_school_unavailable' : 'school_not_corroborated';
  return { ...base, status, reason: status === 'school_not_corroborated' ? 'Visible schools do not corroborate the register; another qualification may be omitted' : 'Review the recorded candidate checks' };
}
