# Data governance checklist

This is an operational checklist, not legal advice. A licensed source file establishes provenance, but the permitted uses still depend on the supply agreement and applicable rules.

- Record the contract, purchase, or supply-agreement reference during import.
- Confirm that enrichment, provider processing, storage location, retention, and outreach are within the permitted purpose.
- Give access only to staff who need the data for approved work.
- Keep AHPRA source facts distinct from inferred identity and contact data.
- Record the source and date of every enriched email or phone number.
- Use work contact details where appropriate; treat personal mobile numbers as a higher-risk field.
- Require identity confirmation before email or phone discovery.
- Require a documented contact-basis approval before campaign export.
- Honour suppression and opt-out immediately across all destinations.
- Do not upload unrestricted full datasets to a provider during testing.
- Establish correction, deletion, retention, incident, and access-review procedures before production.
- Reconcile exports and downstream CRM records so suppression status cannot drift.
- Keep the pilot on localhost; the current UI has no authentication or role-based export control.
- Set and periodically review `DATA_RETENTION_DAYS`; deletion remains a documented manual process in the pilot.
- Stop the service before file-copy backups, copy SQLite/WAL/SHM consistently, encrypt backups, and test restoration separately.
- Never place provider secrets in SQLite, CSV files, source code, screenshots, or logs; use `.env` locally and a secrets manager in production.
- Do not log enriched contact values. Restrict the database, exports, and temporary provider files using operating-system permissions.
- Preserve the original licensed workbook unchanged and outside application-controlled cleanup paths.
