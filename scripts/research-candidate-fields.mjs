import { db } from "../src/db.mjs";

console.log("=== DB SCHEMA FOR CANDIDATES ===");
const cols = db.prepare("PRAGMA table_info(candidates)").all();
console.log(cols.map(c => `${c.name} (${c.type})`).join(", "));

console.log("\n=== TOTAL CANDIDATES & FIELD FILL RATES ===");
const total = db.prepare("SELECT count(*) as c FROM candidates").get().c;
const withQual = db.prepare("SELECT count(*) as c FROM candidates WHERE qualifications IS NOT NULL AND qualifications != ''").get().c;
const withSuburb = db.prepare("SELECT count(*) as c FROM candidates WHERE suburb IS NOT NULL AND suburb != ''").get().c;
const withPostcode = db.prepare("SELECT count(*) as c FROM candidates WHERE postcode IS NOT NULL AND postcode != ''").get().c;
const withState = db.prepare("SELECT count(*) as c FROM candidates WHERE state IS NOT NULL AND state != ''").get().c;
console.log({ total, withQual, withSuburb, withPostcode, withState });

console.log("\n=== SAMPLE CANDIDATES (WITH QUALIFICATIONS) ===");
const sampleQual = db.prepare("SELECT id, full_name, profession, state, suburb, postcode, qualifications FROM candidates WHERE qualifications IS NOT NULL AND qualifications != '' LIMIT 5").all();
console.log(JSON.stringify(sampleQual, null, 2));

console.log("\n=== SAMPLE CANDIDATES (FIRST 5) ===");
const sampleFirst = db.prepare("SELECT id, full_name, profession, state, suburb, postcode, qualifications FROM candidates LIMIT 5").all();
console.log(JSON.stringify(sampleFirst, null, 2));
