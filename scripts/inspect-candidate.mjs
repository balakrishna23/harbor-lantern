import { db } from "../src/db.mjs";

const id = process.argv[2] || 38;
const row = db.prepare("SELECT * FROM candidates WHERE id = ?").get(id);
console.log(JSON.stringify(row, null, 2));
