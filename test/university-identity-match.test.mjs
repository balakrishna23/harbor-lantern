import test from "node:test";
import assert from "node:assert/strict";
import { scoreIdentityMatch } from "../src/domain.mjs";

test("scoreIdentityMatch rewards Australian university match (+25 pts)", () => {
  const candidate = {
    full_name: "Miss Kirandeep Kaur",
    profession: "Nurse",
    state: "ACT",
    postcode: "2600",
    qualifications: "• Bachelor of Nursing, University of Canberra, Australia, 2025"
  };

  const match = scoreIdentityMatch(candidate, {
    fullName: "Kirandeep Kaur",
    profession: "Nurse",
    state: "ACT",
    university: "University of Canberra",
    location: "Canberra, ACT, Australia",
    linkedinUrl: "https://www.linkedin.com/in/kirandeep-kaur-1234"
  });

  assert.equal(match.confidence, "high");
  assert.ok(match.score >= 95);
  assert.ok(match.reasons.some(r => r.includes("University matches AHPRA licensed qualifications (University of Canberra)")));
  assert.ok(match.reasons.some(r => r.includes("Profile location confirmed in Australia")));
  assert.equal(match.conflicts.length, 0);
});

test("scoreIdentityMatch strictly rejects overseas profile location (e.g. India or USA)", () => {
  const candidate = {
    full_name: "Miss Prabhleen Kaur",
    profession: "Nurse",
    state: "ACT",
    qualifications: "• Master of Nursing Practice, Charles Darwin University, Australia, 2024"
  };

  const match = scoreIdentityMatch(candidate, {
    fullName: "Prabhleen Kaur",
    profession: "Nurse",
    location: "Punjab, India",
    linkedinUrl: "https://www.linkedin.com/in/prabhleen-kaur-india"
  });

  assert.equal(match.score, 0);
  assert.equal(match.confidence, "low");
  assert.ok(match.conflicts.some(c => c.includes("outside Australia")));
});

test("scoreIdentityMatch flags slug with conflicting first name on common surname", () => {
  const candidate = {
    full_name: "Miss Nimrat Kaur",
    profession: "Nurse",
    state: "ACT",
    qualifications: "• Bachelor of Nursing, University of Canberra, Australia, 2025"
  };

  const match = scoreIdentityMatch(candidate, {
    fullName: "Nimrat Kaur",
    profession: "Nurse",
    state: "ACT",
    linkedinUrl: "https://www.linkedin.com/in/simran-kaur-delhi"
  });

  assert.ok(match.conflicts.some(c => c.includes("first name differs")));
});
