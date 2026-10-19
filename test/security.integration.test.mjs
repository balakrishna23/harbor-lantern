import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, child) {
  // Up to 10s: with the whole suite running in parallel on a busy machine,
  // start-up sometimes exceeded the old 2s budget (flaky, not a real failure).
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode != null) throw new Error(`Test server exited with ${child.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Test server did not start");
}

test("HTTP boundaries reject malformed and oversized imports with security headers", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-security-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: path.resolve("."),
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATABASE_PATH: path.join(directory, "test.sqlite"), MAX_UPLOAD_BYTES: "80" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth(baseUrl, child);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-frame-options"), "DENY");

    const malformed = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{broken"
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, "Request body is not valid JSON");

    const wrongType = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "source.txt", csvText: "name\nExample" })
    });
    assert.equal(wrongType.status, 400);
    assert.match((await wrongType.json()).error, /\.xlsx or \.csv/);

    const oversized = await fetch(`${baseUrl}/api/import`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "source.csv", csvText: `name\n${"x".repeat(100)}` })
    });
    assert.equal(oversized.status, 400);
    assert.match((await oversized.json()).error, /upload limit/);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
