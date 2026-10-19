import { db } from "../src/db.mjs";

const ws = db.prepare("SELECT workflow_stage, COUNT(id) as cnt FROM candidates GROUP BY workflow_stage").all();
const ids = db.prepare("SELECT identity_status, COUNT(id) as cnt FROM candidates GROUP BY identity_status").all();
const highest = db.prepare("SELECT MAX(id) as maxId FROM candidates WHERE workflow_stage != 'source_imported'").get();
const total = db.prepare("SELECT COUNT(id) as total FROM candidates").get().total;
const confirmed = db.prepare("SELECT COUNT(id) as c FROM candidates WHERE identity_status = 'confirmed'").get().c;
const unresolved = db.prepare("SELECT COUNT(id) as u FROM candidates WHERE workflow_stage = 'academic_unresolved'").get().u;

console.log(JSON.stringify({
  total,
  highestCandidateProcessed: highest.maxId,
  confirmed,
  unresolved,
  stages: ws,
  identities: ids
}, null, 2));
