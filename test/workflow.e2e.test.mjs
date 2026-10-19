import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

async function api(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) }
  });
  const body = response.headers.get("content-type")?.includes("application/json")
    ? await response.json() : await response.text();
  assert.ok(response.ok, `${pathname} failed: ${JSON.stringify(body)}`);
  return body;
}

test("complete two-stage workflow succeeds in a temporary database", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-e2e-"));
  const databasePath = path.join(directory, "workflow.sqlite");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: databasePath,
      PILOT_RECORD_CEILING: "4", PHONE_ENRICHMENT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(baseUrl, child);
    const sourceCsv = [
      "AHPRA Registration Number,Health Practitioner,Profession,Registration Status,Registration Type,Suburb,State,Postcode,Qualifications",
      "NMW000000001,Alex Example,Nurse,Registered,General,CANBERRA,ACT,2600,Bachelor of Nursing",
      "NMW000000001,Alex Example,Nurse,Registered,Non-practising,CANBERRA,ACT,2600,Bachelor of Nursing"
    ].join("\r\n");
    const imported = await api(baseUrl, "/api/import", {
      method: "POST", body: JSON.stringify({ filename: "ACT-pilot.csv", csvText: sourceCsv, agreementReference: "test-only" })
    });
    assert.deepEqual({ rows: imported.rows, inserted: imported.inserted, duplicates: imported.duplicates, rejected: imported.rejected },
      { rows: 2, inserted: 1, duplicates: 1, rejected: 0 });
    const duplicate = await api(baseUrl, "/api/import", {
      method: "POST", body: JSON.stringify({ filename: "ACT-pilot.csv", csvText: sourceCsv, agreementReference: "test-only" })
    });
    assert.equal(duplicate.alreadyImported, true);

    const listing = await api(baseUrl, "/api/candidates?page=1&pageSize=25");
    assert.equal(listing.pagination.total, 1);
    const candidateId = listing.candidates[0].id;
    const sourceDetail = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.equal(sourceDetail.registrations.length, 2);

    await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "identity", name: "Identity dry run", dryRun: true, recordCeiling: 4, creditBudget: 4
    }) });
    const identityBatch = await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "identity", name: "Identity controlled", dryRun: false, recordCeiling: 4, creditBudget: 4
    }) });
    const identityExport = await api(baseUrl, `/api/enrichment/batches/${identityBatch.batchId}/csv`);
    assert.match(identityExport, /candidate_id/);
    await api(baseUrl, "/api/enrichment/results", { method: "POST", body: JSON.stringify({
      batchId: identityBatch.batchId,
      csvText: `candidate_id,matched_full_name,matched_profession,matched_state,linkedin_url,employer,current_title,provider_reference,actual_credits\r\n${candidateId},Alex Example,Nurse,ACT,https://example.test/alex,Example Health,Registered Nurse,identity-1,1`
    }) });
    const identityDetail = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.equal(identityDetail.candidate.identity_status, "manual_review");
    assert.equal(identityDetail.matchEvidence.length, 1);

    const validationBatch = await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "identity", provider: "clay_mcp_validator", name: "Identity revalidation",
      dryRun: false, forceIdentity: true, recordCeiling: 4, creditBudget: 4
    }) });
    await api(baseUrl, "/api/enrichment/results", { method: "POST", body: JSON.stringify({
      batchId: validationBatch.batchId,
      csvText: `candidate_id,matched_full_name,linkedin_url,employer,current_title,provider_reference,actual_credits\r\n${candidateId},,,,,validator-no-match,1`
    }) });
    const revalidatedDetail = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.equal(revalidatedDetail.candidate.linkedin_url, null);
    assert.equal(revalidatedDetail.candidate.identity_provider, "clay_mcp_validator");

    await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "confirmed", linkedinUrl: "https://example.test/alex", employer: "Example Health",
      currentTitle: "Registered Nurse", contactBasisApproved: false, notes: "Test match confirmed", reviewer: "E2E recruiter"
    }) });
    await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "email", name: "Email dry run", dryRun: true, recordCeiling: 4, creditBudget: 4
    }) });
    const emailBatch = await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "email", name: "Email controlled", dryRun: false, recordCeiling: 4, creditBudget: 4
    }) });
    await api(baseUrl, "/api/enrichment/results", { method: "POST", body: JSON.stringify({
      batchId: emailBatch.batchId,
      csvText: `candidate_id,work_email,email_status,provider_reference,actual_credits\r\n${candidateId},alex@example.test,valid,email-1,3`
    }) });
    await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "confirmed", contactBasisApproved: true, notes: "Contact basis approved", reviewer: "E2E recruiter"
    }) });
    const campaign = await api(baseUrl, "/api/export/campaign-ready.csv");
    assert.match(campaign, /alex@example\.test/);

    await api(baseUrl, `/api/candidates/${candidateId}/suppression`, { method: "POST", body: JSON.stringify({
      suppressed: true, optedOut: false, reason: "E2E suppression", actor: "E2E recruiter"
    }) });
    const suppressedExport = await api(baseUrl, "/api/export/campaign-ready.csv");
    assert.doesNotMatch(suppressedExport, /alex@example\.test/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) count FROM candidates").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM registrations").get().count, 2);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM provider_responses").get().count, 3);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM contact_points").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) count FROM credit_ledger WHERE entry_type = 'actual'").get().count, 3);
    assert.ok(db.prepare("SELECT COUNT(*) count FROM audit_log").get().count >= 10);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
