import test from "node:test";
import assert from "node:assert/strict";
import { parseCandidateQualifications, primaryAustralianQualification, matchInstitutionDomain } from "../src/qualification-parser.mjs";
import { buildSalesNavigatorQueries } from "../src/browser-agent.mjs";

test("parseCandidateQualifications accurately parses degrees, institutions, years and AU domains", () => {
  const raw = "• Doctor of Medicine, University of Wollongong, Australia, 2021 • Bachelor of Nursing, Charles Sturt University, Australia, 2009";
  const parsed = parseCandidateQualifications(raw);

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].degree, "Doctor of Medicine");
  assert.equal(parsed[0].institution, "University of Wollongong");
  assert.equal(parsed[0].domain, "uow.edu.au");
  assert.equal(parsed[0].year, 2021);
  assert.equal(parsed[0].isAustralian, true);

  assert.equal(parsed[1].degree, "Bachelor of Nursing");
  assert.equal(parsed[1].institution, "Charles Sturt University");
  assert.equal(parsed[1].domain, "csu.edu.au");
  assert.equal(parsed[1].year, 2009);
  assert.equal(parsed[1].isAustralian, true);
});

test("primaryAustralianQualification prioritizes degree with recognized .edu.au domain", () => {
  const raw = "• Bachelor of Science in Nursing, Baba Farid University of Health Sciences, India, 2011 • Entry Program for Internationally Qualified Nurse Registered Nurse, Australian College of Nursing, Australia, 2015";
  const primary = primaryAustralianQualification(raw);

  assert.ok(primary);
  assert.equal(primary.institution, "Australian College of Nursing");
  assert.equal(primary.domain, "acn.edu.au");
  assert.equal(primary.isAustralian, true);
});

test("matchInstitutionDomain handles University of Canberra, ACU, and CIT", () => {
  assert.equal(matchInstitutionDomain("University of Canberra")?.domain, "canberra.edu.au");
  assert.equal(matchInstitutionDomain("Australian Catholic University")?.domain, "acu.edu.au");
  assert.equal(matchInstitutionDomain("CIT (Canberra Institute of Technology)")?.domain, "cit.edu.au");
});

test("parseCandidateQualifications treats AHPRA's placeholder institution values as no institution on file", () => {
  // Live incident: candidate #113 Alice Barbara Wexford's AHPRA record has
  // "Other Not Recognised" as the literal institution field (meaning the
  // registrar didn't capture one) — this was being typed verbatim into
  // Sales Navigator search queries ("Alice Barbara Wexford Other Not
  // Recognised"), a useless/gibberish query. 24 candidates total carry one
  // of these placeholders ("UNKNOWN" x19, "Institute Unknown" x4, "Other
  // Not Recognised" x1). The qualification itself is still a real,
  // isAustralian: true nursing degree — only the bogus institution name is
  // dropped.
  for (const placeholder of ["UNKNOWN", "Institute Unknown", "Other Not Recognised"]) {
    const raw = `Bachelor of Nursing, ${placeholder}, Australia, 2010`;
    const [parsed] = parseCandidateQualifications(raw);
    assert.equal(parsed.institution, null, `expected null institution for "${placeholder}"`);
    assert.equal(parsed.isAustralian, true);
  }
});

test("buildSalesNavigatorQueries does not append a placeholder institution to the search query", () => {
  const candidate = {
    full_name: "Miss Alice Barbara Wexford",
    suburb: "GARRAN",
    state: "ACT",
    qualifications: "• Bachelor of Nursing, Other Not Recognised, Australia, 2010"
  };
  const queries = buildSalesNavigatorQueries(candidate);
  assert.deepEqual(queries, ["Alice Wexford", "Alice Barbara Wexford", "Alice Wexford GARRAN"]);
  queries.forEach((q) => assert.ok(!/not recognised|unknown/i.test(q), `query "${q}" should not contain placeholder text`));
});
