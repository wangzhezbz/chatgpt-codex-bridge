import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createGptTransportRegistry } from "../src/gpt-transports/transport-registry.js";
import { createMockGptTransport } from "../src/gpt-transports/mock-transport.js";
import { createMcpServer } from "../src/mcp-server.js";
import { createProject } from "../src/project-store.js";

test("createMcpServer returns a connectable MCP server", () => {
  const server = createMcpServer({ storeRoot: ".bridge-test", runnerMode: "manual" });
  assert.equal(typeof server.connect, "function");
});

test("MCP server exposes room tools for the current Codex thread", async () => {
  const source = await readFile("src/mcp-server.js", "utf8");

  assert.match(source, /list_room_messages/);
  assert.match(source, /claim_next_room_codex_task/);
  assert.match(source, /complete_room_codex_task/);
  assert.match(source, /syncToChatGpt/);
  assert.match(source, /fail_room_codex_task/);
  assert.match(source, /ask_chatgpt_project/);
  assert.match(source, /bind_current_codex_session/);
  assert.match(source, /delegate_current_request/);
  assert.match(source, /continue_router_run/);
  assert.match(source, /cancel_router_run/);
  assert.match(source, /runId/);
  assert.match(source, /read_chatgpt_project_answer/);
  assert.match(source, /send_local_file_to_chatgpt_project/);
  assert.match(source, /send_local_file_to_chatgpt_project_and_wait/);
  assert.match(source, /timeoutMs/);
  assert.match(source, /localPath/);
  assert.match(source, /projectId/);
  assert.match(source, /conversationId/);
  assert.match(source, /avoid cross-room routing/);
  assert.match(source, /list_artifacts/);
  assert.match(source, /read_artifact_text/);
});

test("MCP protocol lists strict Router schemas and invokes continue_router_run", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-mcp-router-"));
  const targetRepo = await mkdtemp(path.join(tmpdir(), "bridge-mcp-project-"));
  const project = await createProject(storeRoot, {
    name: "MCP Router project",
    chatgptProjectUrl: "https://chatgpt.com/c/mcp-router",
    targetRepo,
    conversationId: "mcp-router-conversation",
    currentCodexThreadId: "mcp-router-thread"
  });
  const mock = createMockGptTransport({
    responses: { gpt: { replyText: "MCP Router result" } }
  });
  const server = createMcpServer({
    storeRoot,
    currentCodexThreadId: "mcp-router-thread",
    routerV2Enabled: true,
    gptTransportRegistry: createGptTransportRegistry({
      transports: [mock],
      defaultTransportId: "mock",
      env: {}
    }),
    gptTransportId: "mock"
  });
  const client = new Client({ name: "bridge-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  for (const name of ["continue_router_run", "cancel_router_run"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be listed`);
    assert.deepEqual(
      [...tool.inputSchema.required].sort(),
      ["conversationId", "projectId", "runId"].sort()
    );
  }

  const delegatedCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      projectId: project.id,
      conversationId: project.conversationId,
      text: "请写一个长篇故事大纲。",
      waitForGpt: false
    }
  });
  const delegated = JSON.parse(delegatedCall.content[0].text);
  assert.equal(delegated.routerRun.status, "queued");

  const continuedCall = await client.callTool({
    name: "continue_router_run",
    arguments: {
      runId: delegated.routerRun.id,
      projectId: project.id,
      conversationId: project.conversationId,
      waitForGpt: true
    }
  });
  const continued = JSON.parse(continuedCall.content[0].text);
  assert.equal(continued.routerRun.status, "succeeded");
  assert.equal(continued.replyText, "MCP Router result");

  const cancelCandidateCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      projectId: project.id,
      conversationId: project.conversationId,
      text: "请再写一个长篇故事大纲。",
      waitForGpt: false
    }
  });
  const cancelCandidate = JSON.parse(cancelCandidateCall.content[0].text);
  const cancelledCall = await client.callTool({
    name: "cancel_router_run",
    arguments: {
      runId: cancelCandidate.routerRun.id,
      projectId: project.id,
      conversationId: project.conversationId,
      reason: "MCP cancellation test"
    }
  });
  const cancelled = JSON.parse(cancelledCall.content[0].text);
  assert.equal(cancelled.routerRun.status, "cancelled");
});
