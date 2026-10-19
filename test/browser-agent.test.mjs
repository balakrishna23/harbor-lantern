import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import {
  normalizeBrowserLead, recordBrowserLead, applyBrowserLeadDecision, buildSalesNavigatorQueries,
  rankCandidateCards, hasUniversityCorroborationInText, isHealthcareRole, isAustralianLocation,
  classifySearchPage, urlHasKeywords
} from "../src/browser-agent.mjs";
import { buildPostcodeIndex } from "../src/au-location.mjs";

function setupTestDb() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec(`
    INSERT INTO imports (id, filename, file_hash) VALUES (1, 'test.csv', 'hash123');
    INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, first_name, last_name,
      profession, state, postcode, qualifications, registration_status, workflow_stage)
    VALUES (1, 1, 1, 'h1', 'Dr Brynlee Anne Gallister', 'Brynlee', 'Gallister', 'Nurse', 'ACT', '2617',
      'Bachelor of Nursing, University of Canberra, Australia, 2018', 'Registered', 'claiming_browser_discovery');
  `);
  return db;
}

test("normalizeBrowserLead maps a raw Sales Navigator find into the scoreIdentityMatch result shape", () => {
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-12345",
    name: " Brynlee Gallister ",
    headline: "Registered Nurse",
    company: "Canberra Health Services",
    location: "Canberra, Australia",
    educationSnippet: "University of Canberra — Bachelor of Nursing"
  });
  assert.equal(normalized.fullName, "Brynlee Gallister");
  assert.equal(normalized.linkedinUrl, "https://www.linkedin.com/in/brynlee-gallister-12345");
  assert.equal(normalized.employer, "Canberra Health Services");
  assert.equal(normalized.currentTitle, "Registered Nurse");
});

test("buildSalesNavigatorQueries tiers First Last, full name, then name+location, then name+university", () => {
  // "First Last" comes first: LinkedIn keyword search requires every word and
  // most people don't show middle names (live test 2026-10-13: full name
  // found 0/20 middle-name nurses, "First Last" surfaced 10/20).
  const candidate = {
    full_name: "Dr Brynlee Anne Gallister",
    suburb: "Bruce",
    state: "ACT",
    qualifications: "Bachelor of Nursing, University of Canberra, Australia, 2018"
  };
  const queries = buildSalesNavigatorQueries(candidate);
  assert.deepEqual(queries, [
    "Brynlee Gallister",
    "Brynlee Anne Gallister",
    "Brynlee Gallister Bruce",
    "Brynlee Gallister University of Canberra"
  ]);
});

test("buildSalesNavigatorQueries prefers the register's first/last name fields and strips every honorific", () => {
  assert.deepEqual(
    buildSalesNavigatorQueries({ full_name: "Assoc Prof Chelsea Amber Mallinson", first_name: "Chelsea", last_name: "Mallinson" }),
    ["Chelsea Mallinson", "Chelsea Amber Mallinson"]
  );
  assert.deepEqual(buildSalesNavigatorQueries({ full_name: "Lady Tamsin Dawn Ormond-Marsh" }),
    ["Tamsin Ormond-Marsh", "Tamsin Dawn Ormond-Marsh"]);
  // No location in the source (national register) → no location tier.
  assert.deepEqual(buildSalesNavigatorQueries({ full_name: "Jane Citizen", first_name: "Jane", last_name: "Citizen" }), ["Jane Citizen"]);
});

test("isHealthcareRole accepts healthcare titles/employers and rejects recruiters and other fields", () => {
  assert.equal(isHealthcareRole("Registered Nurse", ""), true);
  assert.equal(isHealthcareRole("Clinical Nurse Consultant", "Canberra Health Services"), true);
  assert.equal(isHealthcareRole("Team Leader", "Canberra Health Services"), true);
  assert.equal(isHealthcareRole("Midwife", ""), true);
  assert.equal(isHealthcareRole("Senior Test Analyst", "Australian Retirement Trust"), false);
  assert.equal(isHealthcareRole("Recruitment Consultant - Nursing", "Healthcare Recruiters"), false);
  assert.equal(isHealthcareRole("Software Engineer", "Health Tech Co"), false);
  assert.equal(isHealthcareRole("", ""), false);
});

test("isAustralianLocation requires a positive Australian location and rejects look-alikes", () => {
  assert.equal(isAustralianLocation("Canberra, Australian Capital Territory, Australia"), true);
  assert.equal(isAustralianLocation("Greater Sydney Area"), true);
  assert.equal(isAustralianLocation("Wagga Wagga, New South Wales, Australia"), true);
  assert.equal(isAustralianLocation("Greater Philadelphia"), false);
  assert.equal(isAustralianLocation("Victoria, British Columbia, Canada"), false);
  assert.equal(isAustralianLocation("Perth, Scotland, United Kingdom"), false);
  assert.equal(isAustralianLocation("Ernakulam, Kerala, India"), false);
  assert.equal(isAustralianLocation(""), false);
});

test("classifySearchPage treats LinkedIn's out-of-filter suggestions as an empty result, and an unloaded page as unknown", () => {
  // Live 2026-10-13: with Geography=Australia and no Australian match, Sales
  // Navigator shows "No matches found" and then lists overseas people under
  // "22 LEADS AVAILABLE IF YOU REMOVE THE REGION FILTER" — not real results.
  assert.equal(classifySearchPage({ bodyText: "No matches found Remove the Region filter... 22 LEADS AVAILABLE IF YOU REMOVE THE REGION FILTER", leadLinkCount: 6 }), "empty");
  assert.equal(classifySearchPage({ bodyText: "0 results No leads matched your search", leadLinkCount: 0 }), "empty");
  assert.equal(classifySearchPage({ bodyText: "3 results", leadLinkCount: 3 }), "results");
  assert.equal(classifySearchPage({ bodyText: "HTTP ERROR 429", leadLinkCount: 0 }), "rate_limited");
  // Neither results nor a recognised empty-state: must NOT be read as "not found".
  assert.equal(classifySearchPage({ bodyText: "Loading...", leadLinkCount: 0 }), "pending");
});

test("urlHasKeywords matches the double-encoded keywords Sales Navigator puts in the URL", () => {
  const url = "https://www.linkedin.com/sales/search/people?query=(spellCorrectionEnabled%3Atrue%2Cfilters%3AList((type%3AREGION))%2Ckeywords%3ALekha%2520Sebastian)";
  assert.equal(urlHasKeywords(url, "Lekha Sebastian"), true);
  assert.equal(urlHasKeywords(url, "Nandini Raghavan"), false);
});

test("buildSalesNavigatorQueries falls back gracefully when location/university are missing", () => {
  const queries = buildSalesNavigatorQueries({ full_name: "Mr John Doe" });
  assert.deepEqual(queries, ["John Doe"]);
});

test("buildSalesNavigatorQueries returns an empty array when there is no usable name", () => {
  assert.deepEqual(buildSalesNavigatorQueries({}), []);
});

test("normalizeBrowserLead returns null for a null/undefined raw find", () => {
  assert.equal(normalizeBrowserLead(null), null);
  assert.equal(normalizeBrowserLead(undefined), null);
});

test("recordBrowserLead always logs the raw find to browser_leads, independent of the confirmation decision", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/someone-else",
    name: "Someone Else", headline: "", company: "", location: "", educationSnippet: ""
  });
  recordBrowserLead(db, { candidateId: 1, normalized, raw: { profileUrl: "https://www.linkedin.com/in/someone-else" } });
  const lead = db.prepare("SELECT * FROM browser_leads WHERE candidate_id = 1").get();
  assert.equal(lead.linkedin_url, "https://www.linkedin.com/in/someone-else");
  assert.equal(lead.status, "found");
  db.close();
});

test("applyBrowserLeadDecision auto-confirms a clean, high-confidence match with no human gate", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-12345",
    name: "Brynlee Gallister",
    headline: "Registered Nurse",
    company: "Canberra Health Services",
    location: "Canberra, ACT, Australia",
    educationSnippet: "University of Canberra Bachelor of Nursing"
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "confirmed");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(updated.identity_status, "confirmed");
  assert.equal(updated.identity_provider, "browser_agent_salesnav");
  assert.equal(updated.identity_provider_reference, "https://www.linkedin.com/in/brynlee-gallister-12345");
  assert.equal(updated.reviewer_decision, "confirmed");

  const history = db.prepare("SELECT * FROM review_history WHERE candidate_id = 1").get();
  assert.equal(history.decision, "confirmed");
  assert.equal(history.reviewer, "Browser Agent (Sales Navigator)");
  // The verified profile's location is stored apart from the register's own fields.
  assert.equal(updated.profile_location, "Canberra, ACT, Australia");
  assert.equal(updated.profile_state, "ACT");
  assert.equal(updated.profile_postcode, null); // a city, not a suburb — no guessed postcode
  assert.equal(updated.postcode, "2617"); // register value untouched
  db.close();
});

test("applyBrowserLeadDecision stores the postcode of a verified match located in a specific suburb", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-12345",
    name: "Brynlee Gallister",
    headline: "Registered Nurse",
    company: "Canberra Health Services",
    location: "Bruce, Australian Capital Territory, Australia",
    educationSnippet: "University of Canberra Bachelor of Nursing"
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const postcodeIndex = buildPostcodeIndex([{ postcode: "2617", locality: "BRUCE", state: "ACT", type: "Delivery Area" }]);
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 }, () => {}, { postcodeIndex });
  assert.equal(result.decision, "confirmed");
  const updated = db.prepare("SELECT profile_suburb, profile_state, profile_postcode FROM candidates WHERE id = 1").get();
  assert.deepEqual({ ...updated }, { profile_suburb: "Bruce", profile_state: "ACT", profile_postcode: "2617" });
  db.close();
});

test("applyBrowserLeadDecision does not store a profile location for a match it doesn't confirm", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-rn",
    name: "Brynlee Gallister", headline: "Registered Nurse", company: "",
    location: "Bruce, Australian Capital Territory, Australia", educationSnippet: ""
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 }).decision, "manual_review");
  assert.equal(db.prepare("SELECT profile_postcode FROM candidates WHERE id = 1").get().profile_postcode, null);
  db.close();
});

test("applyBrowserLeadDecision does not auto-confirm a namesake with a conflicting overseas location", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-99999",
    name: "Brynlee Gallister",
    headline: "Staff Nurse",
    company: "Apollo Hospitals",
    location: "Mumbai, India",
    educationSnippet: ""
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "manual_review");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.notEqual(updated.identity_status, "confirmed");
  // Since 2026-10-13 only people located in Australia are attached (user
  // requirement): the overseas namesake is audited, not attached.
  assert.equal(updated.linkedin_url, null);
  assert.equal(updated.workflow_stage, "manual_review");
  db.close();
});

test("applyBrowserLeadDecision never attaches a same-name recruiter, even in Australia with a matching university", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-recruiter",
    name: "Brynlee Gallister",
    headline: "Senior Recruitment Consultant - Nursing",
    company: "Healthcare Staffing Australia",
    location: "Canberra, Australian Capital Territory, Australia",
    educationSnippet: "University of Canberra Bachelor of Nursing"
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "manual_review");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.notEqual(updated.identity_status, "confirmed");
  assert.equal(updated.linkedin_url, null);
  db.close();
});

test("applyBrowserLeadDecision does not attach a thin same-name profile with no university or profession corroboration", () => {
  // Live incident: candidate #163 Ambrin John matched a real LinkedIn
  // profile by name + AU location, but the profile was paper-thin (0
  // followers, no headline, no posts, no education/employer evidence) —
  // not strong enough to park on a candidate's identity even for manual
  // review. Name-only + location is no longer sufficient; needs a
  // university or nursing/medical title match too.
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-thin",
    name: "Brynlee Gallister",
    headline: "",
    company: "",
    location: "Perth, Western Australia, Australia",
    educationSnippet: ""
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "manual_review");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(updated.linkedin_url, null);
  assert.equal(updated.employer, null);
  assert.equal(updated.current_title, null);
  assert.equal(updated.identity_match_score, result.score);
  db.close();
});

test("applyBrowserLeadDecision attaches a same-name profile corroborated only by a nursing job title", () => {
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/brynlee-gallister-rn",
    name: "Brynlee Gallister",
    headline: "Registered Nurse",
    company: "",
    location: "Canberra, Australia",
    educationSnippet: ""
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "manual_review");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(updated.linkedin_url, "https://www.linkedin.com/in/brynlee-gallister-rn");
  db.close();
});

test("applyBrowserLeadDecision does not attach a name-mismatched lead's linkedin_url/employer/title to the candidate", () => {
  // Regression test: before this fix, a completely different person's
  // profile (wrong name, matched only because they were the top Sales Nav
  // result) still got written into linkedin_url/employer/current_title —
  // which silently strands the candidate forever, since every future
  // discovery attempt skips candidates that already have a linkedin_url.
  // Live incident: candidate #172 Anjali Rai, candidates #12/#27/#28/#29/
  // #49/#53/#76 — see scripts/fix-name-mismatched-leads.mjs.
  const db = setupTestDb();
  const normalized = normalizeBrowserLead({
    profileUrl: "https://www.linkedin.com/in/completely-different-person",
    name: "Completely Different Person",
    headline: "Staff Nurse",
    company: "Some Other Hospital",
    location: "Sydney, Australia",
    educationSnippet: ""
  });
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, normalized, { high: 85, manual: 60 });

  assert.equal(result.decision, "manual_review");
  assert.ok(result.conflicts.includes("Name differs from licensed source"));
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(updated.linkedin_url, null);
  assert.equal(updated.employer, null);
  assert.equal(updated.current_title, null);
  // The score/reasons/conflicts audit trail is still recorded, just not
  // attached as this candidate's identity.
  assert.equal(updated.identity_match_score, result.score);
  db.close();
});

test("rankCandidateCards keeps only same-name healthcare workers in Australia, nurses first", () => {
  // Live incident: an unfiltered "Anushka Tamboli" search returned a
  // Brisbane "Senior Test Analyst" as the top card, with the real Canberra
  // Hospital "Registered Nurse Level 2" further down the results. Ranking
  // must not just trust search-result order — and since 2026-10-13
  // non-healthcare namesakes and overseas people aren't opened at all.
  const candidate = { full_name: "Miss Anushka Tamboli" };
  const cards = [
    { index: 0, name: "Anushka Tamboli", headline: "Senior Test Analyst", company: "Australian Retirement Trust", location: "Greater Brisbane Area" },
    { index: 1, name: "Anushka Tamboli", headline: "Pharmacist", company: "Chemist Warehouse", location: "Sydney, New South Wales, Australia" },
    { index: 2, name: "Anushka Tamboli", headline: "Registered Nurse Level 2", company: "Canberra Hospital", location: "Australia" },
    { index: 3, name: "Anushka Tamboli", headline: "Staff Nurse", company: "Apollo Hospitals", location: "Mumbai, Maharashtra, India" },
    { index: 4, name: "Someone Else Entirely", headline: "Registered Nurse", company: "", location: "" }
  ];
  const ranked = rankCandidateCards(cards, candidate);
  assert.deepEqual(ranked.map((card) => card.index), [2, 1]);
});

test("rankCandidateCards drops cards whose name doesn't match at all", () => {
  const candidate = { full_name: "Dr Brynlee Anne Gallister" };
  const cards = [{ index: 0, name: "Completely Different Person", headline: "Registered Nurse" }];
  assert.deepEqual(rankCandidateCards(cards, candidate), []);
});

test("rankCandidateCards matches a card whose displayed name drops the candidate's leading token", () => {
  // Real user-reported case: South Asian/Nepali/Filipino multi-part AHPRA
  // names often appear on LinkedIn with a leading family/village-name token
  // dropped. Before this fix, this card was filtered out here and never
  // even opened or scored — a silent false negative in the live pipeline.
  const candidate = { full_name: "Mergu Bala Krishna" };
  const cards = [
    { index: 0, name: "Bala Krishna", headline: "Registered Nurse", company: "", location: "" }
  ];
  const ranked = rankCandidateCards(cards, candidate);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].index, 0);
});

test("rankCandidateCards still drops a same-surname card belonging to a different person", () => {
  // Critical safety-regression test: must not regress into a last-name-only
  // or any-shared-token match. This dataset has many different real
  // candidates sharing exactly this kind of common surname.
  const candidate = { full_name: "Ravneet Kaur" };
  const cards = [{ index: 0, name: "Harleen Kaur", headline: "Registered Nurse", company: "", location: "" }];
  assert.deepEqual(rankCandidateCards(cards, candidate), []);
});

test("hasUniversityCorroborationInText matches the candidate's AHPRA-listed institution in an education snippet", () => {
  const candidate = { qualifications: "Bachelor of Nursing, University of Canberra, Australia, 2018" };
  assert.equal(hasUniversityCorroborationInText("Education University of Canberra Bachelor of Nursing 2015 - 2018", candidate), true);
  assert.equal(hasUniversityCorroborationInText("Education UNSW Doctor of Philosophy", candidate), false);
  assert.equal(hasUniversityCorroborationInText("", candidate), false);
});

test("applyBrowserLeadDecision marks identity_unresolved when the browser agent found nothing", () => {
  const db = setupTestDb();
  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  const result = applyBrowserLeadDecision(db, candidate, null, { high: 85, manual: 60 });

  assert.equal(result.decision, "not_found");
  const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(updated.workflow_stage, "identity_unresolved");
  assert.notEqual(updated.identity_status, "confirmed");
  db.close();
});
