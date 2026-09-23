import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildEmbeddedPackagePlan } from "../src/embedded-package.js";
import { EXTENSION_PROTOCOL_VERSION } from "../src/service-metadata.js";

test("embedded package uses an exact runtime allowlist", () => {
  const plan = buildEmbeddedPackagePlan({ version: "0.1.0" });
  assert.equal(plan.packageName, "ChatGPT-Codex-Bridge-Embedded-v0.1.0");
  assert.equal(plan.archiveName, "ChatGPT-Codex-Bridge-Embedded-v0.1.0.zip");
  assert.deepEqual(
    plan.entries.map((entry) => entry.to),
    [
      "src",
      "public",
      "chrome-extension",
      "package.json",
      "package-lock.json",
      "embedded-manifest.json",
      "LICENSE"
    ]
  );
  assert.deepEqual(plan.entries.find((entry) => entry.to === "src").exclude, [
    "src/embedded-package.js"
  ]);
});

test("embedded manifest defines stable host integration entrypoints", async () => {
  const manifest = JSON.parse(await readFile("embedded-manifest.json", "utf8"));
  assert.deepEqual(manifest, {
    name: "chatgpt-codex-bridge",
    version: "0.1.95",
    protocolVersion: 1,
    entrypoints: {
      http: "src/index.js",
      mcp: "src/mcp-server.js"
    },
    defaults: {
      host: "127.0.0.1",
      port: 4317
    },
    healthPath: "/health",
    versionPath: "/version",
    security: {
      apiTokenHeader: "X-Bridge-Token",
      scopeHeader: "X-Bridge-Scope",
      scopeQueryParameter: "scope",
      scopeCreatePath: "/api/scopes"
    },
    extensionDir: "chrome-extension"
  });
});

test("package.json exposes package:embedded", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["package:embedded"], "node scripts/create-embedded-package.js");
  assert.equal(packageJson.license, "MIT");
});

test("embedded Chrome extension keeps its visible release version aligned with the content protocol", async () => {
  const manifest = JSON.parse(await readFile("chrome-extension/manifest.json", "utf8"));
  const contentScript = await readFile("chrome-extension/content-script.js", "utf8");
  const workerProtocol = /const WORKER_ID = "codex-chatgpt-project-extension-([^\"]+)";/.exec(contentScript)?.[1];
  const protocolDate = /^v(\d{8})-/.exec(EXTENSION_PROTOCOL_VERSION)?.[1];

  assert.equal(manifest.version, "0.1.95");
  assert.equal(manifest.version_name, "0.1.95 - 20260923");
  assert.equal(workerProtocol, EXTENSION_PROTOCOL_VERSION);
  assert.equal(protocolDate, "20260923");
  assert.equal(manifest.version_name, `${manifest.version} - ${protocolDate}`);
});
