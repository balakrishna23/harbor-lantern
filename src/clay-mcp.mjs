import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const endpoints = Object.freeze({
  authorization: "https://app.clay.com/oauth/authorize",
  registration: "https://api.clay.com/oauth/register",
  token: "https://api.clay.com/oauth/token",
  revocation: "https://api.clay.com/oauth/revoke",
  mcp: "https://api.clay.com/v3/mcp"
});

const base64url = (value) => Buffer.from(value).toString("base64url");

function responsePayload(text, contentType) {
  if (!text) return null;
  if (!contentType.includes("text/event-stream")) return JSON.parse(text);
  const messages = text.split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line));
  return messages.at(-1) || null;
}

export class ClayMcpClient {
  constructor({ redirectUri, metadataPath, tokenPath, fetchImpl = fetch, now = () => Date.now() }) {
    this.redirectUri = redirectUri;
    this.metadataPath = metadataPath;
    this.tokenPath = tokenPath || null;
    this.fetch = fetchImpl;
    this.now = now;
    this.client = this.loadClient();
    this.pending = null;
    this.tokens = this.loadTokens();
    this.sessionId = null;
    this.tools = [];
    this.requestId = 0;
  }

  loadTokens() {
    if (!this.tokenPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
      if (parsed?.accessToken) return parsed;
    } catch {}
    return null;
  }

  saveTokens() {
    if (!this.tokenPath || !this.tokens) return;
    try {
      fs.mkdirSync(path.dirname(this.tokenPath), { recursive: true });
      fs.writeFileSync(this.tokenPath, `${JSON.stringify(this.tokens, null, 2)}\n`, { mode: 0o600 });
    } catch {}
  }

  clearTokens() {
    this.tokens = null;
    if (this.tokenPath) {
      try { if (fs.existsSync(this.tokenPath)) fs.unlinkSync(this.tokenPath); } catch {}
    }
  }

  loadClient() {
    try {
      const client = JSON.parse(fs.readFileSync(this.metadataPath, "utf8"));
      return client.redirect_uri === this.redirectUri && client.client_id ? client : null;
    } catch {
      return null;
    }
  }

  saveClient(client) {
    fs.mkdirSync(path.dirname(this.metadataPath), { recursive: true });
    const publicMetadata = { client_id: client.client_id, redirect_uri: this.redirectUri };
    fs.writeFileSync(this.metadataPath, `${JSON.stringify(publicMetadata, null, 2)}\n`, { mode: 0o600 });
    this.client = publicMetadata;
  }

  async jsonRequest(url, options) {
    const response = await this.fetch(url, options);
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    if (!response.ok) {
      throw new Error(payload.error_description || payload.message || payload.error || `Clay request failed (${response.status})`);
    }
    return payload;
  }

  async ensureClient() {
    if (this.client) return this.client;
    const registered = await this.jsonRequest(endpoints.registration, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "HCRHUB Candidate Intelligence",
        redirect_uris: [this.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: "mcp"
      })
    });
    if (!registered.client_id) throw new Error("Clay did not return an OAuth client ID");
    this.saveClient(registered);
    return this.client;
  }

  async beginAuthorization() {
    const client = await this.ensureClient();
    const verifier = base64url(crypto.randomBytes(64));
    const state = base64url(crypto.randomBytes(32));
    const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
    this.pending = { verifier, state, expiresAt: this.now() + 10 * 60_000 };
    const url = new URL(endpoints.authorization);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "mcp",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256"
    });
    return url.toString();
  }

  async completeAuthorization({ code, state, error, errorDescription }) {
    if (error) throw new Error(errorDescription || error);
    if (!code || !state || !this.pending || state !== this.pending.state || this.pending.expiresAt < this.now()) {
      this.pending = null;
      throw new Error("Clay authorization state is invalid or expired");
    }
    const verifier = this.pending.verifier;
    this.pending = null;
    const token = await this.jsonRequest(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.redirectUri,
        code_verifier: verifier,
        client_id: this.client.client_id
      })
    });
    this.setTokens(token);
    await this.initialize();
  }

  setTokens(token) {
    if (!token.access_token) throw new Error("Clay did not return an access token");
    this.tokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || null,
      expiresAt: this.now() + (Number(token.expires_in || 3600) * 1000) - 30_000
    };
    this.saveTokens();
  }

  async accessToken() {
    if (!this.tokens) throw new Error("Clay is not connected");
    if (this.tokens.expiresAt > this.now()) return this.tokens.accessToken;
    if (!this.tokens.refreshToken) throw new Error("Clay authorization expired; reconnect Clay");
    const token = await this.jsonRequest(endpoints.token, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.tokens.refreshToken,
        client_id: this.client.client_id
      })
    });
    this.setTokens(token);
    this.sessionId = null;
    return this.tokens.accessToken;
  }

  async mcpRequest(method, params = {}, notification = false) {
    const request = { jsonrpc: "2.0", method, params };
    if (!notification) request.id = ++this.requestId;
    const token = await this.accessToken();
    const response = await this.fetch(endpoints.mcp, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {})
      },
      body: JSON.stringify(request)
    });
    if (!this.sessionId && response.headers.get("mcp-session-id")) {
      this.sessionId = response.headers.get("mcp-session-id");
    }
    const text = await response.text();
    const payload = responsePayload(text, response.headers.get("content-type") || "");
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error?.message || `Clay MCP request failed (${response.status})`);
    }
    return payload?.result || null;
  }

  async initialize() {
    this.sessionId = null;
    await this.mcpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "HCRHUB Candidate Intelligence", version: "0.1.0" }
    });
    await this.mcpRequest("notifications/initialized", {}, true);
    return this.refreshTools();
  }

  async refreshTools() {
    if (!this.sessionId) return this.initialize();
    const result = await this.mcpRequest("tools/list");
    this.tools = Array.isArray(result?.tools) ? result.tools : [];
    return this.tools;
  }

  async callTool(name, args = {}) {
    if (!this.sessionId) await this.initialize();
    const tool = this.tools.find((item) => item.name === name);
    if (!tool) throw new Error(`Clay tool is not available: ${name}`);
    return this.mcpRequest("tools/call", { name, arguments: args });
  }

  async listSubroutines() {
    return this.callTool("list_subroutines", {});
  }

  async subroutineInputOptions(args) {
    return this.callTool("get_subroutine_input_options", args);
  }

  async creditsAvailable() {
    return this.callTool("get-credits-available", {});
  }

  async runSubroutineDirect(subroutineId, inputs) {
    return this.callTool("run_subroutine_direct", { subroutine_id: subroutineId, inputs });
  }

  async taskContext(taskId, page = 1) {
    return this.callTool("get-task-context", { taskId, page });
  }

  status() {
    return {
      connected: Boolean(this.tokens),
      sessionReady: Boolean(this.sessionId),
      tokenPersistence: this.tokenPath ? "file_secured" : "memory_only",
      tools: this.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        inputProperties: Object.keys(tool.inputSchema?.properties || {})
      }))
    };
  }

  async disconnect() {
    const token = this.tokens?.refreshToken || this.tokens?.accessToken;
    try {
      if (token && this.client) {
        await this.fetch(endpoints.revocation, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token, client_id: this.client.client_id })
        });
      }
    } finally {
      this.pending = null;
      this.clearTokens();
      this.sessionId = null;
      this.tools = [];
    }
  }
}

export const clayMcpEndpoints = endpoints;

export function pruneSubroutines(catalog) {
  if (!catalog || !Array.isArray(catalog.subroutines)) return { subroutines: [] };
  return {
    subroutines: catalog.subroutines.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description || "",
      requiredInputs: (item.requiredInputs || []).map((input) => ({
        name: input.name,
        type: input.type
      }))
    }))
  };
}

export function pruneTaskContext(task) {
  if (!task || typeof task !== "object") return {};
  const pruned = {
    taskId: task.taskId || task.task_id || task.id,
    status: task.status,
    completed: Boolean(task.completed || task.status === "completed" || task.isComplete)
  };
  if (task.actualCredits != null) pruned.actualCredits = task.actualCredits;
  if (task.results || task.outputs || task.output) {
    pruned.results = task.results || task.outputs || task.output;
  }
  if (task.error || task.errorMessage) {
    pruned.error = task.error || task.errorMessage;
  }
  return pruned;
}

