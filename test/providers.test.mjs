import test from "node:test";
import assert from "node:assert/strict";
import { buildPdlQuery, pdlLookup, normalisePdlPerson, PDL_ENDPOINT } from "../src/providers/pdl.mjs";
import { createMockProvider } from "../src/providers/mock-provider.mjs";
import { RUN_STOPPING_ERRORS } from "../src/providers/provider-contract.mjs";

const fakeFetch = (status, body, seen = []) => async (url, init) => {
  seen.push({ url, init });
  return { status, json: async () => body };
};

test("PDL query sends name, country and training institution, never a region", () => {
  const { query } = buildPdlQuery(
    { first_name: "Alex", middle_name: "Jo", last_name: "Example" },
    { institution: "University of Technology Sydney", inferredState: "NSW" }
  );
  assert.equal(query.first_name, "Alex");
  assert.equal(query.middle_name, "Jo");
  assert.equal(query.country, "australia");
  assert.equal(query.school, "University of Technology Sydney");
  assert.equal(query.min_likelihood, "6");
  assert.equal(query.region, undefined);
});

test("PDL query skips single-name registrations", () => {
  assert.match(buildPdlQuery({ first_name: "", last_name: "Example" }).skip, /first and last name/);
});

test("PDL match is normalised, with the API key sent as a header not in the URL", async () => {
  const seen = [];
  const body = {
    status: 200, likelihood: 8,
    data: {
      id: "pdl-1", full_name: "Alex Example", first_name: "Alex", last_name: "Example",
      linkedin_url: "linkedin.com/in/alex-example-rn", facebook_url: "facebook.com/alex.example",
      profiles: [{ network: "instagram", url: "instagram.com/alexexample" }, { network: "linkedin", url: "linkedin.com/in/alex-example-rn" }],
      job_title: "Registered Nurse", job_company_name: "Example Health",
      location_name: "Sydney, New South Wales, Australia", location_country: "australia", location_region: "new south wales",
      education: [{ school: { name: "University of Technology Sydney" }, end_date: "2014-11", degrees: ["bachelors"] }],
      work_email: "alex.example@examplehealth.test", personal_emails: ["alex@example.test"],
      mobile_phone: "+61400000000", phone_numbers: ["+61400000000", "+61290000000"]
    }
  };
  const r = await pdlLookup({ first_name: "Alex", last_name: "Example" }, { apiKey: "test-key", fetchImpl: fakeFetch(200, body, seen) });
  assert.equal(r.status, "match");
  assert.equal(r.likelihood, 8);
  assert.equal(r.creditsUsed, 1);
  assert.ok(seen[0].url.startsWith(PDL_ENDPOINT));
  assert.ok(!seen[0].url.includes("test-key"));
  assert.equal(seen[0].init.headers["X-Api-Key"], "test-key");
  const p = r.person;
  assert.equal(p.linkedinUrl, "https://linkedin.com/in/alex-example-rn");
  assert.deepEqual(p.socials.map((s) => s.network).sort(), ["facebook", "instagram"]);
  assert.equal(p.education[0].endYear, 2014);
  assert.equal(p.emails.length, 2);
  assert.equal(p.phones.length, 2);
  assert.deepEqual(p.contactAvailability, { email: true, phone: true });
});

test("PDL free-plan booleans become availability flags, not fake contacts", () => {
  const p = normalisePdlPerson({ full_name: "Alex Example", work_email: true, personal_emails: true, mobile_phone: false, phone_numbers: false });
  assert.equal(p.emails.length, 0);
  assert.equal(p.phones.length, 0);
  assert.deepEqual(p.contactAvailability, { email: true, phone: false });
});

test("PDL outcomes map to stable codes", async () => {
  const q = { first_name: "Alex", last_name: "Example" };
  assert.equal((await pdlLookup(q, { apiKey: "k", fetchImpl: fakeFetch(404, { error: { type: "not_found" } }) })).status, "no_match");
  const out = await pdlLookup(q, { apiKey: "k", fetchImpl: fakeFetch(402, {}) });
  assert.equal(out.errorCode, "credits_exhausted");
  assert.ok(RUN_STOPPING_ERRORS.has(out.errorCode));
  const rl = await pdlLookup(q, { apiKey: "k", fetchImpl: fakeFetch(429, {}) });
  assert.equal(rl.errorCode, "rate_limited");
  assert.equal(rl.retryable, true);
  assert.equal((await pdlLookup(q, { apiKey: "k", fetchImpl: fakeFetch(503, {}) })).retryable, true);
  const net = await pdlLookup(q, { apiKey: "k", fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(net.errorCode, "network");
  assert.equal((await pdlLookup(q, {})).errorCode, "auth");
});

test("mock provider returns scripted matches and records calls", async () => {
  const mock = createMockProvider({ "alex|example": { person: { fullName: "Alex Example", country: "australia" } } });
  const hit = await mock.lookup(mock.buildQuery({ first_name: "Alex", last_name: "Example" }).query);
  const miss = await mock.lookup(mock.buildQuery({ first_name: "Sam", last_name: "Sample" }).query);
  assert.equal(hit.status, "match");
  assert.equal(hit.person.fullName, "Alex Example");
  assert.equal(miss.status, "no_match");
  assert.equal(mock.calls.length, 2);
});

test("PDL query can leave the institution out for comparison runs", () => {
  const { query } = buildPdlQuery({ first_name: "Alex", last_name: "Example" }, { institution: "Example University" }, { sendSchool: false });
  assert.equal(query.school, undefined);
});
