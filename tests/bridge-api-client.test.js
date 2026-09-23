import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeApiClient } from "../public/bridge-api-client.js";

function jsonResponse(status, value) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return value;
    }
  };
}

test("browser API client bootstraps a token before its first mutation", async () => {
  const calls = [];
  const client = createBridgeApiClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === "/api/config") {
        return jsonResponse(200, { apiToken: "page-session-token" });
      }
      return jsonResponse(201, { id: "task_secured" });
    }
  });

  const response = await client.fetch("/api/tasks", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title: "secured" })
  });

  assert.equal(response.status, 201);
  assert.deepEqual(calls.map((call) => call.url), ["/api/config", "/api/tasks"]);
  assert.equal(calls[1].options.headers["X-Bridge-Token"], "page-session-token");
});

test("browser API client refreshes an expired token once after service restart", async () => {
  const calls = [];
  let configReads = 0;
  const client = createBridgeApiClient({
    apiToken: "expired-token",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === "/api/config") {
        configReads += 1;
        return jsonResponse(200, { apiToken: "replacement-token" });
      }
      if (options.headers["X-Bridge-Token"] === "expired-token") {
        return jsonResponse(401, { error: "Bridge API token is required" });
      }
      return jsonResponse(201, { id: "task_after_restart" });
    }
  });

  const response = await client.fetch("/api/tasks", {
    method: "POST",
    body: "{}"
  });

  assert.equal(response.status, 201);
  assert.equal(configReads, 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["/api/tasks", "/api/config", "/api/tasks"]
  );
  assert.equal(calls[2].options.headers["X-Bridge-Token"], "replacement-token");
});

test("browser API client carries its page scope on config and mutation requests", async () => {
  const calls = [];
  const client = createBridgeApiClient({
    scopeToken: "signed-thread-scope",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (url === "/api/config") {
        return jsonResponse(200, { apiToken: "scoped-page-token" });
      }
      return jsonResponse(200, { ok: true });
    }
  });

  await client.fetch("/api/config");
  await client.fetch("/api/projects/current-session", {
    method: "POST",
    body: "{}"
  });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.headers["X-Bridge-Scope"], "signed-thread-scope");
  }
  assert.equal(calls[2].options.headers["X-Bridge-Token"], "scoped-page-token");
});
