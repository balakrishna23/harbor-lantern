/**
 * Deterministic in-memory provider for tests and dry runs. Never touches the
 * network. Responses are keyed by "first|last" in lower case.
 */
import { emptyPerson, lookupResult } from "./provider-contract.mjs";

export function createMockProvider(responses = {}, { creditsPerMatch = 1 } = {}) {
  const calls = [];
  return {
    id: "mock",
    label: "Mock provider",
    supports: ["identity", "email", "phone"],
    calls,
    buildQuery(candidate, keys = {}) {
      const first = String(candidate.first_name || "").trim();
      const last = String(candidate.last_name || "").trim();
      if (!first || !last) return { skip: "needs first and last name" };
      return { query: { first_name: first, last_name: last, school: keys.institution ?? null } };
    },
    async lookup(query) {
      calls.push(query);
      const key = `${String(query.first_name).toLowerCase()}|${String(query.last_name).toLowerCase()}`;
      const entry = responses[key];
      if (!entry) return lookupResult("mock", { status: "no_match", query });
      if (entry.error) return lookupResult("mock", { status: "error", errorCode: entry.error, retryable: entry.error === "rate_limited", query });
      return lookupResult("mock", {
        status: "match",
        likelihood: entry.likelihood ?? 8,
        creditsUsed: creditsPerMatch,
        providerReference: entry.id ?? key,
        person: { ...emptyPerson(), ...entry.person },
        query
      });
    }
  };
}
