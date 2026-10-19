import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { applyContactResult, createEnrichmentBatch, recordActualCredits } from "../src/enrichment.mjs";

const config = {
  defaultBudget: 20,
  maxBatchRecords: 4,
  phoneEnabled: false,
  creditEstimates: { identity: 1, email: 3, phone: 9 }
};

function fixture(count = 5, status = "manual_review") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  const imported = db.prepare("INSERT INTO imports(filename, file_hash) VALUES ('test.csv', 'enrichment-test')").run();
  const insert = db.prepare(`INSERT INTO candidates
    (import_id, source_row, source_hash, ahpra_number, full_name, identity_status)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (let index = 1; index <= count; index += 1) {
    insert.run(Number(imported.lastInsertRowid), index + 1, `hash-${index}`, `NMW${index}`, `Person ${index}`, status);
  }
  return db;
}

test("batch creation enforces record and credit ceilings", () => {
  const db = fixture();
  try {
    assert.throws(() => createEnrichmentBatch(db, {
      candidateIds: [1, 2, 3, 4, 5], kind: "identity", recordCeiling: 4
    }, config), /4-record ceiling/);
    assert.throws(() => createEnrichmentBatch(db, {
      candidateIds: [1, 2], kind: "identity", recordCeiling: 4, creditBudget: 1
    }, config), /hard credit ceiling/);
  } finally { db.close(); }
});

test("jobs and estimated credits are idempotent while dry-run and execution are distinct", () => {
  const db = fixture(2);
  try {
    const dryRun = createEnrichmentBatch(db, { candidateIds: [1], kind: "identity", dryRun: true }, config);
    assert.equal(dryRun.estimatedCredits, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM credit_ledger WHERE entry_type = 'estimate'").get().count, 1);
    assert.throws(() => createEnrichmentBatch(db, { candidateIds: [1], kind: "identity", dryRun: true }, config), /already exists|already created/);
    const execution = createEnrichmentBatch(db, { candidateIds: [1], kind: "identity", dryRun: false }, config);
    assert.equal(execution.dryRun, false);
    assert.equal(db.prepare("SELECT workflow_stage FROM candidates WHERE id = 1").get().workflow_stage, "identity_discovery_queued");
  } finally { db.close(); }
});

test("contextual identity validation can recheck an existing profile without duplicating the same provider", () => {
  const db = fixture(1);
  try {
    db.prepare("UPDATE candidates SET linkedin_url = 'https://linkedin.example/suspect' WHERE id = 1").run();
    const validation = createEnrichmentBatch(db, {
      candidateIds: [1], kind: "identity", provider: "clay_mcp_validator", dryRun: false,
      forceIdentity: true, creditBudget: 10
    }, config);
    assert.equal(validation.records, 1);
    assert.equal(db.prepare("SELECT provider FROM enrichment_jobs WHERE batch_id = ?").get(validation.batchId).provider,
      "clay_mcp_validator");
    assert.throws(() => createEnrichmentBatch(db, {
      candidateIds: [1], kind: "identity", provider: "clay_mcp_validator", dryRun: false,
      forceIdentity: true, creditBudget: 10
    }, config), /already exists|already created/);
  } finally { db.close(); }
});

test("actual provider credits are recorded once and preserve results when the provider exceeds the ceiling", () => {
  const db = fixture(2);
  try {
    const batch = createEnrichmentBatch(db, {
      candidateIds: [1, 2], kind: "identity", dryRun: false, creditBudget: 2
    }, config);
    assert.equal(recordActualCredits(db, { batchId: batch.batchId, candidateId: 1, kind: "identity", credits: 2 }).recorded, true);
    assert.equal(recordActualCredits(db, { batchId: batch.batchId, candidateId: 1, kind: "identity", credits: 2 }).recorded, false);
    const stopped = recordActualCredits(db, { batchId: batch.batchId, candidateId: 2, kind: "identity", credits: 1 });
    assert.equal(stopped.stopped, true);
    assert.equal(stopped.recorded, true);
    assert.equal(db.prepare("SELECT actual_credits FROM enrichment_batches WHERE id = ?").get(batch.batchId).actual_credits, 3);
    assert.equal(db.prepare("SELECT status FROM enrichment_batches WHERE id = ?").get(batch.batchId).status, "stopped");
  } finally { db.close(); }
});

test("contact enrichment requires confirmation and phone is disabled by default", () => {
  const db = fixture(1, "manual_review");
  try {
    assert.throws(() => createEnrichmentBatch(db, { candidateIds: [1], kind: "email" }, config), /confirmed first/);
    db.prepare("UPDATE candidates SET identity_status = 'confirmed' WHERE id = 1").run();
    assert.throws(() => createEnrichmentBatch(db, { candidateIds: [1], kind: "phone" }, config), /disabled/);
  } finally { db.close(); }
});

test("contact results validate email status and preserve provenance", () => {
  const db = fixture(1, "confirmed");
  try {
    const batch = { id: 1, kind: "email", provider: "controlled_csv" };
    const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
    assert.throws(() => applyContactResult(db, {
      batch, candidate, config, result: { workEmail: "person@example.test", emailStatus: "unknown" }
    }), /Invalid email status/);
    assert.throws(() => applyContactResult(db, {
      batch, candidate, config, result: { workEmail: "not-an-email", emailStatus: "valid" }
    }), /Malformed work email/);
    const applied = applyContactResult(db, {
      batch, candidate, config, result: {
        workEmail: "person@example.test", emailStatus: "valid", providerReference: "result-1"
      }
    });
    assert.deepEqual(applied.added, ["work_email"]);
    assert.equal(db.prepare("SELECT workflow_stage FROM candidates WHERE id = 1").get().workflow_stage, "email_verified");
    const contact = db.prepare("SELECT * FROM contact_points WHERE candidate_id = 1").get();
    assert.equal(contact.verification_status, "valid");
    assert.equal(contact.provider_reference, "result-1");
  } finally { db.close(); }
});

test("a non-Australian phone discovered during contact enrichment re-flags an already-confirmed identity", () => {
  const db = fixture(1, "confirmed");
  try {
    const configWithPhone = { ...config, phoneEnabled: true };
    const batch = { id: 1, kind: "phone", provider: "controlled_csv" };
    const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
    const applied = applyContactResult(db, {
      batch, candidate, config: configWithPhone,
      result: { mobilePhone: "+15128209742", providerReference: "result-1" }
    });
    assert.ok(applied.added.includes("identity_flagged_foreign_contact"));

    // The identity is pulled back out of "confirmed" the moment a foreign phone
    // surfaces, instead of silently staying campaign-eligible while only the raw
    // phone number is quarantined — this is the safeguard that previously had to
    // be applied by hand, after the fact, for 37 confirmed overseas namesakes.
    const updated = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
    assert.equal(updated.identity_status, "manual_review");
    assert.notEqual(updated.identity_status, "confirmed");
    assert.equal(updated.contact_basis_approved, 0);
    assert.equal(updated.international_phone, "+15128209742");
    assert.equal(updated.mobile_phone, null);
    const conflicts = JSON.parse(updated.conflicting_evidence);
    assert.equal(conflicts[0].type, "foreign_contact_discovered");
  } finally { db.close(); }
});

test("contact results remain blocked if identity confirmation is later revoked", () => {
  const db = fixture(1, "manual_review");
  try {
    const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
    assert.throws(() => applyContactResult(db, {
      batch: { id: 1, kind: "email", provider: "controlled_csv" }, candidate, config,
      result: { workEmail: "person@example.test", emailStatus: "valid" }
    }), /not confirmed/);
  } finally { db.close(); }
});
