import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { applyMigrations } from "../src/migrations.mjs";
import { explainEmail, buildEmail, learnDomainPatterns, patternConfidence } from "../src/email-engine/patterns.mjs";
import { buildEmployerIndex, normaliseEmployer } from "../src/email-engine/employers.mjs";
import { findWorkEmail } from "../src/email-engine/engine.mjs";
import { parseSmtpReply, rcptVerdict, probeAddresses, resetPort25StateForTests } from "../src/email-engine/verify.mjs";
import { crmRows, CRM_COLUMNS } from "../src/email-engine/crm-export.mjs";

// Shapes taken from real addresses in the ACT data.
const actExamples = [
  { firstName: "Aanya", lastName: "Hartono", employer: "Canberra Health Services", email: "aanya.hartono@act.gov.au" },
  { firstName: "Anushka", lastName: "Tamboli", employer: "Canberra Hospital", email: "anushka.tamboli@act.gov.au" },
  { firstName: "Liesl", lastName: "Arlott", employer: "ACT Health", email: "liesl.arlott@act.gov.au" },
  { firstName: "Bimala", lastName: "Acharya Kharel", employer: "Canberra Health Services", email: "bimala.acharyakharel@act.gov.au" },
  // Someone else's address returned for this person — must be ignored.
  { firstName: "Aditi", lastName: "Bhattarai", employer: "Australian Red Cross Lifeblood", email: "zquadri@hammond.com.au" }
];

test("explainEmail recognises formats, joined multi-part surnames, and rejects someone else's address", () => {
  assert.deepEqual(explainEmail({ firstName: "Bimala", lastName: "Acharya Kharel" }, "bimala.acharyakharel@act.gov.au"), ["first.last"]);
  assert.deepEqual(explainEmail({ firstName: "Aditi", lastName: "Siddiqui" }, "a.siddiqui@basscare.org.au"), ["f.last"]);
  assert.deepEqual(explainEmail({ firstName: "Ayla", lastName: "Fontana" }, "afontana@au.drakeintl.com"), ["flast"]);
  assert.deepEqual(explainEmail({ firstName: "José", lastName: "O'Brien" }, "jose.obrien@x.org.au"), ["first.last"]);
  assert.deepEqual(explainEmail({ firstName: "Aditi", lastName: "Bhattarai" }, "zquadri@hammond.com.au"), []);
});

test("learnDomainPatterns finds the dominant format and counts noise separately", () => {
  const learned = learnDomainPatterns(actExamples);
  const act = learned.get("act.gov.au");
  assert.equal(act.best, "first.last");
  assert.equal(act.total, 4);
  assert.equal(patternConfidence(act), "strong");
  assert.equal(learned.get("hammond.com.au").total, 0);
  assert.equal(learned.get("hammond.com.au").noise, 1);
  assert.equal(patternConfidence(learned.get("hammond.com.au")), "none");
});

test("employer names match despite legal suffixes and case, and personal mailboxes never define an employer", () => {
  assert.equal(normaliseEmployer("CAPITAL PATHOLOGY PTY LTD"), normaliseEmployer("Capital Pathology"));
  const index = buildEmployerIndex([
    ...actExamples,
    { firstName: "A", lastName: "B", employer: "Some Clinic", email: "a.b@gmail.com" }
  ], [{ employer: "Box Hill Institute", domain: "boxhill.edu.au", source: "manual" }]);
  assert.equal(index.resolve("canberra health services").domain, "act.gov.au");
  assert.equal(index.resolve("Box Hill Institute").source, "manual");
  assert.equal(index.resolve("Some Clinic"), null);
});

test("findWorkEmail builds the learned format, and never marks a built address as OK to email", async () => {
  const deps = { patternsByDomain: learnDomainPatterns(actExamples), employerIndex: buildEmployerIndex(actExamples) };
  const found = await findWorkEmail({ firstName: "Grace", lastName: "Wanjiru-Smith", employer: "Canberra Hospital" }, deps);
  assert.equal(found.email, "grace.wanjirusmith@act.gov.au");
  assert.equal(found.confidence, "strong");
  assert.equal(found.source, "derived_from_format");
  assert.equal(found.mayEmail, false);

  const unknown = await findWorkEmail({ firstName: "Amy", lastName: "Jessop", employer: "LDK Seniors' Living" }, deps);
  assert.equal(unknown.email, null);
  assert.match(unknown.reason, /no email domain known/);
});

test("findWorkEmail handles a whole name stored in the surname field and lowers confidence for unclear names", async () => {
  const deps = { patternsByDomain: learnDomainPatterns(actExamples), employerIndex: buildEmployerIndex(actExamples) };
  // Register shape: first_name blank, last_name "Tanvi Shalini Thomas".
  const split = await findWorkEmail({ firstName: "", lastName: "Tanvi Shalini Thomas", employer: "ACT Health" }, deps);
  assert.equal(split.email, "tanvi.thomas@act.gov.au");
  assert.equal(split.confidence, "moderate");
  // Two-part first name: which part the address uses is a guess.
  const twoPart = await findWorkEmail({ firstName: "Meera Anu", lastName: "Sam", employer: "ACT Health" }, deps);
  assert.equal(twoPart.email, "meera.sam@act.gov.au");
  assert.equal(twoPart.confidence, "moderate");
  assert.equal((await findWorkEmail({ firstName: "", lastName: "Madonna", employer: "ACT Health" }, deps)).reason, "name incomplete");
});

test("findWorkEmail lets a mail-server check pick the format for a domain with no examples", async () => {
  const employerIndex = buildEmployerIndex([], [{ employer: "Example Aged Care", domain: "example.org.au" }]);
  const probe = async (domain, emails) => ({ status: "checked", catchAll: false, results: Object.fromEntries(emails.map((e) => [e, e === "jsmith@example.org.au" ? "accepted" : "rejected"])) });
  const found = await findWorkEmail({ firstName: "Jane", lastName: "Smith", employer: "Example Aged Care" },
    { patternsByDomain: new Map(), employerIndex, verify: true, probe });
  assert.equal(found.email, "jsmith@example.org.au");
  assert.equal(found.confidence, "verified");

  const catchAll = async () => ({ status: "checked", catchAll: true, results: {} });
  const unsure = await findWorkEmail({ firstName: "Jane", lastName: "Smith", employer: "Example Aged Care" },
    { patternsByDomain: new Map(), employerIndex, verify: true, probe: catchAll });
  assert.equal(unsure.email, null); // no learned format and the server accepts anything → no guess
});

test("SMTP replies parse across multi-line responses and map to verdicts", () => {
  assert.equal(parseSmtpReply("250-mx.example\r\n250-SIZE 1000\r\n"), null);
  assert.deepEqual(parseSmtpReply("250-mx.example\r\n250 OK\r\n"), { code: 250, message: "mx.example OK" });
  assert.equal(rcptVerdict(250), "accepted");
  assert.equal(rcptVerdict(550), "rejected");
  assert.equal(rcptVerdict(451), "unknown");
});

test("probeAddresses reports 'unverifiable' (not 'rejected') when port 25 is blocked", async () => {
  resetPort25StateForTests();
  const resolver = { resolveMx: async () => [{ exchange: "mx.blocked.example", priority: 10 }] };
  const connect = () => {
    const socket = new EventEmitter();
    socket.write = () => {}; socket.end = () => {}; socket.destroy = () => {};
    setTimeout(() => socket.emit("error", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), 5);
    return socket;
  };
  const result = await probeAddresses("blocked.example", ["a@blocked.example"], { resolver, connect, timeoutMs: 1000 });
  assert.equal(result.status, "unverifiable");
  assert.equal(result.reason, "ETIMEDOUT");
  // Known blocked for the rest of the run: no further connection attempts.
  let attempts = 0;
  const again = await probeAddresses("blocked.example", ["b@blocked.example"], { resolver, connect: () => { attempts += 1; return connect(); } });
  assert.equal(again.reason, "outbound port 25 blocked");
  assert.equal(attempts, 0);
  resetPort25StateForTests();
});

test("probeAddresses only says 'no mail server' on a definite DNS answer, not when DNS is unreachable", async () => {
  const refused = { resolveMx: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); } };
  assert.equal((await probeAddresses("unreachable-dns.example", ["a@x"], { resolver: refused })).status, "unverifiable");
  const none = { resolveMx: async () => { throw Object.assign(new Error("no data"), { code: "ENODATA" }); } };
  assert.equal((await probeAddresses("no-mx.example", ["a@x"], { resolver: none })).status, "no_mx");
});

test("CRM rows carry the OK-to-Email guardrail and use import-friendly column names", () => {
  const db = new DatabaseSync(":memory:");
  applyMigrations(db);
  db.exec(`
    INSERT INTO imports (id, filename, file_hash) VALUES (1, 't.csv', 'h');
    INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, first_name, last_name, employer, current_title, registration_status, ahpra_number)
      VALUES (1, 1, 2, 'h1', 'Jane Smith', 'Jane', 'Smith', 'Canberra Hospital', 'Registered Nurse', 'Registered', 'NMW0000000001');
    INSERT INTO email_findings (candidate_id, email, domain, pattern, confidence, verification, source, may_email)
      VALUES (1, 'jane.smith@act.gov.au', 'act.gov.au', 'first.last', 'strong', 'unverifiable', 'derived_from_format', 0);
  `);
  db.exec(`
    INSERT INTO candidates (id, import_id, source_row, source_hash, full_name, first_name, last_name, registration_status)
      VALUES (2, 1, 3, 'h2', 'Ken Lee', 'Ken', 'Lee', 'Registered');
    INSERT INTO contact_points (candidate_id, kind, contact_value, verification_status, provider, active)
      VALUES (2, 'work_email', 'ken.lee@example.org.au', 'unverified', 'clay', 1);
  `);
  const [row, provider] = crmRows(db);
  assert.equal(row["Email"], "jane.smith@act.gov.au");
  assert.equal(row["OK to Email"], "No");
  assert.equal(row["Email Check"], "Not checked (port 25 blocked)");
  assert.deepEqual(Object.keys(row), CRM_COLUMNS);
  // Provider-held emails are included too, labelled as such and not OK to email.
  assert.equal(provider["Email"], "ken.lee@example.org.au");
  assert.equal(provider["Email Source"], "Found by a data provider (Clay)");
  assert.equal(provider["OK to Email"], "No");
  db.close();
});
