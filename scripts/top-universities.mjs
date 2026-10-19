import { db } from "../src/db.mjs";

const candidates = db.prepare(`
  SELECT id, full_name, qualifications
  FROM candidates
  WHERE qualifications IS NOT NULL AND qualifications != ''
`).all();

const uniCounts = {};

for (const c of candidates) {
  const parts = c.qualifications.split(/[•\n\r]+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts) {
    const segments = p.split(",").map(s => s.trim());
    if (segments.length >= 2) {
      const inst = segments[1];
      uniCounts[inst] = (uniCounts[inst] || 0) + 1;
    }
  }
}

const sorted = Object.entries(uniCounts).sort((a, b) => b[1] - a[1]);
console.log("Top 30 Institutions in AHPRA ACT Nurses:");
sorted.slice(0, 30).forEach(([inst, count], idx) => {
  console.log(`${idx + 1}. ${inst}: ${count}`);
});
