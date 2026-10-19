import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import readXlsxFile from "read-excel-file/node";
import { parseCsv, toCsv } from "./csv.mjs";
import { campaignEligibility, estimateCredits, scoreIdentityMatch, compactCandidateForAi, formatStructuredReviewNotes, hasHardIdentityConflict } from "./domain.mjs";
import { candidateDetail, listCandidates } from "./candidates.mjs";
import { insertCandidateRows } from "./importer.mjs";
import { recordVerifiedProfileLocation } from "./au-location.mjs";
import { claimEligibility, browserDiscoveryClaimOptions } from "./pipeline-orchestrator.mjs";
import { findProfileCandidates } from "./identity-search.mjs";
import { controlledCsv, controlledCsvProvider, normalizeControlledCsvResult } from "./providers/controlled-csv.mjs";
import { applyContactResult, createEnrichmentBatch, recordActualCredits } from "./enrichment.mjs";
import { campaignReadyRows, syncCampaignEligibility } from "./campaign.mjs";
import { ClayMcpClient, pruneSubroutines, pruneTaskContext } from "./clay-mcp.mjs";
import { primaryAustralianQualification } from "./qualification-parser.mjs";
import { LocationAgents } from "./location-agents.mjs";
import { ExtractionBotControl } from './extraction-bot-control.mjs';

loadEnv();
const { db, audit } = await import("./db.mjs");
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const config = {
  defaultBudget: Number(process.env.DEFAULT_CREDIT_BUDGET || 350),
  identityCredits: Number(process.env.IDENTITY_CREDIT_ESTIMATE || 1),
  identityValidationCredits: Number(process.env.CLAY_IDENTITY_VALIDATION_ESTIMATE || 10),
  emailCredits: Number(process.env.EMAIL_CREDIT_ESTIMATE || 3),
  phoneCredits: Number(process.env.PHONE_CREDIT_ESTIMATE || 9)
  ,maxBatchRecords: Number(process.env.PILOT_RECORD_CEILING || 4)
  ,phoneEnabled: process.env.PHONE_ENRICHMENT_ENABLED === "true"
  ,maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 25_000_000)
  ,maxRequestBytes: Number(process.env.MAX_REQUEST_BYTES || 36_000_000)
  ,matchThresholds: {
    high: Number(process.env.MATCH_HIGH_THRESHOLD || 85),
    manual: Number(process.env.MATCH_MANUAL_THRESHOLD || 60)
  }
};
config.creditEstimates = { identity: config.identityCredits, email: config.emailCredits, phone: config.phoneCredits };
const clayMcp = new ClayMcpClient({
  redirectUri: `http://${host}:${port}/api/clay/oauth/callback`,
  metadataPath: path.join(path.dirname(path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite")), "clay-mcp-client.json"),
  tokenPath: path.join(path.dirname(path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite")), ".clay-tokens.json")
});
const locationAgents = new LocationAgents({ root, database: process.env.DATABASE_PATH || './data/hcrhub.sqlite', maxUploadBytes: config.maxUploadBytes });
const extractionBot = new ExtractionBotControl({root,directory:path.join(path.dirname(path.resolve(process.env.DATABASE_PATH||'./data/hcrhub.sqlite')),'extraction-bot')});

function loadEnv() {
  const filename = path.resolve(".env");
  if (!fs.existsSync(filename)) return;
  for (const line of fs.readFileSync(filename, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] == null) process.env[match[1]] = match[2];
  }
}

function json(res, status, value) {
  res.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }));
  res.end(JSON.stringify(value));
}

function text(res, status, value, type = "text/plain; charset=utf-8") {
  res.writeHead(status, securityHeaders({ "content-type": type, "cache-control": "no-store" }));
  res.end(value);
}

function redirect(res, location) {
  res.writeHead(302, securityHeaders({ location, "cache-control": "no-store" }));
  res.end();
}

function securityHeaders(headers) {
  return {
    ...headers,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'"
  };
}

async function readJson(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  try {
    return JSON.parse(await readBody(req, config.maxRequestBytes));
  } catch (error) {
    if (error.message === "Request is too large") throw error;
    throw new Error("Request body is not valid JSON");
  }
}

async function readBody(req, maxBytes = 40_000_000) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Request is too large");
  }
  return body;
}

function recomputeCampaignStatus(candidateId) {
  return syncCampaignEligibility(db, candidateId);
}

// Confirming an identity is the one action that unlocks contact enrichment and
// campaign export, so it is the one decision worth a server-side guardrail even
// though the review endpoints otherwise trust the caller's judgment (human or
// AI). If this candidate already carries a recorded hard conflict — overseas
// location, a non-Australian phone, or a prior namesake demotion — a bare
// "confirmed" call is refused; the caller must set overrideConfirmed=true and
// write down why in notes, so an override is deliberate and auditable rather
// than a silent status flip over evidence the system already flagged.
function assertConfirmationAllowed(candidateId, status, payload) {
  if (status !== "confirmed") return;
  const candidate = db.prepare("SELECT conflicting_evidence FROM candidates WHERE id = ?").get(candidateId);
  if (!candidate || !hasHardIdentityConflict(candidate)) return;
  if (!payload.overrideConfirmed) {
    throw new Error("Candidate has a recorded hard identity conflict (overseas location, non-Australian phone, or a prior namesake demotion). Confirming requires overrideConfirmed=true and a documented reason in notes.");
  }
  if (!String(payload.notes || payload.recruiterNotes || "").trim()) {
    throw new Error("Overriding a recorded hard identity conflict requires a documented reason in notes.");
  }
}

// Deliberately reads straight off tables the browser agent writes to in
// real time (browser_leads on every search attempt, candidates.updated_at
// on every decision) rather than the script reporting its own status — so
// this reflects what's actually in the database right now, including from
// a batch running in a different process, with no extra instrumentation to
// keep in sync.
// The current search round (scripts/auto-run-browser-agent.mjs's
// BROWSER_ATTEMPTED_SINCE), written to data/imports/current-round.txt at launch.
function currentSearchRound() {
  try {
    const roundPath = path.join(path.dirname(path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite")), "imports", "current-round.txt");
    return fs.readFileSync(roundPath, "utf8").trim() || null;
  } catch { return null; }
}

// "Still to search" scans every candidate (~0.4s at 530k rows), so it's
// cached rather than recomputed on every 4-second poll.
let remainingCache = { at: 0, round: null, value: null };
function roundRemaining(round) {
  if (remainingCache.round === round && Date.now() - remainingCache.at < 30000) return remainingCache.value;
  const { whereClause, params } = claimEligibility(browserDiscoveryClaimOptions(round));
  const value = db.prepare(`SELECT COUNT(*) total, SUM(id <= ?) act FROM candidates WHERE ${whereClause}`).get(ACT_LAST_ID, ...params);
  remainingCache = { at: Date.now(), round, value };
  return value;
}
const ACT_LAST_ID = 8951; // ids above this came from the all-jurisdictions import

function searchRoundStats() {
  const round = currentSearchRound();
  if (!round) return null;
  const outcomes = db.prepare(`SELECT
      COUNT(*) searched,
      SUM(c.identity_status = 'confirmed' AND c.linkedin_url = bl.linkedin_url) confirmed,
      SUM(c.identity_status <> 'confirmed' AND bl.linkedin_url IS NOT NULL AND c.linkedin_url = bl.linkedin_url) review,
      SUM(bl.status = 'not_found') not_found
    FROM browser_leads bl JOIN candidates c ON c.id = bl.candidate_id WHERE bl.created_at >= ?`).get(round);
  // Rate over the last 15 minutes, or over the round so far if it's younger.
  const window = db.prepare(`SELECT COUNT(*) n,
      MIN(15.0, (julianday('now') - julianday(MAX(?, (SELECT MIN(created_at) FROM browser_leads WHERE created_at >= ?)))) * 1440) minutes
    FROM browser_leads WHERE created_at >= datetime('now', '-15 minutes') AND created_at >= ?`).get(round, round, round);
  const perMinute = window.minutes >= 1 ? window.n / window.minutes : null;
  const remaining = roundRemaining(round);
  return {
    round, ...outcomes, perMinute,
    remaining: remaining.total || 0,
    remainingAct: remaining.act || 0,
    remainingNational: (remaining.total || 0) - (remaining.act || 0),
    etaDays: perMinute > 0 ? (remaining.total || 0) / perMinute / 1440 : null
  };
}

function browserAgentLive({ limit = 50, offset = 0 } = {}) {
  const funnel = db.prepare(`SELECT
    COUNT(*) total,
    SUM(identity_provider = 'browser_agent_salesnav' AND identity_status = 'confirmed') salesnav_confirmed,
    SUM(identity_provider = 'academic_resolver' AND identity_status = 'confirmed') academic_confirmed,
    SUM(identity_provider = 'browser_agent_salesnav' AND workflow_stage = 'manual_review') salesnav_manual_review,
    SUM(workflow_stage = 'identity_unresolved') unresolved,
    SUM(workflow_stage = 'claiming_browser_discovery') currently_claimed,
    SUM(linkedin_url IS NOT NULL AND linkedin_url <> '') with_linkedin,
    SUM(workflow_stage IN ('source_imported', 'manual_review') AND (linkedin_url IS NULL OR linkedin_url = '')) still_queued
    FROM candidates`).get();
  const totalLeads = db.prepare("SELECT COUNT(*) n FROM browser_leads").get().n;
  // Bounded, not "everything in one response": the leads table grows by one
  // row per candidate processed and can reach into the thousands over a full
  // run. Every poll re-fetching the whole table would get slower and slower
  // as the run progresses. Instead the live feed auto-refreshes just the
  // most recent page (offset 0) and the page can page back through history
  // with limit/offset — see public/live-agent.js's "Load older" control.
  const recentLeads = db.prepare(`
    SELECT bl.id, bl.candidate_id, bl.linkedin_url, bl.matched_full_name, bl.status, bl.created_at,
      c.full_name candidate_name, c.identity_status, c.workflow_stage, c.identity_match_score, c.match_confidence,
      c.identity_provider, c.linkedin_url candidate_linkedin_url
    FROM browser_leads bl JOIN candidates c ON c.id = bl.candidate_id
    ORDER BY bl.id DESC LIMIT ? OFFSET ?
  `).all(limit, offset);
  const lastActivity = db.prepare("SELECT MAX(created_at) latest FROM browser_leads").get().latest;
  return { funnel, round: searchRoundStats(), recentLeads, totalLeads, offset, limit, hasMore: offset + recentLeads.length < totalLeads, lastActivity, serverTime: new Date().toISOString() };
}

function dashboard() {
  const counts = db.prepare(`SELECT
    COUNT(*) total,
    SUM(identity_status = 'confirmed') confirmed,
    SUM(email_status = 'valid') valid_emails,
    SUM(campaign_status = 'ready') campaign_ready,
    SUM(identity_status = 'manual_review' OR identity_confidence < 85) needs_review
    FROM candidates`).get();
  counts.registration_records = db.prepare("SELECT COUNT(*) count FROM registrations").get().count;
  const latestImport = db.prepare("SELECT * FROM imports ORDER BY id DESC LIMIT 1").get() || null;
  const batches = db.prepare("SELECT * FROM enrichment_batches ORDER BY id DESC LIMIT 10").all();
  return { counts, latestImport, batches, config };
}

function excelCellText(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

async function importCandidates(payload) {
  if (!payload.filename) throw new Error("Filename is required");
  const extension = path.extname(payload.filename).toLowerCase();
  const sourceBytes = extension === ".xlsx"
    ? Buffer.from(payload.fileBase64 || "", "base64")
    : Buffer.from(payload.csvText || "", "utf8");
  if (sourceBytes.length > config.maxUploadBytes) throw new Error(`Source file exceeds the ${config.maxUploadBytes}-byte upload limit`);
  const fileHash = crypto.createHash("sha256").update(sourceBytes).digest("hex");
  const previous = db.prepare("SELECT * FROM imports WHERE file_hash = ?").get(fileHash);
  if (previous) return {
    importId: previous.id, rows: previous.total_rows, inserted: 0, duplicates: previous.total_rows,
    rejected: 0, alreadyImported: true
  };
  let rows;
  if (extension === ".xlsx") {
    if (!payload.fileBase64) throw new Error("Excel file content is required");
    const parsedWorkbook = await readXlsxFile(sourceBytes);
    const matrix = Array.isArray(parsedWorkbook[0]?.data) ? parsedWorkbook[0].data : parsedWorkbook;
    if (!matrix.length) throw new Error("The workbook has no rows");
    const headers = matrix[0].map(excelCellText);
    rows = matrix.slice(1).map((values) => Object.fromEntries(
      headers.map((header, index) => [header, excelCellText(values[index])])
    )).filter((record) => Object.values(record).some(Boolean));
  } else if (extension === ".csv") {
    if (!payload.csvText) throw new Error("CSV content is required");
    rows = parseCsv(payload.csvText);
  } else {
    throw new Error("Use an .xlsx or .csv file");
  }
  const importResult = db.prepare("INSERT INTO imports(filename, file_hash, source_name, agreement_reference, total_rows) VALUES (?, ?, ?, ?, ?)")
    .run(payload.filename, fileHash, payload.sourceName || "AHPRA licensed data", payload.agreementReference || "", rows.length);
  const importId = Number(importResult.lastInsertRowid);
  let inserted, duplicates, rejected;
  db.exec("BEGIN");
  try {
    ({ inserted, duplicates, rejected } = insertCandidateRows(db, importId, rows));
    db.prepare("UPDATE imports SET inserted_rows = ?, duplicate_rows = ?, rejected_rows = ? WHERE id = ?")
      .run(inserted, duplicates, rejected, importId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("import.completed", "import", importId, { rows: rows.length, inserted, duplicates, rejected });
  return { importId, rows: rows.length, inserted, duplicates, rejected };
}

function batchCsv(batchId) {
  const batch = db.prepare("SELECT * FROM enrichment_batches WHERE id = ?").get(batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.dry_run) throw new Error("Dry-run batches cannot accept provider results; create an approved controlled batch first");
  const rows = db.prepare(`SELECT c.id candidate_id, c.ahpra_number, c.full_name, c.first_name, c.middle_name, c.last_name,
    c.linkedin_url, c.employer company_name,
    CASE WHEN instr(c.work_email, '@') > 0 THEN substr(c.work_email, instr(c.work_email, '@') + 1) ELSE '' END company_domain,
    c.work_email existing_work_email, c.suburb, c.state, c.postcode, c.profession, c.qualifications
    FROM enrichment_batch_items i JOIN candidates c ON c.id = i.candidate_id WHERE i.batch_id = ? ORDER BY c.id`).all(batchId);
  return controlledCsv(rows);
}

function importEnrichmentResults(payload) {
  const batchId = Number(payload.batchId);
  if (!Number.isInteger(batchId)) throw new Error("A valid batch is required");
  const batch = db.prepare("SELECT * FROM enrichment_batches WHERE id = ?").get(batchId);
  if (!batch) throw new Error("Batch not found");
  const rows = parseCsv(payload.csvText || "");
  let updated = 0, skipped = 0;
  const belongs = db.prepare("SELECT 1 FROM enrichment_batch_items WHERE batch_id = ? AND candidate_id = ?");
  const updateIdentity = db.prepare(`UPDATE candidates SET linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
    employer = COALESCE(NULLIF(?, ''), employer), company_domain = COALESCE(NULLIF(?, ''), company_domain),
    current_title = COALESCE(NULLIF(?, ''), current_title), identity_match_score = ?, match_confidence = ?,
    match_reasons = ?, conflicting_evidence = ?, identity_provider = ?,
    identity_provider_reference = NULLIF(?, ''), identity_discovered_at = CURRENT_TIMESTAMP,
    identity_status = 'manual_review', workflow_stage = 'manual_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  const replaceValidatedIdentity = db.prepare(`UPDATE candidates SET linkedin_url = NULLIF(?, ''),
    employer = NULLIF(?, ''), company_domain = NULLIF(?, ''), current_title = NULLIF(?, ''),
    identity_match_score = ?, match_confidence = ?, match_reasons = ?, conflicting_evidence = ?,
    identity_provider = ?, identity_provider_reference = NULLIF(?, ''), identity_discovered_at = CURRENT_TIMESTAMP,
    identity_status = 'manual_review', workflow_stage = 'manual_review', updated_at = CURRENT_TIMESTAMP WHERE id = ?`);
  const addResponse = db.prepare(`INSERT INTO provider_responses
    (candidate_id, provider, provider_reference, response_kind, payload_json) VALUES (?, ?, ?, ?, ?)`);
  const addEvidence = db.prepare(`INSERT INTO match_evidence
    (candidate_id, score, confidence_band, reasons_json, conflicts_json, provider, provider_reference)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const result = normalizeControlledCsvResult(row);
      const candidate = Number.isInteger(result.candidateId)
        ? db.prepare("SELECT * FROM candidates WHERE id = ?").get(result.candidateId) : null;
      if (!candidate || !belongs.get(batchId, result.candidateId)) { skipped += 1; continue; }
      addResponse.run(result.candidateId, batch.provider, result.providerReference, batch.kind, JSON.stringify(row));
      if (result.errorCode) {
        const resultKinds = batch.kind === "email_phone" ? ["email", "phone"] : [batch.kind];
        for (const resultKind of resultKinds) {
          const credits = batch.kind === "email_phone"
            ? (resultKind === "email" ? result.emailActualCredits : result.phoneActualCredits)
            : result.actualCredits;
          recordActualCredits(db, { batchId, candidateId: result.candidateId, kind: resultKind, credits,
            providerReference: result.providerReference });
        }
        db.prepare(`UPDATE enrichment_jobs SET status = 'failed', error_code = ?, error_message = ?,
          completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
          WHERE batch_id = ? AND candidate_id = ?`)
          .run(result.errorCode, result.errorMessage || "Provider returned an error", batchId, result.candidateId);
        db.prepare("UPDATE candidates SET workflow_stage = 'enrichment_failed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(result.candidateId);
        audit("enrichment.result_received", "candidate", result.candidateId,
          { batchId, kind: batch.kind, status: "failed", errorCode: result.errorCode });
        skipped += 1;
        continue;
      }
      if (batch.kind === "identity") {
        const credit = recordActualCredits(db, { batchId, candidateId: result.candidateId, kind: "identity",
          credits: result.actualCredits, providerReference: result.providerReference });
        const match = scoreIdentityMatch(candidate, result, config.matchThresholds);
        const identityUpdate = batch.provider === "clay_mcp_validator" ? replaceValidatedIdentity : updateIdentity;
        identityUpdate.run(result.linkedinUrl, result.employer, result.companyDomain, result.currentTitle,
          match.score, match.confidence, JSON.stringify(match.reasons), JSON.stringify(match.conflicts),
          batch.provider, result.providerReference, result.candidateId);
        addEvidence.run(result.candidateId, match.score, match.confidence, JSON.stringify(match.reasons),
          JSON.stringify(match.conflicts), batch.provider, result.providerReference);
      } else {
        const jobKinds = batch.kind === "email_phone" ? ["email", "phone"] : [batch.kind];
        let stopped = false;
        for (const jobKind of jobKinds) {
          const credits = batch.kind === "email_phone"
            ? (jobKind === "email" ? result.emailActualCredits : result.phoneActualCredits)
            : result.actualCredits;
          const credit = recordActualCredits(db, { batchId, candidateId: result.candidateId, kind: jobKind,
            credits, providerReference: result.providerReference });
          if (credit.overBudget) { stopped = true; break; }
        }
        if (stopped) { skipped += 1; continue; }
        applyContactResult(db, { batch, candidate, result, config });
        recomputeCampaignStatus(result.candidateId);
      }
      updated += 1;
      audit("enrichment.result_received", "candidate", result.candidateId,
        { batchId, kind: batch.kind, status: "completed", providerReference: result.providerReference || null });
    }
    db.prepare("UPDATE enrichment_batches SET status = 'results_imported' WHERE id = ? AND status <> 'stopped'").run(batchId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("enrichment.results_imported", "batch", batchId, { updated, skipped, provider: batch.provider, kind: batch.kind });
  return { batchId, rows: rows.length, updated, skipped };
}

function campaignCsv() {
  const rows = campaignReadyRows(db);
  return toCsv(rows, ["candidate_id", "ahpra_number", "full_name", "profession", "state", "employer", "current_title", "work_email", "business_phone", "mobile_phone", "enrichment_source", "enriched_at"]);
}

function clayStructured(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const textContent = result?.content?.find((item) => item.type === "text" && item.text)?.text;
  if (!textContent) return {};
  try { return JSON.parse(textContent); } catch { return { text: textContent }; }
}

async function runClayIdentityPilot(payload) {
  const requestedIds = [...new Set((payload.candidateIds || []).map(Number).filter(Number.isInteger))];
  if (!requestedIds.length) throw new Error("Select at least one candidate");
  if (requestedIds.length > config.maxBatchRecords) throw new Error(`Pilot is limited to ${config.maxBatchRecords} candidates`);

  const validatorName = "Validate Professional Profile and Employment";
  const requestedSubroutine = payload.subroutineName === "Person LinkedIn URL" ? "Person LinkedIn URL" : validatorName;
  const catalog = clayStructured(await clayMcp.listSubroutines());
  const subroutine = catalog.subroutines?.find((item) => item.name === requestedSubroutine);
  if (!subroutine) throw new Error(`Clay ${requestedSubroutine} is not enabled for MCP`);
  const fullNameInput = subroutine.requiredInputs?.find((item) => item.type === "full-name" || /^full name$/i.test(item.name));
  if (!fullNameInput) throw new Error(`Clay ${requestedSubroutine} does not declare a full-name input`);

  const validationRun = requestedSubroutine === validatorName;
  const estimatedCredits = validationRun ? config.identityValidationCredits : config.identityCredits;
  const batchConfig = validationRun
    ? { ...config, creditEstimates: { ...config.creditEstimates, identity: estimatedCredits } }
    : config;
  const provider = validationRun ? "clay_mcp_validator" : "clay_mcp";

  const batch = createEnrichmentBatch(db, {
    candidateIds: requestedIds,
    name: payload.name || (validationRun ? "Clay contextual identity validation" : "Clay identity pilot"),
    kind: "identity",
    provider,
    dryRun: false,
    forceIdentity: validationRun,
    recordCeiling: requestedIds.length,
    creditBudget: Number(payload.creditBudget || Math.ceil(requestedIds.length * estimatedCredits) + 1)
  }, batchConfig, audit);
  const candidates = db.prepare(`SELECT c.id, c.full_name, c.first_name, c.last_name, c.profession, c.qualifications, c.employer, c.suburb, c.state FROM enrichment_batch_items i
    JOIN candidates c ON c.id = i.candidate_id WHERE i.batch_id = ? ORDER BY c.id`).all(batch.batchId);
  try {
    const inputName = (pattern) => subroutine.requiredInputs?.find((item) => pattern.test(item.name))?.name;
    const firstNameInput = inputName(/^first name$/i);
    const lastNameInput = inputName(/^last name$/i);
    const titleInput = inputName(/^existing job title$/i);
    const countryInput = inputName(/^country location$/i);
    const companyNameInput = inputName(/^(company name)$/i);
    const companyDomainInput = inputName(/^(company domain|website)$/i);
    const cleanName = (name) => String(name || "").replace(/^(Dr|Mr|Mrs|Ms|Miss)\s+/i, "").trim();

    const result = await clayMcp.runSubroutineDirect(subroutine.id,
      candidates.map((candidate) => {
        const auQual = primaryAustralianQualification(candidate.qualifications);
        const institution = auQual?.institution;
        const uniDomain = auQual?.domain;
        const companyName = candidate.employer || institution || "Canberra Health Services";
        const companyDomain = uniDomain || (candidate.employer ? null : "canberra.edu.au");

        return {
          [fullNameInput.name]: cleanName(candidate.full_name),
          ...(companyNameInput && companyName ? { [companyNameInput]: companyName } : {}),
          ...(companyDomainInput && companyDomain ? { [companyDomainInput]: companyDomain } : {}),
          ...(countryInput ? { [countryInput]: "Australia" } : {}),
          ...(titleInput ? { [titleInput]: candidate.profession || "Registered Nurse" } : {}),
          ...(firstNameInput && candidate.first_name ? { [firstNameInput]: candidate.first_name } : {}),
          ...(lastNameInput && candidate.last_name ? { [lastNameInput]: candidate.last_name } : {})
        };
      }));
    const task = clayStructured(result);
    const taskId = task.taskId || task.task_id;
    if (!taskId) throw new Error("Clay did not return a task ID");
    db.prepare("UPDATE enrichment_jobs SET status = 'running', provider_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?")
      .run(taskId, batch.batchId);
    db.prepare("UPDATE enrichment_batches SET status = 'running' WHERE id = ?").run(batch.batchId);
    const addAttempt = db.prepare(`INSERT INTO enrichment_attempts
      (job_id, attempt_number, status, estimated_credits, provider_reference)
      SELECT id, 1, 'running', estimated_credits, ? FROM enrichment_jobs WHERE batch_id = ?`);
    addAttempt.run(taskId, batch.batchId);
    audit("clay.identity_started", "batch", batch.batchId, { taskId, records: candidates.length, subroutine: subroutine.name });
    return { ...batch, taskId, subroutine: subroutine.name };
  } catch (error) {
    db.prepare("UPDATE enrichment_jobs SET status = 'failed', error_code = 'CLAY_START_FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?")
      .run(error.message, batch.batchId);
    db.prepare("UPDATE enrichment_batches SET status = 'failed', stopped_reason = ? WHERE id = ?").run(error.message, batch.batchId);
    throw error;
  }
}

async function runClayContactPilot(payload) {
  const requestedIds = [...new Set((payload.candidateIds || []).map(Number).filter(Number.isInteger))];
  if (!requestedIds.length) throw new Error("Select at least one candidate");
  if (requestedIds.length > config.maxBatchRecords) throw new Error(`Pilot is limited to ${config.maxBatchRecords} candidates`);
  if (!config.phoneEnabled) throw new Error("Phone enrichment is disabled. Set PHONE_ENRICHMENT_ENABLED=true only after approval");

  const subroutineName = "Enrich Person and Find Contact Details";
  const catalog = clayStructured(await clayMcp.listSubroutines());
  const subroutine = catalog.subroutines?.find((item) => item.name === subroutineName);
  if (!subroutine) throw new Error(`Clay ${subroutineName} is not enabled for MCP`);
  const profileInput = subroutine.requiredInputs?.find((item) =>
    item.type === "person-linkedin-url" || /social profile url|professional profile url/i.test(item.name));
  if (!profileInput) throw new Error(`Clay ${subroutineName} does not declare a professional-profile input`);

  const batch = createEnrichmentBatch(db, {
    candidateIds: requestedIds,
    name: payload.name || "Clay verified contact pilot",
    kind: "email_phone",
    provider: "clay_mcp_contact",
    dryRun: false,
    force: payload.force ?? true,
    recordCeiling: requestedIds.length,
    creditBudget: Number(payload.creditBudget || Math.ceil(requestedIds.length * (config.emailCredits + config.phoneCredits)) + 1)
  }, config, audit);
  const candidates = db.prepare(`SELECT c.id, c.linkedin_url FROM enrichment_batch_items i
    JOIN candidates c ON c.id = i.candidate_id WHERE i.batch_id = ? ORDER BY c.id`).all(batch.batchId);
  if (candidates.some((candidate) => !candidate.linkedin_url)) {
    throw new Error("Every contact-enrichment candidate must have a confirmed LinkedIn URL");
  }
  try {
    const result = await clayMcp.runSubroutineDirect(subroutine.id,
      candidates.map((candidate) => ({ [profileInput.name]: candidate.linkedin_url })));
    const task = clayStructured(result);
    const taskId = task.taskId || task.task_id;
    if (!taskId) throw new Error("Clay did not return a task ID");
    db.prepare("UPDATE enrichment_jobs SET status = 'running', provider_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?")
      .run(taskId, batch.batchId);
    db.prepare("UPDATE enrichment_batches SET status = 'running' WHERE id = ?").run(batch.batchId);
    const addAttempt = db.prepare(`INSERT INTO enrichment_attempts
      (job_id, attempt_number, status, estimated_credits, provider_reference)
      SELECT id, 1, 'running', estimated_credits, ? FROM enrichment_jobs WHERE batch_id = ?`);
    addAttempt.run(taskId, batch.batchId);
    audit("clay.contact_started", "batch", batch.batchId,
      { taskId, records: candidates.length, subroutine: subroutine.name });
    return { ...batch, taskId, subroutine: subroutine.name };
  } catch (error) {
    db.prepare("UPDATE enrichment_jobs SET status = 'failed', error_code = 'CLAY_START_FAILED', error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE batch_id = ?")
      .run(error.message, batch.batchId);
    db.prepare("UPDATE enrichment_batches SET status = 'failed', stopped_reason = ? WHERE id = ?").run(error.message, batch.batchId);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith('/api/extraction-bot')) {
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Error('Origin does not match this dashboard');
      if (url.pathname === '/api/extraction-bot' && req.method === 'GET') return json(res, 200, extractionBot.status());
      if (url.pathname === '/api/extraction-bot/start' && req.method === 'POST') { await readJson(req); return json(res, 202, extractionBot.start()); }
      if (url.pathname === '/api/extraction-bot/pause' && req.method === 'POST') { await readJson(req); return json(res, 200, extractionBot.pause()); }
      return json(res,404,{error:'Extraction bot endpoint not found'});
    }
    if (url.pathname.startsWith('/api/location-agents')) {
      if (req.method === 'POST' && req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) throw new Error('Origin does not match this dashboard');
      if (url.pathname === '/api/location-agents' && req.method === 'GET') return json(res, 200, { jobs: locationAgents.list() });
      if (url.pathname === '/api/location-agents' && req.method === 'POST') return json(res, 202, locationAgents.create(await readJson(req)));
      const match = url.pathname.match(/^\/api\/location-agents\/([a-f0-9-]{36})(?:\/(verify|stop|export))?$/);
      if (match) {
        const [, id, action] = match;
        if (!action && req.method === 'GET') return json(res, 200, locationAgents.detail(id, { offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 50) }));
        if (action === 'verify' && req.method === 'POST') return json(res, 202, locationAgents.startVerification(id, await readJson(req)));
        if (action === 'stop' && req.method === 'POST') { await readJson(req); return json(res, 200, locationAgents.stop(id)); }
        if (action === 'export' && req.method === 'GET') {
          const filename = url.searchParams.get('file') || 'results.csv';
          const bytes = locationAgents.download(id, filename);
          res.writeHead(200, securityHeaders({ 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${filename}"` }));
          return res.end(bytes);
        }
      }
      return json(res, 404, { error: 'Location agent endpoint not found' });
    }
    if (req.method === "GET" && url.pathname === "/api/dashboard") return json(res, 200, dashboard());
    if (req.method === "GET" && url.pathname === "/api/browser-agent/live") {
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") || 50)), 500);
      const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
      return json(res, 200, browserAgentLive({ limit, offset }));
    }
    if (req.method === "GET" && url.pathname === "/api/providers") return json(res, 200, { providers: [controlledCsvProvider] });
    if (req.method === "GET" && url.pathname === "/api/clay/status") return json(res, 200, clayMcp.status());
    if (req.method === "POST" && url.pathname === "/api/clay/connect") {
      const authorizationUrl = await clayMcp.beginAuthorization();
      audit("clay.oauth_started", "provider", "clay_mcp", {});
      return json(res, 200, { authorizationUrl });
    }
    if (req.method === "GET" && url.pathname === "/api/clay/oauth/callback") {
      try {
        await clayMcp.completeAuthorization({
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          error: url.searchParams.get("error"),
          errorDescription: url.searchParams.get("error_description")
        });
        audit("clay.oauth_connected", "provider", "clay_mcp", { tools: clayMcp.status().tools.length });
        return redirect(res, "/?clay=connected");
      } catch (error) {
        audit("clay.oauth_failed", "provider", "clay_mcp", { reason: error.message });
        return redirect(res, `/?clay=error&message=${encodeURIComponent(error.message)}`);
      }
    }
    if (req.method === "POST" && url.pathname === "/api/clay/tools/refresh") {
      await clayMcp.refreshTools();
      return json(res, 200, clayMcp.status());
    }
    if (req.method === "GET" && url.pathname === "/api/clay/subroutines") {
      const raw = await clayMcp.listSubroutines();
      if (url.searchParams.get("compact") === "true") {
        return json(res, 200, pruneSubroutines(clayStructured(raw)));
      }
      return json(res, 200, raw);
    }
    if (req.method === "GET" && url.pathname === "/api/clay/credits") {
      return json(res, 200, await clayMcp.creditsAvailable());
    }
    if (req.method === "POST" && url.pathname === "/api/clay/subroutines/options") {
      return json(res, 200, await clayMcp.subroutineInputOptions(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/clay/identity/run") {
      return json(res, 202, await runClayIdentityPilot(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/clay/contact/run") {
      return json(res, 202, await runClayContactPilot(await readJson(req)));
    }
    if (req.method === "GET" && url.pathname.match(/^\/api\/clay\/tasks\/[^/]+$/)) {
      const taskId = decodeURIComponent(url.pathname.split("/")[4]);
      const raw = await clayMcp.taskContext(taskId, Number(url.searchParams.get("page") || 1));
      if (url.searchParams.get("compact") === "true") {
        return json(res, 200, pruneTaskContext(clayStructured(raw)));
      }
      return json(res, 200, raw);
    }
    if (req.method === "POST" && url.pathname === "/api/clay/disconnect") {
      await clayMcp.disconnect();
      audit("clay.oauth_disconnected", "provider", "clay_mcp", {});
      return json(res, 200, clayMcp.status());
    }
    if (req.method === "GET" && url.pathname === "/api/candidates") return json(res, 200, listCandidates(db, url.searchParams));
    if (req.method === "GET" && url.pathname === "/api/ai/candidates") {
      const purpose = url.searchParams.get("purpose") || "identity";
      const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") || 25)), 100);
      const status = url.searchParams.get("status") || "";
      const stage = url.searchParams.get("stage") || "";
      const where = [];
      const params = [];
      if (status) { where.push("identity_status = ?"); params.push(status); }
      if (stage) { where.push("workflow_stage = ?"); params.push(stage); }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const rows = db.prepare(`SELECT * FROM candidates ${clause} ORDER BY id ASC LIMIT ?`).all(...params, limit);
      const compact = rows.map((row) => compactCandidateForAi(row, purpose));
      return json(res, 200, { candidates: compact, count: compact.length, purpose });
    }
    if (req.method === "POST" && url.pathname === "/api/ai/review") {
      const payload = await readJson(req);
      const candidateId = Number(payload.candidateId || payload.id);
      if (!Number.isInteger(candidateId)) throw new Error("A valid candidateId is required");
      const status = ["confirmed", "manual_review", "rejected"].includes(payload.decision || payload.identityStatus)
        ? (payload.decision || payload.identityStatus) : "manual_review";
      assertConfirmationAllowed(candidateId, status, payload);
      const notes = formatStructuredReviewNotes({
        decision: status,
        tags: payload.tags || [],
        customNote: payload.notes || payload.recruiterNotes || ""
      });
      db.prepare(`UPDATE candidates SET identity_status = ?, linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
        employer = COALESCE(NULLIF(?, ''), employer), current_title = COALESCE(NULLIF(?, ''), current_title),
        contact_basis_approved = ?, recruiter_notes = ?, reviewer_decision = ?, identity_reviewed_at = CURRENT_TIMESTAMP,
        workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(status, payload.linkedinUrl || "", payload.employer || "", payload.currentTitle || "",
          payload.contactBasisApproved ? 1 : 0, notes, status,
          status === "confirmed" ? "identity_confirmed" : status === "rejected" ? "identity_rejected" : "manual_review", candidateId);
      db.prepare(`INSERT INTO review_history(candidate_id, decision, match_score, notes, reviewer)
        SELECT id, ?, identity_match_score, ?, ? FROM candidates WHERE id = ?`)
        .run(status, notes, payload.reviewer || "AI Recruiter", candidateId);
      if (status === "confirmed") recordVerifiedProfileLocation(db, candidateId);
      recomputeCampaignStatus(candidateId);
      audit("candidate.reviewed_by_ai", "candidate", candidateId, { status, tagsCount: (payload.tags || []).length });
      return json(res, 200, { ok: true, candidateId, status, notes });
    }
    if (req.method === "POST" && url.pathname === "/api/identity/match") {
      const payload = await readJson(req);
      if (!String(payload.fullName || "").trim()) throw new Error("LinkedIn full name is required");
      return json(res, 200, { matches: findProfileCandidates(db, payload, Math.min(Number(payload.limit) || 5, 20)) });
    }
    if (req.method === "GET" && url.pathname.match(/^\/api\/candidates\/\d+$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const detail = candidateDetail(db, id);
      return detail ? json(res, 200, detail) : json(res, 404, { error: "Candidate not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/import") return json(res, 201, await importCandidates(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/enrichment/batches") return json(res, 201, createEnrichmentBatch(db, await readJson(req), config, audit));
    if (req.method === "POST" && url.pathname === "/api/enrichment/results") return json(res, 200, importEnrichmentResults(await readJson(req)));
    if (req.method === "GET" && url.pathname.match(/^\/api\/enrichment\/batches\/\d+\/csv$/)) {
      const id = Number(url.pathname.split("/")[4]);
      return text(res, 200, batchCsv(id), "text/csv; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/\d+\/review$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const payload = await readJson(req);
      const status = ["confirmed", "manual_review", "rejected"].includes(payload.identityStatus) ? payload.identityStatus : "manual_review";
      assertConfirmationAllowed(id, status, payload);
      db.prepare(`UPDATE candidates SET identity_status = ?, linkedin_url = COALESCE(NULLIF(?, ''), linkedin_url),
        employer = COALESCE(NULLIF(?, ''), employer), current_title = COALESCE(NULLIF(?, ''), current_title),
        contact_basis_approved = ?, recruiter_notes = ?, reviewer_decision = ?, identity_reviewed_at = CURRENT_TIMESTAMP,
        workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(status, payload.linkedinUrl || "", payload.employer || "", payload.currentTitle || "",
          payload.contactBasisApproved ? 1 : 0, payload.notes || "", status,
          status === "confirmed" ? "identity_confirmed" : status === "rejected" ? "identity_rejected" : "manual_review", id);
      db.prepare(`INSERT INTO review_history(candidate_id, decision, match_score, notes, reviewer)
        SELECT id, ?, identity_match_score, ?, ? FROM candidates WHERE id = ?`)
        .run(status, payload.notes || "", payload.reviewer || "Local recruiter", id);
      if (status === "confirmed") recordVerifiedProfileLocation(db, id);
      recomputeCampaignStatus(id);
      audit("candidate.reviewed", "candidate", id, { status });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname.match(/^\/api\/candidates\/\d+\/suppression$/)) {
      const id = Number(url.pathname.split("/")[3]);
      const payload = await readJson(req);
      db.prepare("UPDATE candidates SET suppressed = ?, opted_out = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(payload.suppressed ? 1 : 0, payload.optedOut ? 1 : 0, id);
      db.prepare(`INSERT INTO suppression_history(candidate_id, suppressed, opted_out, reason, actor)
        SELECT id, ?, ?, ?, ? FROM candidates WHERE id = ?`)
        .run(payload.suppressed ? 1 : 0, payload.optedOut ? 1 : 0, payload.reason || "", payload.actor || "Local recruiter", id);
      recomputeCampaignStatus(id);
      audit("candidate.suppression_updated", "candidate", id, {
        suppressed: Boolean(payload.suppressed), optedOut: Boolean(payload.optedOut), reason: payload.reason || ""
      });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/api/export/campaign-ready.csv") {
      const csv = campaignCsv();
      audit("campaign.exported", "campaign", "ready", { records: Math.max(0, csv.split(/\r?\n/).length - 1) });
      return text(res, 200, csv, "text/csv; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { status: "ok" });

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return text(res, 404, "Not found");
    const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    return text(res, 200, fs.readFileSync(file), types[path.extname(file)] || "application/octet-stream");
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: error.message || "Unexpected error" });
  }
});

server.listen(port, host, () => console.log(`HCRHUB Candidate Intelligence running at http://${host}:${port}`));
