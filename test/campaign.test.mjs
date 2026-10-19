import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { campaignReadyRows, syncCampaignEligibility } from "../src/campaign.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  const imported = db.prepare("INSERT INTO imports(filename, file_hash) VALUES ('test.csv', 'campaign-test')").run();
  db.prepare(`INSERT INTO candidates
    (import_id, source_row, source_hash, ahpra_number, full_name, registration_status, identity_status,
      work_email, email_status, contact_basis_approved)
    VALUES (?, 2, 'campaign-person', 'NMW1', 'Campaign Person', 'Registered', 'confirmed',
      'person@example.test', 'valid', 1)`).run(Number(imported.lastInsertRowid));
  return db;
}

test("campaign-ready export derives every gate from authoritative fields", () => {
  const db = fixture();
  try {
    const eligibility = syncCampaignEligibility(db, 1);
    assert.equal(eligibility.eligible, true);
    assert.equal(campaignReadyRows(db).length, 1);
    db.prepare("UPDATE candidates SET identity_status = 'manual_review', campaign_status = 'ready' WHERE id = 1").run();
    assert.equal(campaignReadyRows(db).length, 0, "stale campaign status cannot bypass the gates");
  } finally { db.close(); }
});

test("suppression and opt-out override otherwise eligible records", () => {
  for (const field of ["suppressed", "opted_out"]) {
    const db = fixture();
    try {
      db.prepare(`UPDATE candidates SET ${field} = 1 WHERE id = 1`).run();
      const result = syncCampaignEligibility(db, 1);
      assert.equal(result.eligible, false);
      const candidate = db.prepare("SELECT campaign_status, workflow_stage FROM candidates WHERE id = 1").get();
      assert.equal(candidate.campaign_status, "not_ready");
      assert.equal(candidate.workflow_stage, field === "suppressed" ? "suppressed" : "opted_out");
      assert.equal(campaignReadyRows(db).length, 0);
    } finally { db.close(); }
  }
});
