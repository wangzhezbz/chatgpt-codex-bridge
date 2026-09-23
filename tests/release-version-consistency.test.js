import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SERVICE_VERSION, versionPayload } from "../src/service-metadata.js";

test("release version is consistent across package, embedded runtime, service and Chrome extension", async () => {
  const [packageJson, embeddedManifest, extensionManifest] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile("embedded-manifest.json", "utf8").then(JSON.parse),
    readFile("chrome-extension/manifest.json", "utf8").then(JSON.parse)
  ]);
  assert.equal(packageJson.version, "0.1.95");
  assert.equal(embeddedManifest.version, packageJson.version);
  assert.equal(extensionManifest.version, packageJson.version);
  assert.equal(SERVICE_VERSION, packageJson.version);
  assert.equal(versionPayload().version, packageJson.version);
});

test("runtime entrypoints do not publish an obsolete hard-coded release version", async () => {
  const files = ["src/mcp-server.js", "src/codex-app-relay.js"];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /version:\s*["']0\.1\.0["']/, file);
  }
});
