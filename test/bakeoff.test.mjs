import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { buildNameCounts, deriveMatchKeys } from "../src/match-keys.mjs";
import { selectSample, runLookups, normaliseLinkedin } from "../src/bakeoff.mjs";
import { createMockProvider } from "../src/providers/mock-provider.mjs";

function setup() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.prepare("INSERT INTO imports (id, filename, file_hash) VALUES (1, 'test.csv', 'h')").run();
  const add = db.prepare(`INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, first_name, middle_name, last_name,
    qualifications, registration_status, identity_status, linkedin_url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const q = "• Bachelor of Nursing, University of Technology Sydney, Australia, 2014";
  add.run(1, 1, 1, "h1", "Alex Example", "Alex", "", "Example", q, "Registered", "confirmed", "https://www.linkedin.com/in/alex-example-rn/");
  add.run(2, 1, 2, "h2", "Sam Sample", "Sam", "", "Sample", q, "Registered", "unreviewed", null);
  add.run(3, 1, 3, "h3", "Kim Test", "Kim", "", "Test", q, "Registered", "unreviewed", null);
  const rows = db.prepare("SELECT * FROM candidates").all();
  const counts = buildNameCounts(rows);
  const ins = db.prepare(`INSERT INTO match_keys(candidate_id, name_key, full_name_key, name_count, full_name_count, uniqueness, institution,
    institution_known, grad_year, earliest_year, inferred_state, register_state, qualification_country, overseas_trained, tier) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const r of rows) {
    const k = deriveMatchKeys(r, counts);
    ins.run(r.id, k.nameKey, k.fullNameKey, k.nameCount, k.fullNameCount, k.uniqueness, k.institution, 1, k.gradYear, k.earliestYear,
      k.inferredState, null, k.qualificationCountry, 0, k.tier);
  }
  return db;
}

const mock = () => createMockProvider({
  "alex|example": { person: { fullName: "Alex Example", country: "australia", currentTitle: "Registered Nurse", linkedinUrl: "https://linkedin.com/in/alex-example-rn", contactAvailability: { email: true, phone: false } } },
  "sam|sample": { person: { fullName: "Sam Sample", country: "india", currentTitle: "Staff Nurse" } }
});

test("normalises LinkedIn URLs for comparison", () => {
  assert.equal(normaliseLinkedin("https://www.linkedin.com/in/alex-example-rn/"), "linkedin.com/in/alex-example-rn");
  assert.equal(normaliseLinkedin("https://au.linkedin.com/in/alex-example-rn?trk=x"), "linkedin.com/in/alex-example-rn");
});

test("dry run plans lookups and writes nothing", async () => {
  const db = setup();
  const provider = mock();
  const sample = selectSample(db, { groups: { confirmed: 5, tier1: 5 }, provider: "mock" });
  assert.equal(sample.length, 3);
  const run = await runLookups(db, { provider, candidates: sample, options: { dryRun: true } });
  assert.equal(provider.calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM provider_lookups").get().n, 0);
  assert.equal(run.outcomes.filter((o) => o.status === "planned").length, 3);
});

test("live run records lookups, verifies them and scores against confirmed truth", async () => {
  const db = setup();
  const provider = mock();
  const sample = selectSample(db, { groups: { confirmed: 5, tier1: 5 }, provider: "mock" });
  const run = await runLookups(db, { provider, candidates: sample, options: { dryRun: false, delayMs: 0 } });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM provider_lookups").get().n, 3);
  assert.equal(run.summary.confirmed.truth_same_profile, 1);
  assert.equal(run.summary.confirmed.accept, 1);
  assert.equal(run.summary.confirmed.email_available, 1);
  assert.equal(run.summary.tier1.reject, 1, "overseas namesake rejected");
  assert.equal(run.summary.tier1.no_match, 1);
  const untouched = db.prepare("SELECT linkedin_url FROM candidates WHERE id = 2").get();
  assert.equal(untouched.linkedin_url, null, "a bake-off never edits candidates");
  const again = selectSample(db, { groups: { confirmed: 5, tier1: 5 }, provider: "mock" });
  assert.equal(again.length, 0, "already-answered nurses are not looked up twice");
});

test("stops at the credit ceiling and on run-stopping errors", async () => {
  const db = setup();
  const sample = selectSample(db, { groups: { confirmed: 5, tier1: 5 }, provider: "mock" });
  const capped = await runLookups(db, { provider: mock(), candidates: sample, options: { dryRun: false, delayMs: 0, maxCredits: 1 } });
  assert.match(capped.stoppedBecause, /credit ceiling/);
  const broke = createMockProvider({ "alex|example": { error: "credits_exhausted" } });
  const stopped = await runLookups(db, { provider: broke, candidates: sample, options: { dryRun: false, delayMs: 0 } });
  assert.match(stopped.stoppedBecause, /credits_exhausted/);
  assert.equal(broke.calls.length, 1);
});
