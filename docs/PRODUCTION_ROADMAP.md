# Production roadmap: 9,000 to 200,000+ records

The included SQLite application is the working pilot. It is appropriate for one operator validating the process locally. Do not treat it as the final 200,000-record multi-user deployment.

## Promotion gates

| Gate | Evidence required | Recommended batch size |
|---|---|---:|
| Workbook import | Counts reconcile; duplicate registration types preserved | Full ACT file |
| Identity accuracy | Manual sample demonstrates acceptable match precision | 4, then 20–50 |
| Email quality | Valid-email rate and bounce-risk review | 20–100 |
| Credit economics | Actual credits per successful verified contact measured | 100–500 |
| Multi-state rollout | State-specific counts and duplicate behavior reconcile | 1 state at a time |
| Production | Security, access, retention, backups, and incident controls approved | Controlled chunks |

## Before the 200,000-record rollout

1. Replace SQLite with PostgreSQL while preserving the existing ordered migration contract.
2. Add authenticated accounts and role-based permissions for administrators, recruiters, and auditors.
3. Move imports and enrichment processing to a background queue; keep idempotency and require explicit approval for any credit-spending retry.
4. Store source files in encrypted object storage; retain hashes and metadata in PostgreSQL.
5. Encrypt backups, define retention/deletion rules, and test restoration.
6. Add provider-level credit ledgers, daily ceilings, alerts, and a hard kill switch.
7. Add structured match evidence and require human approval below a defined threshold.
8. Add rate limits, request logs, monitoring, and alerting without logging contact values.
9. Separate source registration facts from inferred profile/contact data and track provenance for every enriched value.
10. Complete a documented review of the AHPRA supply agreement, privacy obligations, contact rules, and each enrichment provider before production use.

## Recommended production services

- Web/API service: the existing Node workflow split into authenticated API and UI deployments.
- PostgreSQL: candidates, source registrations, batches, consent/suppression, and audit history.
- Worker queue: imports, Clay/API calls, validation, retries, and dead-letter handling.
- Object storage: original licensed files and controlled exports.
- Secrets manager: provider credentials; never store them in source code or exported CSV files.

The pilot's candidate, registration, batch, and audit entities already reflect this separation, so the migration can preserve the recruiter workflow.

Additional scale blockers are SQLite concurrent-write limits, synchronous large-file parsing, no distributed worker leasing, no rate limiting, no authenticated export roles, no automated retention executor, and no production observability or SLA controls. Resolve and load-test these before 200,000 records.
