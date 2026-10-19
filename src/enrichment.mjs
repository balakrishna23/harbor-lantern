import crypto from "node:crypto";
import { estimateCredits } from "./domain.mjs";
import { parseAndValidatePhone } from "./phone-validator.mjs";

const kinds = new Set(["identity", "email", "phone", "email_phone"]);

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

export function enrichmentJobKinds(kind) {
  return kind === "email_phone" ? ["email", "phone"] : [kind];
}

export function idempotencyKey(candidateId, kind, provider = "controlled_csv", dryRun = false) {
  return crypto.createHash("sha256").update(`${provider}:${candidateId}:${kind}:${dryRun ? "dry-run" : "execute"}:v1`).digest("hex");
}

export function createEnrichmentBatch(db, payload, config, audit = () => {}) {
  const ids = [...new Set((payload.candidateIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) throw new Error("Select at least one candidate");
  const kind = kinds.has(payload.kind) ? payload.kind : "identity";
  if ((kind === "phone" || kind === "email_phone") && !config.phoneEnabled) {
    throw new Error("Phone enrichment is disabled. Set PHONE_ENRICHMENT_ENABLED=true only after approval");
  }
  const configuredCeiling = positiveNumber(config.maxBatchRecords, 4);
  const recordCeiling = Math.min(positiveNumber(payload.recordCeiling, configuredCeiling), configuredCeiling);
  if (ids.length > recordCeiling) throw new Error(`Selected ${ids.length} candidates exceeds the ${recordCeiling}-record ceiling`);
  const provider = typeof payload.provider === "string" && payload.provider.startsWith("clay_mcp")
    ? payload.provider : "controlled_csv";
  const dryRun = payload.dryRun !== false;
  const placeholders = ids.map(() => "?").join(",");
  const candidates = db.prepare(`SELECT * FROM candidates WHERE id IN (${placeholders})`).all(...ids);
  const accepted = [];
  const warnings = [];
  for (const candidate of candidates) {
    if (kind === "identity" && (!candidate.ahpra_number || candidate.identity_status === "rejected")) {
      warnings.push({ candidateId: candidate.id, reason: "Not eligible for identity discovery" });
      continue;
    }
    if (kind !== "identity" && candidate.identity_status !== "confirmed") {
      warnings.push({ candidateId: candidate.id, reason: "Identity must be recruiter-confirmed first" });
      continue;
    }
    const jobKinds = enrichmentJobKinds(kind);
    const missingKinds = jobKinds.filter((jobKind) => {
      if (jobKind === "identity" && candidate.linkedin_url && !payload.forceIdentity) return false;
      if (jobKind === "email" && candidate.email_status === "valid") return false;
      if (jobKind === "phone" && (candidate.business_phone || candidate.mobile_phone)) return false;
      const key = idempotencyKey(candidate.id, jobKind, provider, dryRun);
      if (payload.force) return true;
      return !db.prepare("SELECT 1 FROM enrichment_jobs WHERE idempotency_key = ?").get(key);
    });
    if (!missingKinds.length) {
      warnings.push({ candidateId: candidate.id, reason: "Data already exists or an equivalent enrichment job was already created" });
      continue;
    }
    if (missingKinds.length !== jobKinds.length) {
      warnings.push({ candidateId: candidate.id, reason: `Only missing enrichment will be queued: ${missingKinds.join(", ")}` });
    }
    accepted.push({ candidate, jobKinds: missingKinds });
  }
  if (!accepted.length) throw new Error(warnings[0]?.reason || "No candidates are eligible for this batch");
  const estimates = accepted.flatMap(({ jobKinds }) => jobKinds.map((jobKind) => ({
    kind: jobKind,
    credits: estimateCredits(1, jobKind, config.creditEstimates)
  })));
  const estimate = Math.round(estimates.reduce((sum, item) => sum + item.credits, 0) * 100) / 100;
  const budget = Math.round(positiveNumber(payload.creditBudget, config.defaultBudget) * 100) / 100;
  if (estimate > budget) throw new Error(`Estimated ${estimate} credits exceeds the ${budget} hard credit ceiling`);

  let batchId;
  db.exec("BEGIN IMMEDIATE");
  try {
    const batch = db.prepare(`INSERT INTO enrichment_batches
      (name, kind, record_count, estimated_credits, credit_budget, provider, dry_run, record_ceiling, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(payload.name || `Pilot batch ${new Date().toISOString().slice(0, 10)}`, kind, accepted.length,
        estimate, budget, provider, dryRun ? 1 : 0, recordCeiling, dryRun ? "dry_run" : "draft");
    batchId = Number(batch.lastInsertRowid);
    const addItem = db.prepare(`INSERT INTO enrichment_batch_items(batch_id, candidate_id, idempotency_key, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)`);
    const addJob = db.prepare(`INSERT INTO enrichment_jobs
      (batch_id, candidate_id, kind, provider, status, idempotency_key, dry_run, estimated_credits)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const addCredit = db.prepare(`INSERT INTO credit_ledger
      (batch_id, job_id, candidate_id, kind, entry_type, credits, provider)
      VALUES (?, ?, ?, ?, 'estimate', ?, ?)`);
    const updateStage = db.prepare("UPDATE candidates SET workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?");
    for (const { candidate, jobKinds } of accepted) {
      addItem.run(batchId, candidate.id, crypto.randomUUID());
      for (const jobKind of jobKinds) {
        if (payload.force) {
          const key = idempotencyKey(candidate.id, jobKind, provider, dryRun);
          const existingJobs = db.prepare("SELECT id FROM enrichment_jobs WHERE idempotency_key = ?").all(key);
          for (const ej of existingJobs) {
            db.prepare("DELETE FROM provider_responses WHERE job_id = ?").run(ej.id);
            db.prepare("DELETE FROM match_evidence WHERE job_id = ?").run(ej.id);
            db.prepare("DELETE FROM enrichment_attempts WHERE job_id = ?").run(ej.id);
            db.prepare("DELETE FROM credit_ledger WHERE job_id = ?").run(ej.id);
            db.prepare("DELETE FROM enrichment_jobs WHERE id = ?").run(ej.id);
          }
        }
        const credits = estimateCredits(1, jobKind, config.creditEstimates);
        const job = addJob.run(batchId, candidate.id, jobKind, provider, dryRun ? "dry_run" : "queued",
          idempotencyKey(candidate.id, jobKind, provider, dryRun), dryRun ? 1 : 0, credits);
        addCredit.run(batchId, Number(job.lastInsertRowid), candidate.id, jobKind, credits, provider);
        audit("enrichment.requested", "job", Number(job.lastInsertRowid), { batchId, candidateId: candidate.id, kind: jobKind, dryRun, estimatedCredits: credits });
      }
      if (!dryRun) updateStage.run(kind === "identity" ? "identity_discovery_queued" : kind === "email" ? "email_queued" : "phone_queued", candidate.id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  audit("enrichment.batch_created", "batch", batchId, { kind, records: accepted.length, estimate, budget, recordCeiling, dryRun });
  return { batchId, records: accepted.length, excluded: ids.length - accepted.length, estimatedCredits: estimate,
    budget, recordCeiling, dryRun, warnings };
}

export function recordActualCredits(db, { batchId, candidateId, kind, credits, providerReference }) {
  const hasCost = credits !== null && credits !== undefined && credits !== "";
  const amount = Number(hasCost ? credits : 0);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Actual credits must be a non-negative number");
  const batch = db.prepare("SELECT * FROM enrichment_batches WHERE id = ?").get(batchId);
  if (!batch) throw new Error("Batch not found");
  const job = db.prepare("SELECT * FROM enrichment_jobs WHERE batch_id = ? AND candidate_id = ? AND kind = ?").get(batchId, candidateId, kind);
  if (!job) return { recorded: false, reason: "No matching job" };
  if (job.status === "completed") return { recorded: false, reason: "Actual cost already recorded" };
  const overBudget = Number(batch.actual_credits) + amount > Number(batch.credit_budget);
  if (hasCost) {
    db.prepare(`INSERT INTO credit_ledger(batch_id, job_id, candidate_id, kind, entry_type, credits, provider, provider_reference)
      VALUES (?, ?, ?, ?, 'actual', ?, ?, ?)`)
      .run(batchId, job.id, candidateId, kind, amount, job.provider, providerReference || null);
  }
  db.prepare(`UPDATE enrichment_jobs SET actual_credits = ?, status = 'completed', error_code = NULL,
    error_message = NULL, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .run(amount, job.id);
  db.prepare("UPDATE enrichment_batches SET actual_credits = actual_credits + ? WHERE id = ?").run(amount, batchId);
  if (overBudget) {
    db.prepare(`UPDATE enrichment_batches SET status = 'stopped',
      stopped_reason = 'Provider-reported actual credits exceeded the hard credit ceiling' WHERE id = ?`).run(batchId);
  }
  return { recorded: hasCost, completed: true, jobId: job.id, stopped: overBudget, overBudget };
}

export const allowedEmailStatuses = new Set(["valid", "invalid", "risky", "catch_all", "unverified"]);
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function applyContactResult(db, { batch, candidate, result, config }) {
  if (candidate.identity_status !== "confirmed") throw new Error(`Candidate ${candidate.id} identity is not confirmed`);
  const handlesEmail = batch.kind === "email" || batch.kind === "email_phone";
  const handlesPhone = batch.kind === "phone" || batch.kind === "email_phone";
  if (handlesPhone && !config.phoneEnabled) throw new Error("Phone enrichment is disabled");
  if (handlesEmail && result.workEmail && !allowedEmailStatuses.has(result.emailStatus)) {
    throw new Error(`Invalid email status for candidate ${candidate.id}`);
  }
  if (handlesEmail && result.workEmail && !emailPattern.test(result.workEmail)) {
    throw new Error(`Malformed work email for candidate ${candidate.id}`);
  }
  if (handlesEmail && result.emailStatus && !allowedEmailStatuses.has(result.emailStatus)) {
    throw new Error(`Invalid email status for candidate ${candidate.id}`);
  }
  const addContact = db.prepare(`INSERT INTO contact_points
    (candidate_id, kind, contact_value, verification_status, provider, provider_reference, enriched_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`);
  const deactivate = db.prepare("UPDATE contact_points SET active = 0 WHERE candidate_id = ? AND kind = ? AND active = 1");
  const added = [];
  let foreignPhoneDetected = null;
  if (handlesEmail && result.workEmail) {
    deactivate.run(candidate.id, "work_email");
    addContact.run(candidate.id, "work_email", result.workEmail, result.emailStatus || "unverified", batch.provider, result.providerReference || null);
    db.prepare(`UPDATE candidates SET work_email = ?, email_status = ?, enrichment_source = ?, enriched_at = CURRENT_TIMESTAMP,
      workflow_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(result.workEmail, result.emailStatus || "unverified", batch.provider,
        result.emailStatus === "valid" ? "email_verified" : "enrichment_failed", candidate.id);
    added.push("work_email");
  } else if (handlesEmail) {
    db.prepare(`UPDATE candidates SET email_status = 'unverified', workflow_stage = 'contact_unresolved', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(candidate.id);
  }
  if (handlesPhone && result.businessPhone) {
    const bPhone = parseAndValidatePhone(result.businessPhone);
    if (bPhone.isValidAu) {
      deactivate.run(candidate.id, "business_phone");
      addContact.run(candidate.id, "business_phone", bPhone.normalized, "provider_returned", batch.provider, result.providerReference || null);
      db.prepare("UPDATE candidates SET business_phone = ?, enrichment_source = ?, enriched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(bPhone.normalized, batch.provider, candidate.id);
      added.push("business_phone");
    } else if (bPhone.isInternational) {
      db.prepare("UPDATE candidates SET international_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(bPhone.raw, candidate.id);
      foreignPhoneDetected = foreignPhoneDetected || { kind: "business_phone", raw: bPhone.raw };
    }
  }
  if (handlesPhone && result.mobilePhone) {
    const mPhone = parseAndValidatePhone(result.mobilePhone);
    if (mPhone.isValidAu) {
      deactivate.run(candidate.id, "mobile_phone");
      addContact.run(candidate.id, "mobile_phone", mPhone.normalized, "provider_returned", batch.provider, result.providerReference || null);
      db.prepare("UPDATE candidates SET mobile_phone = ?, enrichment_source = ?, enriched_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(mPhone.normalized, batch.provider, candidate.id);
      added.push("mobile_phone");
    } else if (mPhone.isInternational) {
      db.prepare("UPDATE candidates SET international_phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(mPhone.raw, candidate.id);
      foreignPhoneDetected = foreignPhoneDetected || { kind: "mobile_phone", raw: mPhone.raw };
    }
  }

  // Safety net: a confirmed identity that turns out to have a non-Australian
  // phone number is very likely an overseas namesake that slipped past identity
  // scoring (the exact failure mode that previously required a manual, one-off
  // script to find and reverse 37 confirmed candidates after the fact). Re-flag
  // the identity for recruiter re-review immediately instead of leaving it
  // "confirmed" and campaign-eligible while only the raw phone is quarantined.
  if (foreignPhoneDetected) {
    let priorConflicts = [];
    try {
      const parsed = candidate.conflicting_evidence ? JSON.parse(candidate.conflicting_evidence) : [];
      if (Array.isArray(parsed)) priorConflicts = parsed;
    } catch {}
    priorConflicts.push({
      type: "foreign_contact_discovered",
      phoneKind: foreignPhoneDetected.kind,
      quarantinedPhone: foreignPhoneDetected.raw,
      reason: "Contact enrichment returned a non-Australian phone number for a confirmed identity; identity re-flagged for recruiter review."
    });
    db.prepare(`UPDATE candidates SET identity_status = 'manual_review',
      workflow_stage = 'identity_flagged_foreign_contact', contact_basis_approved = 0,
      conflicting_evidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify(priorConflicts), candidate.id);
    added.push("identity_flagged_foreign_contact");
  }

  return { added };
}
