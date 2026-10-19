import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, migrationVersions } from "../src/migrations.mjs";

test("migrations are additive, repeatable, and preserve existing rows", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-migrations-"));
  const filename = path.join(directory, "test.sqlite");
  const db = new DatabaseSync(filename);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    applyMigrations(db);
    const imported = db.prepare("INSERT INTO imports(filename, file_hash) VALUES (?, ?)")
      .run("pilot.csv", "migration-test-hash");
    db.prepare(`INSERT INTO candidates (
      import_id, source_row, source_hash, ahpra_number, full_name, registration_status,
      identity_confidence, identity_status
    ) VALUES (?, 2, ?, ?, ?, 'Registered', 80, 'manual_review')`)
      .run(Number(imported.lastInsertRowid), "candidate-hash", "NMW000000001", "Migration Test");

    applyMigrations(db);

    assert.equal(db.prepare("SELECT COUNT(*) count FROM candidates").get().count, 1);
    assert.equal(db.prepare("SELECT workflow_stage FROM candidates").get().workflow_stage, "source_imported");
    assert.deepEqual(
      db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all()
        .map((row) => ({ version: row.version, name: row.name })),
      migrationVersions
    );
    for (const table of [
      "enrichment_jobs", "enrichment_attempts", "provider_responses", "match_evidence",
      "contact_points", "credit_ledger", "suppression_history", "review_history", "browser_leads"
    ]) {
      assert.equal(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
    }
    assert.ok(db.prepare("PRAGMA table_info(enrichment_jobs)").all().some((column) => column.name === "provider_reference"));
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
