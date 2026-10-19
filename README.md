# HCRHUB Candidate Intelligence

A no-Docker candidate data platform for licensed AHPRA data. It preserves source registrations, supports evidence-based identity review, creates controlled provider-neutral enrichment jobs, tracks estimated and actual credits, retains provenance, enforces suppression, and exports only campaign-eligible records.

The ACT workbook contains 9,130 registration rows representing 8,951 unique registration numbers. The 179 repeated numbers differ by registration type, so the platform preserves every source registration row while maintaining one candidate identity per registration number.

## Requirements

- Node.js 24 or later
- No Docker
- No database installation for the MVP; Node's built-in SQLite is used

## Start

```powershell
copy .env.example .env
npm install
npm start
```

Open `http://127.0.0.1:4173`. The pilot binds to the local computer by default.

On Windows, you can instead right-click `Start-HCRHUB.ps1` and choose **Run with PowerShell**. Keep the PowerShell window open while using the dashboard.

Run verification:

```powershell
npm test
npm run check
npm audit --omit=dev
```

## First pilot

1. Import the licensed workbook without moving, renaming, or editing the original.
2. Select no more than four candidates and create an identity dry run with a four-record ceiling.
3. Inspect its estimate, then create the approved controlled identity batch with Dry run cleared.
4. Export CSV, perform the configured Clay work manually, and import results against that exact batch.
5. Compare source facts with provider evidence and record a recruiter decision for every match.
6. Create a separate email batch only for confirmed identities; import a recognized validation status.
7. Approve contact basis, review suppression/opt-out, then export campaign-ready records.

The application includes both a controlled CSV bridge and an official Clay MCP OAuth connection. Open **Clay connection** to authorize the workspace and discover the functions its administrator has enabled. Connecting and listing functions do not run enrichment or spend credits. OAuth tokens remain in server memory and are discarded when HCRHUB stops.

Direct execution stays locked until the intended identity and contact functions are visible and their schemas have been mapped to HCRHUB. CSV remains the working fallback. The webhook variables are reserved configuration only; no webhook execution is implemented or claimed.

See `docs/CLAY_WORKFLOW.md` for the exact two-stage mapping, `docs/PRODUCTION_ROADMAP.md` for the 200,000-record architecture, and `docs/DATA_GOVERNANCE_CHECKLIST.md` before production use.

## Sales Navigator location agents

Use **Location matching agents** in the dashboard to upload multiple real Excel
or CSV search exports, compare against the national register, then start a separate
LinkedIn school verification run. Matching and school checks are separate actions.
Clear name-and-school matches update candidate identities in the database;
existing identity conflicts, ambiguous or unavailable evidence stays for review.
Progress and evidence are saved for resume.

See [location workflow](docs/LOCATION_SHEET_WORKFLOW.md) and
[Australia search batches](sample/australia-search-batches.csv).

## Register source columns

Column matching is case-insensitive and supports common variants:

- AHPRA registration number
- Health practitioner or full name
- First name, middle name, last name
- Profession
- Registration status
- Registration type
- Registration expiry date
- Suburb, state, postcode
- Qualifications
- Languages
- LinkedIn URL, current employer, current title (optional)

## Safety controls

- Additive schema migrations, immutable import checksums, and audit/history records
- Registration number is the preferred unique source identifier
- Duplicate protection before enrichment
- Identity-review status separated from registration verification
- Dry-run, four-record pilot ceiling, hard credit ceiling, idempotent jobs, and separate email/phone estimates
- Phone enrichment disabled by default
- Suppression and opt-out fields override campaign eligibility
- Clay exports include only the fields needed for enrichment
- Clay MCP uses authorization-code OAuth with PKCE; API keys and OAuth tokens are not stored in SQLite

## Production migration

SQLite is suitable for the first 9,000-record pilot. Before multi-user production or the 200,000-record rollout, migrate the storage adapter to PostgreSQL and run the worker as a separate service. The API and data model are designed so that migration does not change the recruiter workflow.

## Environment variables

| Variable | Purpose |
|---|---|
| `HOST`, `PORT` | Local bind address and web server port |
| `DATABASE_PATH` | SQLite file location |
| `DEFAULT_CREDIT_BUDGET` | Maximum default batch estimate |
| `IDENTITY_CREDIT_ESTIMATE` | Planning estimate per identity-discovery row |
| `EMAIL_CREDIT_ESTIMATE` | Estimated credits for email plus validation |
| `PHONE_CREDIT_ESTIMATE` | Additional estimated credits for phone |
| `PILOT_RECORD_CEILING` | Maximum records accepted in one pilot batch; default `4` |
| `PHONE_ENRICHMENT_ENABLED` | Must be explicitly set to `true` before phone batches |
| `MATCH_HIGH_THRESHOLD`, `MATCH_MANUAL_THRESHOLD` | Configurable identity evidence bands; never auto-confirm |
| `MAX_UPLOAD_BYTES`, `MAX_REQUEST_BYTES` | Source-file and HTTP request limits |
| `DATA_RETENTION_DAYS` | Policy input; deletion is not automated in the pilot |
| `CLAY_WEBHOOK_URL` | Optional future Clay webhook |
| `CLAY_WEBHOOK_SECRET` | Optional webhook bearer token |

## Data handling

Before production use, record the AHPRA data-supply agreement and confirm permitted purpose, authorised users, subprocessors, overseas processing, retention, enrichment, and outreach conditions. Registration verification and permission to contact are represented separately in the database.

The pilot has no login system. Keep it bound to `127.0.0.1`, restrict OS access to the project and database, and do not expose the port to a network. Campaign export access must be protected by authenticated role-based access before deployment.

For backup, stop the application and copy the SQLite database plus its `-wal` and `-shm` files together, or use SQLite's backup tooling. Test restoration into a separate path by setting `DATABASE_PATH`; never overwrite the only working copy. Original licensed source files remain outside the application and must follow the supply agreement's access and retention rules.

## Australia extraction bot

Open `/extraction-bot.html` on the dashboard for the continuous location/list/export
workflow. It uses your signed-in Brave debug session, a 99-page search limit,
durable checkpoints, full-list downloads and automatic register comparison.
Use **Pause after current batch** to finish cleanly. Setup and limitations are in
[the extraction bot guide](docs/AUSTRALIA_EXTRACTION_BOT.md).

## Continuous school checks

`npm run schools:start` starts the independent school verification queue;
`npm run schools:status` shows progress and `npm run schools:stop` pauses after the
current profile. It reads LinkedIn education in a separate tab, saves evidence,
and updates the database for confirmed matches. Local comparisons continue alongside
it. Results remain in the Location matching agents dashboard. See
[the school bot guide](docs/SCHOOL_VERIFICATION_BOT.md).
