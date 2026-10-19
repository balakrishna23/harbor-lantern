import fs from "node:fs";
import path from "node:path";

const rootDir = path.resolve(".");
const ignoreDirs = new Set(["node_modules", ".git", ".idea", ".vscode"]);

function getFiles(dir) {
  let results = [];
  const list = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of list) {
    if (ignoreDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(getFiles(fullPath));
    } else {
      const stats = fs.statSync(fullPath);
      results.push({
        path: path.relative(rootDir, fullPath).replace(/\\/g, "/"),
        size: stats.size,
        mtime: stats.mtime
      });
    }
  }
  return results;
}

const allFiles = getFiles(rootDir);
// Filter for files modified since 2026-09-21 00:00:00 (today)
const cutoff = new Date("2026-09-21T00:00:00+05:30").getTime();
const todayFiles = allFiles.filter(f => f.mtime.getTime() >= cutoff);
todayFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

console.log(`=== FILES MODIFIED OR CREATED TODAY (Total: ${todayFiles.length}) ===\n`);

const grouped = {};
for (const f of todayFiles) {
  const folder = path.dirname(f.path);
  if (!grouped[folder]) grouped[folder] = [];
  grouped[folder].push(f);
}

for (const [folder, files] of Object.entries(grouped)) {
  console.log(`📁 [${folder}] (${files.length} files):`);
  for (const file of files) {
    const timeStr = file.mtime.toISOString().replace("T", " ").substring(0, 19);
    console.log(`  - ${path.basename(file.path)} (${(file.size / 1024).toFixed(1)} KB) - ${timeStr}`);
  }
  console.log();
}
