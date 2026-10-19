/**
 * Builds the match_keys table for every candidate.
 *
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/build-match-keys.mjs [--limit=N] [--rebuild]
 *
 * Resumable: each run fills in candidates that have no match key yet, up to
 * --limit, committing every 5,000 rows. --rebuild clears the table first.
 * Name counts are always computed over the whole register.
 *
 * Refuses to run against the original data/hcrhub.sqlite unless
 * --allow-original is passed, so development work never touches it.
 */
import path from "node:path";

const target = path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite");
if (target === path.resolve("./data/hcrhub.sqlite") && !process.argv.includes("--allow-original")) {
  console.error(`Refusing to write to the original database (${target}). Set DATABASE_PATH to the dev copy, or pass --allow-original.`);
  process.exit(2);
}

const { db } = await import("../src/db.mjs");
const { buildNameCounts, deriveMatchKeys } = await import("../src/match-keys.mjs");

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const limit = Number(arg("limit") || Infinity);
if (process.argv.includes("--rebuild")) db.exec("DELETE FROM match_keys");

const started = Date.now();
const all = db.prepare(`SELECT id, first_name, middle_name, last_name FROM candidates`).all();
const counts = buildNameCounts(all);
const pending = db.prepare(`SELECT c.id, c.first_name, c.middle_name, c.last_name, c.qualifications, c.state FROM candidates c
  WHERE NOT EXISTS (SELECT 1 FROM match_keys m WHERE m.candidate_id = c.id) ORDER BY c.id`).all();
const rows = pending.slice(0, limit);
console.log(`Name counts over ${all.length} candidates; ${pending.length} without keys; processing ${rows.length}`);

const insert = db.prepare(`INSERT INTO match_keys(candidate_id, name_key, full_name_key, name_count, full_name_count, uniqueness,
  institution, institution_known, grad_year, earliest_year, inferred_state, register_state, qualification_country, overseas_trained, tier, built_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  ON CONFLICT(candidate_id) DO UPDATE SET name_key=excluded.name_key, full_name_key=excluded.full_name_key, name_count=excluded.name_count,
  full_name_count=excluded.full_name_count, uniqueness=excluded.uniqueness, institution=excluded.institution, institution_known=excluded.institution_known,
  grad_year=excluded.grad_year, earliest_year=excluded.earliest_year, inferred_state=excluded.inferred_state, register_state=excluded.register_state,
  qualification_country=excluded.qualification_country, overseas_trained=excluded.overseas_trained, tier=excluded.tier, built_at=CURRENT_TIMESTAMP`);

const CHUNK = 5000;
for (let i = 0; i < rows.length; i += CHUNK) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows.slice(i, i + CHUNK)) {
      const k = deriveMatchKeys(row, counts);
      insert.run(row.id, k.nameKey, k.fullNameKey, k.nameCount, k.fullNameCount, k.uniqueness, k.institution, k.institutionKnown ? 1 : 0,
        k.gradYear, k.earliestYear, k.inferredState, k.registerState, k.qualificationCountry, k.overseasTrained ? 1 : 0, k.tier);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`  ${Math.min(i + CHUNK, rows.length)}/${rows.length} (${Math.round((Date.now() - started) / 1000)}s)`);
}

const summary = (sql) => db.prepare(sql).all();
console.log(`Processed ${rows.length} candidates in ${Math.round((Date.now() - started) / 1000)}s`);
console.log("By tier:", summary("SELECT tier, COUNT(*) n FROM match_keys GROUP BY tier ORDER BY tier"));
console.log("By uniqueness:", summary("SELECT uniqueness, COUNT(*) n FROM match_keys GROUP BY uniqueness ORDER BY n DESC"));
console.log("Inferred state:", summary("SELECT COALESCE(inferred_state,'(none)') state, COUNT(*) n FROM match_keys GROUP BY 1 ORDER BY n DESC"));
console.log("Overseas-trained:", summary("SELECT overseas_trained, COUNT(*) n FROM match_keys GROUP BY 1"));
