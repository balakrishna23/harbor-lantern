import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv } from "../src/csv.mjs";
import { normalizeCandidate, campaignEligibility, estimateCredits, scoreIdentityMatch, hasHardIdentityConflict, namesMatch } from "../src/domain.mjs";

test("parses quoted CSV fields and newlines", () => {
  const rows = parseCsv('Name,Qualifications\r\n"Alex Example","Bachelor, Nursing"\r\n');
  assert.equal(rows[0].Name, "Alex Example");
  assert.equal(rows[0].Qualifications, "Bachelor, Nursing");
});

test("normalizes AHPRA-shaped candidate records", () => {
  const c = normalizeCandidate({ "First name":"Alex", "Last name":"Example", Profession:"Nurse", State:"act", Postcode:"2600.0", Qualifications:"Bachelor of Nursing" });
  assert.equal(c.fullName, "Alex Example");
  assert.equal(c.state, "ACT");
  assert.equal(c.postcode, "2600");
  assert.equal(c.identityConfidence, 80);
});

test("requires all campaign controls", () => {
  const result = campaignEligibility({ registration_status:"Registered", identity_status:"confirmed", email_status:"valid", contact_basis_approved:1, suppressed:0, opted_out:0 });
  assert.equal(result.eligible, true);
  assert.equal(campaignEligibility({ registration_status:"Registered", identity_status:"confirmed", email_status:"valid", contact_basis_approved:1, suppressed:1, opted_out:0 }).eligible, false);
});

test("estimates enrichment credits", () => {
  assert.equal(estimateCredits(20,"identity",{identity:1,email:3,phone:9}),20);
  assert.equal(estimateCredits(20,"email",{email:3,phone:9}),60);
  assert.equal(estimateCredits(20,"email_phone",{email:3,phone:9}),240);
});

test("scores provider identity evidence without auto-confirming a person", () => {
  const candidate = { full_name: "Jane Smith", profession: "Nurse", state: "ACT", postcode: "2600", qualifications: "BN" };
  const strong = scoreIdentityMatch(candidate, {
    fullName: "Jane Smith", profession: "Nurse", postcode: "2600", qualifications: "BN",
    linkedinUrl: "https://linkedin.example/jane", employer: "Example Health", currentTitle: "RN"
  });
  assert.equal(strong.score, 100);
  assert.equal(strong.confidence, "high");
  assert.deepEqual(strong.conflicts, []);

  const conflict = scoreIdentityMatch(candidate, { fullName: "Someone Else", profession: "Doctor", state: "NSW" });
  assert.equal(conflict.confidence, "low");
  assert.equal(conflict.conflicts.length, 3);

  const suspiciousUrl = scoreIdentityMatch(candidate, { linkedinUrl: "https://www.linkedin.com/in/alex-jones-123" });
  assert.equal(suspiciousUrl.score, 5);
  assert.deepEqual(suspiciousUrl.conflicts, ["LinkedIn profile slug does not contain the candidate's first or last name"]);

  const titlelessName = scoreIdentityMatch({ ...candidate, full_name: "Dr Jane Smith" }, { fullName: "Jane Smith" });
  assert.equal(titlelessName.score, 40);
  assert.deepEqual(titlelessName.conflicts, []);

  const omittedMiddleNames = scoreIdentityMatch(
    { ...candidate, full_name: "Mrs Sophia Rose Michelle De Bellavista" },
    { fullName: "Sophia de bellavista" }
  );
  assert.equal(omittedMiddleNames.score, 40);
  assert.deepEqual(omittedMiddleNames.conflicts, []);

  const droppedLeadingToken = scoreIdentityMatch(
    { ...candidate, full_name: "Mergu Bala Krishna" },
    { fullName: "Bala Krishna" }
  );
  assert.equal(droppedLeadingToken.score, 40);
  assert.deepEqual(droppedLeadingToken.conflicts, []);

  const differentPersonSameSurname = scoreIdentityMatch(
    { ...candidate, full_name: "Ravneet Kaur" },
    { fullName: "Harleen Kaur" }
  );
  assert.ok(differentPersonSameSurname.conflicts.includes("Name differs from licensed source"));
});

test("namesMatch tolerates a dropped LEADING token without loosening into a same-surname-only match", () => {
  // Real user-reported case: AHPRA candidate "Mergu Bala Krishna" appears on
  // LinkedIn as "Bala Krishna" — the leading token is dropped, not a middle
  // one (the omittedMiddleNames case above already covers dropped middle
  // tokens). This must match, from either argument order.
  assert.equal(namesMatch("Mergu Bala Krishna", "Bala Krishna"), true);
  assert.equal(namesMatch("Bala Krishna", "Mergu Bala Krishna"), true);

  // Critical safety-regression test: two DIFFERENT real candidates sharing a
  // common surname must NOT match just because both are >=2 tokens ending
  // in the same surname — this dataset has dozens of repeated surnames
  // (Kaur, Singh, Kumar, Sharma...) and this exact false-positive category
  // ("Anushka Tamboli" namesake collision) has already been hit once.
  assert.equal(namesMatch("Ravneet Kaur", "Harleen Kaur"), false);
  assert.equal(namesMatch("Arshdeep Kaur Tarnowski", "Ravneet Kaur Tarnowski"), false);

  // A single bare token (even the shared surname) must never be enough on
  // its own to trigger a match.
  assert.equal(namesMatch("Krishna", "Mergu Bala Krishna"), false);

  // No reordering tolerance: dropping a token is fixed, scrambling is not.
  assert.equal(namesMatch("John Michael Smith", "Michael John Smith"), false);

  // Deliberately NOT supported: dropping a TRAILING token. In this
  // population "Kaur"/"Singh" function more like gender markers than
  // distinguishing surnames, so allowing the family name to be dropped
  // risks matching an unrelated same-first-name person.
  assert.equal(namesMatch("Arshdeep Kaur Tarnowski", "Arshdeep Kaur"), false);
});

test("a non-Australian phone returned alongside identity evidence hard-rejects the match", () => {
  const candidate = { full_name: "Jane Smith", profession: "Nurse", state: "ACT", postcode: "2600", qualifications: "BN" };
  // Same strong evidence as the "scores provider identity evidence" case above,
  // which alone would score 100/high — but a foreign phone number returned
  // alongside it is the signature of an overseas namesake (see the AHPRA
  // dossier's 37 demoted namesakes, all of which surfaced a non-AU phone).
  const result = scoreIdentityMatch(candidate, {
    fullName: "Jane Smith", profession: "Nurse", postcode: "2600", qualifications: "BN",
    linkedinUrl: "https://linkedin.example/jane", employer: "Example Health", currentTitle: "RN",
    mobilePhone: "+15128209742"
  });
  assert.equal(result.score, 0);
  assert.equal(result.confidence, "low");
  assert.ok(result.conflicts.some((c) => c.includes("is not an Australian number")));
});

test("an Australian phone returned alongside identity evidence does not conflict", () => {
  const candidate = { full_name: "Jane Smith", profession: "Nurse", state: "ACT", postcode: "2600", qualifications: "BN" };
  const result = scoreIdentityMatch(candidate, {
    fullName: "Jane Smith", profession: "Nurse", postcode: "2600", qualifications: "BN",
    linkedinUrl: "https://linkedin.example/jane", employer: "Example Health", currentTitle: "RN",
    mobilePhone: "+61412345678"
  });
  assert.equal(result.score, 100);
  assert.deepEqual(result.conflicts, []);
});

test("graduation year matching the AHPRA qualification year adds evidence", () => {
  const candidate = {
    full_name: "Jane Smith", profession: "Nurse", state: "ACT", postcode: "2600",
    qualifications: "Bachelor of Nursing, University of Canberra, Australia, 2018"
  };
  const matching = scoreIdentityMatch(candidate, { fullName: "Jane Smith", graduationYear: "2019" });
  assert.ok(matching.reasons.some((r) => r.includes("Graduation year")));
  assert.deepEqual(matching.conflicts, []);

  const mismatched = scoreIdentityMatch(candidate, { fullName: "Jane Smith", graduationYear: "2009" });
  assert.ok(mismatched.conflicts.some((c) => c.includes("Graduation year")));
});

test("hasHardIdentityConflict recognizes recorded overseas/phone/demotion conflicts in either storage shape", () => {
  // Shape produced by scoreIdentityMatch's own conflicts array (plain strings)
  assert.equal(hasHardIdentityConflict({
    conflicting_evidence: JSON.stringify(["Profile location (India) is outside Australia"])
  }), true);
  assert.equal(hasHardIdentityConflict({
    conflicting_evidence: JSON.stringify(["Returned phone number (+15128209742) is not an Australian number"])
  }), true);
  // Shape produced by the manual demotion script and the enrichment.mjs safety net (objects)
  assert.equal(hasHardIdentityConflict({
    conflicting_evidence: JSON.stringify([{ type: "overseas_mismatch", reason: "foreign entity" }])
  }), true);
  assert.equal(hasHardIdentityConflict({
    conflicting_evidence: JSON.stringify([{ type: "foreign_contact_discovered", quarantinedPhone: "+447855064390" }])
  }), true);
  // A weak/ordinary conflict (e.g. name differs) is not a hard conflict
  assert.equal(hasHardIdentityConflict({
    conflicting_evidence: JSON.stringify(["Name differs from licensed source"])
  }), false);
  assert.equal(hasHardIdentityConflict({ conflicting_evidence: null }), false);
  assert.equal(hasHardIdentityConflict({ conflicting_evidence: "not json" }), false);
  assert.equal(hasHardIdentityConflict({}), false);
});

test("CSV output escapes commas", () => {
  assert.equal(toCsv([{name:"Example, Alex"}],["name"]), 'name\r\n"Example, Alex"');
});

test("CSV output neutralizes spreadsheet formulas", () => {
  const csv = toCsv([{ name: "=HYPERLINK(\"https://evil.test\")", phone: "+612345678" }], ["name", "phone"]);
  assert.match(csv, /'=HYPERLINK/);
  assert.match(csv, /'\+612345678/);
});

test("malformed quoted CSV is rejected", () => {
  assert.throws(() => parseCsv('name\r\n"unterminated'), /Malformed CSV/);
});

test("identity thresholds are configurable", () => {
  const candidate = { full_name: "Jane Smith", profession: "Nurse" };
  const result = scoreIdentityMatch(candidate, { fullName: "Jane Smith", profession: "Nurse", linkedinUrl: "https://example.test" }, { high: 90, manual: 50 });
  assert.equal(result.score, 75);
  assert.equal(result.confidence, "medium");
});

test("a bare country in the institution slot does not resolve to a university", async () => {
  const { matchInstitutionDomain, parseCandidateQualifications } = await import("../src/qualification-parser.mjs");
  assert.equal(matchInstitutionDomain("Australia"), null);
  assert.equal(matchInstitutionDomain("Curtin"), null);
  assert.equal(matchInstitutionDomain("University of Canberra")?.domain, "canberra.edu.au");
  assert.equal(matchInstitutionDomain("Canberra Institute of Technology (CIT)")?.domain, "cit.edu.au");
  const [q] = parseCandidateQualifications("• General, Australia, 1985");
  assert.notEqual(q.institution, "Australian National University");
});
