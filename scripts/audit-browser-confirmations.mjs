#!/usr/bin/env node
/**
 * Spot-check tool for the browser agent's autonomous confirmations.
 * Lists recent candidates confirmed by identity_provider = 'browser_agent_salesnav',
 * with the exact Sales Navigator lead that was found (from browser_leads) and
 * the scoring reasons that cleared the auto-confirm bar — everything needed
 * for a quick "surprise inspection" without re-researching each candidate.
 *
 * Usage: node scripts/audit-browser-confirmations.mjs [--limit=20] [--since=2026-09-20]
 */
import { db } from "../src/db.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, val] = arg.replace(/^--/, "").split("=");
    return [key, val === undefined ? true : val];
  })
);

const limit = Number(args.limit || 20);
const since = args.since ? String(args.since) : null;

const rows = db.prepare(`
  SELECT c.id, c.full_name, c.ahpra_number, c.profession, c.state, c.employer, c.current_title,
         c.linkedin_url, c.identity_match_score, c.match_reasons, c.identity_reviewed_at,
         bl.headline, bl.location, bl.education_snippet, bl.created_at AS lead_found_at
  FROM candidates c
  LEFT JOIN browser_leads bl ON bl.candidate_id = c.id AND bl.linkedin_url = c.linkedin_url
  WHERE c.identity_provider = 'browser_agent_salesnav'
    ${since ? "AND c.identity_reviewed_at >= ?" : ""}
  ORDER BY c.identity_reviewed_at DESC
  LIMIT ?
`).all(...(since ? [since, limit] : [limit]));

if (!rows.length) {
  console.log("No browser-agent confirmations recorded yet.");
  process.exit(0);
}

console.log(`===============================================================`);
console.log(`  BROWSER AGENT AUTO-CONFIRMATIONS — last ${rows.length}`);
console.log(`===============================================================\n`);

for (const row of rows) {
  const reasons = (() => { try { return JSON.parse(row.match_reasons || "[]").join("; "); } catch { return ""; } })();
  console.log(`#${row.id}  ${row.full_name}  (${row.ahpra_number || "no AHPRA #"})`);
  console.log(`  Profession/state: ${row.profession || "-"} / ${row.state || "-"}`);
  console.log(`  Confirmed via:    ${row.linkedin_url}`);
  console.log(`  Sales Nav found:  ${row.headline || "-"} @ ${row.employer || "-"} · ${row.location || "-"}`);
  if (row.education_snippet) console.log(`  Education snippet: ${row.education_snippet.slice(0, 140)}${row.education_snippet.length > 140 ? "..." : ""}`);
  console.log(`  Score: ${row.identity_match_score}  Reasons: ${reasons || "-"}`);
  console.log(`  Confirmed at: ${row.identity_reviewed_at}  (lead found: ${row.lead_found_at || "unknown"})`);
  console.log("");
}

const total = db.prepare("SELECT COUNT(*) c FROM candidates WHERE identity_provider = 'browser_agent_salesnav'").get().c;
console.log(`Total browser-agent confirmations to date: ${total}`);
