import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { buildPostcodeIndex, resolveAustralianLocation, recordVerifiedProfileLocation } from "../src/au-location.mjs";

// A small slice of the reference list, in its real shape.
const index = buildPostcodeIndex([
  { postcode: "2617", locality: "BRUCE", state: "ACT", type: "Delivery Area" },
  { postcode: "2600", locality: "CANBERRA", state: "ACT", type: "Delivery Area" },
  { postcode: "2601", locality: "CANBERRA", state: "ACT", type: "Delivery Area" },
  { postcode: "2144", locality: "AUBURN", state: "NSW", type: "Delivery Area" },
  { postcode: "1835", locality: "AUBURN", state: "NSW", type: "Post Office Boxes" },
  { postcode: "5451", locality: "AUBURN", state: "SA", type: "Delivery Area" },
  { postcode: "2661", locality: "KAPOOKA", state: "NSW", type: "LVR" },
  { postcode: "3174", locality: "NOBLE PARK", state: "VIC", type: "Delivery Area" },
  { postcode: "3174", locality: "NOBLE PARK NORTH", state: "VIC", type: "Delivery Area" },
  { postcode: "2000", locality: "SYDNEY", state: "NSW", type: "Delivery Area" }
]);

test("resolveAustralianLocation fills a postcode only for a specific place with one delivery postcode", () => {
  assert.deepEqual(resolveAustralianLocation("Bruce, Australian Capital Territory, Australia", index),
    { location: "Bruce, Australian Capital Territory, Australia", suburb: "Bruce", state: "ACT", postcode: "2617", precision: "suburb" });
  // Same locality name in two states: the state decides; PO-box codes are ignored.
  assert.equal(resolveAustralianLocation("Auburn, New South Wales, Australia", index).postcode, "2144");
  // A place with only a large-volume-receiver code still resolves.
  assert.equal(resolveAustralianLocation("Kapooka, New South Wales, Australia", index).postcode, "2661");
  assert.equal(resolveAustralianLocation("Noble Park, VIC, Australia", index).postcode, "3174");
});

test("resolveAustralianLocation never guesses a postcode for a city, metro area, state or country", () => {
  for (const [text, state, precision] of [
    ["Canberra, Australian Capital Territory, Australia", "ACT", "city"],
    ["Sydney, New South Wales, Australia", "NSW", "city"],
    ["Greater Melbourne Area", "VIC", "city"],
    ["New South Wales, Australia", "NSW", "state"],
    ["Australia", null, "country"]
  ]) {
    const resolved = resolveAustralianLocation(text, index);
    assert.equal(resolved.postcode, null, text);
    assert.equal(resolved.state, state, text);
    assert.equal(resolved.precision, precision, text);
  }
  // A named place missing from the list keeps its suburb/state, no postcode.
  assert.deepEqual(resolveAustralianLocation("Nowhereville, Queensland, Australia", index),
    { location: "Nowhereville, Queensland, Australia", suburb: "Nowhereville", state: "QLD", postcode: null, precision: "locality" });
});

test("resolveAustralianLocation returns null outside Australia", () => {
  assert.equal(resolveAustralianLocation("Tokyo, Japan", index), null);
  assert.equal(resolveAustralianLocation("Greater Bengaluru Area", index), null);
  assert.equal(resolveAustralianLocation("", index), null);
});

test("recordVerifiedProfileLocation stores the attached lead's location, and flags an overseas one", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec(`
    INSERT INTO imports (id, filename, file_hash) VALUES (1, 'test.csv', 'hash');
    INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, registration_status, identity_status, linkedin_url)
    VALUES (1, 1, 2, 'h1', 'Jane Citizen', 'Registered', 'confirmed', 'https://www.linkedin.com/in/jane'),
           (2, 1, 3, 'h2', 'Ken Overseas', 'Registered', 'confirmed', 'https://www.linkedin.com/in/ken');
    INSERT INTO browser_leads (candidate_id, linkedin_url, location, status) VALUES
      (1, 'https://www.linkedin.com/in/someone-else', 'Sydney, New South Wales, Australia', 'found'),
      (1, 'https://www.linkedin.com/in/jane', 'Bruce, Australian Capital Territory, Australia', 'found'),
      (2, 'https://www.linkedin.com/in/ken', 'Tokyo, Japan', 'found');
  `);
  recordVerifiedProfileLocation(db, 1, { index });
  recordVerifiedProfileLocation(db, 2, { index });
  const jane = db.prepare("SELECT profile_suburb, profile_state, profile_postcode, profile_location_precision, suburb, postcode FROM candidates WHERE id = 1").get();
  assert.deepEqual({ ...jane }, { profile_suburb: "Bruce", profile_state: "ACT", profile_postcode: "2617", profile_location_precision: "suburb", suburb: null, postcode: null });
  const ken = db.prepare("SELECT profile_location, profile_postcode, profile_location_precision FROM candidates WHERE id = 2").get();
  assert.deepEqual({ ...ken }, { profile_location: "Tokyo, Japan", profile_postcode: null, profile_location_precision: "outside_australia" });
  db.close();
});
