import fs from "node:fs";
import { parseCsv } from "../csv.mjs";
import { splitEmail } from "./patterns.mjs";

/**
 * Employer name → email domain. Learned from real (employer, address) pairs
 * plus a hand-maintained list (data/reference/employer-email-domains.csv:
 * employer,domain,source) for employers we have no example for yet.
 */

// Free/personal mailbox domains never identify an employer.
export const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.com.au", "hotmail.com", "hotmail.com.au", "outlook.com",
  "outlook.com.au", "live.com", "live.com.au", "icloud.com", "me.com", "bigpond.com", "bigpond.net.au",
  "optusnet.com.au", "aol.com", "protonmail.com", "proton.me", "msn.com", "ymail.com", "rocketmail.com"
]);

const LEGAL_SUFFIX = /\b(pty|ltd|limited|inc|incorporated|co|company|corp|corporation|group|australia|aust|the)\b/g;

/** "CAPITAL PATHOLOGY PTY LTD" and "Capital Pathology" compare equal. */
export function normaliseEmployer(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(LEGAL_SUFFIX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds the index from examples [{ employer, email }] and manual rows
 * [{ employer, domain, source }]. Manual rows win over learned ones.
 * Returns { resolve(employer) → { domain, source, evidence } | null, entries }.
 */
export function buildEmployerIndex(examples = [], manualRows = []) {
  const learned = new Map(); // normalised employer → Map(domain → count)
  for (const { employer, email } of examples) {
    const key = normaliseEmployer(employer);
    const parts = splitEmail(email);
    if (!key || !parts || PERSONAL_DOMAINS.has(parts.domain)) continue;
    const counts = learned.get(key) || new Map();
    counts.set(parts.domain, (counts.get(parts.domain) || 0) + 1);
    learned.set(key, counts);
  }
  const manual = new Map();
  for (const row of manualRows) {
    const key = normaliseEmployer(row.employer);
    const domain = String(row.domain || "").trim().toLowerCase();
    if (key && domain) manual.set(key, { domain, source: row.source || "manual", evidence: 0 });
  }
  const entries = new Map(manual);
  for (const [key, counts] of learned) {
    if (entries.has(key)) continue;
    const [domain, evidence] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    entries.set(key, { domain, source: "learned", evidence });
  }
  return {
    entries,
    resolve(employer) {
      const key = normaliseEmployer(employer);
      return key ? entries.get(key) || null : null;
    }
  };
}

export function loadManualEmployerDomains(file) {
  try {
    return parseCsv(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}
