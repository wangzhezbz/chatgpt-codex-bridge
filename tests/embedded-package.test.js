import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildEmbeddedPackagePlan } from "../src/embedded-package.js";

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
    version: "0.1.0",
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
    extensionDir: "chrome-extension"
  });
});

test("package.json exposes package:embedded", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  assert.equal(packageJson.scripts["package:embedded"], "node scripts/create-embedded-package.js");
  assert.equal(packageJson.license, "MIT");
});
