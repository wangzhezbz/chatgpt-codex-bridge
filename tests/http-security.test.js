import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";

async function withServer(options, fn) {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-security-"));
  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    apiToken: "test-bridge-token",
    ...options
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("browser requests from an unrelated origin cannot read Bridge APIs", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: {
        Origin: "https://attacker.example"
      }
    });

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

test("trusted same-origin responses reflect only that origin and expose the session API token", async () => {
  await withServer({}, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: {
        Origin: baseUrl
      }
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), baseUrl);
    assert.equal(response.headers.get("vary"), "Origin");
    const config = await response.json();
    assert.equal(config.apiToken, "test-bridge-token");
  });
});

test("browser mutation requests require the Bridge API token", async () => {
  await withServer({}, async (baseUrl) => {
    const request = (token) =>
      fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          Origin: baseUrl,
          "Content-Type": "application/json",
          ...(token ? { "X-Bridge-Token": token } : {})
        },
        body: JSON.stringify({
          title: "Protected task",
          prompt: "Do not accept cross-site mutation.",
          run: false
        })
      });

    const blocked = await request(null);
    assert.equal(blocked.status, 401);

    const accepted = await request("test-bridge-token");
    assert.equal(accepted.status, 201);
  });
});

test("trusted extension preflight receives the narrow Bridge header allowlist", async () => {
  await withServer({}, async (baseUrl) => {
    const extensionOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    const response = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "OPTIONS",
      headers: {
        Origin: extensionOrigin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-bridge-token"
      }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), extensionOrigin);
    assert.equal(
      response.headers.get("access-control-allow-headers"),
      "Content-Type, X-Bridge-Token, X-Bridge-Scope"
    );
  });
});

test("JSON request bodies over the configured limit fail before creating a task", async () => {
  await withServer({ maxJsonBodyBytes: 128 }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: "Oversized",
        prompt: "x".repeat(1024),
        run: false
      })
    });

    assert.equal(response.status, 413);

    const listResponse = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), []);
  });
});
