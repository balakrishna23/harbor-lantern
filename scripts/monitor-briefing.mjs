import { db } from "../src/db.mjs";
import { execSync, spawn } from "node:child_process";

async function checkCdp() {
  try {
    const res = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

let cdpHealthy = await checkCdp();
let cdpAutoRecovered = false;

// If Brave CDP is down, automatically revive it
if (!cdpHealthy) {
  try {
    execSync(`"${process.execPath}" scripts/launch-brave-debug.mjs`, { stdio: "ignore" });
    await new Promise(r => setTimeout(r, 4000));
    cdpHealthy = await checkCdp();
    cdpAutoRecovered = cdpHealthy;
  } catch (e) {
    // handled
  }
}

// Process check (Windows PowerShell)
let supervisorAlive = false;
let workersAlive = false;
let workerCount = 0;
let workerPids = [];

function checkProcesses() {
  supervisorAlive = false;
  workersAlive = false;
  workerCount = 0;
  workerPids = [];
  try {
    const psOut = execSync('powershell -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'node.exe\'\\" | Select-Object ProcessId, CommandLine | ConvertTo-Json"', { encoding: "utf8" });
    const procs = JSON.parse(psOut);
    const procList = Array.isArray(procs) ? procs : [procs];
    for (const p of procList) {
      const cmd = p.CommandLine || "";
      if (cmd.includes("auto-run-browser-agent.mjs")) {
        supervisorAlive = true;
      }
      if (cmd.includes("run-browser-agent.mjs")) {
        workersAlive = true;
        workerPids.push(p.ProcessId);
        const match = cmd.match(/--workers=(\d+)/);
        if (match) workerCount = Number(match[1]);
      }
    }
  } catch (e) {}
}

checkProcesses();

let supervisorAutoRecovered = false;

// If Supervisor is offline, automatically revive it with 4 workers
if (!supervisorAlive) {
  try {
    const child = spawn(process.execPath, ["scripts/auto-run-browser-agent.mjs"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, BROWSER_AGENT_WORKERS: "4" }
    });
    child.unref();
    await new Promise(r => setTimeout(r, 2000));
    checkProcesses();
    supervisorAutoRecovered = supervisorAlive;
  } catch (e) {}
}

const stages = Object.fromEntries(
  db.prepare("SELECT workflow_stage, COUNT(*) as cnt FROM candidates GROUP BY workflow_stage ORDER BY 2 DESC")
    .all().map(r => [r.workflow_stage, r.cnt])
);

const statuses = Object.fromEntries(
  db.prepare("SELECT identity_status, COUNT(*) as cnt FROM candidates GROUP BY identity_status ORDER BY 2 DESC")
    .all().map(r => [r.identity_status, r.cnt])
);

const leadsCount = db.prepare("SELECT COUNT(*) as c FROM browser_leads").get().c;

const recentLeads = db.prepare(
  "SELECT id, candidate_id, linkedin_url, headline, location, created_at FROM browser_leads ORDER BY id DESC LIMIT 5"
).all();

const confirmed = db.prepare(
  "SELECT id, full_name, profession, state, postcode, linkedin_url, identity_match_score, employer, current_title, recruiter_notes, updated_at FROM candidates WHERE identity_status = 'confirmed' ORDER BY updated_at DESC"
).all();

const integrity = db.prepare("PRAGMA integrity_check").get().integrity_check;
const fkErrors = db.prepare("PRAGMA foreign_key_check").all().length;

const inFlight = stages.claiming_browser_discovery || 0;
const totalProcessed = (stages.identity_unresolved || 0) + confirmed.length;

// Send ntfy push notification
const ntfyMsg = `HCRHUB Autonomous Watchdog:
Supervisor: ${supervisorAlive ? "ACTIVE" : "OFFLINE"}${supervisorAutoRecovered ? " (Auto-Recovered!)" : ""}
Workers: ${workersAlive ? `4 Active (PID ${workerPids.join(",")})` : "Batch Transition / Paused"}
CDP Port 9222: ${cdpHealthy ? "Connected" : "Disconnected"}${cdpAutoRecovered ? " (Auto-Recovered!)" : ""}
Confirmed Nurses: ${confirmed.length}
Total Processed: ${totalProcessed}
In-Flight Batch: ${inFlight}
Raw Leads Logged: ${leadsCount}
DB Integrity: ${integrity === "ok" && fkErrors === 0 ? "100% OK" : "CHECK REQUIRED"}`;

try {
  await fetch("https://ntfy.sh/hcrhub-recon-merugu", {
    method: "POST",
    body: ntfyMsg,
    headers: {
      "Title": `HCRHUB Watchdog: ${confirmed.length} Confirmed | ${totalProcessed} Processed`,
      "Priority": supervisorAutoRecovered || cdpAutoRecovered ? "high" : "default"
    }
  });
} catch (err) {}

console.log(JSON.stringify({
  health: {
    supervisorAlive,
    supervisorAutoRecovered,
    workersAlive,
    workerPids,
    workerCount,
    cdpHealthy,
    cdpAutoRecovered
  },
  stages,
  statuses,
  leadsCount,
  inFlight,
  totalProcessed,
  recentLeads,
  confirmedCount: confirmed.length,
  confirmed,
  integrity,
  fkErrors
}, null, 2));
