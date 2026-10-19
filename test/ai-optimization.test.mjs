import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "../src/migrations.mjs";
import { compactCandidateForAi, expandEvidenceTags, formatStructuredReviewNotes } from "../src/domain.mjs";
import { findProfileCandidates } from "../src/identity-search.mjs";
import { pruneSubroutines, pruneTaskContext } from "../src/clay-mcp.mjs";

test("compactCandidateForAi prunes nulls and boilerplate across purposes", () => {
  const fullCandidate = {
    id: 101,
    full_name: "Sarah Jane Connor",
    ahpra_number: "NMW1234567890",
    profession: "Nurse",
    suburb: "Canberra",
    state: "ACT",
    postcode: "2600",
    qualifications: "Bachelor of Nursing",
    employer: "Canberra Health Services",
    current_title: "Registered Nurse",
    linkedin_url: "https://www.linkedin.com/in/sarah-connor",
    work_email: "sarah.connor@act.gov.au",
    email_status: "valid",
    identity_status: "confirmed",
    identity_match_score: 95
  };

  const identityCompact = compactCandidateForAi(fullCandidate, "identity");
  assert.equal(identityCompact.id, 101);
  assert.equal(identityCompact.name, "Sarah Jane Connor");
  assert.equal(identityCompact.ahpra, "NMW1234567890");
  assert.equal(identityCompact.loc, "Canberra ACT 2600");
  assert.equal(identityCompact.email, undefined); // email excluded in identity purpose

  const emailCompact = compactCandidateForAi(fullCandidate, "email");
  assert.equal(emailCompact.id, 101);
  assert.equal(emailCompact.linkedin, "https://www.linkedin.com/in/sarah-connor");
  assert.equal(emailCompact.email, "sarah.connor@act.gov.au");
  assert.equal(emailCompact.qual, undefined); // qualifications excluded in email purpose
});

test("structured micro-tags expand to human-readable audit notes", () => {
  const tags = ["name:exact", "loc:ACT", "role:rn", "edu:match", "conflict:NSW_relocation"];
  const expanded = expandEvidenceTags(tags);
  assert.deepEqual(expanded, [
    "Exact name match",
    "Location: ACT",
    "Registered Nurse role verified",
    "Education matches source qualification",
    "Discrepancy: NSW relocation"
  ]);

  const note = formatStructuredReviewNotes({
    decision: "confirmed",
    tags: ["name:exact", "role:rn"],
    customNote: "Verified with ACT Health records."
  });
  assert.equal(note, "Identity confirmed. Exact name match; Registered Nurse role verified. Verified with ACT Health records.");
});

test("findProfileCandidates uses pre-filtered SQL without loading entire table", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);

  db.prepare("INSERT INTO imports (id, filename, file_hash) VALUES (1, 'test.csv', 'hash1')").run();

  const insert = db.prepare(`INSERT INTO candidates (
    import_id, source_row, source_hash, full_name, first_name, last_name, profession,
    registration_status, state, qualifications
  ) VALUES (1, ?, ?, ?, ?, ?, 'Nurse', 'Registered', 'ACT', 'Bachelor of Nursing')`);

  insert.run(1, "h1", "Alex Smith", "Alex", "Smith");
  insert.run(2, "h2", "Sarah Connor", "Sarah", "Connor");
  insert.run(3, "h3", "John Doe", "John", "Doe");

  const results = findProfileCandidates(db, {
    fullName: "Sarah Connor",
    headline: "Registered Nurse",
    location: "Canberra ACT"
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].candidate.full_name, "Sarah Connor");
  assert.ok(results[0].score >= 60);
});

test("pruneSubroutines strips JSON Schema bloat while preserving required inputs", () => {
  const bloatedCatalog = {
    subroutines: [
      {
        id: "sub_123",
        name: "Person LinkedIn URL",
        description: "Finds LinkedIn profile",
        requiredInputs: [
          { name: "Full Name", type: "full-name", description: "The person's full name", schema: { type: "string" } }
        ],
        extraSchemaMetadata: { complex: "nested object", traces: [1, 2, 3] }
      }
    ]
  };

  const pruned = pruneSubroutines(bloatedCatalog);
  assert.equal(pruned.subroutines.length, 1);
  assert.equal(pruned.subroutines[0].id, "sub_123");
  assert.equal(pruned.subroutines[0].name, "Person LinkedIn URL");
  assert.deepEqual(pruned.subroutines[0].requiredInputs, [{ name: "Full Name", type: "full-name" }]);
  assert.equal(pruned.subroutines[0].extraSchemaMetadata, undefined);
});

test("pruneTaskContext reduces raw task payload to essential status and outputs", () => {
  const bloatedTask = {
    taskId: "task_abc",
    status: "completed",
    actualCredits: 1.5,
    results: [{ work_email: "test@example.com", status: "valid" }],
    debugLogs: ["step 1 started", "step 2 executed", "done"],
    eventStream: "data: {...}\n\ndata: [DONE]"
  };

  const pruned = pruneTaskContext(bloatedTask);
  assert.equal(pruned.taskId, "task_abc");
  assert.equal(pruned.status, "completed");
  assert.equal(pruned.completed, true);
  assert.equal(pruned.actualCredits, 1.5);
  assert.deepEqual(pruned.results, [{ work_email: "test@example.com", status: "valid" }]);
  assert.equal(pruned.debugLogs, undefined);
});
