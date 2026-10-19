import { db } from "../src/db.mjs";

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

for (const t of tables) {
  const fks = db.prepare(`PRAGMA foreign_key_list(${t.name})`).all();
  if (fks.length > 0) {
    console.log(`Table ${t.name} references:`);
    for (const fk of fks) {
      console.log(`  -> ${fk.table} (${fk.to} <- ${fk.from})`);
    }
  }
}
