import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import {
  cleanCandidateName,
  claimCandidates,
  claimEligibility,
  runDiscoveryBatch,
  runVerificationBatch,
  runSupervisorCheck
} from "../src/pipeline-orchestrator.mjs";

function setupTestDb() {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);

  db.exec(`
    INSERT INTO imports (id, filename, file_hash)
    VALUES (1, 'test.csv', 'hash123');

    INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, first_name, last_name, profession, state, postcode, registration_status, workflow_stage)
    VALUES
      (1, 1, 1, 'h1', 'Dr Brynlee Anne Gallister', 'Brynlee', 'Gallister', 'Nurse', 'ACT', '2617', 'Registered', 'source_imported'),
      (2, 1, 2, 'h2', 'Miss Stephanie Kate McGowan', 'Stephanie', 'McGowan', 'Nurse', 'ACT', '2605', 'Registered', 'source_imported'),
      (3, 1, 3, 'h3', 'Mr John Doe', 'John', 'Doe', 'Doctor', 'NSW', '2000', 'Suspended', 'source_imported');
  `);
  return db;
}

test("cleanCandidateName strips titles accurately", () => {
  assert.equal(cleanCandidateName("Dr Alexandra Kelly Tolhurst"), "Alexandra Kelly Tolhurst");
  assert.equal(cleanCandidateName("Miss Stephanie Kate McGowan"), "Stephanie Kate McGowan");
  assert.equal(cleanCandidateName("Mrs Aishani Kandel"), "Aishani Kandel");
  assert.equal(cleanCandidateName("Prof Jane Doe"), "Jane Doe");
  assert.equal(cleanCandidateName("Sarah Connor"), "Sarah Connor");
});

test("claimCandidates atomically claims matching candidates without duplicates", () => {
  const db = setupTestDb();

  // Claim 1 candidate for Worker A
  const batchA = claimCandidates(db, {
    sourceStage: "source_imported",
    claimingStage: "claiming_worker_a",
    limit: 1,
    cohort: "ACT"
  });

  assert.equal(batchA.length, 1);
  assert.equal(batchA[0].id, 1);

  // Worker B should get candidate 2, not candidate 1
  const batchB = claimCandidates(db, {
    sourceStage: "source_imported",
    claimingStage: "claiming_worker_b",
    limit: 1,
    cohort: "ACT"
  });

  assert.equal(batchB.length, 1);
  assert.equal(batchB[0].id, 2);

  // No more registered ACT candidates in source_imported
  const batchC = claimCandidates(db, {
    sourceStage: "source_imported",
    claimingStage: "claiming_worker_c",
    limit: 1,
    cohort: "ACT"
  });
  assert.equal(batchC.length, 0);

  db.close();
});

test("claimCandidates with excludeBrowserAgentAttempted skips manual_review candidates already searched once", () => {
  const db = setupTestDb();
  // Candidate 1 already got one browser-agent attempt (a found-but-not-
  // corroborated lead, so linkedin_url stayed null) and is back in
  // manual_review, same shape as a real "Pranav Thomas"-style stuck record.
  db.exec("UPDATE candidates SET workflow_stage = 'manual_review' WHERE id = 1");
  db.prepare(`INSERT INTO browser_leads (candidate_id, linkedin_url, matched_full_name, status)
    VALUES (1, NULL, 'Someone Else', 'found')`).run();
  db.exec("UPDATE candidates SET workflow_stage = 'manual_review' WHERE id = 2");

  const withExclusion = claimCandidates(db, {
    sourceStage: ["source_imported", "manual_review"],
    claimingStage: "claiming_test",
    limit: 10,
    excludeBrowserAgentAttempted: true
  });
  // Only candidate 2 (never searched) should be claimable; candidate 1 is
  // excluded because it already has a browser_leads row.
  assert.deepEqual(withExclusion.map((c) => c.id), [2]);

  db.close();
});

test("claimCandidates with attemptedSince re-claims candidates searched only before the new round, once", () => {
  const db = setupTestDb();
  // Candidate 1: searched in the old round only → eligible again.
  // Candidate 2: already searched in the new round → not eligible.
  db.exec("UPDATE candidates SET workflow_stage = 'identity_unresolved' WHERE id IN (1, 2)");
  db.prepare(`INSERT INTO browser_leads (candidate_id, status, created_at) VALUES (1, 'not_found', '2026-09-26 12:00:00')`).run();
  db.prepare(`INSERT INTO browser_leads (candidate_id, status, created_at) VALUES (2, 'not_found', '2026-10-13 05:00:00')`).run();
  const eligibility = {
    sourceStage: ["source_imported", "manual_review", "identity_unresolved"],
    excludeBrowserAgentAttempted: true,
    attemptedSince: "2026-10-13 00:00:00"
  };
  const { whereClause, params } = claimEligibility(eligibility);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM candidates WHERE ${whereClause}`).get(...params).n, 1);
  const claimed = claimCandidates(db, { ...eligibility, claimingStage: "claiming_test", limit: 10 });
  assert.deepEqual(claimed.map((c) => c.id), [1]);
  db.close();
});

test("claimCandidates without excludeBrowserAgentAttempted still reclaims manual_review candidates (unchanged default for other callers)", () => {
  const db = setupTestDb();
  db.exec("UPDATE candidates SET workflow_stage = 'manual_review' WHERE id = 1");
  db.prepare(`INSERT INTO browser_leads (candidate_id, linkedin_url, matched_full_name, status)
    VALUES (1, NULL, 'Someone Else', 'found')`).run();

  const claimed = claimCandidates(db, {
    sourceStage: ["source_imported", "manual_review"],
    claimingStage: "claiming_test",
    limit: 10
  });
  assert.ok(claimed.some((c) => c.id === 1));

  db.close();
});

test("runVerificationBatch never auto-confirms a high-confidence profile", () => {
  const db = setupTestDb();

  // Set candidate 1 to identity_discovered with a valid LinkedIn URL
  db.prepare(`
    UPDATE candidates
    SET linkedin_url = 'https://www.linkedin.com/in/brynlee-gallister-12345',
        workflow_stage = 'identity_discovered'
    WHERE id = 1
  `).run();

  const results = runVerificationBatch(db, [1]);
  assert.equal(results.length, 1);
  // A high score with zero conflicts is strong automated evidence, but it must
  // never itself become "confirmed" — that decision belongs to a recruiter via
  // the review UI/API. See src/pipeline-orchestrator.mjs for why.
  assert.equal(results[0].decision, "pending_confirmation");
  assert.equal(results[0].workflowStage, "pending_confirmation");

  const candidate = db.prepare("SELECT * FROM candidates WHERE id = 1").get();
  assert.equal(candidate.identity_status, "pending_confirmation");
  assert.notEqual(candidate.identity_status, "confirmed");
  assert.equal(candidate.contact_basis_approved, 0);
  assert.ok(candidate.recruiter_notes.includes("awaiting recruiter confirmation"));
  assert.ok(candidate.recruiter_notes.includes("Exact name"));

  db.close();
});

test("runSupervisorCheck recovers stale claimed leases and compiles throughput stats", () => {
  const db = setupTestDb();

  // Simulate candidate 1 stuck in claiming state
  db.prepare(`
    UPDATE candidates
    SET workflow_stage = 'claiming_dead_worker',
        updated_at = datetime('now', '-20 minutes')
    WHERE id = 1
  `).run();

  const { staleRecovered, stats } = runSupervisorCheck(db, { leaseTimeoutMinutes: 10 });
  assert.equal(staleRecovered, 1);

  const candidate1 = db.prepare("SELECT workflow_stage FROM candidates WHERE id = 1").get();
  assert.equal(candidate1.workflow_stage, "source_imported");

  assert.equal(stats.total_candidates, 3);
  assert.equal(stats.registered, 2);

  db.close();
});
