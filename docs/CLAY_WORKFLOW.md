# Controlled Clay pilot workflow

The working enrichment provider is the manual CSV bridge. HCRHUB also supports official Clay MCP OAuth connection and function discovery. Connection alone cannot spend credits; function execution remains locked until an administrator-enabled function has been inspected and explicitly mapped. `candidate_id` is the immutable join key.

## Connect Clay MCP

1. In Clay, an administrator opens **Settings → MCP users**, assigns an appropriate per-user credit limit, permits **Unknown** MCP clients, and enables only the intended Functions for MCP.
2. Start HCRHUB at the same `HOST` and `PORT` configured for the local pilot.
3. Open **Clay connection** and click **Connect Clay**.
4. Clay displays an OAuth consent screen for the local HCRHUB client. Select the correct workspace.
5. Back in HCRHUB, inspect the discovered function names and declared inputs.
6. Do not execute anything until the identity/email function schemas have been mapped and a one-candidate dry run is approved.

HCRHUB registers a public OAuth client with PKCE. Only its non-secret client ID is cached under the ignored `data` directory. Access and refresh tokens are held in memory and disappear when the server stops, so a restart requires reconnecting.

## Exact four-person identity pilot

1. Import the licensed AHPRA workbook and reconcile 9,130 registrations, 8,951 candidates, 179 additional registration-type rows, and 0 rejected rows.
2. Select 15 candidates with enough source context to review for the approved pilot.
3. Create an **Identity discovery** dry run with record ceiling `15` and a hard credit ceiling at or above the displayed estimate.
4. Review exclusions, duplicate-work warnings, and estimated credits. No provider work has occurred.
5. Re-select the same four, clear **Dry run**, and create the approved controlled identity batch.
6. Download that batch's CSV and upload it to a new Clay table. Configure only documented Clay enrichments available in the user's account.
7. Preserve `candidate_id`. Return profile/job evidence, `provider_reference`, and `actual_credits` when the provider supplies it.
8. Export results from Clay and import them against the exact approved batch.
9. Compare the proposed profile with AHPRA name, alternative name, profession, location, qualifications, languages, employer/title, and career consistency. Confirm, reject, or defer each row; a high score never auto-confirms. This applies identically to the autonomous discovery pipeline (`scripts/run-autonomous-pipeline.mjs`, the swarm orchestrator): a score at or above `MATCH_HIGH_THRESHOLD` with zero conflicts is routed to `pending_confirmation`, never written as `confirmed`, until a recruiter reviews it through `/api/candidates/:id/review`.
10. Reconcile estimated versus actual credits before any contact batch.

Do not accept a same-name result based on name alone. Do not run the full dataset.

Confirming a candidate that already carries a recorded hard identity conflict (overseas location, a non-Australian phone number, or a prior namesake demotion) is refused by both `/api/candidates/:id/review` and `/api/ai/review` unless the caller explicitly sends `overrideConfirmed: true` with a non-empty `notes` explaining why the conflict doesn't apply. This keeps an override deliberate and auditable instead of a silent status flip over evidence the system already flagged.

## Email enrichment

1. Select only recruiter-confirmed identities.
2. Create an email dry run, review it, then create an approved controlled batch.
3. Use confirmed profile/employer context to find and validate a work email.
4. Return `candidate_id`, `work_email`, `email_status`, `provider_reference`, `enriched_at`, and `actual_credits` when available.
5. Import against the matching batch. Recognized statuses are `valid`, `invalid`, `risky`, `catch_all`, and `unverified`; only `valid` satisfies campaign eligibility.

## Optional phone enrichment

Phone enrichment is disabled by default. After written approval, set `PHONE_ENRICHMENT_ENABLED=true`, restart, and use a separate small batch. Return `candidate_id`, phone fields, provenance, and actual cost metadata. The application performs no automatic credit-spending retry.

## Credit controls

Values in `.env` are planning estimates, not verified Clay prices. Every approved batch has a hard credit ceiling and record ceiling. Returned actual costs are ledged when supplied. If a returned cost would exceed the ceiling, processing stops.

## Safe 20–50 person expansion

1. Review every pilot join and record false positives and false negatives.
2. Reconcile provider actuals and secure approval for the next total budget.
3. Raise `PILOT_RECORD_CEILING` only to the approved size and restart.
4. Run identity discovery first, with every result manually decided.
5. Run email only for confirmed identities, preferably in smaller controlled chunks.
6. Keep phone disabled unless separately approved.
7. Review provider errors, suppression, opt-outs, email validity, and the credit ledger before another batch.

## Column mapping

| Project export | Purpose | Typical result |
|---|---|---|
| `candidate_id` | Stable join key; never transform | `candidate_id` |
| Name fields | Person search/evidence | `matched_full_name` |
| `profession`, location, `qualifications` | Identity evidence | matched evidence fields |
| — | Optional graduation-year cross-check against the AHPRA qualification year | `graduation_year` / `education_year` |
| `linkedin_url` | Profile input/result | `linkedin_url` |
| `company_name`, `company_domain` | Work-email input | `employer`, `company_domain` |
| — | Job information | `current_title` |
| — | Verified work email | `work_email`, `email_status` |
| — | Optional phone | `business_phone`, `mobile_phone` |
| — | Provenance/cost | `provider_reference`, `actual_credits` |
