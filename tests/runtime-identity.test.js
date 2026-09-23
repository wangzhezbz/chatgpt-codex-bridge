import assert from "node:assert/strict";
import { access, mkdtemp, readdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createHttpServer } from "../src/http-server.js";

async function mcp(t, storeRoot) {
  const server = createMcpServer({ storeRoot, env: {}, currentCodexThreadId: "identity-thread" });
  const client = new Client({ name: "runtime-identity-test", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(() => client.close());
  return client;
}

test("HTTP and MCP report matching store identity without creating a project", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-identity-"));
  const server = createHttpServer({ storeRoot: root, env: {}, currentCodexThreadId: "identity-thread" });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = await mcp(t, path.join(root, "."));
  const listed = await client.listTools();
  assert.ok(listed.tools.some(tool => tool.name === "get_runtime_identity" && tool.annotations?.readOnlyHint === true));
  const config = await (await fetch(`${base}/api/config`)).json();
  assert.ok(config.runtime?.dataRootId, "HTTP config must expose the same identity contract");
  const before = await readdir(root);
  const response = await client.callTool({ name: "get_runtime_identity", arguments: { expectedDataRootId: config.runtime.dataRootId } });
  assert.equal(response.isError, undefined);
  const identity = response.structuredContent;
  assert.equal(identity.comparison.state, "matched");
  assert.equal(identity.dataRootId, config.runtime.dataRootId);
  assert.equal(identity.dataRoot, config.runtime.dataRoot);
  assert.equal(identity.currentCodexThreadId, "identity-thread");
  assert.equal(identity.service, "chatgpt-codex-bridge");
  assert.equal(identity.routerLockProtocol, "kernel-v1", "runtime identity must identify upgraded lock participants");
  assert.equal(config.runtime.routerLockProtocol, identity.routerLockProtocol);
  assert.equal(identity.stateStorageProtocol, "atomic-backup-v1");
  assert.equal(config.runtime.stateStorageProtocol, identity.stateStorageProtocol);
  assert.equal(identity.apiToken, undefined);
  assert.equal(identity.scopeToken, undefined);
  assert.deepEqual(await readdir(root), before, "identity lookup cannot bind, claim or create files");
  const diagnostics = await (await fetch(`${base}/api/diagnostics/status`)).json();
  assert.equal(diagnostics.runtime.dataRootId, identity.dataRootId);
});

test("a missing MCP store is unknown and is not created by identity lookup", async t => {
  const parent = await mkdtemp(path.join(tmpdir(), "bridge-identity-missing-"));
  const missing = path.join(parent, "not-created");
  const client = await mcp(t, missing);
  const result = await client.callTool({ name: "get_runtime_identity", arguments: { expectedDataRootId: "a".repeat(64) } });
  assert.equal(result.structuredContent.dataRootId, null);
  assert.equal(result.structuredContent.dataRootStatus, "missing");
  assert.equal(result.structuredContent.comparison.state, "unknown");
  await assert.rejects(access(missing), { code: "ENOENT" });
});

test("same data directory cannot hide protocol version mismatches", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-identity-protocol-"));
  const client = await mcp(t, root);
  const first = await client.callTool({ name: "get_runtime_identity", arguments: {} });
  const checked = await client.callTool({ name: "get_runtime_identity", arguments: {
    expectedDataRootId: first.structuredContent.dataRootId,
    expectedProtocolVersion: 999, expectedExtensionProtocolVersion: "fixture-incompatible"
  } });
  assert.equal(checked.structuredContent.comparison.state, "mismatched");
  assert.deepEqual(checked.structuredContent.comparison.mismatches, ["protocolVersion", "extensionProtocolVersion"]);
});

test("a directory alias reports the same canonical data identity", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-identity-alias-"));
  const target = await mkdtemp(path.join(root, "target-"));
  const alias = path.join(root, "alias");
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => unlink(alias));
  const first = await mcp(t, target), second = await mcp(t, alias);
  const a = await first.callTool({ name: "get_runtime_identity", arguments: {} });
  const b = await second.callTool({ name: "get_runtime_identity", arguments: { expectedDataRootId: a.structuredContent.dataRootId } });
  assert.equal(b.structuredContent.comparison.state, "matched");
  assert.equal(b.structuredContent.dataRoot, a.structuredContent.dataRoot);
});

test("different MCP data roots return an explicit mismatch and never change either store", async t => {
  const rootA = await mkdtemp(path.join(tmpdir(), "bridge-identity-a-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "bridge-identity-b-"));
  const a = await mcp(t, rootA), b = await mcp(t, rootB);
  const first = await a.callTool({ name: "get_runtime_identity", arguments: {} });
  assert.ok(first.structuredContent?.dataRootId, "unbound MCP must support read-only identification");
  const second = await b.callTool({ name: "get_runtime_identity", arguments: { expectedDataRootId: first.structuredContent.dataRootId } });
  assert.equal(second.structuredContent.comparison.state, "mismatched");
  assert.deepEqual(second.structuredContent.comparison.mismatches, ["dataRootId"]);
  assert.deepEqual(await readdir(rootA), []);
  assert.deepEqual(await readdir(rootB), []);
});
