import test from "node:test";
import assert from "node:assert/strict";
import { rankProfileCandidates, scoreProfileCandidate } from "../src/identity-search.mjs";

test("reverse identity search disambiguates a LinkedIn profile with qualification evidence", () => {
  const candidates = [
    { id: 1, full_name: "Mrs Kalpana Shrestha", profession: "Nurse", state: "ACT", qualifications: "Bachelor of Science in Nursing, Rajiv Gandhi University" },
    { id: 2, full_name: "Ms Kalpana Shrestha", profession: "Nurse", state: "ACT", qualifications: "Bachelor of Science Nursing, Edith Cowan University" }
  ];
  const matches = rankProfileCandidates(candidates, {
    fullName: "kalpana shrestha", headline: "Registered Nurse", location: "Canberra ACT",
    education: "Rajiv Gandhi University of Health Sciences"
  });
  assert.equal(matches[0].candidateId, 1);
  assert.ok(matches[0].score > matches[1].score);
});

test("reverse identity search records interstate conflicts without discarding strong identity evidence", () => {
  const result = scoreProfileCandidate({ id: 3, full_name: "Miss Kara-Lyn Elizabeth Mcallister-Keane", state: "ACT",
    qualifications: "Bachelor of Nursing, University of New England" }, {
    fullName: "Kara-Lyn McAllister-Keane", currentTitle: "Registered Nurse", state: "NSW",
    education: "University of New England"
  });
  assert.ok(result.score >= 60);
  assert.deepEqual(result.conflicts, ["Profile state differs from licensed source"]);
});
