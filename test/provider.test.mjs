import test from "node:test";
import assert from "node:assert/strict";
import { controlledCsvProvider, normalizeControlledCsvResult } from "../src/providers/controlled-csv.mjs";

test("controlled CSV adapter declares that it never executes automatically", () => {
  assert.equal(controlledCsvProvider.executesAutomatically, false);
  assert.equal(controlledCsvProvider.requiresManualExport, true);
  assert.deepEqual(controlledCsvProvider.supports, ["identity", "email", "phone", "email_phone"]);
});

test("controlled CSV result normalization accepts documented headings", () => {
  const result = normalizeControlledCsvResult({
    "Candidate ID": "42", "LinkedIn URL": "https://example.test/profile", "Company Name": "Clinic",
    "Email Status": "VALID", "Actual Credits": "2"
  });
  assert.equal(result.candidateId, 42);
  assert.equal(result.employer, "Clinic");
  assert.equal(result.emailStatus, "valid");
  assert.equal(result.actualCredits, 2);
  assert.equal(result.emailActualCredits, null);
});

test("controlled CSV adapter preserves structured provider errors", () => {
  const result = normalizeControlledCsvResult({
    candidate_id: "7", error_code: "NO_MATCH", error_message: "No reliable professional profile"
  });
  assert.equal(result.errorCode, "NO_MATCH");
  assert.equal(result.errorMessage, "No reliable professional profile");
});
