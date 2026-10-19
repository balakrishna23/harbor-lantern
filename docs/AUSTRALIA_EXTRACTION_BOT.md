# Australia extraction bot

Open `http://127.0.0.1:4173/extraction-bot.html` after starting the dashboard.
Start/resume launches a detached worker. Pause after current batch waits for the
current export and comparison to finish. No scheduled chat or open chat is needed.

The worker uses the installed `playwright-core` and the signed-in Brave session at
`http://127.0.0.1:9222`. It never restarts Brave. Do not close the extraction tab or
change its selected list while it is working. Authentication and access challenges
pause the bot for manual action. It does not bypass restrictions or send messages.

## Workflow

1. Recover the exact active search/list from the last saved manifest, if present.
2. Keep the current title filter at Registered Nurse. Try available geography tags.
   Combine tags within one state until the next addition would exceed 99 pages;
   remove that addition and leave it pending. An oversized singleton needs a split.
3. Create an exact, unique list in the existing hcrhub folder. Find it by name first
   on resume, so retries cannot create duplicate lists.
4. Select that list, verify its name, save the starting checkpoint, start extraction.
5. Monitor page and saved counts every 5 seconds. On the final page only, 60
   seconds of unchanged page/contact counts stops a cycling extractor and salvages
   the saved export. An empty page beyond already collected results is also an
   end boundary; a fresh empty search is not. A short export remains incomplete. Twelve minutes with no
   progress elsewhere pauses for review. A mid-search stop is not completion.
6. After the extractor stops twice on the last page, read the actual GrowMeOrganic
   saved count. Label a count below the displayed total/range as a short export.
7. Download the complete list CSV, confirm exported row count matches saved count,
   then run the existing register comparison agent in the background while the next
   batch is prepared and extracted. Pending comparisons are checkpointed and resumed
   after a worker restart; a pause drains them, and failures pause for review.
   No identity confirmation occurs
   from name matching, and school checks are not started by this extraction bot.
8. Save progress and proceed to the next batch unless pause was requested.

The queue combines priority regions with the ABS locality checklist when that file
exists. These names are not a verified Sales Navigator taxonomy. Missing tags, large
singletons, prior searches and short exports remain distinct from reconciled counts.
State searches supersede localities only when the broad export count reconciles.
Search results overlap and change: counts are not unique people or proof of complete
geographic coverage. Oversized single locations need further filters/manual splits.

State: `data/extraction-bot/state.json`; activity: `events.jsonl`; worker output:
`worker.log`; downloads: `exports/`. The worker lock prevents concurrent owners.
Queue/progress is persistent; Start/resume does not reset prior work. Checkpoints
before list creation and extraction handle uncertain outcomes without blind repeats.
Location selection waits for stable results once, rather than repeating the same
wait when reading its count. The immediate pre-extraction size check still waits
independently. GrowMeOrganic controls its own page-processing countdown; polling
more frequently does not accelerate that countdown.

CSV downloads use a durable `data/extraction-bot/downloads` directory and browser
download events tied to the GrowMeOrganic page frame. This avoids temporary
Playwright download paths disappearing when another CDP worker exits. The saved
CSV still must reconcile with GrowMeOrganic's contact count before comparison.

CLI: `node scripts/run-location-extractor.mjs` (foreground) or use the dashboard.
Debug connection must be enabled after an existing extraction finishes. Never run
the older `monitor-briefing.mjs` to start this bot: it controls another discovery
pipeline and can restart the browser.
