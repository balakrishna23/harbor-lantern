#!/usr/bin/env node
/**
 * Imports a register converted by scripts/convert-register-xlsx.py, in
 * committed chunks, through the same insertCandidateRows the HTTP upload
 * uses (one candidate per registration number, every registration row kept,
 * existing candidates never overwritten). For files too large for the
 * server's in-memory upload path.
 *
 * The import's file_hash is the SHA-256 of the ORIGINAL source file (not the
 * JSONL), so re-importing the same source is detected and skipped exactly as
 * an identical upload would be.
 *
 * Usage:
 *   node scripts/import-register-jsonl.mjs --jsonl=<file.jsonl> --source=<original.xlsx> [--note="..."]
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { db, audit } from "../src/db.mjs";
import { insertCandidateRows } from "../src/importer.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.length ? rest.join("=") : true];
}));
if (!args.jsonl || !args.source) {
  console.error('Usage: node scripts/import-register-jsonl.mjs --jsonl=<file.jsonl> --source=<original.xlsx> [--note="..."]');
  process.exit(1);
}
const CHUNK = 5000;

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function main() {
  const fileHash = await sha256(args.source);
  const previous = db.prepare("SELECT id, total_rows FROM imports WHERE file_hash = ?").get(fileHash);
  if (previous) {
    console.log(`Already imported as import #${previous.id} (${previous.total_rows} rows) — nothing to do.`);
    return;
  }

  const importId = Number(db.prepare("INSERT INTO imports(filename, file_hash, source_name, agreement_reference, total_rows) VALUES (?, ?, ?, ?, ?)")
    .run(path.basename(args.source), fileHash, "AHPRA licensed data", "", 0).lastInsertRowid);
  const totals = { rows: 0, inserted: 0, duplicates: 0, rejected: 0 };
  let chunk = [];
  let firstSourceRow = 2;

  const flush = () => {
    if (!chunk.length) return;
    db.exec("BEGIN");
    try {
      const result = insertCandidateRows(db, importId, chunk, { firstSourceRow });
      db.exec("COMMIT");
      totals.inserted += result.inserted;
      totals.duplicates += result.duplicates;
      totals.rejected += result.rejected;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    firstSourceRow += chunk.length;
    totals.rows += chunk.length;
    chunk = [];
    process.stdout.write(`\r  ${totals.rows.toLocaleString()} rows | ${totals.inserted.toLocaleString()} new | ${totals.duplicates.toLocaleString()} already present`);
  };

  const lines = readline.createInterface({ input: fs.createReadStream(args.jsonl, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    chunk.push(JSON.parse(line));
    if (chunk.length >= CHUNK) flush();
  }
  flush();
  process.stdout.write("\n");

  db.prepare("UPDATE imports SET total_rows = ?, inserted_rows = ?, duplicate_rows = ?, rejected_rows = ? WHERE id = ?")
    .run(totals.rows, totals.inserted, totals.duplicates, totals.rejected, importId);
  audit("import.completed", "import", importId, { ...totals, via: "import-register-jsonl", note: args.note || "" });
  console.log(`Import #${importId} complete:`, totals);
}

main().catch((error) => {
  console.error("Import failed:", error);
  process.exit(1);
});
