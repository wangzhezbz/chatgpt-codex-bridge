import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createGptTransportRegistry } from "../src/gpt-transports/transport-registry.js";
import { createWebSyncTransport } from "../src/gpt-transports/web-sync-transport.js";
import { completeSyncJob } from "../src/sync-store.js";

function createTransport(id) {
  return {
    id,
    async submitText() {},
    async submitArtifacts() {},
    async wait() {},
    async cancel() {}
  };
}

test("GPT transport registry resolves web-sync by default", () => {
  const web = createTransport("web-sync");
  const mock = createTransport("mock");
  const registry = createGptTransportRegistry({
    transports: [web, mock],
    env: {}
  });

  assert.equal(registry.resolve(), web);
  assert.equal(registry.resolve("mock"), mock);
  assert.deepEqual(registry.list().map((transport) => transport.id), ["web-sync", "mock"]);
});

test("GPT transport registry honors the configured environment transport", () => {
  const web = createTransport("web-sync");
  const mock = createTransport("mock");
  const registry = createGptTransportRegistry({
    transports: [web, mock],
    env: { BRIDGE_GPT_TRANSPORT: "mock" }
  });

  assert.equal(registry.resolve(), mock);
  assert.equal(registry.resolve("web-sync"), web);
});

test("GPT transport registry rejects unknown and invalid transports", () => {
  const registry = createGptTransportRegistry({
    transports: [createTransport("web-sync")],
    env: {}
  });

  assert.throws(() => registry.resolve("missing"), /not registered/i);
  assert.throws(() => registry.register({ id: "bad" }), /submitText/);
  assert.throws(() => registry.register(createTransport("web-sync")), /already registered/i);

  const replacement = createTransport("web-sync");
  registry.register(replacement, { replace: true });
  assert.equal(registry.resolve(), replacement);
});

test("web-sync transport normalizes existing sync jobs without leaking private fields", async () => {
  const calls = [];
  const transport = createWebSyncTransport({
    enqueueText: async (input) => {
      calls.push(["text", input]);
      return {
        message: { id: "message-1" },
        syncJob: {
          id: "sync-1",
          status: "pending",
          payloadText: input.payloadText,
          _bridgePrivate: "raw only"
        }
      };
    },
    enqueueArtifacts: async (input) => {
      calls.push(["artifacts", input]);
      return {
        artifact: { id: "input-artifact" },
        syncJob: { id: "sync-2", status: "running" }
      };
    },
    waitJob: async (requestId, options) => {
      calls.push(["wait", requestId, options]);
      return {
        finalJob: {
          id: requestId,
          status: "succeeded",
          replyText: "Web GPT result",
          artifactIds: ["artifact-1"]
        },
        timedOut: false,
        replyText: "Web GPT result"
      };
    },
    getJob: async (requestId) => ({ id: requestId, status: "running" }),
    cancelJob: async (requestId) => ({
      id: requestId,
      status: "failed",
      error: "Manually cancelled",
      errorCode: "manual_cancelled"
    }),
    resolveArtifacts: async (artifactIds) =>
      artifactIds.map((id) => ({ id, filename: `${id}.png` }))
  });

  const queued = await transport.submitText({
    stageId: "outline",
    payloadText: "Outline only"
  });
  assert.equal(queued.transportId, "web-sync");
  assert.equal(queued.requestId, "sync-1");
  assert.equal(queued.status, "queued");
  assert.equal(queued.replyText, null);
  assert.equal(Object.hasOwn(queued, "syncJob"), false);
  assert.equal(Object.hasOwn(queued, "_bridgePrivate"), false);
  assert.equal(queued.raw.syncJob._bridgePrivate, "raw only");

  const completed = await transport.wait(queued.requestId, { timeoutMs: 500 });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.replyText, "Web GPT result");
  assert.deepEqual(completed.artifacts, [
    { id: "artifact-1", filename: "artifact-1.png" }
  ]);
  assert.equal(completed.raw.submitted.message.id, "message-1");
  assert.equal(completed.raw.waited.finalJob.id, "sync-1");

  const artifactQueued = await transport.submitArtifacts({
    stageId: "source",
    artifacts: [{ id: "input-artifact" }]
  });
  assert.equal(artifactQueued.requestId, "sync-2");
  assert.equal(artifactQueued.status, "running");

  const cancelled = await transport.cancel(artifactQueued.requestId, {
    reason: "user stopped the run"
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "user stopped the run");
  assert.equal(cancelled.raw.errorCode, "manual_cancelled");
  assert.deepEqual(calls.map(([kind]) => kind), ["text", "wait", "artifacts"]);
});

test("web-sync transport maps cached success, timeout failure, and raw cancellation", async () => {
  const transport = createWebSyncTransport({
    enqueueText: async () => ({
      cached: true,
      replyText: "Cached result",
      syncJob: { id: "sync-cached", status: "succeeded", replyText: "Cached result" }
    }),
    enqueueArtifacts: async () => ({ syncJob: { id: "unused", status: "pending" } }),
    waitJob: async () => ({
      finalJob: {
        id: "sync-cached",
        status: "failed",
        error: "Timed out waiting for GPT reply.",
        errorCode: "reply_timeout"
      },
      timedOut: true,
      replyText: null
    }),
    getJob: async (requestId) => ({ id: requestId, status: "running" }),
    cancelJob: async (requestId) => ({
      id: requestId,
      status: "failed",
      error: "Stopped",
      errorCode: "manual_cancelled"
    })
  });

  const cached = await transport.submitText({ stageId: "cached", payloadText: "cached" });
  assert.equal(cached.status, "succeeded");
  assert.equal(cached.replyText, "Cached result");

  const timedOut = await transport.wait(cached.requestId);
  assert.equal(timedOut.status, "failed");
  assert.equal(timedOut.error, "Timed out waiting for GPT reply.");
  assert.equal(timedOut.raw.waited.timedOut, true);

  const cancelled = await transport.cancel("persisted-sync", { reason: "cancel run" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.requestId, "persisted-sync");
  assert.equal(cancelled.raw.errorCode, "manual_cancelled");
});

test("web-sync transport enforces a caller-provided idempotent request id", async () => {
  const transport = createWebSyncTransport({
    enqueueText: async () => ({ syncJob: { id: "different-id", status: "pending" } }),
    enqueueArtifacts: async () => ({ syncJob: { id: "different-id", status: "pending" } }),
    waitJob: async () => ({ finalJob: { id: "different-id", status: "succeeded" } }),
    getJob: async () => ({ id: "different-id", status: "pending" }),
    cancelJob: async () => ({ id: "different-id", status: "failed" })
  });

  await assert.rejects(
    () =>
      transport.submitText({
        requestId: "prepared-id",
        stageId: "gpt",
        payloadText: "payload"
      }),
    /request id mismatch/i
  );
});

test("web-sync default adapters create a sync job with the prepared Router request id", async () => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-web-sync-default-"));
  const transport = createWebSyncTransport({ storeRoot });
  const requestId = "sync_router_default_adapter";

  const queued = await transport.submitText({
    requestId,
    stageId: "gpt",
    kind: "chat_message",
    payloadText: "default adapter payload",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/c/default-adapter",
      targetRepo: storeRoot,
      conversationId: "default-adapter-conversation"
    }
  });

  assert.equal(queued.requestId, requestId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.raw.syncJob.id, requestId);
});

test("web-sync default artifact adapter keeps every submitted attachment", async () => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-web-sync-artifacts-"));
  const transport = createWebSyncTransport({ storeRoot });
  const queued = await transport.submitArtifacts({
    requestId: "sync_router_default_artifacts",
    stageId: "gpt",
    payloadText: "analyze both",
    artifacts: [
      { id: "artifact-a", filename: "a.txt", contentType: "text/plain", sizeBytes: 1 },
      { id: "artifact-b", filename: "b.txt", contentType: "text/plain", sizeBytes: 1 }
    ],
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/c/default-artifacts",
      targetRepo: storeRoot,
      conversationId: "default-artifacts-conversation"
    }
  });

  assert.equal(queued.status, "queued");
  assert.deepEqual(
    queued.raw.syncJob.inputArtifacts.map((artifact) => artifact.id),
    ["artifact-a", "artifact-b"]
  );
});

test("web-sync default artifact adapter preserves image generation kind and payload", async () => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-web-sync-image-artifacts-"));
  const transport = createWebSyncTransport({ storeRoot });
  const payloadText = "Use this reference to generate a new poster image.";
  const queued = await transport.submitArtifacts({
    requestId: "sync_router_default_image_artifacts",
    stageId: "gpt",
    kind: "image_request",
    payloadText,
    artifacts: [
      { id: "artifact-reference", filename: "reference.png", contentType: "image/png", sizeBytes: 1 }
    ],
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/c/default-image-artifacts",
      targetRepo: storeRoot,
      conversationId: "default-image-artifacts-conversation"
    }
  });

  assert.equal(queued.raw.syncJob.kind, "image_request");
  assert.equal(queued.raw.syncJob.payloadText, payloadText);
  assert.equal(queued.raw.syncJob.inputArtifacts[0].id, "artifact-reference");
});

test("web-sync keeps a complete long file-analysis reply containing Reading text", async () => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-web-sync-long-analysis-"));
  const transport = createWebSyncTransport({ storeRoot });
  const queued = await transport.submitArtifacts({
    requestId: "sync_router_long_analysis",
    stageId: "gpt",
    payloadText: "Analyze the attached architecture notes.",
    artifacts: [
      { id: "artifact-notes", filename: "notes.txt", contentType: "text/plain", sizeBytes: 1 }
    ],
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/c/long-analysis",
      targetRepo: storeRoot,
      conversationId: "long-analysis-conversation"
    }
  });
  const replyText = [
    "The architecture review is complete. Reading file-related skill notes was one step in the evaluation, not a pending status.",
    "The Router persists each stage before submission, carries the exact request id across recovery, and advances only after the dependency has succeeded.",
    "Transport-private fields remain under raw, while callers consume a stable public envelope with status, reply text, artifacts, and errors.",
    "Cancellation and failure are terminal outcomes. Artifact paths are returned directly from the bound project so downstream code never scans the disk.",
    "This is the final usable analysis and includes the state model, recovery behavior, transport boundary, and artifact contract."
  ].join("\n\n");
  assert.ok(replyText.length > 220);
  await completeSyncJob(storeRoot, queued.requestId, { replyText });

  const completed = await transport.wait(queued.requestId, { timeoutMs: 100, pollMs: 1 });
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.replyText, replyText);
});

test("web-sync cancel preserves the latest persisted terminal job state", async () => {
  let cancelCalls = 0;
  const transport = createWebSyncTransport({
    enqueueText: async (input) => ({
      syncJob: { id: input.requestId, status: "pending" }
    }),
    enqueueArtifacts: async () => ({ syncJob: { id: "unused", status: "pending" } }),
    waitJob: async () => ({ finalJob: { id: "sync_router_terminal", status: "succeeded" } }),
    getJob: async (requestId) => ({
      id: requestId,
      status: "succeeded",
      replyText: "already complete"
    }),
    cancelJob: async () => {
      cancelCalls += 1;
      return { id: "sync_router_terminal", status: "failed" };
    }
  });
  await transport.submitText({
    requestId: "sync_router_terminal",
    payloadText: "terminal request"
  });

  const result = await transport.cancel("sync_router_terminal", { reason: "too late" });

  assert.equal(result.status, "succeeded");
  assert.equal(result.replyText, "already complete");
  assert.equal(cancelCalls, 0);
});

test("web-sync cancel preserves a terminal state won during the cancel race", async () => {
  const transport = createWebSyncTransport({
    enqueueText: async (input) => ({ syncJob: { id: input.requestId, status: "pending" } }),
    enqueueArtifacts: async () => ({ syncJob: { id: "unused", status: "pending" } }),
    waitJob: async () => ({ finalJob: { id: "unused", status: "succeeded" } }),
    getJob: async (requestId) => ({ id: requestId, status: "running" }),
    cancelJob: async (requestId) => ({
      id: requestId,
      status: "succeeded",
      replyText: "completed during cancel"
    })
  });
  await transport.submitText({
    requestId: "sync_router_cancel_race",
    payloadText: "race request"
  });

  const result = await transport.cancel("sync_router_cancel_race", { reason: "too late" });

  assert.equal(result.status, "succeeded");
  assert.equal(result.replyText, "completed during cancel");
  assert.equal(result.error, null);
});

test("web-sync cancel re-reads the persisted job after cancellation", async () => {
  let getCalls = 0;
  const transport = createWebSyncTransport({
    enqueueText: async (input) => ({ syncJob: { id: input.requestId, status: "pending" } }),
    enqueueArtifacts: async () => ({ syncJob: { id: "unused", status: "pending" } }),
    waitJob: async () => ({ finalJob: { id: "unused", status: "succeeded" } }),
    getJob: async (requestId) => {
      getCalls += 1;
      return getCalls === 1
        ? { id: requestId, status: "running" }
        : { id: requestId, status: "succeeded", replyText: "persisted winner" };
    },
    cancelJob: async (requestId) => ({
      id: requestId,
      status: "failed",
      error: "cancel snapshot",
      errorCode: "manual_cancelled"
    })
  });
  await transport.submitText({
    requestId: "sync_router_cancel_reread",
    payloadText: "reread request"
  });

  const result = await transport.cancel("sync_router_cancel_reread", { reason: "cancel" });

  assert.equal(getCalls, 2);
  assert.equal(result.status, "succeeded");
  assert.equal(result.replyText, "persisted winner");
});
