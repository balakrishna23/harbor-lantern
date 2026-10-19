import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClayMcpClient, clayMcpEndpoints } from "../src/clay-mcp.mjs";

test("Clay OAuth uses public-client PKCE and keeps tokens out of persistent metadata", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-clay-oauth-"));
  const metadataPath = path.join(directory, "client.json");
  const requests = [];
  const fakeFetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === clayMcpEndpoints.registration) {
      const body = JSON.parse(options.body);
      assert.equal(body.token_endpoint_auth_method, "none");
      return new Response(JSON.stringify({ client_id: "cci_test" }), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (url === clayMcpEndpoints.token) {
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("client_id"), "cci_test");
      assert.ok(body.get("code_verifier").length >= 43);
      return new Response(JSON.stringify({ access_token: "access-secret", refresh_token: "refresh-secret", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url === clayMcpEndpoints.mcp) {
      const request = JSON.parse(options.body);
      assert.equal(options.headers.authorization, "Bearer access-secret");
      if (request.method === "initialize") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { capabilities: {} } }), {
          status: 200, headers: { "content-type": "application/json", "mcp-session-id": "session-1" }
        });
      }
      assert.equal(options.headers["mcp-session-id"], "session-1");
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [{
        name: "HCRHUB Identity Discovery", description: "Find a professional identity",
        inputSchema: { properties: { full_name: {}, profession: {} } }
      }, {
        name: "list_subroutines", description: "List functions", inputSchema: { properties: {} }
      }, {
        name: "get-credits-available", description: "Credits", inputSchema: { properties: {} }
      }, {
        name: "run_subroutine_direct", description: "Run", inputSchema: { properties: { subroutine_id: {}, inputs: {} } }
      }, {
        name: "get-task-context", description: "Task", inputSchema: { properties: { taskId: {}, page: {} } }
      }] } }), { status: 200, headers: { "content-type": "application/json" } });
      if (request.method === "tools/call") return new Response(JSON.stringify({
        jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Identity Discovery" }] }
      }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected MCP method ${request.method}`);
    }
    if (url === clayMcpEndpoints.revocation) return new Response(null, { status: 200 });
    throw new Error(`Unexpected URL ${url}`);
  };
  try {
    const client = new ClayMcpClient({
      redirectUri: "http://127.0.0.1:4173/api/clay/oauth/callback", metadataPath, fetchImpl: fakeFetch
    });
    const authorizationUrl = new URL(await client.beginAuthorization());
    assert.equal(authorizationUrl.origin, "https://app.clay.com");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorizationUrl.searchParams.get("code_challenge"));
    await client.completeAuthorization({ code: "authorization-code", state: authorizationUrl.searchParams.get("state") });
    assert.equal(client.status().connected, true);
    assert.deepEqual(client.status().tools[0].inputProperties, ["full_name", "profession"]);
    const subroutines = await client.listSubroutines();
    assert.equal(subroutines.content[0].text, "Identity Discovery");
    const persisted = fs.readFileSync(metadataPath, "utf8");
    assert.match(persisted, /cci_test/);
    assert.doesNotMatch(persisted, /access-secret|refresh-secret/);
    await client.disconnect();
    assert.equal(client.status().connected, false);
    assert.ok(requests.some((request) => request.url === clayMcpEndpoints.revocation));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Clay OAuth rejects a mismatched state before token exchange", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hcrhub-clay-state-"));
  let calls = 0;
  const client = new ClayMcpClient({
    redirectUri: "http://127.0.0.1:4173/api/clay/oauth/callback",
    metadataPath: path.join(directory, "client.json"),
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ client_id: "cci_state" }), { status: 201, headers: { "content-type": "application/json" } });
    }
  });
  try {
    await client.beginAuthorization();
    await assert.rejects(client.completeAuthorization({ code: "code", state: "wrong-state" }), /invalid or expired/);
    assert.equal(calls, 1, "only client registration occurs; no token request is made");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
