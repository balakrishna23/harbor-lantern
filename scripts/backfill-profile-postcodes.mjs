#!/usr/bin/env node
/**
 * Stores the LinkedIn-profile location (suburb / state / postcode) for every
 * confirmed candidate that doesn't have one yet — matches confirmed before
 * src/au-location.mjs existed. New confirmations get it automatically.
 * Only writes the profile_* columns; register fields are never touched.
 */
import { db } from "../src/db.mjs";
import { recordVerifiedProfileLocation } from "../src/au-location.mjs";

const pending = db.prepare(`SELECT id, full_name FROM candidates
  WHERE identity_status = 'confirmed' AND profile_location_precision IS NULL ORDER BY id`).all();
const counts = {};
for (const candidate of pending) {
  const resolved = recordVerifiedProfileLocation(db, candidate.id);
  const key = resolved ? resolved.precision : "no_location_on_lead";
  counts[key] = (counts[key] || 0) + 1;
  if (resolved?.precision === "outside_australia") {
    console.log(`  ! #${candidate.id} ${candidate.full_name} — confirmed profile is located outside Australia: ${resolved.location}`);
  }
}
console.log(`Confirmed candidates processed: ${pending.length}`, counts);
