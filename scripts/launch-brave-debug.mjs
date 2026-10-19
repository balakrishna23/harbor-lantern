#!/usr/bin/env node
/**
 * Setup step for the browser agent: Brave only exposes the Chrome DevTools
 * Protocol port used by scripts/run-browser-agent.mjs if it was started with
 * --remote-debugging-port. This script:
 *
 *   1. Checks whether a debug-enabled Brave is already reachable (no-op if so).
 *   2. Otherwise ends any running brave.exe (Chromium ignores the debug flag
 *      on a second launch while an instance is already running against the
 *      same profile — a half-closed browser silently won't enable it, so a
 *      real close is required first) and relaunches Brave against the
 *      EXISTING profile with the flag added and --restore-last-session so
 *      open tabs (including Sales Navigator) come back, still logged in.
 *
 * Run non-interactively (no confirmation prompt) at the user's standing
 * request — this closes and relaunches their real Brave window each time.
 */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const PORT = Number(process.env.CDP_PORT || 9222);
const ENDPOINT = `http://127.0.0.1:${PORT}`;

const CANDIDATE_PATHS = [
  process.env.BRAVE_EXECUTABLE_PATH,
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  `${process.env.LOCALAPPDATA}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/brave-browser"
].filter(Boolean);

async function isDebugPortReady() {
  try {
    const res = await fetch(`${ENDPOINT}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function findBraveExecutable() {
  return CANDIDATE_PATHS.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) || null;
}

async function waitForDebugPort(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDebugPortReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function isBraveRunning() {
  if (process.platform !== "win32") return false;
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq brave.exe" /NH', { encoding: "utf8" });
    return /brave\.exe/i.test(out);
  } catch {
    return false;
  }
}

function endBrave() {
  console.log("[Brave Debug] Ending running brave.exe so it can restart with the debug port enabled...");
  try {
    execSync("taskkill /IM brave.exe /F", { stdio: "ignore" });
  } catch {
    // No matching process, or already gone — fine either way.
  }
}

async function main() {
  if (await isDebugPortReady()) {
    console.log(`[Brave Debug] Already reachable at ${ENDPOINT}. Nothing to do.`);
    return;
  }

  const bravePath = findBraveExecutable();
  if (!bravePath) {
    console.error(
      "[Brave Debug] Could not find brave.exe in the usual locations.\n" +
      "Set BRAVE_EXECUTABLE_PATH to its full path and run this script again."
    );
    process.exit(1);
  }

  console.log("===============================================================");
  console.log("  BRAVE DEBUG-MODE LAUNCH");
  console.log("===============================================================");
  console.log(`Found Brave at: ${bravePath}`);

  if (isBraveRunning()) {
    endBrave();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  console.log(`\n[Brave Debug] Launching Brave with --remote-debugging-port=${PORT}...`);
  const braveArgs = [`--remote-debugging-port=${PORT}`, "--restore-last-session"];
  // On Windows, spawning a GUI .exe directly with detached+ignore stdio is
  // unreliable in practice (confirmed live: it silently produced no running
  // process at all) — routing through `cmd /c start` is the standard robust
  // way to launch a fully independent Windows GUI process from Node.
  const child = process.platform === "win32"
    ? spawn("cmd.exe", ["/c", "start", '""', bravePath, ...braveArgs], { detached: true, stdio: "ignore", windowsHide: true })
    : spawn(bravePath, braveArgs, { detached: true, stdio: "ignore" });
  child.unref();

  console.log(`[Brave Debug] Waiting for the debug port (up to 60s — a cold start restoring many tabs/extensions can take a while)...`);
  const ready = await waitForDebugPort();
  if (!ready) {
    console.error(
      `\n[Brave Debug] ${ENDPOINT} never became reachable within 60s.\n` +
      `brave.exe was ended and relaunched fresh, so it's most likely still cold-starting (many\n` +
      `tabs/extensions to restore) — just run this script again; it will detect the now-ready\n` +
      `port immediately if Brave finished starting in the meantime.\n`
    );
    process.exit(1);
  }

  const tabs = await fetch(`${ENDPOINT}/json/list`).then((res) => res.json()).catch(() => []);
  console.log(`\n[Brave Debug] Ready at ${ENDPOINT}. ${tabs.length} tab(s) open:`);
  for (const tab of tabs) console.log(`  - ${tab.title || "(untitled)"} — ${tab.url}`);
  console.log("\nMake sure one of them is your LinkedIn Sales Navigator tab, then run:");
  console.log("  node scripts/run-browser-agent.mjs\n");
}

main().catch((err) => {
  console.error("[Brave Debug] Failed:", err.message);
  process.exit(1);
});
