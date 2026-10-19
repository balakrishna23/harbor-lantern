import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

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
  return { status: response.status, body };
}

test("confirming a candidate with a recorded hard identity conflict requires an explicit, documented override", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-confirm-guard-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: path.join(directory, "test.sqlite"),
      PILOT_RECORD_CEILING: "4", PHONE_ENRICHMENT_ENABLED: "false" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(baseUrl, child);
    const sourceCsv = [
      "AHPRA Registration Number,Health Practitioner,Profession,Registration Status,Suburb,State,Postcode,Qualifications",
      "NMW000000002,Priya Overseas,Nurse,Registered,CANBERRA,ACT,2600,Bachelor of Nursing"
    ].join("\r\n");
    const imported = await api(baseUrl, "/api/import", {
      method: "POST", body: JSON.stringify({ filename: "guard-test.csv", csvText: sourceCsv, agreementReference: "test-only" })
    });
    assert.equal(imported.body.inserted, 1);
    const listing = await api(baseUrl, "/api/candidates?page=1&pageSize=25");
    const candidateId = listing.body.candidates[0].id;

    // Run an identity batch and import a result carrying a non-Australian phone
    // number, so scoreIdentityMatch's phone-conflict check records a hard
    // conflict in conflicting_evidence — the same evidence pattern every one of
    // the 37 overseas namesakes in the AHPRA dossier actually surfaced.
    const batch = await api(baseUrl, "/api/enrichment/batches", { method: "POST", body: JSON.stringify({
      candidateIds: [candidateId], kind: "identity", name: "Identity controlled", dryRun: false, recordCeiling: 4, creditBudget: 4
    }) });
    await api(baseUrl, "/api/enrichment/results", { method: "POST", body: JSON.stringify({
      batchId: batch.body.batchId,
      csvText: `candidate_id,matched_full_name,linkedin_url,employer,current_title,mobile_phone,provider_reference,actual_credits\r\n${candidateId},Priya Overseas,https://example.test/priya,Some US Corp,Nurse,+15128209742,identity-1,1`
    }) });
    const flagged = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.match(flagged.body.candidate.conflicting_evidence, /not an Australian number/);

    // Bare confirm attempt is refused
    const blocked = await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "confirmed", contactBasisApproved: true, reviewer: "Test recruiter"
    }) });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error, /hard identity conflict/);

    const detailAfterBlock = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.notEqual(detailAfterBlock.body.candidate.identity_status, "confirmed");

    // Override without a documented reason is also refused
    const noReason = await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "confirmed", overrideConfirmed: true, reviewer: "Test recruiter"
    }) });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error, /documented reason/);

    // Explicit override with a documented reason succeeds
    const overridden = await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "confirmed", overrideConfirmed: true,
      notes: "Recruiter called the candidate directly and confirmed AHPRA identity despite the flagged overseas evidence.",
      reviewer: "Test recruiter"
    }) });
    assert.equal(overridden.status, 200);
    const detailAfterOverride = await api(baseUrl, `/api/candidates/${candidateId}`);
    assert.equal(detailAfterOverride.body.candidate.identity_status, "confirmed");

    // Same guard applies to the AI-recruiter review endpoint
    await api(baseUrl, `/api/candidates/${candidateId}/review`, { method: "POST", body: JSON.stringify({
      identityStatus: "manual_review", reviewer: "Test recruiter"
    }) });
    const aiBlocked = await api(baseUrl, "/api/ai/review", { method: "POST", body: JSON.stringify({
      candidateId, decision: "confirmed"
    }) });
    assert.equal(aiBlocked.status, 400);
    assert.match(aiBlocked.body.error, /hard identity conflict/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
