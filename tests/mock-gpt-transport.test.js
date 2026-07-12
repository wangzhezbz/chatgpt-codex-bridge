import assert from "node:assert/strict";
import test from "node:test";

import { createMockGptTransport } from "../src/gpt-transports/mock-transport.js";

const FIXED_TIME = "2026-07-10T12:00:00.000Z";

function createTransport(responses) {
  return createMockGptTransport({
    responses,
    clock: () => FIXED_TIME,
    requestIdFactory: ({ sequence }) => `mock-request-${sequence}`
  });
}

test("mock GPT transport records ordered text and artifact submissions", async () => {
  const transport = createTransport({
    outline: { replyText: "Outline result" },
    source: {
      replyText: "Artifact result",
      artifacts: [{ id: "artifact-1", filename: "source.pdf" }]
    }
  });

  const textQueued = await transport.submitText({
    stageId: "outline",
    payloadText: "Write only the outline."
  });
  const artifactsQueued = await transport.submitArtifacts({
    stageId: "source",
    payloadText: "Analyze this file.",
    artifacts: [{ id: "artifact-input", filename: "input.pdf" }]
  });

  assert.deepEqual(textQueued, {
    transportId: "mock",
    requestId: "mock-request-1",
    status: "queued",
    replyText: null,
    artifacts: [],
    error: null,
    raw: null
  });
  assert.equal(artifactsQueued.requestId, "mock-request-2");
  assert.equal(artifactsQueued.status, "queued");

  assert.deepEqual(
    transport.submissions.map(({ sequence, kind, requestId, stageId, submittedAt }) => ({
      sequence,
      kind,
      requestId,
      stageId,
      submittedAt
    })),
    [
      {
        sequence: 1,
        kind: "text",
        requestId: "mock-request-1",
        stageId: "outline",
        submittedAt: FIXED_TIME
      },
      {
        sequence: 2,
        kind: "artifacts",
        requestId: "mock-request-2",
        stageId: "source",
        submittedAt: FIXED_TIME
      }
    ]
  );
  assert.equal(transport.submissions[0].payload.payloadText, "Write only the outline.");
  assert.equal(transport.submissions[1].payload.artifacts[0].id, "artifact-input");

  const textDone = await transport.wait(textQueued.requestId);
  const artifactsDone = await transport.wait(artifactsQueued.requestId);
  assert.equal(textDone.status, "succeeded");
  assert.equal(textDone.replyText, "Outline result");
  assert.deepEqual(artifactsDone.artifacts, [{ id: "artifact-1", filename: "source.pdf" }]);
});

test("mock GPT transport can resolve responses by submission order", async () => {
  const transport = createTransport([
    { replyText: "First response" },
    { replyText: "Second response" }
  ]);

  const first = await transport.submitText({ stageId: "one", payloadText: "one" });
  const second = await transport.submitText({ stageId: "two", payloadText: "two" });

  assert.equal((await transport.wait(first.requestId)).replyText, "First response");
  assert.equal((await transport.wait(second.requestId)).replyText, "Second response");
});

test("mock GPT transport preserves configured failure without touching the network", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("network must not be used");
  };

  try {
    const transport = createTransport({
      chapter: { status: "failed", error: "chapter failed", raw: { reason: "fixture" } }
    });
    const queued = await transport.submitText({ stageId: "chapter", payloadText: "chapter" });
    const failed = await transport.wait(queued.requestId);

    assert.deepEqual(failed, {
      transportId: "mock",
      requestId: "mock-request-1",
      status: "failed",
      replyText: null,
      artifacts: [],
      error: "chapter failed",
      raw: { reason: "fixture" }
    });
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mock GPT transport cancels a queued request and keeps it cancelled", async () => {
  const transport = createTransport({ poster: { replyText: "Poster result" } });
  const queued = await transport.submitText({ stageId: "poster", payloadText: "poster" });

  const cancelled = await transport.cancel(queued.requestId, { reason: "user cancelled" });
  const waited = await transport.wait(queued.requestId);

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, "user cancelled");
  assert.deepEqual(waited, cancelled);
});

test("mock GPT transport rejects unknown request ids", async () => {
  const transport = createTransport({});

  await assert.rejects(() => transport.wait("missing"), /not found/i);
  await assert.rejects(() => transport.cancel("missing"), /not found/i);
});

test("mock GPT transport reuses a caller-provided request id without duplicate submission", async () => {
  const transport = createTransport({ outline: { replyText: "Idempotent outline" } });

  const first = await transport.submitText({
    requestId: "stable-request-id",
    stageId: "outline",
    payloadText: "outline"
  });
  const second = await transport.submitText({
    requestId: "stable-request-id",
    stageId: "outline",
    payloadText: "outline"
  });

  assert.equal(first.requestId, "stable-request-id");
  assert.equal(second.requestId, "stable-request-id");
  assert.equal(transport.submissions.length, 1);
  assert.equal((await transport.wait(first.requestId)).replyText, "Idempotent outline");
});
