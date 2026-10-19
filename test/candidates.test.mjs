import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { candidateDetail, listCandidates } from "../src/candidates.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  applyMigrations(db);
  const imported = db.prepare("INSERT INTO imports(filename, file_hash) VALUES ('test.csv', 'candidate-list-test')").run();
  const insert = db.prepare(`INSERT INTO candidates
    (import_id, source_row, source_hash, ahpra_number, full_name, profession, state, identity_status)
    VALUES (?, ?, ?, ?, ?, 'Nurse', ?, ?)`);
  for (let index = 1; index <= 120; index += 1) {
    insert.run(Number(imported.lastInsertRowid), index + 1, `hash-${index}`, `NMW${String(index).padStart(9, "0")}`,
      `Candidate ${String(index).padStart(3, "0")}`, index % 2 ? "ACT" : "NSW", index % 3 ? "manual_review" : "confirmed");
  }
  return db;
}

test("candidate listing is server-paginated and returns reliable metadata", () => {
  const db = fixture();
  try {
    const result = listCandidates(db, new URLSearchParams({ page: "2", pageSize: "50" }));
    assert.equal(result.candidates.length, 50);
    assert.deepEqual(result.pagination, { page: 2, pageSize: 50, total: 120, totalPages: 3 });
    assert.equal(result.candidates[0].full_name, "Candidate 070");

    const filtered = listCandidates(db, new URLSearchParams({ status: "confirmed", state: "NSW", pageSize: "25" }));
    assert.equal(filtered.pagination.total, 20);
    assert.ok(filtered.candidates.every((candidate) => candidate.identity_status === "confirmed" && candidate.state === "NSW"));
  } finally {
    db.close();
  }
});

test("candidate detail separates source facts, evidence, and review history", () => {
  const db = fixture();
  try {
    db.prepare("INSERT INTO match_evidence(candidate_id, provider, score, confidence_band, reasons_json) VALUES (1, 'controlled_csv', 72, 'medium', '[\"name\"]')").run();
    db.prepare("INSERT INTO review_history(candidate_id, decision, reviewer) VALUES (1, 'manual_review', 'Test reviewer')").run();
    const detail = candidateDetail(db, 1);
    assert.equal(detail.candidate.full_name, "Candidate 001");
    assert.equal(detail.matchEvidence[0].score, 72);
    assert.equal(detail.reviewHistory[0].reviewer, "Test reviewer");
    assert.equal(candidateDetail(db, 9999), null);
  } finally {
    db.close();
  }
});

test("candidate detail surfaces found-but-unattached browser leads for manual review", () => {
  const db = fixture();
  try {
    // A weak/uncorroborated find (status 'found') never gets copied onto
    // candidates.linkedin_url (see applyBrowserLeadDecision), but it must
    // still show up here so a human reviewer can see and judge it.
    db.prepare(`INSERT INTO browser_leads
      (candidate_id, linkedin_url, matched_full_name, headline, status)
      VALUES (1, 'https://linkedin.example/weak-match', 'Candidate 001', 'RN', 'found')`).run();
    db.prepare(`INSERT INTO browser_leads
      (candidate_id, linkedin_url, matched_full_name, status)
      VALUES (1, NULL, NULL, 'not_found')`).run();

    const detail = candidateDetail(db, 1);
    assert.equal(detail.suggestedLeads.length, 1);
    assert.equal(detail.suggestedLeads[0].linkedin_url, "https://linkedin.example/weak-match");
  } finally {
    db.close();
  }
});
