import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "./migrations.mjs";

const dbPath = path.resolve(process.env.DATABASE_PATH || "./data/hcrhub.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
applyMigrations(db);

export function audit(action, entityType, entityId, details = {}) {
  db.prepare("INSERT INTO audit_log(action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)")
    .run(action, entityType, String(entityId ?? ""), JSON.stringify(details));
}
