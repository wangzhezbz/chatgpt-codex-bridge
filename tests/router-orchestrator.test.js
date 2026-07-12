import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { getArtifact, saveArtifactFromBase64 } from "../src/artifact-store.js";
import { createGptTransportRegistry } from "../src/gpt-transports/transport-registry.js";
import { createMockGptTransport } from "../src/gpt-transports/mock-transport.js";
import { decideRoomRoute } from "../src/room-routing-policy.js";
import { createRouterOrchestrator } from "../src/router-orchestrator.js";
import { createRouterRunStore } from "../src/router-run-store.js";

const SCOPE = {
  projectId: "project-router",
  conversationId: "conversation-router",
  codexThreadId: "thread-router"
};

async function tempRoot(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

function workspace(targetRepo) {
  return {
    projectId: SCOPE.projectId,
    conversationId: SCOPE.conversationId,
    currentCodexThreadId: SCOPE.codexThreadId,
    targetRepo,
    chatgptProjectUrl: "https://chatgpt.com/c/router-test"
  };
}

function monotonicClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 10, 12, 0, tick++)).toISOString();
}

async function createHarness(responses = {}) {
  const storeRoot = await tempRoot("bridge-router-orchestrator-store-");
  const targetRepo = await tempRoot("bridge-router-orchestrator-project-");
  const clock = monotonicClock();
  let runSequence = 0;
  const runStore = createRouterRunStore({
    storeRoot,
    clock,
    runIdFactory: () => `router-run-${++runSequence}`
  });
  const transport = createMockGptTransport({
    responses,
    clock,
    requestIdFactory: ({ sequence }) => `mock-request-${sequence}`
  });
  const transportRegistry = createGptTransportRegistry({
    transports: [transport],
    defaultTransportId: "mock",
    env: {}
  });
  const orchestrator = createRouterOrchestrator({
    runStore,
    transportRegistry,
    artifactResolver: (artifactId) => getArtifact(storeRoot, artifactId),
    clock,
    transportRequestIdFactory: ({ sequence }) => `mock-request-${sequence}`
  });
  return {
    storeRoot,
    targetRepo,
    clock,
    runStore,
    transport,
    transportRegistry,
    orchestrator,
    workspace: workspace(targetRepo)
  };
}

async function saveTestPng(harness, filename = "poster.png", overrides = {}) {
  return saveArtifactFromBase64(harness.storeRoot, {
    syncJobId: "mock-sync",
    conversationId: SCOPE.conversationId,
    filename,
    contentType: "image/png",
    base64Data:
      overrides.base64Data ||
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2Y1sAAAAASUVORK5CYII="
  });
}

function startInput(harness, route, overrides = {}) {
  return {
    route,
    originalRequestText: overrides.originalRequestText || route.gptPayloadText || "Router request",
    workspace: harness.workspace,
    scope: SCOPE,
    transportId: "mock",
    waitForGpt: overrides.waitForGpt ?? true,
    artifacts: overrides.artifacts || [],
    waitOptions: overrides.waitOptions || {}
  };
}

test("router orchestrator persists codex-only work without calling a GPT transport", async () => {
  const harness = await createHarness();
  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "codex_only",
      codexPromptText: "Run npm test locally.",
      gptPayloadText: null
    })
  );

  assert.equal(result.routerRun.status, "succeeded");
  assert.equal(result.routerRun.currentStageIndex, -1);
  assert.deepEqual(result.routerRun.stages, []);
  assert.equal(result.transportResult, null);
  assert.deepEqual(result.projectArtifactPaths, []);
  assert.equal(harness.transport.submissions.length, 0);
});

test("router orchestrator queues one GPT stage and resumes it without resubmitting", async () => {
  const harness = await createHarness({
    gpt: { replyText: "Single stage result" }
  });
  const route = {
    kind: "gpt_only",
    syncKind: "chat_message",
    gptPayloadText: "Write a single response."
  };

  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: false })
  );
  assert.equal(queued.routerRun.status, "queued");
  assert.equal(queued.routerRun.stages[0].status, "queued");
  assert.equal(queued.routerRun.stages[0].transportRequestId, "mock-request-1");
  assert.equal(harness.transport.submissions.length, 1);

  const resumedOrchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `resume-request-${sequence}`
  });
  const completed = await resumedOrchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });

  assert.equal(completed.routerRun.status, "succeeded");
  assert.equal(completed.routerRun.stages[0].replyText, "Single stage result");
  assert.equal(harness.transport.submissions.length, 1);
  const expectedTextPath = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id,
    "gpt.md"
  );
  assert.deepEqual(completed.projectArtifactPaths, [expectedTextPath]);
  assert.equal(await readFile(expectedTextPath, "utf8"), "Single stage result\n");
});

test("router orchestrator sends gpt-then-codex work through the transport", async () => {
  const harness = await createHarness({ gpt: { replyText: "Design handoff" } });
  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_then_codex",
      syncKind: "user_request",
      gptPayloadText: "Design this first."
    })
  );

  assert.equal(result.routerRun.routeKind, "gpt_then_codex");
  assert.equal(result.routerRun.status, "succeeded");
  assert.equal(result.routerRun.stages[0].replyText, "Design handoff");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["gpt"]);
});

test("router orchestrator stops after a failed stage", async () => {
  const harness = await createHarness({
    outline: { status: "failed", error: "outline failed" },
    chapter: { replyText: "must not run" }
  });
  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      gptPayloadText: "outline",
      sequentialPlan: {
        stages: [
          { id: "outline", title: "Outline", payloadText: "outline" },
          { id: "chapter", title: "Chapter", dependsOn: "outline", instruction: "chapter" }
        ]
      }
    })
  );

  assert.equal(result.routerRun.status, "failed");
  assert.equal(result.routerRun.stages[0].status, "failed");
  assert.equal(result.routerRun.stages[0].error, "outline failed");
  assert.equal(result.routerRun.stages[1].status, "pending");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["outline"]);
});

test("router orchestrator cancellation prevents every later stage", async () => {
  const harness = await createHarness({
    outline: { replyText: "outline" },
    chapter: { replyText: "must not run" }
  });
  const queued = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        gptPayloadText: "outline",
        sequentialPlan: {
          stages: [
            { id: "outline", title: "Outline", payloadText: "outline" },
            { id: "chapter", title: "Chapter", dependsOn: "outline", instruction: "chapter" }
          ]
        }
      },
      { waitForGpt: false }
    )
  );

  const cancelled = await harness.orchestrator.cancelRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    reason: "user cancelled"
  });
  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal(cancelled.routerRun.stages[1].status, "pending");

  const continued = await harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  assert.equal(continued.routerRun.status, "cancelled");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["outline"]);
});

test("router orchestrator cancellation preempts an in-flight transport wait", async () => {
  const harness = await createHarness();
  let resolveWait;
  let markWaitEntered;
  const waitEntered = new Promise((resolve) => {
    markWaitEntered = resolve;
  });
  const waitResult = new Promise((resolve) => {
    resolveWait = resolve;
  });
  let cancelCalls = 0;
  const envelope = (requestId, status, error = null) => ({
    transportId: "interruptible",
    requestId,
    status,
    replyText: null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: "interruptible",
    async submitText(input) {
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      markWaitEntered();
      return waitResult;
    },
    async cancel(requestId) {
      cancelCalls += 1;
      const cancelled = envelope(requestId, "cancelled", "cancelled by user");
      resolveWait(cancelled);
      return cancelled;
    }
  };
  harness.transportRegistry.register(transport);
  const queued = await harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "wait for cancellation" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });
  const continuing = harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  await waitEntered;
  const cancelling = harness.orchestrator.cancelRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    reason: "cancel during wait"
  });
  let cancellationResult = null;
  let preemptionError = null;
  try {
    cancellationResult = await Promise.race([
      cancelling,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cancel did not preempt transport.wait")), 250)
      )
    ]);
  } catch (error) {
    preemptionError = error;
  } finally {
    if (cancelCalls === 0) {
      resolveWait(envelope(queued.routerRun.stages[0].transportRequestId, "succeeded"));
    }
    await Promise.allSettled([continuing, cancelling]);
  }

  assert.ifError(preemptionError);
  assert.equal(cancelCalls, 1);
  assert.equal(cancellationResult.routerRun.status, "cancelled");
  assert.equal((await harness.runStore.get(queued.routerRun.id, SCOPE)).status, "cancelled");
});

test("router orchestrator applies cancellation after a prepared submit becomes queued", async () => {
  const harness = await createHarness();
  let releaseSubmit;
  let markSubmitEntered;
  let releaseCancel;
  let markCancelEntered;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const holdSubmit = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const cancelEntered = new Promise((resolve) => {
    markCancelEntered = resolve;
  });
  const holdCancel = new Promise((resolve) => {
    releaseCancel = resolve;
  });
  const envelope = (requestId, status, error = null) => ({
    transportId: "submit-cancel-race",
    requestId,
    status,
    replyText: null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: "submit-cancel-race",
    async submitText(input) {
      markSubmitEntered();
      await holdSubmit;
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, "queued");
    },
    async cancel(requestId) {
      markCancelEntered();
      await holdCancel;
      return envelope(requestId, "cancelled", "cancelled during submit");
    }
  };
  harness.transportRegistry.register(transport);
  const starting = harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "submit then cancel" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });
  await submitEntered;
  const preparedRun = (await harness.runStore.list(SCOPE))[0];
  assert.equal(preparedRun.stages[0].submissionState, "prepared");

  const cancelling = harness.orchestrator.cancelRouterRun({
    runId: preparedRun.id,
    scope: SCOPE,
    reason: "cancel during submit"
  });
  await cancelEntered;
  releaseSubmit();
  const queued = await starting;
  assert.equal(queued.routerRun.stages[0].submissionState, "submitted");
  releaseCancel();
  const cancelled = await cancelling;

  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal((await harness.runStore.get(preparedRun.id, SCOPE)).status, "cancelled");
});

test("router orchestrator applies cancellation atomically against the latest submitted stage", async () => {
  const harness = await createHarness();
  let releaseSubmit;
  let markSubmitEntered;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const holdSubmit = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const envelope = (requestId, status, error = null) => ({
    transportId: "atomic-cancel-race",
    requestId,
    status,
    replyText: null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: "atomic-cancel-race",
    async submitText(input) {
      markSubmitEntered();
      await holdSubmit;
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, "queued");
    },
    async cancel(requestId) {
      return envelope(requestId, "cancelled", "atomic cancellation");
    }
  };
  harness.transportRegistry.register(transport);
  let interceptCancelUpdate = false;
  let releaseCancelUpdate;
  let markCancelUpdateEntered;
  const cancelUpdateEntered = new Promise((resolve) => {
    markCancelUpdateEntered = resolve;
  });
  const holdCancelUpdate = new Promise((resolve) => {
    releaseCancelUpdate = resolve;
  });
  const cancellingRunStore = {
    ...harness.runStore,
    async update(...args) {
      if (interceptCancelUpdate) {
        interceptCancelUpdate = false;
        markCancelUpdateEntered();
        await holdCancelUpdate;
      }
      return harness.runStore.update(...args);
    }
  };
  const cancellingOrchestrator = createRouterOrchestrator({
    runStore: cancellingRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `atomic-cancel-${sequence}`
  });
  const starting = harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "atomic submit cancel" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });
  await submitEntered;
  const preparedRun = (await harness.runStore.list(SCOPE))[0];
  interceptCancelUpdate = true;
  const cancelling = cancellingOrchestrator.cancelRouterRun({
    runId: preparedRun.id,
    scope: SCOPE,
    reason: "atomic cancel during submit"
  });
  await cancelUpdateEntered;

  releaseSubmit();
  const queued = await starting;
  assert.equal(queued.routerRun.stages[0].submissionState, "submitted");
  releaseCancelUpdate();
  const cancelled = await cancelling;

  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal((await harness.runStore.get(preparedRun.id, SCOPE)).status, "cancelled");
});

test("router orchestrator retries cancellation when an unsubmitted stage becomes queued", async () => {
  const harness = await createHarness();
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "cancel while preparing",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "pending",
    stages: [
      {
        id: "gpt",
        title: "GPT",
        status: "pending",
        payloadText: "cancel while preparing"
      }
    ]
  });
  let interceptCancelUpdate = true;
  let releaseCancelUpdate;
  let markCancelUpdateEntered;
  const cancelUpdateEntered = new Promise((resolve) => {
    markCancelUpdateEntered = resolve;
  });
  const holdCancelUpdate = new Promise((resolve) => {
    releaseCancelUpdate = resolve;
  });
  const cancellingRunStore = {
    ...harness.runStore,
    async update(...args) {
      if (interceptCancelUpdate) {
        interceptCancelUpdate = false;
        markCancelUpdateEntered();
        await holdCancelUpdate;
      }
      return harness.runStore.update(...args);
    }
  };
  const cancellingOrchestrator = createRouterOrchestrator({
    runStore: cancellingRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `cancel-prepare-${sequence}`
  });

  const cancelling = cancellingOrchestrator.cancelRouterRun({
    runId: created.id,
    scope: SCOPE,
    reason: "cancel while stage is prepared"
  });
  await cancelUpdateEntered;
  const queued = await harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: false
  });
  assert.equal(queued.routerRun.status, "queued");
  releaseCancelUpdate();
  const cancelled = await cancelling;

  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal(harness.transport.submissions.length, 1);
  assert.equal((await harness.runStore.get(created.id, SCOPE)).status, "cancelled");
});

test("router orchestrator does not finish cancellation before an in-flight submit is persisted", async () => {
  const harness = await createHarness();
  let releaseSubmit;
  let markSubmitEntered;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const holdSubmit = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const requests = new Map();
  const envelope = (requestId, status, error = null) => ({
    transportId: "submit-linearization",
    requestId,
    status,
    replyText: status === "succeeded" ? "submitted result" : null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: "submit-linearization",
    async submitText(input) {
      markSubmitEntered();
      await holdSubmit;
      requests.set(input.requestId, "succeeded");
      return envelope(input.requestId, "succeeded");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, requests.get(requestId) || "queued");
    },
    async cancel(requestId) {
      if (!requests.has(requestId)) {
        const error = new Error(`request not found: ${requestId}`);
        error.code = "ENOENT";
        throw error;
      }
      requests.set(requestId, "cancelled");
      return envelope(requestId, "cancelled", "cancelled after submit");
    }
  };
  harness.transportRegistry.register(transport);
  const starting = harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "linearized submit" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });
  await submitEntered;
  const preparedRun = (await harness.runStore.list(SCOPE))[0];
  const cancelling = harness.orchestrator.cancelRouterRun({
    runId: preparedRun.id,
    scope: SCOPE,
    reason: "cancel before submit registration"
  });
  const cancellationSettledEarly = await Promise.race([
    cancelling.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50))
  ]);

  releaseSubmit();
  const [started, cancelled] = await Promise.all([starting, cancelling]);

  assert.equal(cancellationSettledEarly, false);
  assert.equal(started.routerRun.status, "succeeded");
  assert.equal(cancelled.routerRun.status, "succeeded");
  assert.equal(requests.get(preparedRun.stages[0].transportRequestId), "succeeded");
});

test("router orchestrator skips an already succeeded stage during recovery", async () => {
  const harness = await createHarness({ chapter: { replyText: "Chapter result" } });
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    transportId: "mock",
    originalRequestText: "outline then chapter",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    stages: [
      {
        id: "outline",
        title: "Outline",
        status: "succeeded",
        payloadText: "outline",
        replyText: "Persisted outline",
        completedAt: "2026-07-10T11:00:00.000Z"
      },
      {
        id: "chapter",
        title: "Chapter",
        dependsOn: "outline",
        instruction: "Write the chapter."
      }
    ]
  });

  const result = await harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: false
  });

  assert.equal(result.routerRun.stages[0].replyText, "Persisted outline");
  assert.equal(result.routerRun.stages[1].status, "queued");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["chapter"]);
  assert.match(harness.transport.submissions[0].payload.payloadText, /Persisted outline/);
});

test("router orchestrator advances outline, chapter, and poster strictly in order", async () => {
  const request =
    "我要写一篇玄幻穿越小说。先设计前十集大纲，再写第一章，最后生成小说海报。";
  const responses = {
    outline: { replyText: "OUTLINE RESULT: hero and world" },
    chapter: { replyText: "CHAPTER RESULT: opening scene" }
  };
  const harness = await createHarness(responses);
  const posterArtifact = await saveTestPng(harness, "novel-poster.png");
  responses.poster = {
    replyText: "POSTER RESULT: generated",
    artifacts: [{ id: posterArtifact.id }]
  };
  const route = decideRoomRoute({
    text: request,
    workspace: harness.workspace
  });

  const first = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: false, originalRequestText: request })
  );
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["outline"]);
  assert.equal(first.routerRun.stages[1].status, "pending");
  assert.equal(first.routerRun.stages[2].status, "pending");

  const second = await harness.orchestrator.continueRouterRun({
    runId: first.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), ["outline", "chapter"]);
  assert.equal(second.routerRun.stages[0].status, "succeeded");
  assert.equal(second.routerRun.stages[1].status, "queued");
  const chapterPayload = harness.transport.submissions[1].payload.payloadText;
  assert.match(chapterPayload, /OUTLINE RESULT: hero and world/);
  assert.doesNotMatch(chapterPayload, /最后生成小说海报/);

  const third = await harness.orchestrator.continueRouterRun({
    runId: first.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), [
    "outline",
    "chapter",
    "poster"
  ]);
  assert.equal(third.routerRun.stages[1].status, "succeeded");
  assert.equal(third.routerRun.stages[2].status, "queued");
  const posterPayload = harness.transport.submissions[2].payload.payloadText;
  assert.match(posterPayload, /OUTLINE RESULT: hero and world/);
  assert.match(posterPayload, /CHAPTER RESULT: opening scene/);

  const final = await harness.orchestrator.continueRouterRun({
    runId: first.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });
  assert.equal(final.routerRun.status, "succeeded");
  assert.deepEqual(final.routerRun.stages.map((stage) => stage.status), [
    "succeeded",
    "succeeded",
    "succeeded"
  ]);
});

test("router orchestrator can wait through the novel chain but persists each success first", async () => {
  const request =
    "我要写一篇玄幻穿越小说。先设计前十集大纲，再写第一章，最后生成小说海报。";
  const responses = {
    outline: { replyText: "outline done" },
    chapter: { replyText: "chapter done" }
  };
  const harness = await createHarness(responses);
  const posterArtifact = await saveTestPng(harness, "novel-poster.png");
  responses.poster = {
    replyText: "poster done",
    artifacts: [{ id: posterArtifact.id }]
  };
  const originalSubmitText = harness.transport.submitText.bind(harness.transport);
  harness.transport.submitText = async (input) => {
    const existingRuns = await harness.runStore.list(SCOPE);
    const run = existingRuns[0];
    if (input.stageId === "chapter") {
      assert.equal(run.stages[0].status, "succeeded");
      assert.equal(run.stages[0].replyText, "outline done");
    }
    if (input.stageId === "poster") {
      assert.equal(run.stages[1].status, "succeeded");
      assert.equal(run.stages[1].replyText, "chapter done");
    }
    return originalSubmitText(input);
  };
  const route = decideRoomRoute({ text: request, workspace: harness.workspace });

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: true, originalRequestText: request })
  );

  assert.equal(result.routerRun.status, "succeeded");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), [
    "outline",
    "chapter",
    "poster"
  ]);
});

test("router orchestrator copies stored artifacts and returns exact project paths", async () => {
  const harness = await createHarness();
  const artifact = await saveArtifactFromBase64(harness.storeRoot, {
    syncJobId: "mock-sync",
    conversationId: SCOPE.conversationId,
    filename: "poster.png",
    contentType: "image/png",
    base64Data: Buffer.from("poster bytes", "utf8").toString("base64")
  });
  const artifactHarness = await createHarness({
    gpt: {
      replyText: "Poster created",
      artifacts: [{ id: artifact.id }]
    }
  });
  artifactHarness.storeRoot = harness.storeRoot;
  artifactHarness.orchestrator = createRouterOrchestrator({
    runStore: artifactHarness.runStore,
    transportRegistry: artifactHarness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: artifactHarness.clock,
    transportRequestIdFactory: ({ sequence }) => `artifact-request-${sequence}`
  });

  const result = await artifactHarness.orchestrator.startRouterRun(
    startInput(artifactHarness, {
      kind: "gpt_only",
      syncKind: "image_request",
      gptPayloadText: "Generate a poster."
    })
  );
  const runDir = path.join(
    artifactHarness.targetRepo,
    ".bridge",
    "artifacts",
    result.routerRun.id
  );
  const textPath = path.join(runDir, "gpt.md");
  const imagePath = path.join(runDir, "poster.png");

  assert.deepEqual(result.projectArtifactPaths, [textPath, imagePath]);
  assert.deepEqual(result.routerRun.projectArtifactPaths, [textPath, imagePath]);
  assert.deepEqual(result.routerRun.stages[0].projectArtifactPaths, [textPath, imagePath]);
  assert.deepEqual(result.routerRun.stages[0].artifactIds, [artifact.id]);
  assert.equal(await readFile(textPath, "utf8"), "Poster created\n");
  assert.equal((await readFile(imagePath)).toString("utf8"), "poster bytes");
});

test("router orchestrator reuses deterministic artifact paths after copy-before-persist failure", async () => {
  const responses = {};
  const harness = await createHarness(responses);
  const artifact = await saveTestPng(harness, "poster.png");
  responses.gpt = {
    replyText: "Poster created",
    artifacts: [{ id: artifact.id }]
  };
  const queued = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        syncKind: "image_request",
        gptPayloadText: "Generate a poster."
      },
      { waitForGpt: false }
    )
  );
  const requestId = queued.routerRun.stages[0].transportRequestId;
  await harness.transport.wait(requestId);

  const crashingRunStore = {
    ...harness.runStore,
    async update() {
      throw new Error("simulated copy-before-persist crash");
    }
  };
  const crashingOrchestrator = createRouterOrchestrator({
    runStore: crashingRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `crash-request-${sequence}`
  });

  await assert.rejects(
    () =>
      crashingOrchestrator.continueRouterRun({
        runId: queued.routerRun.id,
        scope: SCOPE,
        waitForGpt: true
      }),
    /simulated copy-before-persist crash/
  );

  const runDir = path.join(harness.targetRepo, ".bridge", "artifacts", queued.routerRun.id);
  assert.ok((await readdir(runDir)).includes("poster.png"));

  const recovered = await harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  const expectedPaths = [path.join(runDir, "gpt.md"), path.join(runDir, "poster.png")];
  assert.equal(recovered.routerRun.status, "succeeded");
  assert.deepEqual(recovered.projectArtifactPaths, expectedPaths);
  assert.deepEqual((await readdir(runDir)).sort(), ["gpt.md", "poster.png"]);
});

test("router orchestrator uses submitArtifacts when the stage has input artifacts", async () => {
  const harness = await createHarness({ gpt: { replyText: "File analysis" } });
  const result = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        syncKind: "chat_message",
        gptPayloadText: "Analyze the file."
      },
      {
        artifacts: [{ id: "input-artifact", filename: "input.pdf" }]
      }
    )
  );

  assert.equal(result.routerRun.status, "succeeded");
  assert.equal(harness.transport.submissions[0].kind, "artifacts");
  assert.equal(harness.transport.submissions[0].payload.artifacts[0].id, "input-artifact");
});

test("router orchestrator preserves the route sync kind for the transport", async () => {
  const harness = await createHarness({ gpt: { replyText: "Image result" } });

  await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        syncKind: "image_request",
        gptPayloadText: "Generate one image."
      },
      { waitForGpt: false }
    )
  );

  assert.equal(harness.transport.submissions[0].payload.kind, "image_request");
});

test("router orchestrator fails an image request without a real image artifact", async () => {
  const harness = await createHarness({ gpt: { replyText: "Image generated" } });

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "image_request",
      gptPayloadText: "Generate one image."
    })
  );

  assert.equal(result.routerRun.status, "failed");
  assert.equal(result.routerRun.stages[0].status, "failed");
  assert.match(result.routerRun.error, /real image artifact|new image artifact/i);
  assert.deepEqual(result.routerRun.stages[0].projectArtifactPaths, []);
});

test("router orchestrator fails an image request backed only by a text artifact", async () => {
  const responses = {};
  const harness = await createHarness(responses);
  const textArtifact = await saveArtifactFromBase64(harness.storeRoot, {
    filename: "poster-description.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("not an image", "utf8").toString("base64")
  });
  responses.gpt = {
    replyText: "Poster described",
    artifacts: [{ id: textArtifact.id }]
  };

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "image_request",
      gptPayloadText: "Generate one image."
    })
  );

  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /real image artifact|new image artifact/i);
  assert.deepEqual(result.routerRun.stages[0].projectArtifactPaths, []);
});

test("router orchestrator does not accept an input image echoed back as new output", async () => {
  const responses = {};
  const harness = await createHarness(responses);
  const inputImage = await saveTestPng(harness, "reference.png");
  responses.gpt = {
    replyText: "Reused the reference image",
    artifacts: [{ id: inputImage.id }]
  };

  const result = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        syncKind: "image_request",
        gptPayloadText: "Create a new image from this reference."
      },
      { artifacts: [inputImage] }
    )
  );

  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /real image artifact|new image artifact/i);
  assert.deepEqual(result.routerRun.stages[0].artifactIds, []);
});

test("router orchestrator treats a poster stage as an image output stage", async () => {
  const harness = await createHarness({ poster: { replyText: "Poster generated" } });

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Generate a poster.",
      sequentialPlan: {
        stages: [{ id: "poster", title: "Poster", payloadText: "Generate a poster." }]
      }
    })
  );

  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /real image artifact|new image artifact/i);
});

test("router orchestrator serializes concurrent continue calls so one stage submits once", async () => {
  const harness = await createHarness({ gpt: { replyText: "Concurrent result" } });
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "concurrent request",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    stages: [{ id: "gpt", title: "GPT", payloadText: "concurrent request" }]
  });

  const [first, second] = await Promise.all([
    harness.orchestrator.continueRouterRun({
      runId: created.id,
      scope: SCOPE,
      waitForGpt: true
    }),
    harness.orchestrator.continueRouterRun({
      runId: created.id,
      scope: SCOPE,
      waitForGpt: true
    })
  ]);

  assert.equal(first.routerRun.status, "succeeded");
  assert.equal(second.routerRun.status, "succeeded");
  assert.equal(harness.transport.submissions.length, 1);
});

test("router orchestrator serializes trimmed-scope continue calls across store instances", async () => {
  const harness = await createHarness({ gpt: { replyText: "Cross-instance result" } });
  const secondRunStore = createRouterRunStore({
    storeRoot: harness.storeRoot,
    clock: harness.clock
  });
  const secondOrchestrator = createRouterOrchestrator({
    runStore: secondRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `second-request-${sequence}`
  });
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "cross-instance request",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    stages: [{ id: "gpt", title: "GPT", payloadText: "cross-instance request" }]
  });
  const originalSubmit = harness.transport.submitText.bind(harness.transport);
  const submitCalls = [];
  let releaseFirstSubmit;
  let markFirstSubmitStarted;
  const firstSubmitStarted = new Promise((resolve) => {
    markFirstSubmitStarted = resolve;
  });
  const holdFirstSubmit = new Promise((resolve) => {
    releaseFirstSubmit = resolve;
  });
  harness.transport.submitText = async (input) => {
    submitCalls.push(structuredClone(input));
    if (submitCalls.length === 1) {
      markFirstSubmitStarted();
      await holdFirstSubmit;
    }
    return originalSubmit(input);
  };

  const first = harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: false
  });
  await firstSubmitStarted;
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  const second = secondOrchestrator.continueRouterRun({
    runId: `  ${created.id}  `,
    scope: paddedScope,
    waitForGpt: false
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstSubmit();
  await Promise.all([first, second]);

  const persisted = await harness.runStore.get(created.id, SCOPE);
  assert.equal(persisted.status, "succeeded");
  assert.equal(submitCalls.length, 1);
  assert.equal(harness.transport.submissions.length, 1);
});

test("router orchestrator keeps cancellation terminal against an in-flight continue from another instance", async () => {
  const harness = await createHarness({ gpt: { replyText: "must stay cancelled" } });
  const secondRunStore = createRouterRunStore({
    storeRoot: harness.storeRoot,
    clock: harness.clock
  });
  const secondOrchestrator = createRouterOrchestrator({
    runStore: secondRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `cancel-race-${sequence}`
  });
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "continue cancel race",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    stages: [{ id: "gpt", title: "GPT", payloadText: "continue cancel race" }]
  });
  const originalSubmit = harness.transport.submitText.bind(harness.transport);
  let releaseSubmit;
  let markSubmitStarted;
  const submitStarted = new Promise((resolve) => {
    markSubmitStarted = resolve;
  });
  const holdSubmit = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  harness.transport.submitText = async (input) => {
    markSubmitStarted();
    await holdSubmit;
    return originalSubmit(input);
  };

  const continuing = harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: false
  });
  await submitStarted;
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  const cancelling = secondOrchestrator.cancelRouterRun({
    runId: `  ${created.id}  `,
    scope: paddedScope,
    reason: "concurrent cancellation"
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  releaseSubmit();
  await Promise.all([continuing, cancelling]);

  const persisted = await harness.runStore.get(created.id, SCOPE);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.stages[0].status, "cancelled");
});

test("router orchestrator resumes a prepared request with the same id", async () => {
  const harness = await createHarness({ gpt: { replyText: "Prepared result" } });
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "prepared request",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    stages: [
      {
        id: "gpt",
        title: "GPT",
        status: "running",
        payloadText: "prepared request",
        transportRequestId: "prepared-request-id",
        submissionState: "prepared",
        startedAt: "2026-07-10T12:00:00.000Z"
      }
    ]
  });

  const completed = await harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: true
  });

  assert.equal(completed.routerRun.status, "succeeded");
  assert.equal(harness.transport.submissions.length, 1);
  assert.equal(harness.transport.submissions[0].requestId, "prepared-request-id");
});

test("router orchestrator reuses a prepared later stage payload and artifacts byte for byte", async () => {
  const harness = await createHarness({ chapter: { replyText: "Prepared chapter result" } });
  const frozenPayload = "  FROZEN prepared payload\r\nwith exact spacing  \n";
  const frozenArtifacts = [
    {
      id: "prepared-input",
      filename: "input.txt",
      metadata: { order: [3, 1, 2], note: "keep exactly" }
    }
  ];
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "outline then prepared chapter",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    currentStageIndex: 1,
    stages: [
      {
        id: "outline",
        title: "Outline",
        status: "succeeded",
        payloadText: "outline",
        replyText: "Persisted outline that must not rebuild the prepared payload",
        completedAt: "2026-07-10T11:00:00.000Z"
      },
      {
        id: "chapter",
        title: "Chapter",
        status: "running",
        dependsOn: "outline",
        instruction: "This instruction must not rebuild the prepared payload.",
        payloadText: frozenPayload,
        inputArtifacts: frozenArtifacts,
        transportRequestId: "prepared-chapter-request",
        submissionState: "prepared",
        startedAt: "2026-07-10T12:00:00.000Z"
      }
    ]
  });

  const completed = await harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: true
  });

  assert.equal(completed.routerRun.status, "succeeded");
  assert.equal(harness.transport.submissions.length, 1);
  assert.equal(harness.transport.submissions[0].kind, "artifacts");
  assert.equal(harness.transport.submissions[0].payload.payloadText, frozenPayload);
  assert.equal(harness.transport.submissions[0].payload.text, frozenPayload);
  assert.deepEqual(harness.transport.submissions[0].payload.artifacts, frozenArtifacts);
  assert.equal(completed.routerRun.stages[1].payloadText, frozenPayload);
  assert.deepEqual(completed.routerRun.stages[1].inputArtifacts, frozenArtifacts);
});

test("router orchestrator locally cancels a prepared request that was never submitted", async () => {
  const harness = await createHarness();
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId: "mock",
    originalRequestText: "prepared but not submitted",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    stages: [
      {
        id: "gpt",
        title: "GPT",
        status: "running",
        payloadText: "prepared but not submitted",
        transportRequestId: "never-submitted-request",
        submissionState: "prepared",
        startedAt: "2026-07-10T12:00:00.000Z"
      }
    ]
  });

  const cancelled = await harness.orchestrator.cancelRouterRun({
    runId: created.id,
    scope: SCOPE,
    reason: "cancel before submit"
  });

  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal(harness.transport.submissions.length, 0);
});

test("router orchestrator preserves a succeeded transport terminal result during cancel", async () => {
  const harness = await createHarness({ gpt: { replyText: "Completed before cancel" } });
  const queued = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "finish first" },
      { waitForGpt: false }
    )
  );
  await harness.transport.wait(queued.routerRun.stages[0].transportRequestId);

  const cancelled = await harness.orchestrator.cancelRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    reason: "too late"
  });

  assert.equal(cancelled.routerRun.status, "succeeded");
  assert.equal(cancelled.routerRun.stages[0].replyText, "Completed before cancel");
});

test("router orchestrator materializes one succeeded result once across wait and cancel", async () => {
  const harness = await createHarness();
  const artifact = await saveTestPng(harness, "shared-success.png");
  const envelope = (requestId, status) => ({
    transportId: "shared-finalization",
    requestId,
    status,
    replyText: status === "succeeded" ? "Shared successful result" : null,
    artifacts: status === "succeeded" ? [{ id: artifact.id }] : [],
    error: null,
    raw: null
  });
  const transport = {
    id: "shared-finalization",
    async submitText(input) {
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, "succeeded");
    },
    async cancel(requestId) {
      return envelope(requestId, "succeeded");
    }
  };
  harness.transportRegistry.register(transport);
  let resolverCalls = 0;
  let releaseResolver;
  let markFirstResolverEntered;
  let markSecondResolverEntered;
  const firstResolverEntered = new Promise((resolve) => {
    markFirstResolverEntered = resolve;
  });
  const secondResolverEntered = new Promise((resolve) => {
    markSecondResolverEntered = resolve;
  });
  const holdResolver = new Promise((resolve) => {
    releaseResolver = resolve;
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async (artifactId) => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        markFirstResolverEntered();
      } else if (resolverCalls === 2) {
        markSecondResolverEntered();
      }
      await holdResolver;
      return getArtifact(harness.storeRoot, artifactId);
    },
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `shared-finalization-${sequence}`
  });
  const queued = await orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "finalize once" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });
  const continuing = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  const cancelling = orchestrator.cancelRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    reason: "cancel while success finalizes"
  });
  await firstResolverEntered;
  const secondResolverEnteredBeforeRelease = await Promise.race([
    secondResolverEntered.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50))
  ]);

  releaseResolver();
  const [continued, cancelled] = await Promise.all([continuing, cancelling]);

  assert.equal(secondResolverEnteredBeforeRelease, false);
  assert.equal(resolverCalls, 1);
  assert.equal(continued.routerRun.status, "succeeded");
  assert.equal(cancelled.routerRun.status, "succeeded");
  assert.equal((await harness.runStore.get(queued.routerRun.id, SCOPE)).status, "succeeded");
});

test("router orchestrator keeps a materialization failure terminal during cancel", async () => {
  const harness = await createHarness({
    gpt: {
      replyText: "Completed with missing artifact",
      artifacts: [{ id: "missing-cancel-artifact" }]
    }
  });
  const queued = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "finish first" },
      { waitForGpt: false }
    )
  );
  await harness.transport.wait(queued.routerRun.stages[0].transportRequestId);

  const cancelled = await harness.orchestrator.cancelRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    reason: "too late"
  });

  assert.equal(cancelled.routerRun.status, "failed");
  assert.equal(cancelled.routerRun.stages[0].status, "failed");
  assert.match(cancelled.routerRun.error, /artifact/i);
});

test("router orchestrator creates one tracked stage per input artifact", async () => {
  const harness = await createHarness({
    "gpt-file-1": { replyText: "First file" },
    "gpt-file-2": { replyText: "Second file" }
  });
  const result = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "Analyze every file." },
      {
        waitForGpt: true,
        artifacts: [
          { id: "input-1", filename: "one.pdf" },
          { id: "input-2", filename: "two.pdf" }
        ]
      }
    )
  );

  assert.equal(result.routerRun.status, "succeeded");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), [
    "gpt-file-1",
    "gpt-file-2"
  ]);
  assert.equal(harness.transport.submissions[0].payload.artifacts.length, 1);
  assert.equal(harness.transport.submissions[1].payload.artifacts.length, 1);
});

test("router orchestrator rejects invalid transport envelopes without advancing", async () => {
  const storeRoot = await tempRoot("bridge-router-invalid-store-");
  const targetRepo = await tempRoot("bridge-router-invalid-project-");
  const runStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "invalid-envelope-run"
  });
  const invalidTransport = {
    id: "invalid",
    async submitText() {
      return { transportId: "invalid", requestId: "invalid-request-id", status: "pending" };
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel() {
      throw new Error("cancel must not run");
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore,
    transportRegistry: createGptTransportRegistry({
      transports: [invalidTransport],
      defaultTransportId: "invalid",
      env: {}
    }),
    artifactResolver: (artifactId) => getArtifact(storeRoot, artifactId),
    transportRequestIdFactory: () => "invalid-request-id"
  });

  const result = await orchestrator.startRouterRun({
    route: { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "invalid" },
    originalRequestText: "invalid",
    workspace: workspace(targetRepo),
    scope: SCOPE,
    transportId: "invalid",
    waitForGpt: true
  });

  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /invalid transport status/i);
});

test("router orchestrator rejects top-level transport-private envelope fields", async () => {
  const harness = await createHarness();
  const leakyTransport = {
    id: "leaky",
    async submitText(input) {
      return {
        transportId: "leaky",
        requestId: input.requestId,
        status: "queued",
        replyText: null,
        artifacts: [],
        error: null,
        raw: null,
        errorCode: "web_private"
      };
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return {
        transportId: "leaky",
        requestId,
        status: "succeeded",
        replyText: "unused",
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async cancel(requestId) {
      return {
        transportId: "leaky",
        requestId,
        status: "cancelled",
        replyText: null,
        artifacts: [],
        error: "cancelled",
        raw: null
      };
    }
  };
  harness.transportRegistry.register(leakyTransport);

  const result = await harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "leaky" },
      { waitForGpt: false }
    ),
    transportId: "leaky"
  });

  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /errorCode|unexpected transport field/i);
});

test("router orchestrator keeps raw in the public envelope when transport raw is undefined", async () => {
  const harness = await createHarness();
  const transport = {
    id: "undefined-raw",
    async submitText(input) {
      return {
        transportId: this.id,
        requestId: input.requestId,
        status: "queued",
        replyText: null,
        artifacts: [],
        error: null,
        raw: undefined
      };
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return {
        transportId: this.id,
        requestId,
        status: "succeeded",
        replyText: "unused",
        artifacts: [],
        error: null,
        raw: undefined
      };
    },
    async cancel(requestId) {
      return {
        transportId: this.id,
        requestId,
        status: "cancelled",
        replyText: null,
        artifacts: [],
        error: "cancelled",
        raw: undefined
      };
    }
  };
  harness.transportRegistry.register(transport);

  const result = await harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "raw" },
      { waitForGpt: false }
    ),
    transportId: transport.id
  });

  assert.equal(result.routerRun.status, "queued");
  assert.equal(result.transportResult.raw, null);
});

test("router orchestrator resolves every output artifact through artifact-store", async () => {
  const harness = await createHarness({
    gpt: {
      replyText: "Untrusted artifact",
      artifacts: [{ id: "not-in-store", filePath: path.join("C:\\untrusted", "evil.png") }]
    }
  });
  const untrustedTransport = harness.transport;
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async () => {
      throw new Error("artifact not found in store");
    },
    clock: harness.clock,
    transportRequestIdFactory: () => "untrusted-request"
  });

  const result = await orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "return artifact"
    })
  );

  assert.equal(untrustedTransport.submissions.length, 1);
  assert.equal(result.routerRun.status, "failed");
  assert.match(result.routerRun.error, /artifact not found in store/i);
});
