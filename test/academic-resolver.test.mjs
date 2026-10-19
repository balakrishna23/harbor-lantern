import test from "node:test";
import assert from "node:assert/strict";
import { buildAcademicSearchQueries, scoreAcademicEvidence } from "../src/academic-resolver.mjs";

test("buildAcademicSearchQueries creates targeted .edu.au domain queries for candidate", () => {
  const candidate = {
    full_name: "Miss Kirandeep Kaur",
    qualifications: "• Bachelor of Nursing, University of Canberra, Australia, 2025"
  };

  const { cleanName, primaryQual, queries } = buildAcademicSearchQueries(candidate);

  assert.equal(cleanName, "Kirandeep Kaur");
  assert.equal(primaryQual.domain, "canberra.edu.au");
  assert.equal(queries[0].type, "university_domain");
  assert.equal(queries[0].query, 'site:canberra.edu.au "Kirandeep Kaur"');
  assert.equal(queries[1].query, 'site:canberra.edu.au "Kirandeep Kaur" "Bachelor of Nursing"');
});

test("scoreAcademicEvidence scores 100 for candidate match on official university domain", () => {
  const candidate = {
    full_name: "Dr Alexandra Kelly Tolhurst",
    qualifications: "• Doctor of Medicine, University of Wollongong, Australia, 2021"
  };
  const primaryQual = {
    domain: "uow.edu.au",
    institution: "University of Wollongong"
  };
  const searchResults = [
    {
      url: "https://www.uow.edu.au/graduation/ceremony-programs/alexandra-tolhurst",
      snippet: "Alexandra Tolhurst graduated with Doctor of Medicine from University of Wollongong."
    }
  ];

  const score = scoreAcademicEvidence(candidate, searchResults, primaryQual);

  assert.equal(score.academicMatchScore, 100);
  assert.equal(score.isAcademicVerified, true);
  assert.equal(score.verifiedUrls.length, 1);
});

test("scoreAcademicEvidence ignores non-matching names", () => {
  const candidate = {
    full_name: "Miss Aimee Lindqvist",
    qualifications: "• Bachelor of Nursing, Charles Sturt University, Australia, 2018"
  };
  const primaryQual = { domain: "csu.edu.au" };
  const searchResults = [
    {
      url: "https://www.csu.edu.au/courses/nursing",
      snippet: "Study Bachelor of Nursing at Charles Sturt University."
    }
  ];

  const score = scoreAcademicEvidence(candidate, searchResults, primaryQual);
  assert.equal(score.academicMatchScore, 0);
  assert.equal(score.isAcademicVerified, false);
});
