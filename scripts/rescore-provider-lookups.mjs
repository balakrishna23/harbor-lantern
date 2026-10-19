/**
 * Re-runs the current verifier over stored provider matches (no new provider
 * calls, no credits) and updates decision/score/reasons in provider_lookups.
 *
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/rescore-provider-lookups.mjs [--run=<run_id>]
 */
import path from "node:path";
const target = path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite");
if (target === path.resolve("./data/hcrhub.sqlite") && !process.argv.includes("--allow-original")) {
  console.error("Refusing to use the original database. Set DATABASE_PATH to the dev copy."); process.exit(2);
}
const { db } = await import("../src/db.mjs");
const { verifyIdentity } = await import("../src/verifier.mjs");
const runId = process.argv.find((a) => a.startsWith("--run="))?.slice(6);
const rows = db.prepare(`SELECT p.id lookup_id, p.decision old_decision, p.likelihood, p.person_json, c.*, m.uniqueness
  FROM provider_lookups p JOIN candidates c ON c.id = p.candidate_id JOIN match_keys m ON m.candidate_id = c.id
  WHERE p.status = 'match' ${runId ? "AND p.run_id = ?" : ""}`).all(...(runId ? [runId] : []));
const update = db.prepare("UPDATE provider_lookups SET decision=?, score=?, signals_json=?, reasons_json=?, conflicts_json=? WHERE id=?");
const changes = {};
for (const r of rows) {
  const v = verifyIdentity(r, { uniqueness: r.uniqueness }, { status: "match", likelihood: r.likelihood, person: JSON.parse(r.person_json) });
  update.run(v.decision, v.score, JSON.stringify(v.signals), JSON.stringify(v.reasons), JSON.stringify(v.conflicts), r.lookup_id);
  const k = `${r.old_decision} -> ${v.decision}`; changes[k] = (changes[k] || 0) + 1;
}
console.log(`Re-scored ${rows.length} stored matches`, changes);
