import test from "node:test";
import assert from "node:assert/strict";
import { verifyIdentity, isNursingTitle } from "../src/verifier.mjs";
import { emptyPerson } from "../src/providers/provider-contract.mjs";

const nurse = {
  full_name: "Alex Jo Example", first_name: "Alex", middle_name: "Jo", last_name: "Example",
  qualifications: "• Bachelor of Nursing, University of Technology Sydney, Australia, 2014"
};
const keys = (uniqueness) => ({ uniqueness, institution: "University of Technology Sydney", gradYear: 2014 });
const match = (person, likelihood = 7) => ({ status: "match", likelihood, person: { ...emptyPerson(), ...person } });

test("recognises nursing titles and rejects recruiters", () => {
  assert.equal(isNursingTitle("Registered Nurse - ICU"), true);
  assert.equal(isNursingTitle("Clinical Nurse Consultant"), true);
  assert.equal(isNursingTitle("Nurse Recruiter"), false);
  assert.equal(isNursingTitle("Software Engineer"), false);
});

test("accepts a unique-name nurse in Australia with a nursing title", () => {
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse" }));
  assert.equal(r.decision, "accept");
  assert.ok(r.score >= 70);
});

test("accepts a common-name nurse only when the school matches", () => {
  const withSchool = verifyIdentity(nurse, keys("common"), match({
    fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse",
    education: [{ school: "University of Technology Sydney", endYear: 2014, degrees: [] }]
  }));
  assert.equal(withSchool.decision, "accept");
  assert.equal(withSchool.signals.yearMatch, true);

  const titleOnly = verifyIdentity(nurse, keys("common"), match({ fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse" }));
  assert.equal(titleOnly.decision, "review");
});

test("rejects an overseas namesake even with matching name and title", () => {
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", country: "india", currentTitle: "Staff Nurse" }));
  assert.equal(r.decision, "reject");
  assert.ok(r.conflicts.some((c) => /outside Australia/.test(c)));
});

test("rejects a different name", () => {
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Sam Sample", country: "australia", currentTitle: "Registered Nurse" }));
  assert.equal(r.decision, "reject");
});

test("sends conflicting middle name or graduation year to review, never accept", () => {
  const middle = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", middleName: "Kai", country: "australia", currentTitle: "Registered Nurse" }));
  assert.notEqual(middle.decision, "accept");
  const year = verifyIdentity(nurse, keys("unique"), match({
    fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse",
    education: [{ school: "University of Technology Sydney", endYear: 2003, degrees: [] }]
  }));
  assert.notEqual(year.decision, "accept");
  assert.ok(year.conflicts.some((c) => /Graduation year/.test(c)));
});

test("does not accept without proof of Australia", () => {
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", currentTitle: "Registered Nurse" }));
  assert.equal(r.decision, "review");
});

test("does not confuse University of Sydney with University of Technology Sydney", () => {
  const r = verifyIdentity(nurse, keys("common"), match({
    fullName: "Alex Example", country: "australia",
    education: [{ school: "University of Sydney", endYear: 2014, degrees: [] }]
  }));
  assert.equal(r.signals.schoolMatch, false);
});

test("a provider no-match is a reject with a reason", () => {
  const r = verifyIdentity(nurse, keys("unique"), { status: "no_match", person: null });
  assert.equal(r.decision, "reject");
});

test("support roles are not treated as registered-nurse evidence", () => {
  assert.equal(isNursingTitle("Assistant in Nursing"), false);
  assert.equal(isNursingTitle("Certified Nursing Assistant"), false);
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", country: "australia", currentTitle: "Assistant in Nursing" }));
  assert.notEqual(r.decision, "accept");
});

test("a LinkedIn address with neither name blocks auto-accept", async () => {
  const { slugConflictsWithName } = await import("../src/verifier.mjs");
  assert.equal(slugConflictsWithName("Alex", "Example", "https://www.linkedin.com/in/alex-example-rn"), false);
  assert.equal(slugConflictsWithName("Alex", "Example", "https://www.linkedin.com/in/sam-sample-123"), true);
  const r = verifyIdentity(nurse, keys("unique"), match({ fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse", linkedinUrl: "https://www.linkedin.com/in/sam-sample-123" }));
  assert.notEqual(r.decision, "accept");
});

test("a second course at the same school does not create a graduation-year conflict", () => {
  const r = verifyIdentity(nurse, keys("unique"), match({
    fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse",
    education: [
      { school: "University of Technology Sydney", endYear: 2014, degrees: ["bachelors"] },
      { school: "University of Technology Sydney", endYear: 2020, degrees: ["masters"] }
    ]
  }));
  assert.equal(r.decision, "accept");
  assert.equal(r.conflicts.length, 0);
});
