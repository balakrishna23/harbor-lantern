/**
 * Qualification & University Parser
 * Parses raw AHPRA qualification strings into structured academic entities with
 * verified Australian university domain mappings.
 */

export const AU_INSTITUTION_DOMAINS = {
  "university of canberra": { name: "University of Canberra", domain: "canberra.edu.au", state: "ACT", isAu: true },
  "canberra institute of technology": { name: "Canberra Institute of Technology", domain: "cit.edu.au", state: "ACT", isAu: true },
  "cit": { name: "Canberra Institute of Technology", domain: "cit.edu.au", state: "ACT", isAu: true },
  "australian national university": { name: "Australian National University", domain: "anu.edu.au", state: "ACT", isAu: true },
  "australian catholic university": { name: "Australian Catholic University", domain: "acu.edu.au", state: "ACT", isAu: true },
  "charles sturt university": { name: "Charles Sturt University", domain: "csu.edu.au", state: "NSW", isAu: true },
  "university of wollongong": { name: "University of Wollongong", domain: "uow.edu.au", state: "NSW", isAu: true },
  "university of technology sydney": { name: "University of Technology Sydney", domain: "uts.edu.au", state: "NSW", isAu: true },
  "western sydney university": { name: "Western Sydney University", domain: "westernsydney.edu.au", state: "NSW", isAu: true },
  "university of western sydney": { name: "Western Sydney University", domain: "westernsydney.edu.au", state: "NSW", isAu: true },
  "university of sydney": { name: "University of Sydney", domain: "sydney.edu.au", state: "NSW", isAu: true },
  "university of newcastle": { name: "University of Newcastle", domain: "newcastle.edu.au", state: "NSW", isAu: true },
  "university of new england": { name: "University of New England", domain: "une.edu.au", state: "NSW", isAu: true },
  "tafe nsw": { name: "TAFE NSW", domain: "tafensw.edu.au", state: "NSW", isAu: true },
  "charles darwin university": { name: "Charles Darwin University", domain: "cdu.edu.au", state: "NT", isAu: true },
  "deakin university": { name: "Deakin University", domain: "deakin.edu.au", state: "VIC", isAu: true },
  "flinders university": { name: "Flinders University", domain: "flinders.edu.au", state: "SA", isAu: true },
  "la trobe university": { name: "La Trobe University", domain: "latrobe.edu.au", state: "VIC", isAu: true },
  "monash university": { name: "Monash University", domain: "monash.edu.au", state: "VIC", isAu: true },
  "university of melbourne": { name: "University of Melbourne", domain: "unimelb.edu.au", state: "VIC", isAu: true },
  "university of tasmania": { name: "University of Tasmania", domain: "utas.edu.au", state: "TAS", isAu: true },
  "university of south australia": { name: "University of South Australia", domain: "unisa.edu.au", state: "SA", isAu: true },
  "queensland university of technology": { name: "Queensland University of Technology", domain: "qut.edu.au", state: "QLD", isAu: true },
  "university of queensland": { name: "University of Queensland", domain: "uq.edu.au", state: "QLD", isAu: true },
  "griffith university": { name: "Griffith University", domain: "griffith.edu.au", state: "QLD", isAu: true },
  "edith cowan university": { name: "Edith Cowan University", domain: "ecu.edu.au", state: "WA", isAu: true },
  "holmesglen institute": { name: "Holmesglen Institute", domain: "holmesglen.edu.au", state: "VIC", isAu: true },
  "australian college of nursing": { name: "Australian College of Nursing", domain: "acn.edu.au", state: "NSW", isAu: true },
  "institute of health and nursing australia": { name: "Institute of Health and Nursing Australia", domain: "ihna.edu.au", state: "VIC", isAu: true },
  "ihna": { name: "Institute of Health and Nursing Australia", domain: "ihna.edu.au", state: "VIC", isAu: true },
  "institute of health and management": { name: "Institute of Health and Management", domain: "ihm.edu.au", state: "VIC", isAu: true },
  "ihm": { name: "Institute of Health and Management", domain: "ihm.edu.au", state: "VIC", isAu: true }
};

export function matchInstitutionDomain(instName) {
  if (!instName) return null;
  const clean = String(instName).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  // Forward match: the source names a known institution ("Curtin University
  // of Technology" contains "curtin"...). The reverse match (a short source
  // string contained in a known name) is only allowed for 3+ word strings:
  // AHPRA often puts just a country or a generic word where the institution
  // belongs ("General, Australia, 1985"), and "australia" used to resolve to
  // "Australian National University" for ~32,000 nurses.
  const allowReverse = clean.split(" ").filter(Boolean).length >= 3;
  for (const [key, val] of Object.entries(AU_INSTITUTION_DOMAINS)) {
    if (key.length >= 4 ? ` ${clean} `.includes(` ${key} `) : clean === key) return val;
    if (allowReverse && key.includes(clean)) return val;
  }
  return null;
}

export function parseCandidateQualifications(rawQual) {
  if (!rawQual) return [];
  const entries = String(rawQual)
    .split(/[•\n\r]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const parsed = [];

  for (const entry of entries) {
    const parts = entry.split(",").map((p) => p.trim());
    if (parts.length < 2) {
      parsed.push({
        raw: entry,
        degree: entry,
        institution: null,
        country: null,
        year: null,
        isAustralian: false,
        domain: null
      });
      continue;
    }

    const degree = parts[0];
    const institution = parts[1];
    let country = null;
    let year = null;

    for (let i = 2; i < parts.length; i++) {
      const p = parts[i];
      const yearMatch = p.match(/\b(19\d\d|20\d\d)\b/);
      if (yearMatch) {
        year = Number(yearMatch[1]);
      } else if (!country && /^[A-Za-z\s()]+$/.test(p)) {
        country = p;
      }
    }

    const auMatch = matchInstitutionDomain(institution);
    const isAustralian = Boolean(
      auMatch?.isAu ||
      country?.toLowerCase() === "australia" ||
      /\baustralia\b/i.test(entry)
    );
    // AHPRA records an institution as a literal placeholder — "UNKNOWN",
    // "Institute Unknown", "Other Not Recognised" — when the registrar
    // didn't capture one, not as a real name. Confirmed live: this was
    // being typed verbatim into Sales Navigator search queries ("Alice
    // Barbara Wexford Other Not Recognised") and could equally have
    // polluted the university-corroboration check. Treated as "no
    // institution on file" instead of a real one, same as if the source
    // field had simply been blank.
    const isPlaceholderInstitution = /^(unknown|institute unknown|other( not recognised)?|not specified|n\/a|unspecified|not applicable)$/i.test((institution || "").trim());

    parsed.push({
      raw: entry,
      degree,
      institution: isPlaceholderInstitution ? null : (auMatch ? auMatch.name : institution),
      country: isAustralian ? "Australia" : (country || "Unknown"),
      year,
      isAustralian,
      domain: auMatch?.domain || null,
      state: auMatch?.state || null
    });
  }

  return parsed;
}

/**
 * Returns the primary Australian university/college qualification if available.
 */
export function primaryAustralianQualification(rawQual) {
  const all = parseCandidateQualifications(rawQual);
  // Prioritize degree with known Australian .edu.au domain
  const withDomain = all.find((q) => q.isAustralian && q.domain);
  if (withDomain) return withDomain;
  // Fall back to any Australian qualification
  const anyAu = all.find((q) => q.isAustralian);
  return anyAu || all[0] || null;
}
