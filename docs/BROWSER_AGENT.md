# Browser agent (Sales Navigator discovery)

Clay's indexed "Person LinkedIn URL" search only found 76 of 1,463 nurses in the last full run (5.2%) — most of this registry isn't well represented in Clay's data sources. The browser agent instead drives LinkedIn Sales Navigator from your own logged-in Brave session, so it searches LinkedIn directly rather than a third-party index.

## How it differs from the Clay pipeline

- **Runs against your real session**, not a bot login — it attaches to a Brave window you already have open via the Chrome DevTools Protocol, reusing your existing Sales Navigator authentication.
- **Paced, not parallel.** Unlike the Clay swarm's multiple concurrent workers, this runs one search at a time with a randomized delay between searches (`BROWSER_SEARCH_DELAY_MIN_MS`/`MAX_MS`, default 15–45s), in small batches (`BROWSER_BATCH_SIZE`, default 8). This is a deliberate account-safety choice — LinkedIn actively polices automated search patterns, including through Sales Navigator, and high-volume/headless-style automation risks the account. Keep batches small; this isn't designed to scan the whole registry unattended.
- **Auto-confirms clean matches directly** — no `pending_confirmation` queue. A match that clears `MATCH_HIGH_THRESHOLD` with zero conflicts is written straight to `identity_status = 'confirmed'` via `applyBrowserLeadDecision` in `src/browser-agent.mjs`, following the same convention already used by the swarm orchestrator's academic-verification engine. The one thing that never changes regardless of automation level: `scoreIdentityMatch`'s hard-conflict rejection (non-Australian phone, overseas location, name-mismatched LinkedIn slug) still zeroes the score and blocks confirmation.
- **Every find is logged before any decision is made**, to `browser_leads` (migration v7) — the raw Sales Navigator result plus the normalized fields, independent of whether it ended up confirmed. This is what makes spot-checking practical.

## Setup

1. `npm install` (installs `playwright-core`; no browser binaries are downloaded since it attaches to your existing Brave instead of launching a new one).
2. Run `node scripts/launch-brave-debug.mjs`. It checks whether Brave is already reachable on the CDP port; if not, it ends any running `brave.exe` and relaunches it with `--remote-debugging-port` against your existing profile and `--restore-last-session` (same logins, same open tabs — Chromium ignores the flag on a second launch while an instance is already running, which is why a full close is required first). Runs non-interactively — no confirmation prompt — since this closes and relaunches the real browser window each time.
3. Make sure a Sales Navigator tab is open in that window (it should already be, if it was open before the relaunch).

## Running it

```
node scripts/run-browser-agent.mjs --limit=50 --batch-size=8
```

Stops gracefully on Ctrl+C (finishes the candidate in progress, releases the rest of the batch back to `manual_review` rather than leaving them stuck claimed).

## Spot-checking ("surprise inspection")

```
node scripts/audit-browser-confirmations.mjs --limit=20
```

Lists recent auto-confirmations with the exact Sales Navigator find (headline, employer, location, education snippet) and the scoring reasons side by side, so checking a batch is a quick read-through rather than re-researching each candidate from scratch.

## Known limitation

Sales Navigator's markup is dynamic and not publicly documented; the selectors in `src/browser-agent.mjs` are a best-effort first pass favoring accessible roles/text over generated class names, but may need adjustment after watching a live run. Start with a small `--limit` the first time.
