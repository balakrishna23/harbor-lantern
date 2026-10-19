import dns from "node:dns/promises";
import net from "node:net";

/**
 * Address checks without sending email.
 *
 * 1. MX lookup: does the domain accept mail at all? Always possible.
 * 2. SMTP "RCPT TO" probe: connect to the domain's mail server, start a
 *    conversation, ask whether it would accept mail for the address, then
 *    QUIT before anything is sent. A random address is asked too: if that is
 *    also accepted the domain is "catch-all" and the answer means nothing.
 *    Needs outbound port 25, which most home internet providers block
 *    (confirmed blocked on the operator's PC, 2026-10-17) — so the probe
 *    detects that once and reports "unverifiable" instead of guessing.
 *
 * Probing is rate-limited per domain and never retried aggressively: mail
 * servers treat bursts of RCPT checks as abuse.
 */

const mxCache = new Map();
export async function lookupMx(domain, { resolver = dns } = {}) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  let result;
  try {
    const records = await resolver.resolveMx(domain);
    result = { ok: records.length > 0, hosts: records.sort((a, b) => a.priority - b.priority).map((r) => r.exchange) };
  } catch (error) {
    // Only a definite answer means "no mail server"; a DNS failure (no
    // network, refused, timeout) says nothing about the domain.
    const definite = ["ENODATA", "ENOTFOUND"].includes(error.code);
    result = { ok: false, definite, hosts: [], error: error.code || error.message };
  }
  if (result.ok || result.definite) mxCache.set(domain, result);
  return result;
}

/** Reads one (possibly multi-line) SMTP reply: "250-..." lines continue, "250 ..." ends. */
export function parseSmtpReply(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const last = lines.at(-1) || "";
  const match = last.match(/^(\d{3})([ -])(.*)$/);
  if (!match || match[2] === "-") return null; // incomplete
  return { code: Number(match[1]), message: lines.map((l) => l.slice(4)).join(" ").trim() };
}

/** Maps a RCPT TO reply code to a verdict. */
export function rcptVerdict(code) {
  if (code === 250 || code === 251) return "accepted";
  if (code >= 550 && code <= 553) return "rejected";
  return "unknown"; // 4xx greylisting / throttling, 252 "cannot verify", etc.
}

let port25 = null; // null = untested, true/false once known for this process
export function resetPort25StateForTests() { port25 = null; }

function smtpSession(host, { timeoutMs = 15000, connect = net.connect } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port: 25 });
    let buffer = "";
    let waiting = null;
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); }, timeoutMs);
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const reply = parseSmtpReply(buffer);
      if (reply && waiting) { buffer = ""; const w = waiting; waiting = null; w(reply); }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    const next = () => new Promise((r) => { waiting = r; });
    const send = (line) => { socket.write(`${line}\r\n`); return next(); };
    next().then((greeting) => resolve({ greeting, send, close: () => { clearTimeout(timer); socket.end("QUIT\r\n"); } }), reject);
  });
}

/**
 * Probes addresses at one domain. Returns { status, catchAll, results: {email: verdict} }.
 * status: "checked" | "unverifiable" (port 25 blocked / server refused) | "no_mx".
 */
export async function probeAddresses(domain, emails, { heloName = "hcrhub.local", mailFrom = "", timeoutMs = 15000, connect, resolver } = {}) {
  const mx = await lookupMx(domain, { resolver });
  if (!mx.ok) {
    return mx.definite
      ? { status: "no_mx", catchAll: null, results: {} }
      : { status: "unverifiable", reason: `DNS lookup failed (${mx.error})`, catchAll: null, results: {} };
  }
  if (port25 === false) return { status: "unverifiable", reason: "outbound port 25 blocked", catchAll: null, results: {} };
  let session;
  try {
    session = await smtpSession(mx.hosts[0], { timeoutMs, connect });
    port25 = true;
  } catch (error) {
    if (["ETIMEDOUT", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(error.code)) port25 = false;
    return { status: "unverifiable", reason: error.code || error.message, catchAll: null, results: {} };
  }
  try {
    if (session.greeting.code !== 220) return { status: "unverifiable", reason: `greeting ${session.greeting.code}`, catchAll: null, results: {} };
    if ((await session.send(`EHLO ${heloName}`)).code !== 250) return { status: "unverifiable", reason: "EHLO refused", catchAll: null, results: {} };
    if ((await session.send(`MAIL FROM:<${mailFrom}>`)).code !== 250) return { status: "unverifiable", reason: "MAIL FROM refused", catchAll: null, results: {} };
    const results = {};
    for (const email of emails) results[email] = rcptVerdict((await session.send(`RCPT TO:<${email}>`)).code);
    const random = `zz${Math.random().toString(36).slice(2, 12)}@${domain}`;
    const catchAll = rcptVerdict((await session.send(`RCPT TO:<${random}>`)).code) === "accepted";
    return { status: "checked", catchAll, results };
  } finally {
    session.close();
  }
}
