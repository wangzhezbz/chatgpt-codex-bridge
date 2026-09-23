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
import { appendRoomMessage } from "../src/room-store.js";

test("createMcpServer returns a connectable MCP server", () => {
  const server = createMcpServer({ storeRoot: ".bridge-test", runnerMode: "manual" });
  assert.equal(typeof server.connect, "function");
});

test("MCP list_room_messages keeps structuredContent object-shaped while preserving the message array", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-mcp-room-list-"));
  const targetRepo = await mkdtemp(path.join(tmpdir(), "bridge-mcp-room-list-project-"));
  const project = await createProject(storeRoot, {
    name: "MCP room list project",
    chatgptProjectUrl: "https://chatgpt.com/c/room-list-conversation",
    targetRepo,
    conversationId: "room-list-conversation",
    currentCodexThreadId: "room-list-thread"
  });
  await appendRoomMessage(storeRoot, {
    conversationId: "room-list-conversation",
    from: "gpt",
    to: ["user", "codex"],
    text: "existing result"
  });
  const server = createMcpServer({
    storeRoot,
    runnerMode: "manual",
    env: {}
  });
  const client = new Client({ name: "bridge-room-list-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const unscoped = await client.callTool({
    name: "list_room_messages",
    arguments: {
      currentCodexThreadId: "room-list-thread",
      conversationId: "room-list-conversation"
    }
  });
  assert.equal(unscoped.isError, true);
  assert.match(unscoped.content[0].text, /projectId/i);

  const result = await client.callTool({
    name: "list_room_messages",
    arguments: {
      currentCodexThreadId: "room-list-thread",
      projectId: project.id,
      conversationId: "room-list-conversation"
    }
  });

  const messages = JSON.parse(result.content[0].text);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "existing result");
  assert.deepEqual(result.structuredContent, {
    result: messages
  });
});

test("MCP binding uses the calling Codex thread without process-global thread state", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-mcp-bind-call-thread-"));
  const targetRepo = await mkdtemp(path.join(tmpdir(), "bridge-mcp-bind-call-thread-project-"));
  const server = createMcpServer({ storeRoot, env: {}, runnerMode: "manual" });
  const client = new Client({ name: "bridge-bind-call-thread-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const boundCall = await client.callTool({
    name: "bind_current_codex_session",
    arguments: {
      currentCodexThreadId: "mcp-bind-call-thread",
      name: "MCP per-call binding",
      chatgptProjectUrl: "https://chatgpt.com/c/mcp-bind-call-thread",
      targetRepo
    }
  });

  assert.notEqual(boundCall.isError, true);
  const bound = JSON.parse(boundCall.content[0].text);
  assert.equal(bound.project.currentCodexThreadId, "mcp-bind-call-thread");
  assert.equal(bound.workspace.currentCodexThreadId, "mcp-bind-call-thread");
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
  assert.match(source, /get_router_run_status/);
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

test("MCP project-scoped submission tools require the calling Codex thread", async (t) => {
  const server = createMcpServer({ storeRoot: ".bridge-test", env: {}, runnerMode: "manual" });
  const client = new Client({ name: "bridge-scoped-schema-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  for (const name of [
    "ask_chatgpt_project",
    "send_local_file_to_chatgpt_project",
    "send_local_file_to_chatgpt_project_and_wait"
  ]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be listed`);
    assert.ok(
      tool.inputSchema.required.includes("currentCodexThreadId"),
      `${name} must require currentCodexThreadId`
    );
  }
});

test("MCP get_router_run_status recovers the latest exact-scope run without submitting again", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-mcp-run-status-"));
  const targetRepo = await mkdtemp(path.join(tmpdir(), "bridge-mcp-run-status-project-"));
  const project = await createProject(storeRoot, {
    name: "MCP run status project",
    chatgptProjectUrl: "https://chatgpt.com/c/mcp-run-status",
    targetRepo,
    conversationId: "mcp-run-status-conversation",
    currentCodexThreadId: "mcp-run-status-thread"
  });
  const mock = createMockGptTransport({
    responses: { gpt: { replyText: "MCP per-call result" } }
  });
  const server = createMcpServer({
    storeRoot,
    currentCodexThreadId: "mcp-run-status-thread",
    routerV2Enabled: true,
    gptTransportRegistry: createGptTransportRegistry({
      transports: [mock],
      defaultTransportId: "mock",
      env: {}
    }),
    gptTransportId: "mock"
  });
  const client = new Client({ name: "bridge-run-status-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const delegatedCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      currentCodexThreadId: "mcp-run-status-thread",
      projectId: project.id,
      conversationId: project.conversationId,
      text: "只生成当前这一版长文案",
      waitForGpt: false
    }
  });
  const delegated = JSON.parse(delegatedCall.content[0].text);
  assert.equal(mock.submissions.length, 1);

  const recoveredCall = await client.callTool({
    name: "get_router_run_status",
    arguments: {
      currentCodexThreadId: "mcp-run-status-thread",
      projectId: project.id,
      conversationId: project.conversationId
    }
  });
  const recovered = JSON.parse(recoveredCall.content[0].text);

  assert.equal(recovered.routerRun.id, delegated.routerRun.id);
  assert.equal(recovered.routerRun.status, "queued");
  assert.equal(recovered.replyText, null);
  assert.equal(mock.submissions.length, 1);
});

test("MCP Router calls use the calling Codex thread instead of process-global thread state", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-mcp-call-thread-"));
  const targetRepo = await mkdtemp(path.join(tmpdir(), "bridge-mcp-call-thread-project-"));
  const project = await createProject(storeRoot, {
    name: "MCP per-call thread project",
    chatgptProjectUrl: "https://chatgpt.com/c/mcp-call-thread",
    targetRepo,
    conversationId: "mcp-call-thread-conversation",
    currentCodexThreadId: "mcp-call-thread"
  });
  const mock = createMockGptTransport();
  const server = createMcpServer({
    storeRoot,
    env: {},
    routerV2Enabled: true,
    gptTransportRegistry: createGptTransportRegistry({
      transports: [mock],
      defaultTransportId: "mock",
      env: {}
    }),
    gptTransportId: "mock"
  });
  const client = new Client({ name: "bridge-call-thread-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
  });

  const listed = await client.listTools();
  const delegateTool = listed.tools.find(
    (candidate) => candidate.name === "delegate_current_request"
  );
  assert.ok(delegateTool);
  assert.ok(delegateTool.inputSchema.required.includes("currentCodexThreadId"));

  const delegatedCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      currentCodexThreadId: "mcp-call-thread",
      projectId: project.id,
      conversationId: project.conversationId,
      text: "只生成当前阶段的大纲",
      waitForGpt: false
    }
  });

  assert.notEqual(delegatedCall.isError, true);
  const delegated = JSON.parse(delegatedCall.content[0].text);
  assert.equal(delegated.routerRun.codexThreadId, "mcp-call-thread");
  assert.equal(mock.submissions.length, 1);

  const statusCall = await client.callTool({
    name: "get_router_run_status",
    arguments: {
      currentCodexThreadId: "mcp-call-thread",
      projectId: project.id,
      conversationId: project.conversationId,
      runId: delegated.routerRun.id
    }
  });
  assert.notEqual(statusCall.isError, true);

  const continuedCall = await client.callTool({
    name: "continue_router_run",
    arguments: {
      currentCodexThreadId: "mcp-call-thread",
      runId: delegated.routerRun.id,
      projectId: project.id,
      conversationId: project.conversationId,
      waitForGpt: true
    }
  });
  assert.notEqual(continuedCall.isError, true);
  const continued = JSON.parse(continuedCall.content[0].text);
  assert.equal(continued.routerRun.status, "succeeded");

  const cancelCandidateCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      currentCodexThreadId: "mcp-call-thread",
      projectId: project.id,
      conversationId: project.conversationId,
      text: "再生成一个待取消阶段",
      waitForGpt: false
    }
  });
  const cancelCandidate = JSON.parse(cancelCandidateCall.content[0].text);
  const cancelledCall = await client.callTool({
    name: "cancel_router_run",
    arguments: {
      currentCodexThreadId: "mcp-call-thread",
      runId: cancelCandidate.routerRun.id,
      projectId: project.id,
      conversationId: project.conversationId,
      reason: "per-call scope cancellation"
    }
  });
  assert.notEqual(cancelledCall.isError, true);
  const cancelled = JSON.parse(cancelledCall.content[0].text);
  assert.equal(cancelled.routerRun.status, "cancelled");
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
  const delegateTool = listed.tools.find(
    (candidate) => candidate.name === "delegate_current_request"
  );
  assert.ok(delegateTool, "delegate_current_request must be listed");
  const proposalSchema = delegateTool.inputSchema.properties.routingProposal;
  assert.ok(proposalSchema, "delegate_current_request must accept routingProposal");
  assert.deepEqual(
    [...proposalSchema.required].sort(),
    ["confidence", "routeKind", "version"].sort()
  );
  assert.deepEqual(proposalSchema.properties.routeKind.enum, [
    "codex_only",
    "gpt_only",
    "gpt_then_codex"
  ]);

  for (const name of ["continue_router_run", "cancel_router_run"]) {
    const tool = listed.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be listed`);
    assert.deepEqual(
      [...tool.inputSchema.required].sort(),
      ["conversationId", "currentCodexThreadId", "projectId", "runId"].sort()
    );
  }

  const delegatedCall = await client.callTool({
    name: "delegate_current_request",
    arguments: {
      currentCodexThreadId: "mcp-router-thread",
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
      currentCodexThreadId: "mcp-router-thread",
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
      currentCodexThreadId: "mcp-router-thread",
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
      currentCodexThreadId: "mcp-router-thread",
      runId: cancelCandidate.routerRun.id,
      projectId: project.id,
      conversationId: project.conversationId,
      reason: "MCP cancellation test"
    }
  });
  const cancelled = JSON.parse(cancelledCall.content[0].text);
  assert.equal(cancelled.routerRun.status, "cancelled");
});
