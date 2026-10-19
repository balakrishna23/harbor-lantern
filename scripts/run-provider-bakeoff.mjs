/**
 * Provider bake-off runner.
 *
 *   # plan only (default): shows the sample and queries, spends nothing
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/run-provider-bakeoff.mjs --provider=pdl
 *
 *   # real calls, capped at 100 credits
 *   DATABASE_PATH=./data/hcrhub-dev.sqlite node scripts/run-provider-bakeoff.mjs --provider=pdl --live --max-credits=100
 *
 * Options:
 *   --confirmed=N --tier1=N --tier3=N --tier4=N   sample sizes (default 50 confirmed, 50 tier1)
 *   --seed=TEXT          sample selection seed (same seed = same nurses)
 *   --no-school          do not send the training institution to the provider
 *   --min-likelihood=N   provider match threshold (PDL default here: 6)
 *   --max-credits=N      hard ceiling for --live (default 100)
 *   --force              include nurses this provider already answered
 *
 * PDL_API_KEY is read from the environment or from .env.
 * Writes only to provider_lookups and an exports/ report; never edits candidates.
 */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=") ?? fallback;

const target = path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite");
if (target === path.resolve("./data/hcrhub.sqlite") && !flag("allow-original")) {
  console.error(`Refusing to use the original database (${target}). Set DATABASE_PATH to the dev copy, or pass --allow-original.`);
  process.exit(2);
}
if (fs.existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

const { db } = await import("../src/db.mjs");
const { selectSample, runLookups } = await import("../src/bakeoff.mjs");
const { getApiProvider } = await import("../src/providers/index.mjs");
const { createMockProvider } = await import("../src/providers/mock-provider.mjs");

const providerId = opt("provider", "pdl");
const provider = providerId === "mock" ? createMockProvider() : getApiProvider(providerId);
const live = flag("live");
if (live && providerId === "pdl" && !process.env.PDL_API_KEY) {
  console.error("PDL_API_KEY is not set. Add it to .env (PDL_API_KEY=...) or the environment.");
  process.exit(2);
}

const groups = {
  confirmed: Number(opt("confirmed", 50)), tier1: Number(opt("tier1", 50)),
  tier3: Number(opt("tier3", 0)), tier4: Number(opt("tier4", 0))
};
const sample = selectSample(db, { groups, seed: opt("seed", "bakeoff-1"), provider: provider.id, force: flag("force") });
const maxCredits = Number(opt("max-credits", 100));

console.log(`${live ? "LIVE" : "DRY RUN"} | provider=${provider.id} | sample=${sample.length} (${Object.entries(groups).filter(([, n]) => n).map(([g, n]) => `${g}:${n}`).join(", ")})`);
console.log(`Credit ceiling: ${maxCredits}. Worst case if every lookup matches: ${sample.length} credits.`);

const run = await runLookups(db, {
  provider,
  candidates: sample,
  options: {
    dryRun: !live,
    maxCredits,
    queryOptions: { sendSchool: !flag("no-school"), minLikelihood: Number(opt("min-likelihood", 6)) }
  }
});

if (!live) {
  const planned = run.outcomes.filter((o) => o.status === "planned");
  const withSchool = planned.filter((o) => o.query.school).length;
  console.log(`Planned lookups: ${planned.length} (${withSchool} include the training institution); skipped: ${run.outcomes.length - planned.length}`);
  console.log("Nothing was sent and nothing was written. Add --live to run it.");
  process.exit(0);
}

console.log(`Run ${run.runId}: spent ${run.creditsSpent} credits${run.stoppedBecause ? `; stopped early: ${run.stoppedBecause}` : ""}`);
console.table(run.summary);

fs.mkdirSync("exports", { recursive: true });
const file = path.join("exports", `bakeoff-${provider.id}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`);
const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const lines = [["candidate_id", "group", "status", "error", "likelihood", "decision", "score", "profile_linkedin", "register_linkedin", "email_available", "phone_available", "socials", "reasons", "conflicts"].join(",")];
for (const o of run.outcomes) {
  const p = o.result?.person;
  lines.push([o.row.id, o.row.sampleGroup, o.status, o.errorCode, o.result?.likelihood, o.verdict?.decision, o.verdict?.score, p?.linkedinUrl, o.row.linkedin_url,
    p ? Boolean(p.contactAvailability?.email || p.emails?.length) : "", p ? Boolean(p.contactAvailability?.phone || p.phones?.length) : "",
    p?.socials?.map((s) => s.network).join(" "), o.verdict?.reasons?.join(" | "), o.verdict?.conflicts?.join(" | ")].map(esc).join(","));
}
fs.writeFileSync(file, lines.join("\n"));
console.log(`Report: ${file}`);
