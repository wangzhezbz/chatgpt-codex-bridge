import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("extension loads bridge-config before the content script and allows every loopback port", async () => {
  const manifest = JSON.parse(await readFile("chrome-extension/manifest.json", "utf8"));
  assert.deepEqual(manifest.content_scripts[0].js.slice(0, 2), [
    "bridge-config.js",
    "content-script.js"
  ]);
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1/*"));
  assert.equal(manifest.host_permissions.includes("http://127.0.0.1:4317/*"), false);
});

test("content script sends Bridge API requests to the unified configured origin", async () => {
  const source = await readFile("chrome-extension/content-script.js", "utf8");
  let fetchedUrl = null;
  const context = {
    CODEX_BRIDGE_CONFIG: { origin: "http://127.0.0.1:54321" },
    console,
    document: { querySelector: () => null, querySelectorAll: () => [] },
    fetch: async (url) => {
      fetchedUrl = String(url);
      return { ok: true, async json() { return { ok: true }; } };
    },
    InputEvent: class {},
    location: { hostname: "chatgpt.com", href: "https://chatgpt.com/c/demo" },
    URL,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    setInterval() {},
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  await context.bridgeApi("/api/config");
  assert.equal(fetchedUrl, "http://127.0.0.1:54321/api/config");
  assert.doesNotMatch(source, /const BRIDGE_ORIGIN = "http:\/\/127\.0\.0\.1:4317"/);
});

test("background worker reads the same config and contains no independent 4317 fallback", async () => {
  const source = await readFile("chrome-extension/background.js", "utf8");
  const config = await readFile("chrome-extension/bridge-config.js", "utf8");

  assert.match(source, /importScripts\("bridge-config\.js"\)/);
  assert.match(source, /CODEX_BRIDGE_CONFIG/);
  assert.doesNotMatch(source, /input\.bridgeOrigin \|\| "http:\/\/127\.0\.0\.1:4317"/);
  assert.match(config, /http:\/\/127\.0\.0\.1:4317/);
});
