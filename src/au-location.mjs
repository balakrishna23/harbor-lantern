import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "./csv.mjs";

/**
 * Turns a LinkedIn profile location ("Bruce, Australian Capital Territory,
 * Australia", "Greater Sydney Area", "Australia") into suburb / state /
 * postcode for a verified match.
 *
 * The national register's own suburb/state/postcode columns are corrupted
 * (they hold the first name), so for those candidates this is the only
 * location we have. It is a DERIVED value: LinkedIn shows what the person
 * chose to display, often a city rather than their suburb. So a postcode is
 * only filled when the location names a specific locality with exactly one
 * delivery postcode; a city or metro area ("Sydney", "Canberra", "Greater
 * Melbourne Area") gets its state and no postcode rather than a guess.
 *
 * Postcode reference: data/reference/australian_postcodes.csv (Matthew
 * Proctor's Australian postcode list; columns postcode, locality, state, type).
 */

const STATE_NAMES = {
  "australian capital territory": "ACT", "new south wales": "NSW", "victoria": "VIC", "queensland": "QLD",
  "western australia": "WA", "south australia": "SA", "tasmania": "TAS", "northern territory": "NT"
};
const STATE_CODES = new Set(Object.values(STATE_NAMES));

// City / region names LinkedIn uses for a whole metro area. One postcode for
// these would pin the person to the CBD, which is almost never where they live.
const METRO_STATE = {
  sydney: "NSW", melbourne: "VIC", brisbane: "QLD", perth: "WA", adelaide: "SA", hobart: "TAS", darwin: "NT", canberra: "ACT",
  "gold coast": "QLD", "sunshine coast": "QLD", "central coast": "NSW", newcastle: "NSW", wollongong: "NSW", geelong: "VIC"
};

const squash = (value) => String(value ?? "").trim().replace(/\s+/g, " ");

/** Builds a lookup index from parsed postcode rows ({ postcode, locality, state, type }). */
export function buildPostcodeIndex(rows) {
  const index = new Map();
  for (const row of rows) {
    const postcode = squash(row.postcode);
    const state = squash(row.state).toUpperCase();
    if (!/^\d{4}$/.test(postcode) || !STATE_CODES.has(state)) continue;
    const key = `${state}|${squash(row.locality).toUpperCase()}`;
    const entry = index.get(key) || { delivery: new Set(), other: new Set() };
    if (squash(row.type) === "Delivery Area") entry.delivery.add(postcode);
    else if (squash(row.type) !== "Post Office Boxes") entry.other.add(postcode);
    index.set(key, entry);
  }
  return index;
}

let defaultIndex;
/** Loads the bundled reference list once; an empty index (no postcodes) if it's missing. */
export function defaultPostcodeIndex() {
  if (defaultIndex) return defaultIndex;
  const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite"));
  const file = process.env.POSTCODE_REFERENCE_PATH || path.join(dataDir, "reference", "australian_postcodes.csv");
  try {
    defaultIndex = buildPostcodeIndex(parseCsv(fs.readFileSync(file, "utf8")));
  } catch {
    defaultIndex = new Map();
  }
  return defaultIndex;
}

function lookupPostcode(index, locality, state) {
  const entry = index.get(`${state}|${locality.toUpperCase()}`);
  if (!entry) return null;
  // Prefer street-delivery postcodes; fall back to the rest (e.g. Kapooka's
  // single large-volume-receiver code) only when a place has no delivery code.
  const pool = entry.delivery.size ? entry.delivery : entry.other;
  return pool.size === 1 ? [...pool][0] : null;
}

/**
 * Stores the verified match's profile location on the candidate. The
 * location comes from locationText when given, otherwise from the
 * browser_leads row for the candidate's attached LinkedIn URL. A location
 * outside Australia is still recorded (precision "outside_australia") so it
 * stands out for review rather than silently disappearing.
 * Returns the stored values, or null when there's no location to store.
 */
export function recordVerifiedProfileLocation(db, candidateId, { locationText = null, index } = {}) {
  let text = squash(locationText);
  if (!text) {
    const lead = db.prepare(`SELECT bl.location FROM browser_leads bl JOIN candidates c ON c.id = bl.candidate_id
      WHERE bl.candidate_id = ? AND bl.linkedin_url = c.linkedin_url AND COALESCE(bl.location, '') <> ''
      ORDER BY bl.id DESC LIMIT 1`).get(candidateId);
    text = squash(lead?.location);
  }
  if (!text) return null;
  const resolved = resolveAustralianLocation(text, index ?? defaultPostcodeIndex())
    || { location: text, suburb: null, state: null, postcode: null, precision: "outside_australia" };
  db.prepare(`UPDATE candidates SET profile_location = ?, profile_suburb = ?, profile_state = ?, profile_postcode = ?,
      profile_location_precision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(resolved.location, resolved.suburb, resolved.state, resolved.postcode, resolved.precision, candidateId);
  return resolved;
}

/**
 * Returns { location, suburb, state, postcode, precision } where precision is
 * "suburb" (postcode found), "locality" (named place, postcode ambiguous or
 * unknown), "city", "state" or "country" — or null for a location that isn't
 * in Australia.
 */
export function resolveAustralianLocation(locationText, index = defaultPostcodeIndex()) {
  const location = squash(locationText);
  if (!location) return null;
  const parts = location.split(",").map(squash).filter(Boolean);
  const result = (suburb, state, postcode, precision) => ({ location, suburb, state, postcode, precision });

  const greater = location.match(/^greater (.+?) area$/i);
  if (greater) {
    const state = METRO_STATE[greater[1].toLowerCase()];
    return state ? result(null, state, null, "city") : null;
  }
  if (parts.at(-1)?.toLowerCase() !== "australia") return null;
  if (parts.length === 1) return result(null, null, null, "country");
  const stateText = parts.at(-2);
  const state = STATE_NAMES[stateText.toLowerCase()] || (STATE_CODES.has(stateText.toUpperCase()) ? stateText.toUpperCase() : null);
  if (!state) return null;
  if (parts.length === 2) return result(null, state, null, "state");

  const locality = parts[0];
  if (METRO_STATE[locality.toLowerCase()] === state) return result(null, state, null, "city");
  const postcode = lookupPostcode(index, locality, state);
  return result(locality, state, postcode, postcode ? "suburb" : "locality");
}
