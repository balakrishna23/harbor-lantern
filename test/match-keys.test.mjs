import test from "node:test";
import assert from "node:assert/strict";
import { inferInstitutionState } from "../src/institution-state.mjs";
import { nameKey, fullNameKey, buildNameCounts, deriveMatchKeys, uniquenessBand, priorityTier } from "../src/match-keys.mjs";

test("infers state from single-state institutions", () => {
  assert.equal(inferInstitutionState("University of Technology Sydney").state, "NSW");
  assert.equal(inferInstitutionState("Curtin University of Technology").state, "WA");
  assert.equal(inferInstitutionState("TAFE Queensland Gold Coast").state, "QLD");
  assert.equal(inferInstitutionState("Victoria University Polytechnic").state, "VIC");
});

test("does not tie multi-state providers to one state", () => {
  const acu = inferInstitutionState("Australian Catholic University");
  assert.equal(acu.known, true);
  assert.equal(acu.state, null);
  assert.equal(inferInstitutionState("University of Notre Dame Australia").state, null);
});

test("never matches a bare word like 'Education' to a longer institution", () => {
  const r = inferInstitutionState("Education");
  assert.equal(r.known, false);
  assert.equal(r.state, null);
});

test("keeps University of Sydney and University of Technology Sydney apart", () => {
  assert.equal(inferInstitutionState("University of Sydney").key, "university of sydney");
  assert.equal(inferInstitutionState("University of Technology Sydney").key, "university of technology sydney");
});

test("builds name keys, ignoring case and honorifics", () => {
  assert.equal(nameKey({ first_name: "Dr Alex", last_name: "Example-Smith" }), "alex|example smith");
  assert.equal(fullNameKey({ first_name: "Alex", middle_name: "Jo", last_name: "Example" }), "alex|jo|example");
  assert.equal(nameKey({ first_name: "Alex", last_name: "" }), null);
});

test("bands and tiers name uniqueness", () => {
  assert.equal(uniquenessBand(1), "unique");
  assert.equal(uniquenessBand(3), "rare");
  assert.equal(uniquenessBand(4), "common");
  assert.equal(priorityTier("unique", true), 1);
  assert.equal(priorityTier("unique", false), 2);
  assert.equal(priorityTier("rare", true), 3);
  assert.equal(priorityTier("common", true), 4);
  assert.equal(priorityTier("common", false), 5);
});

test("derives match keys from a register row", () => {
  const rows = [
    { id: 1, first_name: "Alex", middle_name: "", last_name: "Example", qualifications: "• Bachelor of Nursing, University of Technology Sydney, Australia, 2014", state: "Alex" },
    { id: 2, first_name: "Sam", middle_name: "Lee", last_name: "Sample", qualifications: "• General Nursing, Example College, India, 2009" },
    { id: 3, first_name: "Sam", middle_name: "Kai", last_name: "Sample", qualifications: "" }
  ];
  const counts = buildNameCounts(rows);
  const a = deriveMatchKeys(rows[0], counts);
  assert.equal(a.uniqueness, "unique");
  assert.equal(a.tier, 1);
  assert.equal(a.inferredState, "NSW");
  assert.equal(a.gradYear, 2014);
  assert.equal(a.registerState, null, "a first name in the State column is not a state");
  assert.equal(a.overseasTrained, false);

  const b = deriveMatchKeys(rows[1], counts);
  assert.equal(b.nameCount, 2);
  assert.equal(b.uniqueness, "unique", "a distinct middle name rescues a shared first+last name");
  assert.equal(b.overseasTrained, true);
  assert.equal(b.qualificationCountry, "India");
});

test("a country in the institution slot is not treated as an institution", () => {
  const counts = buildNameCounts([{ first_name: "Alex", last_name: "Example" }]);
  const k = deriveMatchKeys({ first_name: "Alex", last_name: "Example", qualifications: "• General, Australia, 1985" }, counts);
  assert.equal(k.institution, null);
  assert.equal(k.inferredState, null);
  assert.equal(k.gradYear, null);
});

test("nurses registered under a single name still get a key", () => {
  assert.equal(nameKey({ first_name: "", last_name: "Example" }), "-|example");
});
