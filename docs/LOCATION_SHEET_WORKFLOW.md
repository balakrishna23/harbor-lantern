# Location spreadsheets and school verification

## Dashboard

Open **Location matching agents** in the existing dashboard. Choose one or more
real Sales Navigator exports, tick the real-data declaration, and press
**1. Match against register**. This runs a separate background worker and keeps
the dashboard responsive. Dummy workbooks are format references only and must
not be submitted to the agents.

Review the run summary and candidate evidence. Press **2. Start school checks**
separately, with a chosen per-run limit (default 10). **Stop agent** stops matching
or lets the current school check finish before stopping. The run selector retains
earlier runs. Download all results, possible register matches, school-confirmed
profiles or the review queue as Excel-compatible CSV.

Dashboard uploads/job metadata live in `data/location-agents/`; results and
evidence live in `data/location-agent-results/`. These paths follow the configured
database directory. They are excluded from version control. Restarting the server
never launches an agent automatically; interrupted work is marked for review.

The supplied October workbook was explicitly identified by the user as dummy
data with fake results. Its discarded initial comparison is marked invalid in
`tmp/dummy-format-example-2026-10-18/` and is not an active matching run. No
LinkedIn checks were performed on it. Automated validation uses independent
synthetic fixtures in temporary databases.

## Australia coverage

Search batches are in `sample/australia-search-batches.csv`. Select the matching
location offered by Sales Navigator, covering the entire state or territory,
including regional and remote areas. Display labels vary; these are location
names, not Sales Navigator geo IDs. Include the Australia-wide catch-up because
some profiles expose only a country and some territories may lack a location
filter. Deduplication preserves all source-file/sheet/row references.

If a search/export is capped, do not call the batch complete: subdivide using
the locations actually offered and reconcile a rest-of-state search. City names
alone do not form an exhaustive partition. Geographic scope follows the ABS
definition including Jervis Bay, Norfolk, Christmas and Cocos (Keeling):
https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-4-july-2026-june-2031/methodology

## Compare one or several exports

```powershell
node scripts/compare-location-sheets.mjs "ACT-real.xlsx" --real-data
node scripts/compare-location-sheets.mjs "ACT-real.xlsx" "NSW-real.xlsx" "VIC-real.xlsx" --real-data --register-import=2
```

Accepts `.xlsx` (all sheets) and `.csv`. The supplied Sales Navigator format maps
`first_name`, `middle_name`, `last_name`, `url`, `job_title`, `company_name`, `city`.
Header case and spaces/underscores are normalised. No email or phone is used as
identity evidence or copied into the verification outputs.

The main database opens read-only. The latest national register import is used
by default, or choose `--register-import=ID`. Facts come from that import's
preserved source registrations, since the candidate table can retain older ACT
facts for a registration also present in the national import. A completed import
must reconcile to its preserved source-row count.

Eligibility is **Nurse + Registered status + Registered nurse (Division 1),
General** on at least one source row of that extract. Dual RN/EN qualifies via its
RN row. EN-only, provisional-only, non-practising-only and unregistered records
remain visible as ineligible alternatives. This is a historical extract check,
not a live AHPRA registration check. Location is not a register matching key.

Name matches (including recorded alternative names) are provisional. All
matching registration numbers are retained, and supplied registration numbers
take precedence. Numeric, incomplete or conflicting names are held for review.
Identical LinkedIn URLs are deduplicated across files while retaining provenance.
Opaque `/in/ACw...` profile identifiers are accepted without guessing their names.

Each new comparison creates a results directory containing `report.json`
(resumable data), `summary.json`, `results.csv` (one row per unique profile),
`register-candidates.csv` (one row per possible registration), `confirmed.csv`
and `review.csv`. All CSVs open in Excel. The original workbooks are unchanged.
Existing report directories cannot be overwritten by another comparison.

## Run the separate verification bot

Use an existing Brave CDP session signed in to LinkedIn (`CDP_ENDPOINT`, or the
CLI `--cdp=` option). The bot only opens
supplied profile URLs. It does not run Sales Navigator searches or enrichment.

```powershell
node scripts/run-school-verifier.mjs "exports/location-matches/RUN/report.json" --limit=10
```

Checks are serial, paced at 20–25 seconds between profiles by default, with an
explicit limit. Login walls, rate limits and access restrictions stop the run.
There is no automatic retry or bypass. Real LinkedIn markup still needs a small
calibration run when real data is supplied; selector failures stay unavailable
instead of confirming a person. With no CDP browser, no profiles are
claimed or marked checked. Only the bot's own tab is closed on completion.

The bot reads the opened profile name and **Education section**, not school
mentions elsewhere on the page. All usable Australian and overseas institutions
in the register are considered. Exact normalised institution names and explicit
aliases are accepted. Unsupported aliases stay uncorroborated rather than being
guessed. Years, when visible for the same institution, can expose conflicts.

Auto-confirmation requires one eligible registration with matching profile name
and school, no recorded middle-name or year conflict, and no equally plausible
school match or competitor whose register school is missing. Missing education,
unreadable profiles, nonmatching schools and ambiguous identities stay in review.
A nonmatching visible school is not treated as proof of a different person.

`school-evidence.jsonl` records source URL, final URL, time, observed profile name
and education snippets before each report checkpoint. Reruns resume pending work.
Use `--retry-unavailable` deliberately after resolving access/missing data. A lock
prevents concurrent verifiers on the same report. After an abnormal kill, verify
the PID in `verifier.lock` is gone before deleting the stale lock.

School findings are saved in the database's `school_verification_checks` table
and in this pipeline's report and exports. Clear matches update the candidate's
identity status and canonical LinkedIn URL, with review history, match evidence
and an audit entry. Existing rejections, hard conflicts or a different profile
assignment require review and are never silently overwritten. Resume is
idempotent. Ambiguous findings save evidence without confirming an identity.
Registration facts, contact details and contact-basis permissions are preserved.
No enrichment or outreach is executed by the school verifier.

Dashboard checks automatically enable these database updates. CLI runs enable
them with `--database=data/hcrhub.sqlite --job-id=RUN_ID`. The independently
launched supervisor is `node scripts/run-school-pilot.mjs RUN_ID --limit=10`;
it survives the chat turn and records completion in the dashboard job metadata.
It stops after the specified batch. A dashboard stop request also reaches an
independent verifier via a stop-request file. The browser must already expose
the configured local CDP endpoint. Do not restart the user's browser without
coordinating the interruption of their searches.
