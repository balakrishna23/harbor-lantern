# Continuous school verification

`npm run schools:start` launches an independent, hidden worker. It uses a separate
LinkedIn profile tab in the existing Brave debugging session. It never restarts or
closes Brave and never changes the Sales Navigator extraction tab.

The supervisor checks ready comparison reports in chronological order, checks ten
profiles per durable chunk, prioritizes single-candidate matches within each chunk,
then continues automatically. New completed comparison batches join the queue.
The continuous worker waits 8–13 seconds between profiles (8-second minimum plus
up to 5 seconds of jitter), reduced from 20–25 seconds. Page navigation, full
education reading, evidence persistence and identity checks are unchanged. The
standalone/dashboard verifier retains a 20-second default unless given an explicit
delay. The active supervisor's minimumDelaySeconds is shown by schools:status.
There is one school reader at a time. Local register matching can run alongside it
on separate job reports; comparisons and school checks cannot edit the same active job.

The existing rules require matching names, an eligible Registered Nurse record,
corroborating education and no recorded identity/date conflict. Ambiguous candidates,
missing schools and conflicting existing URLs remain unresolved or require review.
Confirmed results can update `data/hcrhub.sqlite` with an audit trail. Name matching
alone never confirms identity.

Evidence is journaled before database/report writes. Completed checks are retained,
and checkpoints tolerate transient Windows destination-file locks. Access restrictions
or three successive unreadable education sections pause for review without automatic
retries. A paused supervisor needs an explicit start after the problem is addressed.

`npm run schools:status` shows live totals, the active run and errors.
`npm run schools:stop` finishes the current profile and pauses. Matching-run results,
school evidence and confirmed/review CSV downloads remain in the existing dashboard:
http://127.0.0.1:4173/#locationAgents

Supervisor state/log: `data/school-bot/`. Per-profile evidence and reports:
`data/location-agent-results/<job-id>/`. Existing Excel exports are static snapshots;
this worker updates the dashboard, reports and database, not already exported workbooks.
