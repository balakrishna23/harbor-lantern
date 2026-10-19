#!/usr/bin/env node
/**
 * Cross-checks an externally-sourced LinkedIn export (exports/linkdin compare
 * data.csv — first/last name + LinkedIn url/company per row) against the
 * full AHPRA candidate roster (the "9k sheet", i.e. the candidates table)
 * using the same namesMatch used everywhere else in the pipeline, to find
 * candidates the browser-agent pipeline missed or under-matched.
 *
 * Categorizes every compare-file row into:
 *  - already_have_this_url: we already have this exact LinkedIn URL attached
 *  - matched_missing_url: matched an AHPRA candidate, but our system has no
 *    linkedin_url for them at all — a real miss, worth reviewing/importing
 *  - matched_different_url: matched an AHPRA candidate who has a DIFFERENT
 *    linkedin_url attached — a discrepancy worth a human look
 *  - no_ahpra_match: no AHPRA candidate's name matches this row at all
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.mjs";
import { parseCsv } from "../src/csv.mjs";
import { namesMatch } from "../src/domain.mjs";

const comparePath = process.argv[2] || "exports/linkdin compare data.csv";
const text = fs.readFileSync(comparePath, "utf8");
const compareRows = parseCsv(text);

const candidates = db.prepare(`
  SELECT id, ahpra_number, full_name, state, suburb, postcode, profession,
         linkedin_url, identity_status, workflow_stage
  FROM candidates
`).all();

function compareFullName(row) {
  return [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" ").trim();
}

const results = { already_have_this_url: [], matched_missing_url: [], matched_different_url: [], no_ahpra_match: [] };

for (const row of compareRows) {
  const fullName = compareFullName(row);
  if (!fullName) continue;
  const matches = candidates.filter((c) => namesMatch(c.full_name, fullName));

  if (!matches.length) {
    results.no_ahpra_match.push({ fullName, url: row.url, company: row.company_name, title: row.job_title, city: row.city });
    continue;
  }

  for (const candidate of matches) {
    const entry = {
      compareFullName: fullName,
      compareUrl: row.url,
      compareCompany: row.company_name,
      compareTitle: row.job_title,
      compareCity: row.city,
      candidateId: candidate.id,
      ahpraNumber: candidate.ahpra_number,
      candidateFullName: candidate.full_name,
      candidateState: candidate.state,
      candidateSuburb: candidate.suburb,
      existingUrl: candidate.linkedin_url,
      identityStatus: candidate.identity_status,
      workflowStage: candidate.workflow_stage
    };
    if (!candidate.linkedin_url) {
      results.matched_missing_url.push(entry);
    } else if (candidate.linkedin_url === row.url) {
      results.already_have_this_url.push(entry);
    } else {
      results.matched_different_url.push(entry);
    }
  }
}

console.log("===============================================================");
console.log("  LinkedIn compare-file cross-check");
console.log("===============================================================");
console.log(`Compare file rows: ${compareRows.length}`);
console.log(`Already have this exact URL: ${results.already_have_this_url.length}`);
console.log(`Matched AHPRA candidate, but WE'RE MISSING their URL: ${results.matched_missing_url.length}`);
console.log(`Matched AHPRA candidate, but URL DIFFERS from ours: ${results.matched_different_url.length}`);
console.log(`No AHPRA candidate name-matches this row at all: ${results.no_ahpra_match.length}`);
console.log("===============================================================\n");

if (results.matched_missing_url.length) {
  console.log("--- MISSING (matched an AHPRA candidate, no LinkedIn URL on file) ---");
  for (const r of results.matched_missing_url) {
    console.log(`#${r.candidateId} ${r.candidateFullName} (${r.candidateState}, AHPRA ${r.ahpraNumber}, stage=${r.workflowStage}) <- compare row "${r.compareFullName}" ${r.compareUrl} @ ${r.compareCompany}`);
  }
  console.log("");
}

if (results.matched_different_url.length) {
  console.log("--- DIFFERS (matched an AHPRA candidate, but we have a different URL) ---");
  for (const r of results.matched_different_url) {
    console.log(`#${r.candidateId} ${r.candidateFullName} (${r.candidateState}) ours=${r.existingUrl} vs compare=${r.compareUrl}`);
  }
  console.log("");
}

const outPath = path.resolve("exports/linkedin_compare_crosscheck_results.json");
fs.writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
console.log(`Full results written to ${outPath}`);
process.exit(0);
