import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";
import { installMcpShutdownHandlers } from "../src/mcp-server.js";
import {
  resolveBridgeDataDir,
  resolveBridgeExtensionDir
} from "../src/runtime-config.js";
import { createGracefulShutdown } from "../src/service-lifecycle.js";

async function tempDir(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test("BRIDGE_DATA_DIR takes precedence while BRIDGE_STORE remains compatible", () => {
  const cwd = path.resolve("F:/embedded-cwd");
  assert.equal(
    resolveBridgeDataDir({
      cwd,
      env: {
        BRIDGE_DATA_DIR: "./embedded-data",
        BRIDGE_STORE: "./legacy-data"
      }
    }),
    path.resolve(cwd, "embedded-data")
  );
  assert.equal(
    resolveBridgeDataDir({ cwd, env: { BRIDGE_STORE: "./legacy-data" } }),
    path.resolve(cwd, "legacy-data")
  );
});

test("BRIDGE_EXTENSION_DIR overrides the package extension directory", () => {
  const packageRoot = path.resolve("F:/embedded-package");
  assert.equal(
    resolveBridgeExtensionDir({
      packageRoot,
      env: { BRIDGE_EXTENSION_DIR: "./stable-extension" }
    }),
    path.resolve(packageRoot, "stable-extension")
  );
  assert.equal(
    resolveBridgeExtensionDir({ packageRoot, env: {} }),
    path.join(packageRoot, "chrome-extension")
  );
});

test("HTTP service exposes minimal health, version, and configured extension metadata", async () => {
  const storeRoot = await tempDir("bridge-embedded-health-");
  const extensionSourceDir = await tempDir("bridge-embedded-extension-");
  const server = createHttpServer({ storeRoot, extensionSourceDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const healthResponse = await fetch(`${baseUrl}/health`);
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), {
      ok: true,
      service: "chatgpt-codex-bridge",
      status: "ready",
      version: "0.1.0",
      protocolVersion: 1
    });

    const versionResponse = await fetch(`${baseUrl}/version`);
    assert.equal(versionResponse.status, 200);
    assert.deepEqual(await versionResponse.json(), {
      service: "chatgpt-codex-bridge",
      version: "0.1.0",
      protocolVersion: 1,
      extensionProtocolVersion: "v20260711-router-v2-safety"
    });

    const configResponse = await fetch(`${baseUrl}/api/config`);
    const config = await configResponse.json();
    assert.equal(config.storeRoot, path.resolve(storeRoot));
    assert.equal(config.extensionSourceDir, path.resolve(extensionSourceDir));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`HTTP ${signal} handler stops accepting connections and completes once`, async () => {
    const server = createHttpServer({ storeRoot: await tempDir("bridge-embedded-shutdown-") });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const processRef = new EventEmitter();
    processRef.exitCode = undefined;
    const logs = [];
    const lifecycle = createGracefulShutdown({
      server,
      processRef,
      timeoutMs: 1_000,
      logger: { log: (value) => logs.push(value), error: (value) => logs.push(value) }
    });
    lifecycle.install();

    const closed = once(server, "close");
    processRef.emit(signal);
    await closed;
    await lifecycle.closed;

    assert.equal(processRef.exitCode, 0);
    assert.equal(server.listening, false);
    assert.equal(logs.filter((line) => line.includes(signal)).length, 1);
    processRef.emit(signal);
    assert.equal(logs.filter((line) => /shutdown complete/i.test(line)).length, 1);
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`MCP ${signal} handler closes the server`, async () => {
    const processRef = new EventEmitter();
    processRef.stdin = new EventEmitter();
    processRef.exitCode = undefined;
    let closeCalls = 0;
    const lifecycle = installMcpShutdownHandlers({
      server: { async close() { closeCalls += 1; } },
      processRef,
      logger: { error() {} }
    });

    processRef.emit(signal);
    await lifecycle.closed;
    assert.equal(closeCalls, 1);
    assert.equal(processRef.exitCode, 0);
  });
}

test("MCP stdin closure closes the server idempotently", async () => {
  const processRef = new EventEmitter();
  processRef.stdin = new EventEmitter();
  processRef.exitCode = undefined;
  let closeCalls = 0;
  const server = {
    async close() {
      closeCalls += 1;
    }
  };
  const lifecycle = installMcpShutdownHandlers({
    server,
    processRef,
    logger: { error() {} }
  });

  processRef.stdin.emit("end");
  processRef.stdin.emit("close");
  await lifecycle.closed;

  assert.equal(closeCalls, 1);
  assert.equal(processRef.exitCode, 0);
});
