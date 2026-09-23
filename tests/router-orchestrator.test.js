import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
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

function rejectAfter(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
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

test("router orchestrator persists the semantic routing audit with the run", async () => {
  const harness = await createHarness();
  const route = {
    kind: "gpt_only",
    syncKind: "chat_message",
    gptPayloadText: "Write the requested copy.",
    decisionSource: "semantic_proposal",
    policyVersion: "semantic-router-v1",
    confidence: 0.92,
    needsClarification: false,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.92,
      reason: "Creative copywriting"
    }
  };

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: false })
  );
  const restored = await harness.runStore.get(result.routerRun.id, SCOPE);

  assert.deepEqual(restored.routingDecision, {
    source: "semantic_proposal",
    policyVersion: "semantic-router-v1",
    confidence: 0.92,
    needsClarification: false,
    proposal: route.routingProposal
  });
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

test("router orchestrator persists an unsignalled transport AbortError as an ordinary failure", async () => {
  const harness = await createHarness({
    gpt: { replyText: "unused" }
  });
  const route = {
    kind: "gpt_only",
    syncKind: "chat_message",
    gptPayloadText: "Queue before the transport fails."
  };
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: false })
  );
  const abortError = new Error("transport aborted independently");
  abortError.name = "AbortError";
  const transport = {
    id: "mock",
    preservesConversationContext: true,
    async submitText() {
      throw new Error("must not resubmit");
    },
    async submitArtifacts() {
      throw new Error("must not resubmit");
    },
    async wait() {
      throw abortError;
    },
    async cancel() {
      throw new Error("must not cancel");
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: { resolve: () => transport },
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock
  });
  const controller = new AbortController();

  const failed = await orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });

  assert.equal(controller.signal.aborted, false);
  assert.equal(failed.routerRun.status, "failed");
  assert.equal(failed.routerRun.stages[0].status, "failed");
  assert.equal(failed.routerRun.stages[0].error, "transport aborted independently");
  assert.equal(harness.transport.submissions.length, 1);
});

test("router orchestrator persists submitting before transport and recovers by waiting without resubmit", async () => {
  const harness = await createHarness();
  let releaseSubmit;
  let markSubmitEntered;
  let submitSignal = null;
  let submitCount = 0;
  let waitCount = 0;
  let waitStatus = "running";
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const submitBarrier = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const transport = {
    id: "mock",
    preservesConversationContext: true,
    async submitText(input) {
      submitCount += 1;
      submitSignal = input.signal;
      markSubmitEntered();
      await submitBarrier;
      return {
        transportId: "mock",
        requestId: input.requestId,
        status: "queued",
        replyText: null,
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      waitCount += 1;
      return {
        transportId: "mock",
        requestId,
        status: waitStatus,
        replyText: waitStatus === "succeeded" ? "Recovered result" : null,
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async cancel() {
      throw new Error("must not cancel");
    }
  };
  harness.transportRegistry.register(transport, { replace: true });
  const controller = new AbortController();
  const startPromise = harness.orchestrator.startRouterRun({
    ...startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Block during submit."
    }, { waitForGpt: false }),
    signal: controller.signal
  });
  const rejected = assert.rejects(
    startPromise,
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
  );
  try {
    await submitEntered;
    controller.abort();
    assert.equal(
      await Promise.race([
        rejected.then(() => "rejected"),
        rejectAfter(2_000, "aborted submit did not reject")
      ]),
      "rejected"
    );
    assert.equal(submitSignal, controller.signal);
    assert.equal(submitCount, 1);

    const leaseState = await Promise.race([
      harness.runStore.withSubmissionLease("router-run-1", SCOPE, async (run) => run.status)
        .then(() => "released"),
      rejectAfter(2_000, "submission lease was not released after abort")
    ]);
    assert.equal(leaseState, "released");

    const persisted = await harness.runStore.get("router-run-1", SCOPE);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.stages[0].submissionState, "submitting");
    assert.equal(submitCount, 1);

    const continuePromise = harness.orchestrator.continueRouterRun({
      runId: persisted.id,
      scope: SCOPE,
      waitForGpt: false
    });
    assert.equal(
      await Promise.race([
        continuePromise.then(() => "continued"),
        rejectAfter(2_000, "continuation did not finish after submit abort")
      ]),
      "continued"
    );
    assert.equal(submitCount, 1);
    assert.equal(waitCount, 1);

    const beforeLateSubmit = await harness.runStore.get(persisted.id, SCOPE);
    releaseSubmit();
    await new Promise((resolve) => setImmediate(resolve));
    const afterLateSubmit = await harness.runStore.get(persisted.id, SCOPE);
    assert.deepEqual(afterLateSubmit, beforeLateSubmit);

    waitStatus = "succeeded";
    const recovered = await harness.orchestrator.continueRouterRun({
      runId: persisted.id,
      scope: SCOPE,
      waitForGpt: false
    });
    assert.equal(recovered.routerRun.status, "succeeded");
    assert.equal(recovered.routerRun.stages[0].replyText, "Recovered result");
    assert.equal(submitCount, 1);
    assert.equal(waitCount, 2);
  } finally {
    releaseSubmit();
    await startPromise.catch(() => {});
  }
});

async function createInterruptedSubmissionCase(transportId) {
  const harness = await createHarness();
  let releaseSubmission;
  let rejectSubmission;
  let markSubmitEntered;
  let jobRegistered = false;
  let cancelCalls = 0;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const submitBarrier = new Promise((resolve, reject) => {
    releaseSubmission = resolve;
    rejectSubmission = reject;
  });
  const envelope = (requestId, status, error = null) => ({
    transportId,
    requestId,
    status,
    replyText: null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText(input) {
      markSubmitEntered();
      await submitBarrier;
      jobRegistered = true;
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, jobRegistered ? "queued" : "running");
    },
    async cancel(requestId) {
      cancelCalls += 1;
      if (!jobRegistered) {
        const error = new Error("structured missing submission");
        error.code = "ENOENT";
        throw error;
      }
      return envelope(requestId, "cancelled", "cancelled registered submission");
    }
  };
  harness.transportRegistry.register(transport);
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `${transportId}-request-${sequence}`
  });
  const controller = new AbortController();
  const starting = orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: transportId },
      { waitForGpt: false }
    ),
    transportId,
    signal: controller.signal
  });
  await submitEntered;
  controller.abort();
  await assert.rejects(starting, (error) => error?.code === "ABORT_ERR");
  const run = (await harness.runStore.list(SCOPE))[0];
  return {
    harness,
    orchestrator,
    run,
    releaseSubmission,
    rejectSubmission,
    cancelCalls: () => cancelCalls
  };
}

test("router orchestrator locally cancels a submitting stage after its interrupted submit rejects", async () => {
  const interrupted = await createInterruptedSubmissionCase("late-submit-reject");
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const rejection = new Error("provider rejected before creating a job");
  rejection.code = "SUBMIT_REJECTED";
  try {
    assert.equal(interrupted.run.stages[0].submissionState, "submitting");
    assert.equal(interrupted.run.stages[0].submissionOwnerPid, process.pid);
    interrupted.rejectSubmission(rejection);
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await interrupted.orchestrator.cancelRouterRun({
      runId: interrupted.run.id,
      scope: SCOPE,
      reason: "cancel rejected submission"
    });
    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
    assert.equal(interrupted.cancelCalls(), 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    interrupted.rejectSubmission(rejection);
    process.off("unhandledRejection", onUnhandled);
  }
});

test("router orchestrator keeps a still-pending interrupted submit nonterminal during cancel", async () => {
  const interrupted = await createInterruptedSubmissionCase("pending-submit-cancel");
  const rejection = new Error("cleanup rejected pending submission");
  rejection.code = "SUBMIT_REJECTED";
  try {
    assert.equal(interrupted.run.stages[0].submissionState, "submitting");
    assert.equal(interrupted.run.stages[0].submissionOwnerPid, process.pid);
    const uncertain = await interrupted.orchestrator.cancelRouterRun({
      runId: interrupted.run.id,
      scope: SCOPE,
      reason: "cancel while submit is pending"
    });
    assert.equal(uncertain.routerRun.status, "running");
    assert.equal(uncertain.routerRun.stages[0].submissionState, "submitting");
    assert.equal(interrupted.cancelCalls(), 0);
  } finally {
    interrupted.rejectSubmission(rejection);
    await new Promise((resolve) => setImmediate(resolve));
    await interrupted.orchestrator.cancelRouterRun({
      runId: interrupted.run.id,
      scope: SCOPE,
      reason: "cleanup rejected submission"
    }).catch(() => {});
  }
});

test("router orchestrator records and consumes cancel intent without blocking a local pending submit", async () => {
  const harness = await createHarness();
  let releaseSubmit;
  let markSubmitEntered;
  let cancelCalls = 0;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const submitBarrier = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const transportId = "pending-submit-intent";
  const envelope = (requestId, status, error = null) => ({
    transportId,
    requestId,
    status,
    replyText: status === "succeeded" ? "must not be committed" : null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText(input) {
      markSubmitEntered();
      await submitBarrier;
      return envelope(input.requestId, "succeeded");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      return envelope(requestId, "succeeded");
    },
    async cancel(requestId) {
      cancelCalls += 1;
      return envelope(requestId, "cancelled", "cancel intent consumed");
    }
  };
  harness.transportRegistry.register(transport);
  const starting = harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "slow local submit" },
      { waitForGpt: false }
    ),
    transportId
  });
  let cancelling;
  try {
    await Promise.race([
      submitEntered,
      rejectAfter(1_000, "submit did not start")
    ]);
    const run = (await harness.runStore.list(SCOPE))[0];
    cancelling = harness.orchestrator.cancelRouterRun({
      runId: run.id,
      scope: SCOPE,
      reason: "cancel local pending submit"
    });
    const requested = await Promise.race([
      cancelling,
      rejectAfter(200, "cancel intent blocked")
    ]);
    assert.equal(requested.routerRun.status, "running");
    assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);
    assert.equal(requested.routerRun.stages[0].cancelReason, "cancel local pending submit");
    releaseSubmit();
    const settled = await starting;
    assert.equal(settled.routerRun.status, "cancelled");
    assert.equal(settled.routerRun.stages[0].status, "cancelled");
    assert.equal(settled.routerRun.stages[0].replyText, null);
    assert.equal(cancelCalls, 1);
  } finally {
    releaseSubmit();
    await Promise.allSettled([starting, cancelling].filter(Boolean));
  }
});

test("router orchestrator consumes cancel intent when an aborted submit settles without another call", async () => {
  const harness = await createHarness();
  const controller = new AbortController();
  let releaseSubmit;
  let markSubmitEntered;
  let submitCalls = 0;
  let cancelCalls = 0;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const submitBarrier = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const transportId = "aborted-submit-settle-intent";
  const envelope = (requestId, status, error = null) => ({
    transportId,
    requestId,
    status,
    replyText: status === "succeeded" ? "must not be applied" : null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText(input) {
      submitCalls += 1;
      markSubmitEntered();
      await submitBarrier;
      return envelope(input.requestId, "succeeded");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel(requestId) {
      cancelCalls += 1;
      return envelope(requestId, "cancelled", "settled cancellation consumed");
    }
  };
  harness.transportRegistry.register(transport);
  const starting = harness.orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "abort active submit" },
      { waitForGpt: false }
    ),
    transportId,
    signal: controller.signal
  });
  try {
    await Promise.race([submitEntered, rejectAfter(1_000, "submit did not start")]);
    controller.abort();
    await assert.rejects(starting, (error) => error?.code === "ABORT_ERR");
    const submitting = (await harness.runStore.list(SCOPE))[0];
    const requested = await harness.orchestrator.cancelRouterRun({
      runId: submitting.id,
      scope: SCOPE,
      reason: "cancel after original caller aborted"
    });
    assert.equal(requested.routerRun.status, "running");
    assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);

    releaseSubmit();
    // The detached completion persists asynchronously; suite-wide I/O load
    // must not turn a fixed 100 ms sleep into a false cancellation failure.
    let settled;
    const settleDeadline = Date.now() + 2_000;
    do {
      settled = await harness.runStore.get(submitting.id, SCOPE);
      if (settled.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < settleDeadline);
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.stages[0].status, "cancelled");
    assert.equal(settled.stages[0].replyText, null);
    assert.equal(submitCalls, 1);
    assert.equal(cancelCalls, 1);
  } finally {
    releaseSubmit();
    await Promise.allSettled([starting]);
  }
});

test("router orchestrator evicts a never-settling active submission without changing its run", async (t) => {
  const harness = await createHarness();
  const controller = new AbortController();
  t.after(() => controller.abort());
  let markSubmitEntered;
  let submitCalls = 0;
  let cancelCalls = 0;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const neverSettles = new Promise(() => {});
  const transportId = "never-settling-active-submission";
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText() {
      submitCalls += 1;
      markSubmitEntered();
      return neverSettles;
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel() {
      cancelCalls += 1;
      const error = new Error("provider never registered the pending request");
      error.code = "ENOENT";
      throw error;
    }
  };
  harness.transportRegistry.register(transport);
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `never-settling-request-${sequence}`,
    activeSubmissionTtlMs: 20
  });
  const starting = orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "never settle" },
      { waitForGpt: false }
    ),
    transportId,
    signal: controller.signal
  });
  await Promise.race([submitEntered, rejectAfter(5_000, "submit did not start")]);
  controller.abort();
  await assert.rejects(starting, (error) => error?.code === "ABORT_ERR");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const submitting = (await harness.runStore.list(SCOPE))[0];
  const requested = await orchestrator.cancelRouterRun({
    runId: submitting.id,
    scope: SCOPE,
    reason: "cancel an evicted pending submission"
  });
  assert.equal(requested.routerRun.status, "running");
  assert.equal(requested.routerRun.stages[0].status, "running");
  assert.equal(requested.routerRun.stages[0].submissionState, "submitting");
  assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);
  assert.equal(submitCalls, 1);
  assert.equal(cancelCalls, 1);
});

test("router orchestrator consumes cancel intent after its active submission index was evicted", async () => {
  const harness = await createHarness();
  const controller = new AbortController();
  let releaseSubmit;
  let markSubmitEntered;
  let submitCalls = 0;
  let cancelCalls = 0;
  let providerRegistered = false;
  const submitEntered = new Promise((resolve) => {
    markSubmitEntered = resolve;
  });
  const submitBarrier = new Promise((resolve) => {
    releaseSubmit = resolve;
  });
  const transportId = "evicted-active-submission-settle";
  const envelope = (requestId, status, error = null) => ({
    transportId,
    requestId,
    status,
    replyText: status === "succeeded" ? "must not be applied" : null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText(input) {
      submitCalls += 1;
      markSubmitEntered();
      await submitBarrier;
      providerRegistered = true;
      return envelope(input.requestId, "succeeded");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel(requestId) {
      cancelCalls += 1;
      if (!providerRegistered) {
        const error = new Error("provider request is not registered yet");
        error.code = "ENOENT";
        throw error;
      }
      return envelope(requestId, "cancelled", "evicted submission intent consumed");
    }
  };
  harness.transportRegistry.register(transport);
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `evicted-settle-request-${sequence}`,
    activeSubmissionTtlMs: 20
  });
  const starting = orchestrator.startRouterRun({
    ...startInput(
      harness,
      { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: "settle after eviction" },
      { waitForGpt: false }
    ),
    transportId,
    signal: controller.signal
  });
  try {
    await Promise.race([submitEntered, rejectAfter(1_000, "submit did not start")]);
    controller.abort();
    await assert.rejects(starting, (error) => error?.code === "ABORT_ERR");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const submitting = (await harness.runStore.list(SCOPE))[0];
    const requested = await orchestrator.cancelRouterRun({
      runId: submitting.id,
      scope: SCOPE,
      reason: "consume after active index eviction"
    });
    assert.equal(requested.routerRun.status, "running");
    assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);
    assert.equal(cancelCalls, 1);

    releaseSubmit();
    // Submission completion is detached after abort. Wait for persisted state,
    // not a 100 ms scheduling assumption that fails under suite-wide I/O load.
    let settled;
    const settleDeadline = Date.now() + 2_000;
    do {
      settled = await harness.runStore.get(submitting.id, SCOPE);
      if (settled.status === "cancelled") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    } while (Date.now() < settleDeadline);
    assert.equal(settled.status, "cancelled");
    assert.equal(settled.stages[0].status, "cancelled");
    assert.equal(settled.stages[0].replyText, null);
    assert.equal(submitCalls, 1);
    assert.equal(cancelCalls, 2);
  } finally {
    releaseSubmit();
    await Promise.allSettled([starting]);
  }
});

test("router orchestrator persists foreign cancel intent while submission lease is held and consumes it on resume", async () => {
  const harness = await createHarness();
  const otherStore = createRouterRunStore({ storeRoot: harness.storeRoot });
  const foreignOwnerPid = process.pid + 200_000;
  const transportId = "foreign-held-submit-intent";
  let cancelCalls = 0;
  const envelope = (requestId, status, error = null) => ({
    transportId,
    requestId,
    status,
    replyText: status === "succeeded" ? "must not be applied" : null,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: transportId,
    async submitText() {
      throw new Error("submit must not run");
    },
    async submitArtifacts() {
      throw new Error("submit must not run");
    },
    async wait(requestId) {
      return envelope(requestId, "succeeded");
    },
    async cancel(requestId) {
      cancelCalls += 1;
      const error = new Error(`request not visible yet: ${requestId}`);
      error.code = "ENOENT";
      throw error;
    }
  };
  harness.transportRegistry.register(transport);
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId,
    originalRequestText: "foreign owner holds submit lease",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "running",
      payloadText: "foreign owner holds submit lease",
      transportRequestId: "foreign-held-request",
      submissionState: "submitting",
      submissionOwnerPid: foreignOwnerPid,
      submissionOwnerToken: "foreign-held-token"
    }]
  });
  let releaseLease;
  let markLeaseEntered;
  const leaseEntered = new Promise((resolve) => {
    markLeaseEntered = resolve;
  });
  const leaseBarrier = new Promise((resolve) => {
    releaseLease = resolve;
  });
  const heldLease = otherStore.withSubmissionLease(created.id, SCOPE, async () => {
    markLeaseEntered();
    await leaseBarrier;
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    isProcessAlive: (pid) => pid === foreignOwnerPid
  });
  let cancelling;
  try {
    await Promise.race([
      leaseEntered,
      rejectAfter(1_000, "submission lease not held")
    ]);
    cancelling = orchestrator.cancelRouterRun({
      runId: created.id,
      scope: SCOPE,
      reason: "cancel foreign held submit"
    });
    const requested = await Promise.race([
      cancelling,
      rejectAfter(200, "foreign cancel intent blocked")
    ]);
    assert.equal(requested.routerRun.status, "running");
    assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);
    releaseLease();
    await heldLease;
    const resumed = await orchestrator.continueRouterRun({
      runId: created.id,
      scope: SCOPE,
      waitForGpt: true
    });
    assert.equal(resumed.routerRun.status, "cancelled");
    assert.equal(resumed.routerRun.stages[0].status, "cancelled");
    assert.equal(resumed.routerRun.stages[0].replyText, null);
    assert.equal(cancelCalls >= 1, true);
  } finally {
    releaseLease();
    await Promise.allSettled([heldLease, cancelling].filter(Boolean));
  }
});

test("router orchestrator cancels the real transport after an interrupted submit fulfills late", async () => {
  const interrupted = await createInterruptedSubmissionCase("late-submit-fulfill");
  try {
    assert.equal(interrupted.run.stages[0].submissionState, "submitting");
    assert.equal(interrupted.run.stages[0].submissionOwnerPid, process.pid);
    interrupted.releaseSubmission();
    await new Promise((resolve) => setImmediate(resolve));
    const cancelled = await interrupted.orchestrator.cancelRouterRun({
      runId: interrupted.run.id,
      scope: SCOPE,
      reason: "cancel fulfilled submission"
    });
    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
    assert.equal(interrupted.cancelCalls(), 1);
  } finally {
    interrupted.releaseSubmission();
  }
});

test("router orchestrator cancels safely when abort lands after submitting persistence but before transport invocation", async () => {
  const harness = await createHarness();
  const controller = new AbortController();
  let submitCalls = 0;
  let cancelCalls = 0;
  const transportId = "reserved-submit-abort";
  const transport = {
    id: transportId,
    preservesConversationContext: true,
    async submitText(input) {
      submitCalls += 1;
      return {
        transportId,
        requestId: input.requestId,
        status: "queued",
        replyText: null,
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel() {
      cancelCalls += 1;
      const error = new Error("no transport request was created");
      error.code = "ENOENT";
      throw error;
    }
  };
  harness.transportRegistry.register(transport);
  let abortedAfterPersistence = false;
  const abortingRunStore = {
    ...harness.runStore,
    async update(...args) {
      const updated = await harness.runStore.update(...args);
      if (
        !abortedAfterPersistence &&
        updated.stages.some((stage) => stage.submissionState === "submitting")
      ) {
        abortedAfterPersistence = true;
        controller.abort();
      }
      return updated;
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore: abortingRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    transportRequestIdFactory: ({ sequence }) => `${transportId}-request-${sequence}`
  });
  await assert.rejects(
    orchestrator.startRouterRun({
      ...startInput(
        harness,
        { kind: "gpt_only", syncKind: "chat_message", gptPayloadText: transportId },
        { waitForGpt: false }
      ),
      transportId,
      signal: controller.signal
    }),
    (error) => error?.code === "ABORT_ERR"
  );
  const run = (await harness.runStore.list(SCOPE))[0];
  assert.equal(run.stages[0].submissionState, "submitting");
  assert.equal(run.stages[0].submissionOwnerPid, process.pid);
  assert.match(run.stages[0].submissionOwnerToken, /^[A-Za-z0-9._-]+$/);
  assert.equal(submitCalls, 0);

  const cancelled = await orchestrator.cancelRouterRun({
    runId: run.id,
    scope: SCOPE,
    reason: "cancel reserved submission"
  });
  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal(cancelCalls, 0);
});

test("router orchestrator conservatively cancels a legacy submitting stage without an owner token", async () => {
  const harness = await createHarness();
  let cancelCalls = 0;
  const transportId = "legacy-submitting-cancel";
  const transport = {
    id: transportId,
    async submitText() {
      throw new Error("submit must not run");
    },
    async submitArtifacts() {
      throw new Error("submit must not run");
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel() {
      cancelCalls += 1;
      const error = new Error("legacy request is absent");
      error.code = "ENOENT";
      throw error;
    }
  };
  harness.transportRegistry.register(transport);
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId,
    originalRequestText: "legacy submitting request",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "running",
      payloadText: "legacy submitting request",
      transportRequestId: "legacy-request",
      submissionState: "submitting",
      submissionOwnerPid: process.pid
    }]
  });
  const cancelled = await harness.orchestrator.cancelRouterRun({
    runId: created.id,
    scope: SCOPE,
    reason: "cancel legacy submitting request"
  });
  assert.equal(cancelled.routerRun.status, "running");
  assert.equal(cancelled.routerRun.stages[0].status, "running");
  assert.match(cancelled.routerRun.stages[0].cancelRequestedAt, /^2026-/);
  assert.equal(cancelled.routerRun.stages[0].cancelReason, "cancel legacy submitting request");
  assert.equal(cancelCalls, 1);
});

test("router orchestrator records cancel intent for a live foreign submission and cancels after its owner exits", async () => {
  const harness = await createHarness();
  let cancelCalls = 0;
  let foreignOwnerAlive = true;
  const transportId = "foreign-submitting-cancel";
  const transport = {
    id: transportId,
    async submitText() {
      throw new Error("submit must not run");
    },
    async submitArtifacts() {
      throw new Error("submit must not run");
    },
    async wait() {
      throw new Error("wait must not run");
    },
    async cancel() {
      cancelCalls += 1;
      const error = new Error("foreign request is not visible in this process");
      error.code = "ENOENT";
      throw error;
    }
  };
  harness.transportRegistry.register(transport);
  const foreignOwnerPid = process.pid + 100_000;
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    syncKind: "chat_message",
    transportId,
    originalRequestText: "foreign submitting request",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    status: "running",
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "running",
      payloadText: "foreign submitting request",
      transportRequestId: "foreign-request",
      submissionState: "submitting",
      submissionOwnerPid: foreignOwnerPid,
      submissionOwnerToken: "foreign-owner-token"
    }]
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    isProcessAlive: (pid) => pid === foreignOwnerPid && foreignOwnerAlive
  });

  const requested = await orchestrator.cancelRouterRun({
    runId: created.id,
    scope: SCOPE,
    reason: "cancel foreign submission"
  });
  assert.equal(requested.routerRun.status, "running");
  assert.equal(requested.routerRun.stages[0].submissionState, "submitting");
  assert.equal(requested.routerRun.stages[0].submissionOwnerToken, "foreign-owner-token");
  assert.match(requested.routerRun.stages[0].cancelRequestedAt, /^2026-/);
  assert.equal(requested.routerRun.stages[0].cancelReason, "cancel foreign submission");
  assert.equal(cancelCalls, 1);

  foreignOwnerAlive = false;
  const cancelled = await orchestrator.cancelRouterRun({
    runId: created.id,
    scope: SCOPE,
    reason: "cancel foreign submission"
  });
  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
  assert.equal(cancelled.routerRun.stages[0].submissionOwnerToken, "foreign-owner-token");
  assert.equal(cancelCalls, 2);
});

test("router orchestrator aborts while queued on the in-process run lock without blocking its successor", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Wait on the active request."
    }, { waitForGpt: false })
  );
  let releaseFirstWait;
  let markFirstWaitEntered;
  let waitCount = 0;
  const firstWaitEntered = new Promise((resolve) => {
    markFirstWaitEntered = resolve;
  });
  const firstWaitBarrier = new Promise((resolve) => {
    releaseFirstWait = resolve;
  });
  harness.transport.wait = async (requestId) => {
    waitCount += 1;
    if (waitCount === 1) {
      markFirstWaitEntered();
      await firstWaitBarrier;
    }
    return {
      transportId: "mock",
      requestId,
      status: "running",
      replyText: null,
      artifacts: [],
      error: null,
      raw: null
    };
  };

  const first = harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  await firstWaitEntered;
  const controller = new AbortController();
  const second = harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const secondOutcome = second.then(
    () => "resolved",
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR" ? "aborted" : "wrong-error"
  );
  try {
    controller.abort();
    assert.equal(
      await Promise.race([
        secondOutcome,
        rejectAfter(2_000, "queued run-lock abort did not settle")
      ]),
      "aborted"
    );
  } finally {
    releaseFirstWait();
    await first;
    await second.catch(() => {});
  }

  const third = await Promise.race([
    harness.orchestrator.continueRouterRun({
      runId: queued.routerRun.id,
      scope: SCOPE,
      waitForGpt: false
    }),
    rejectAfter(2_000, "run-lock successor did not finish")
  ]);
  assert.ok(third.routerRun);
  assert.equal(waitCount, 2);
});

test("router orchestrator aborts while update waits on the persisted run lock without a late write", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Remain running while the update lock is held."
    }, { waitForGpt: false })
  );
  const before = await harness.runStore.get(queued.routerRun.id, SCOPE);
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "running",
    replyText: null,
    artifacts: [],
    error: null,
    raw: null
  });
  const lockPath = path.join(
    harness.storeRoot,
    "router-runs",
    `${queued.routerRun.id}.json.lock`
  );
  await writeFile(lockPath, `${process.pid}-held ${new Date().toISOString()}\n`, "utf8");
  const controller = new AbortController();
  const continuation = harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: false,
    signal: controller.signal
  });
  let lockReleased = false;
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    const outcome = await Promise.race([
      continuation.then(() => "resolved", (error) => error?.code || "rejected"),
      rejectAfter(2_000, "persisted run-lock abort did not settle")
    ]);
    await unlink(lockPath);
    lockReleased = true;
    await continuation.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(outcome, "ABORT_ERR");
    assert.deepEqual(await harness.runStore.get(queued.routerRun.id, SCOPE), before);
  } finally {
    controller.abort();
    if (!lockReleased) {
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
    }
    await continuation.catch(() => {});
  }
});

test("router orchestrator aborts inside artifact resolution without writing outputs", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Resolve one output artifact."
    }, { waitForGpt: false })
  );
  const sourcePath = path.join(harness.targetRepo, "source.bin");
  await writeFile(sourcePath, "source artifact", "utf8");
  let releaseResolver;
  let markResolverEntered;
  let resolverSignal = null;
  const resolverEntered = new Promise((resolve) => {
    markResolverEntered = resolve;
  });
  const resolverBarrier = new Promise((resolve) => {
    releaseResolver = resolve;
  });
  const transport = {
    id: "mock",
    preservesConversationContext: true,
    async submitText() {
      throw new Error("must not resubmit");
    },
    async submitArtifacts() {
      throw new Error("must not resubmit");
    },
    async wait(requestId) {
      return {
        transportId: "mock",
        requestId,
        status: "succeeded",
        replyText: "resolved reply",
        artifacts: [{ id: "artifact-blocked" }],
        error: null,
        raw: null
      };
    },
    async cancel() {
      throw new Error("must not cancel");
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: { resolve: () => transport },
    clock: harness.clock,
    artifactResolver: async (artifactId, options = {}) => {
      resolverSignal = options.signal;
      markResolverEntered();
      await resolverBarrier;
      return {
        id: artifactId,
        filePath: sourcePath,
        filename: "out.bin",
        contentType: "application/octet-stream"
      };
    }
  });
  const controller = new AbortController();
  const continuePromise = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const rejected = assert.rejects(
    continuePromise,
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
  );
  try {
    await resolverEntered;
    controller.abort();
    assert.equal(
      await Promise.race([
        rejected.then(() => "rejected"),
        rejectAfter(2_000, "artifact resolution abort did not settle")
      ]),
      "rejected"
    );
    assert.equal(resolverSignal, controller.signal);

    releaseResolver();
    await new Promise((resolve) => setImmediate(resolve));
    const runDirectory = path.join(
      harness.targetRepo,
      ".bridge",
      "artifacts",
      queued.routerRun.id
    );
    await assert.rejects(readFile(path.join(runDirectory, "gpt.md")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(runDirectory, "out.bin")), { code: "ENOENT" });
    const persisted = await harness.runStore.get(queued.routerRun.id, SCOPE);
    assert.equal(persisted.status, "queued");
    assert.equal(persisted.stages[0].status, "queued");
  } finally {
    releaseResolver();
    await continuePromise.catch(() => {});
  }
});

test("router orchestrator aborts a 128 MiB text materialization without publishing final or temp files", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Return a large text result."
    }, { waitForGpt: false })
  );
  const before = await harness.runStore.get(queued.routerRun.id, SCOPE);
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "T".repeat(128 * 1024 * 1024),
    artifacts: [],
    error: null,
    raw: null
  });
  const controller = new AbortController();
  const runDirectory = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id
  );
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const continuation = harness.orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const operationSettled = continuation.then(() => false, () => false);
  const sawTemporaryFile = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (controller.signal.aborted) {
        return false;
      }
      const entries = await readdir(runDirectory).catch((error) =>
        error.code === "ENOENT" ? [] : Promise.reject(error)
      );
      if (entries.some((name) => name.startsWith("gpt.md.bridge-tmp-"))) {
        controller.abort();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return false;
  })();
  try {
    assert.equal(await Promise.race([sawTemporaryFile, operationSettled]), true);
    await assert.rejects(
      continuation,
      (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
    );
    const entries = await readdir(runDirectory).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error)
    );
    assert.equal(entries.includes("gpt.md"), false);
    assert.equal(entries.some((name) => name.includes(".bridge-tmp-")), false);
    assert.deepEqual(await harness.runStore.get(queued.routerRun.id, SCOPE), before);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    controller.abort();
    await continuation.catch(() => {});
    process.off("unhandledRejection", onUnhandled);
  }
});

test("router orchestrator aborts a large artifact stream copy without publishing any stage output", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Return one large artifact."
    }, { waitForGpt: false })
  );
  const before = await harness.runStore.get(queued.routerRun.id, SCOPE);
  const sourcePath = path.join(harness.targetRepo, "large-source.bin");
  const sourceHandle = await open(sourcePath, "w");
  await sourceHandle.truncate(64 * 1024 * 1024);
  await sourceHandle.close();
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "Large artifact ready",
    artifacts: [{ id: "large-output" }],
    error: null,
    raw: null
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async () => ({
      id: "large-output",
      filename: "out.bin",
      filePath: sourcePath,
      contentHashSha256: "large-output-hash"
    }),
    clock: harness.clock
  });
  const controller = new AbortController();
  const runDirectory = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id
  );
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const continuation = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const operationSettled = continuation.then(() => false, () => false);
  const sawArtifactTemporaryFile = (async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (controller.signal.aborted) {
        return false;
      }
      const entries = await readdir(runDirectory).catch((error) =>
        error.code === "ENOENT" ? [] : Promise.reject(error)
      );
      if (entries.some((name) => name.startsWith("out.bin.bridge-tmp-"))) {
        controller.abort();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return false;
  })();
  try {
    assert.equal(await Promise.race([sawArtifactTemporaryFile, operationSettled]), true);
    await assert.rejects(
      continuation,
      (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
    );
    const entries = await readdir(runDirectory).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error)
    );
    assert.equal(entries.includes("gpt.md"), false);
    assert.equal(entries.includes("out.bin"), false);
    assert.equal(entries.some((name) => name.includes(".bridge-tmp-")), false);
    assert.deepEqual(await harness.runStore.get(queued.routerRun.id, SCOPE), before);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    controller.abort();
    await continuation.catch(() => {});
    process.off("unhandledRejection", onUnhandled);
  }
});

async function exerciseArtifactPublishAbort({
  preserveExistingText = false,
  existingText = "existing result must survive\n",
  unlinkFile,
  afterAbort
} = {}) {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Return twenty output artifacts."
    }, { waitForGpt: false })
  );
  const before = await harness.runStore.get(queued.routerRun.id, SCOPE);
  const artifacts = [];
  const artifactsById = new Map();
  for (let index = 0; index < 20; index += 1) {
    const id = `publish-output-${index + 1}`;
    const filename = `output-${String(index + 1).padStart(2, "0")}.bin`;
    const sourcePath = path.join(harness.targetRepo, `source-${filename}`);
    await writeFile(sourcePath, Buffer.alloc(1024, index + 1));
    artifacts.push({ id });
    artifactsById.set(id, {
      id,
      filename,
      filePath: sourcePath,
      contentHashSha256: `publish-hash-${index + 1}`
    });
  }
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "Twenty artifacts ready",
    artifacts,
    error: null,
    raw: null
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async (artifactId) => artifactsById.get(artifactId),
    clock: harness.clock,
    unlinkFile
  });
  const runDirectory = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id
  );
  await mkdir(runDirectory, { recursive: true });
  if (preserveExistingText) {
    await writeFile(path.join(runDirectory, "gpt.md"), existingText, "utf8");
  }

  const controller = new AbortController();
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  let markFirstFinal;
  const firstFinal = new Promise((resolve) => {
    markFirstFinal = resolve;
  });
  const directoryWatcher = watch(runDirectory, (_eventType, filename) => {
    const name = String(filename || "");
    if (name && !name.includes(".bridge-tmp-") && name !== "gpt.md") {
      markFirstFinal(name);
      controller.abort();
    }
  });
  const continuation = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  let firstFinalTimeout;

  try {
    const firstPublished = await Promise.race([
      firstFinal,
      continuation.then(() => "operation-settled", () => "operation-settled"),
      new Promise((resolve) => {
        firstFinalTimeout = setTimeout(() => resolve("timed-out"), 5_000);
      })
    ]);
    assert.match(firstPublished, /^output-\d{2}\.bin$/);
    await assert.rejects(
      continuation,
      (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
    );
    const entries = await readdir(runDirectory);
    const finalEntries = entries.filter((name) => !name.includes(".bridge-tmp-"));
    assert.deepEqual(finalEntries, preserveExistingText ? ["gpt.md"] : []);
    assert.equal(entries.some((name) => name.includes(".bridge-tmp-")), false);
    if (preserveExistingText) {
      assert.equal(await readFile(path.join(runDirectory, "gpt.md"), "utf8"), existingText);
    }
    assert.deepEqual(await harness.runStore.get(queued.routerRun.id, SCOPE), before);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    await afterAbort?.({ entries, runDirectory });
  } finally {
    clearTimeout(firstFinalTimeout);
    controller.abort();
    directoryWatcher.close();
    await continuation.catch(() => {});
    process.off("unhandledRejection", onUnhandled);
  }
}

test("router orchestrator rolls back twenty outputs when cancellation arrives during publish", async () => {
  await exerciseArtifactPublishAbort();
});

test("router orchestrator never removes a pre-existing destination while rolling back publish", async () => {
  await exerciseArtifactPublishAbort({ preserveExistingText: true });
});

test("router orchestrator never overwrites or removes a pre-existing zero-byte destination", async () => {
  await exerciseArtifactPublishAbort({ preserveExistingText: true, existingText: "" });
});

test("router orchestrator retries a transient unlink failure and still cleans every known publish path", async () => {
  const unlinkAttempts = [];
  let failFirstUnlink = true;
  await exerciseArtifactPublishAbort({
    unlinkFile: async (filePath) => {
      unlinkAttempts.push(path.resolve(filePath));
      if (failFirstUnlink) {
        failFirstUnlink = false;
        const error = new Error("transient Windows publish cleanup failure");
        error.code = "EPERM";
        throw error;
      }
      return unlink(filePath);
    },
    afterAbort: async () => {
      assert.equal(unlinkAttempts.length > 20, true);
      assert.equal(new Set(unlinkAttempts).size > 20, true);
    }
  });
});

test("router orchestrator preserves rollback diagnostics when aborted cleanup cannot remove outputs", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Return one artifact for permanent cleanup failure."
    }, { waitForGpt: false })
  );
  const sourcePath = path.join(harness.targetRepo, "permanent-cleanup-source.bin");
  await writeFile(sourcePath, "permanent cleanup source", "utf8");
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "cleanup must report failure",
    artifacts: [{ id: "permanent-cleanup-artifact" }],
    error: null,
    raw: null
  });
  const controller = new AbortController();
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async () => ({
      id: "permanent-cleanup-artifact",
      filename: "permanent-cleanup.bin",
      filePath: sourcePath
    }),
    clock: harness.clock,
    unlinkFile: async () => {
      const error = new Error("permanent rollback cleanup failure");
      error.code = "EACCES";
      throw error;
    }
  });
  const runDirectory = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id
  );
  await mkdir(runDirectory, { recursive: true });
  let markPublished;
  const published = new Promise((resolve) => {
    markPublished = resolve;
  });
  const watcher = watch(runDirectory, (_eventType, filename) => {
    const name = String(filename || "");
    if (name && !name.includes(".bridge-tmp-")) {
      markPublished(name);
      controller.abort(new Error("abort with permanent rollback failure"));
    }
  });
  const continuation = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  try {
    await Promise.race([
      published,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("no final output was published")), 1_000);
        timer.unref?.();
      })
    ]);
    await assert.rejects(continuation, (error) => {
      assert.equal(error?.code, "ABORT_ERR");
      assert.equal(Array.isArray(error?.cleanupErrors), true);
      assert.equal(error.cleanupErrors.length > 0, true);
      assert.match(error.cleanupErrors[0].message, /permanent rollback cleanup failure/);
      return true;
    });
    const entries = await readdir(runDirectory);
    assert.equal(entries.length > 0, true, "failed cleanup must not pretend the directory is clean");
  } finally {
    controller.abort();
    watcher.close();
    await continuation.catch(() => {});
  }
});

test("router orchestrator rolls back newly published finals when abort happens before the run update commits", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Return two output artifacts before the run update."
    }, { waitForGpt: false })
  );
  const before = await harness.runStore.get(queued.routerRun.id, SCOPE);
  const runDirectory = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id
  );
  await mkdir(runDirectory, { recursive: true });
  const existingText = "pre-existing text must survive\n";
  await writeFile(path.join(runDirectory, "gpt.md"), existingText, "utf8");
  const artifactsById = new Map();
  for (const [id, filename] of [["post-publish-a", "post-publish-a.bin"], ["post-publish-b", "post-publish-b.bin"]]) {
    const sourcePath = path.join(harness.targetRepo, `source-${filename}`);
    await writeFile(sourcePath, `${id}\n`, "utf8");
    artifactsById.set(id, { id, filename, filePath: sourcePath });
  }
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "published before update",
    artifacts: [{ id: "post-publish-a" }, { id: "post-publish-b" }],
    error: null,
    raw: null
  });
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: async (artifactId) => artifactsById.get(artifactId),
    clock: harness.clock
  });
  const lockPath = path.join(
    harness.storeRoot,
    "router-runs",
    `${queued.routerRun.id}.json.lock`
  );
  await writeFile(lockPath, `${process.pid}-held ${new Date().toISOString()}\n`, "utf8");
  const controller = new AbortController();
  const continuation = orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  let lockReleased = false;
  try {
    const published = await Promise.race([
      (async () => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const entries = await readdir(runDirectory);
          if (entries.includes("post-publish-a.bin") && entries.includes("post-publish-b.bin")) {
            return true;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return false;
      })(),
      continuation.then(() => false, () => false)
    ]);
    assert.equal(published, true);
    controller.abort(new Error("abort after all final renames"));
    await assert.rejects(continuation, (error) => error?.code === "ABORT_ERR");
    await unlink(lockPath);
    lockReleased = true;
    const entries = await readdir(runDirectory);
    assert.deepEqual(entries.filter((name) => !name.includes(".bridge-tmp-")).sort(), ["gpt.md"]);
    assert.equal(entries.some((name) => name.includes(".bridge-tmp-")), false);
    assert.equal(await readFile(path.join(runDirectory, "gpt.md"), "utf8"), existingText);
    assert.deepEqual(await harness.runStore.get(queued.routerRun.id, SCOPE), before);
  } finally {
    controller.abort();
    if (!lockReleased) {
      await unlink(lockPath).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await continuation.catch(() => {});
  }
});

test("router orchestrator returns succeeded when abort arrives after finalization committed", async () => {
  const harness = await createHarness();
  const queued = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Commit the final reply before abort."
    }, { waitForGpt: false })
  );
  harness.transport.wait = async (requestId) => ({
    transportId: "mock",
    requestId,
    status: "succeeded",
    replyText: "committed final reply",
    artifacts: [],
    error: null,
    raw: null
  });
  const controller = new AbortController();
  let abortedAfterCommit = false;
  const observingRunStore = {
    ...harness.runStore,
    async withFinalizationLease(runId, scope, operation, options) {
      return harness.runStore.withFinalizationLease(
        runId,
        scope,
        async (snapshot) => {
          const output = await operation(snapshot);
          const persisted = await harness.runStore.get(runId, scope);
          if (!abortedAfterCommit && persisted.status === "succeeded") {
            abortedAfterCommit = true;
            controller.abort(new Error("abort after finalization commit"));
          }
          return output;
        },
        options
      );
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore: observingRunStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock
  });

  const completed = await orchestrator.continueRouterRun({
    runId: queued.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const persisted = await harness.runStore.get(queued.routerRun.id, SCOPE);
  const textPath = path.join(
    harness.targetRepo,
    ".bridge",
    "artifacts",
    queued.routerRun.id,
    "gpt.md"
  );
  assert.equal(abortedAfterCommit, true);
  assert.equal(controller.signal.aborted, true);
  assert.equal(completed.routerRun.status, "succeeded");
  assert.equal(persisted.status, "succeeded");
  assert.equal(persisted.stages[0].replyText, "committed final reply");
  assert.equal(await readFile(textPath, "utf8"), "committed final reply\n");
});

test("router orchestrator aborts while reopen waits for its run lock", async () => {
  const harness = await createHarness({
    gpt: { status: "failed", error: "initial failure" }
  });
  const failed = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "chat_message",
      gptPayloadText: "Fail before late recovery."
    })
  );
  assert.equal(failed.routerRun.status, "failed");
  const runLockPath = path.join(
    harness.storeRoot,
    "router-runs",
    `${failed.routerRun.id}.json.lock`
  );
  await writeFile(runLockPath, "test lock\n", "utf8");
  let markWaitReturned;
  const waitReturned = new Promise((resolve) => {
    markWaitReturned = resolve;
  });
  const transport = {
    id: "mock",
    preservesConversationContext: true,
    async submitText() {
      throw new Error("must not resubmit");
    },
    async submitArtifacts() {
      throw new Error("must not resubmit");
    },
    async wait(requestId) {
      markWaitReturned();
      return {
        transportId: "mock",
        requestId,
        status: "succeeded",
        replyText: "late success",
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async cancel() {
      throw new Error("must not cancel");
    }
  };
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: { resolve: () => transport },
    clock: harness.clock
  });
  const controller = new AbortController();
  const continuePromise = orchestrator.continueRouterRun({
    runId: failed.routerRun.id,
    scope: SCOPE,
    waitForGpt: true,
    signal: controller.signal
  });
  const rejected = assert.rejects(
    continuePromise,
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR"
  );
  try {
    await waitReturned;
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    assert.equal(
      await Promise.race([
        rejected.then(() => "rejected"),
        rejectAfter(2_000, "reopen lock abort did not settle")
      ]),
      "rejected"
    );
    const persisted = await harness.runStore.get(failed.routerRun.id, SCOPE);
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.stages[0].status, "failed");
  } finally {
    await unlink(runLockPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await continuePromise.catch(() => {});
  }
});

test("router orchestrator reconciles a late successful capture without resubmitting or advancing", async () => {
  const storeRoot = await tempRoot("bridge-router-late-capture-store-");
  const targetRepo = await tempRoot("bridge-router-late-capture-project-");
  const clock = monotonicClock();
  const runStore = createRouterRunStore({
    storeRoot,
    clock,
    runIdFactory: () => "router-run-late-capture"
  });
  const submissions = [];
  const waitCounts = new Map();
  const envelope = (requestId, status, error = null, replyText = null) => ({
    transportId: "late-capture",
    requestId,
    status,
    replyText,
    artifacts: [],
    error,
    raw: null
  });
  const transport = {
    id: "late-capture",
    async submitText(input) {
      submissions.push(input);
      return envelope(input.requestId, "queued");
    },
    async submitArtifacts(input) {
      return this.submitText(input);
    },
    async wait(requestId) {
      const count = (waitCounts.get(requestId) || 0) + 1;
      waitCounts.set(requestId, count);
      if (requestId === "late-request-1" && count === 1) {
        return envelope(requestId, "failed", "等待 GPT 回复超时。");
      }
      return envelope(
        requestId,
        "succeeded",
        null,
        requestId === "late-request-1" ? "Recovered outline" : "Chapter result"
      );
    },
    async cancel(requestId) {
      return envelope(requestId, "cancelled", "cancelled");
    }
  };
  const transportRegistry = createGptTransportRegistry({
    transports: [transport],
    defaultTransportId: transport.id,
    env: {}
  });
  const orchestrator = createRouterOrchestrator({
    runStore,
    transportRegistry,
    clock,
    transportRequestIdFactory: ({ sequence }) => `late-request-${sequence}`
  });
  const route = {
    kind: "gpt_only",
    gptPayloadText: "outline",
    sequentialPlan: {
      stages: [
        { id: "outline", title: "Outline", payloadText: "outline" },
        { id: "chapter", title: "Chapter", dependsOn: "outline", instruction: "chapter" }
      ]
    }
  };
  const failed = await orchestrator.startRouterRun({
    route,
    originalRequestText: "late capture",
    workspace: workspace(targetRepo),
    scope: SCOPE,
    transportId: transport.id,
    waitForGpt: true
  });
  assert.equal(failed.routerRun.status, "failed");
  assert.equal(failed.routerRun.stages[0].status, "failed");

  const recovered = await orchestrator.continueRouterRun({
    runId: failed.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });

  assert.equal(recovered.routerRun.status, "pending");
  assert.equal(recovered.routerRun.stages[0].status, "succeeded");
  assert.equal(recovered.routerRun.stages[0].replyText, "Recovered outline");
  assert.equal(recovered.routerRun.stages[1].status, "pending");
  assert.deepEqual(submissions.map((item) => item.stageId), ["outline"]);

  const completed = await orchestrator.continueRouterRun({
    runId: failed.routerRun.id,
    scope: SCOPE,
    waitForGpt: true
  });
  assert.equal(completed.routerRun.status, "succeeded");
  assert.deepEqual(submissions.map((item) => item.stageId), ["outline", "chapter"]);
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

test("router orchestrator applies cancellation intent when a prepared submit becomes queued", async () => {
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
  try {
    await submitEntered;
    const preparedRun = (await harness.runStore.list(SCOPE))[0];
    assert.equal(preparedRun.stages[0].submissionState, "submitting");

    const uncertain = await harness.orchestrator.cancelRouterRun({
      runId: preparedRun.id,
      scope: SCOPE,
      reason: "cancel during submit"
    });
    assert.equal(uncertain.routerRun.status, "running");
    assert.equal(uncertain.routerRun.stages[0].submissionState, "submitting");
    assert.match(uncertain.routerRun.stages[0].cancelRequestedAt, /^2026-/);
    releaseSubmit();
    await Promise.race([
      cancelEntered,
      rejectAfter(1_000, "submit owner did not consume cancel intent")
    ]);
    releaseCancel();
    const cancelled = await starting;

    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
    assert.equal((await harness.runStore.get(preparedRun.id, SCOPE)).status, "cancelled");
  } finally {
    releaseSubmit();
    releaseCancel();
    await Promise.allSettled([starting]);
  }
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
  let cancelling = null;
  try {
    await submitEntered;
    const preparedRun = (await harness.runStore.list(SCOPE))[0];
    releaseSubmit();
    const queued = await starting;
    assert.equal(queued.routerRun.stages[0].submissionState, "submitted");
    interceptCancelUpdate = true;
    cancelling = cancellingOrchestrator.cancelRouterRun({
      runId: preparedRun.id,
      scope: SCOPE,
      reason: "atomic cancel after submit"
    });
    await cancelUpdateEntered;
    releaseCancelUpdate();
    const cancelled = await cancelling;

    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
    assert.equal((await harness.runStore.get(preparedRun.id, SCOPE)).status, "cancelled");
  } finally {
    releaseSubmit();
    releaseCancelUpdate();
    await Promise.allSettled([starting, cancelling].filter(Boolean));
  }
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
  let continuing = null;
  try {
    await cancelUpdateEntered;
    continuing = harness.orchestrator.continueRouterRun({
      runId: created.id,
      scope: SCOPE,
      waitForGpt: false
    });
    const queued = await continuing;
    assert.equal(queued.routerRun.status, "queued");
    releaseCancelUpdate();
    const cancelled = await cancelling;

    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.stages[0].status, "cancelled");
    assert.equal(harness.transport.submissions.length, 1);
    assert.equal((await harness.runStore.get(created.id, SCOPE)).status, "cancelled");
  } finally {
    releaseCancelUpdate();
    await Promise.allSettled([cancelling, continuing].filter(Boolean));
  }
});

test("router orchestrator keeps cancellation nonterminal until an in-flight submit settles then consumes it", async () => {
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
  let cancelling = null;
  try {
    await submitEntered;
    const preparedRun = (await harness.runStore.list(SCOPE))[0];
    const uncertain = await harness.orchestrator.cancelRouterRun({
      runId: preparedRun.id,
      scope: SCOPE,
      reason: "cancel before submit registration"
    });
    assert.equal(uncertain.routerRun.status, "running");
    assert.equal(uncertain.routerRun.stages[0].submissionState, "submitting");
    assert.match(uncertain.routerRun.stages[0].cancelRequestedAt, /^2026-/);

    releaseSubmit();
    const started = await starting;
    cancelling = harness.orchestrator.cancelRouterRun({
      runId: preparedRun.id,
      scope: SCOPE,
      reason: "cancel after successful submit"
    });
    const cancelled = await cancelling;

    assert.equal(started.routerRun.status, "cancelled");
    assert.equal(cancelled.routerRun.status, "cancelled");
    assert.equal(requests.get(preparedRun.stages[0].transportRequestId), "cancelled");
  } finally {
    releaseSubmit();
    await Promise.allSettled([starting, cancelling].filter(Boolean));
  }
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

test("router orchestrator does not repeat prior stage output for a conversation-memory transport", async () => {
  const harness = await createHarness({ chapter: { replyText: "Chapter result" } });
  const memoryTransportId = "conversation-memory";
  const memoryTransport = {
    id: memoryTransportId,
    preservesConversationContext: true,
    submissions: harness.transport.submissions,
    async submitText(input) {
      return {
        ...(await harness.transport.submitText(input)),
        transportId: memoryTransportId
      };
    },
    async submitArtifacts(input) {
      return {
        ...(await harness.transport.submitArtifacts(input)),
        transportId: memoryTransportId
      };
    },
    async wait(requestId, options) {
      return {
        ...(await harness.transport.wait(requestId, options)),
        transportId: memoryTransportId
      };
    },
    async cancel(requestId, options) {
      return {
        ...(await harness.transport.cancel(requestId, options)),
        transportId: memoryTransportId
      };
    }
  };
  harness.transportRegistry.register(memoryTransport);
  const created = await harness.runStore.create({
    ...SCOPE,
    routeKind: "gpt_only",
    transportId: memoryTransportId,
    originalRequestText: "outline then chapter",
    targetRepo: harness.targetRepo,
    chatgptProjectUrl: harness.workspace.chatgptProjectUrl,
    stages: [
      {
        id: "outline",
        title: "设计小说前3集",
        status: "succeeded",
        payloadText: "设计小说前3集。",
        replyText: "PREVIOUS OUTLINE CONTENT THAT MUST NOT BE SENT AGAIN",
        completedAt: "2026-07-10T11:00:00.000Z"
      },
      {
        id: "chapter",
        title: "撰写第一集详细内容",
        dependsOn: "outline",
        instruction: "严格承接上一阶段设定，撰写第一集详细正文。"
      }
    ]
  });

  await harness.orchestrator.continueRouterRun({
    runId: created.id,
    scope: SCOPE,
    waitForGpt: false
  });

  const payloadText = memoryTransport.submissions[0].payload.payloadText;
  assert.match(payloadText, /严格承接上一阶段设定/);
  assert.match(payloadText, /本会话/);
  assert.doesNotMatch(payloadText, /PREVIOUS OUTLINE CONTENT THAT MUST NOT BE SENT AGAIN/);
});

test("later semantic stages preserve their specific payload and instruction without repeating prior output", async () => {
  const harness = await createHarness({outline:{replyText:"PRIOR_RESULT_DO_NOT_REPEAT"},chapter:{replyText:"Chapter result"}});
  harness.transport.preservesConversationContext = true;
  const result = await harness.orchestrator.startRouterRun(startInput(harness, {
    kind:"gpt_only", syncKind:"user_request", gptPayloadText:"Create an outline.",
    sequentialPlan:{stages:[
      {id:"outline",title:"Outline",payloadText:"Create an outline."},
      {id:"chapter",title:"Chapter",dependsOn:"outline",payloadText:"只写约2000字，采用第一人称，不新增人物。",instruction:"使用简体中文。"}
    ]}
  }));
  assert.equal(result.routerRun.status,"succeeded");
  const payload = harness.transport.submissions[1].payload.payloadText;
  assert.match(payload,/只写约2000字，采用第一人称，不新增人物。/);
  assert.match(payload,/使用简体中文。/);
  assert.doesNotMatch(payload,/PRIOR_RESULT_DO_NOT_REPEAT/);
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

test("router orchestrator keeps generated stage ids image-aware and bounds poster context", async () => {
  const responses = {
    stage_1: { replyText: `OUTLINE VISUAL KEY ${"outline ".repeat(1600)}` },
    stage_2: { replyText: `CHAPTER ATMOSPHERE ${"chapter ".repeat(1600)}` }
  };
  const harness = await createHarness(responses);
  const route = {
    kind: "gpt_only",
    syncKind: "chat_message",
    gptPayloadText: "Create the novel stages.",
    sequentialPlan: {
      stages: [
        { id: "stage_1", title: "设计小说大纲", payloadText: "Design the outline." },
        {
          id: "stage_2",
          title: "撰写第一章",
          instruction: "Write the first chapter.",
          dependsOn: "stage_1"
        },
        {
          id: "stage_3",
          title: "生成小说海报",
          instruction: "生成竖版中文小说海报。",
          dependsOn: "stage_2"
        }
      ]
    }
  };

  const first = await harness.orchestrator.startRouterRun(
    startInput(harness, route, { waitForGpt: false })
  );
  await harness.orchestrator.continueRouterRun({
    runId: first.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });
  await harness.orchestrator.continueRouterRun({
    runId: first.routerRun.id,
    scope: SCOPE,
    waitForGpt: false
  });

  const posterSubmission = harness.transport.submissions[2];
  assert.equal(posterSubmission.stageId, "stage_3");
  assert.equal(posterSubmission.payload.kind, "image_request");
  assert.match(posterSubmission.payload.payloadText, /OUTLINE VISUAL KEY/);
  assert.match(posterSubmission.payload.payloadText, /CHAPTER ATMOSPHERE/);
  assert.ok(
    posterSubmission.payload.payloadText.length < 4000,
    `poster payload was ${posterSubmission.payload.payloadText.length} characters`
  );
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

test("router orchestrator applies one observation budget across every stage in a call", async () => {
  const harness = await createHarness();
  let nowMs = 1_000;
  const waits = [];
  const graceWaits = [];
  harness.transport.wait = async (requestId, waitOptions = {}) => {
    waits.push(waitOptions.timeoutMs);
    graceWaits.push(waitOptions.timeoutGraceMs);
    if (waits.length === 1) {
      nowMs += 150_000;
      return {
        transportId: "mock",
        requestId,
        status: "succeeded",
        replyText: "outline done",
        artifacts: [],
        error: null,
        raw: null
      };
    }
    return {
      transportId: "mock",
      requestId,
      status: "running",
      replyText: null,
      artifacts: [],
      error: null,
      raw: {
        observationTimedOut: true,
        stillRunning: true
      }
    };
  };
  const orchestrator = createRouterOrchestrator({
    runStore: harness.runStore,
    transportRegistry: harness.transportRegistry,
    artifactResolver: (artifactId) => getArtifact(harness.storeRoot, artifactId),
    clock: harness.clock,
    nowMs: () => nowMs,
    transportRequestIdFactory: ({ sequence }) => `budget-request-${sequence}`
  });
  const route = {
    kind: "gpt_only",
    syncKind: "chat_message",
    gptPayloadText: "Design the outline.",
    sequentialPlan: {
      stages: [
        {
          id: "outline",
          title: "Outline",
          payloadText: "Design the outline."
        },
        {
          id: "chapter",
          title: "Chapter",
          instruction: "Write the chapter.",
          dependsOn: "outline"
        }
      ]
    }
  };

  const result = await orchestrator.startRouterRun(
    startInput(harness, route, {
      waitForGpt: true,
      waitOptions: { timeoutMs: 240_000, pollMs: 1 }
    })
  );

  assert.deepEqual(waits, [240_000, 90_000]);
  assert.deepEqual(graceWaits, [0, 0]);
  assert.equal(result.routerRun.stages[0].status, "succeeded");
  assert.equal(result.routerRun.stages[1].status, "running");
  assert.deepEqual(harness.transport.submissions.map((item) => item.stageId), [
    "outline",
    "chapter"
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

test("router orchestrator rolls back and reuses deterministic artifact paths after copy-before-persist failure", async () => {
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
  const entriesAfterFailure = await readdir(runDir);
  assert.deepEqual(entriesAfterFailure, []);
  assert.equal(entriesAfterFailure.some((name) => name.includes(".bridge-tmp-")), false);

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

test("router orchestrator keeps a stage with an explicitly negated poster request as text", async () => {
  const request =
    "我想写一本小说，请先帮我设计小说的前3集。当前阶段只完成前3集设计，不要提前写第一集完整内容，也不制作海报。";
  const harness = await createHarness({
    story: { replyText: "小说前3集设计已完成。" }
  });

  const result = await harness.orchestrator.startRouterRun(
    startInput(harness, {
      kind: "gpt_only",
      syncKind: "user_request",
      gptPayloadText: request,
      sequentialPlan: {
        stages: [
          {
            id: "story",
            title: "设计小说前3集",
            payloadText: request,
            instruction: "完成小说前3集设计，不写第一集完整正文，也不制作海报。"
          }
        ]
      }
    })
  );

  assert.equal(harness.transport.submissions[0].payload.kind, "user_request");
  assert.equal(result.routerRun.status, "succeeded");
  assert.deepEqual(result.routerRun.stages[0].artifactIds, []);
  assert.equal(result.routerRun.stages[0].replyText, "小说前3集设计已完成。");
});

test("router orchestrator keeps visual story planning and poster direction as text until the real poster stage", async () => {
  const request = "我想写一本小说，你帮我设计小说的前3集，还有第一集详细的内容，再给我一张海报";
  const responses = {
    outline: { replyText: "前3集设计已经完成。" },
    episode1: { replyText: "第一集详细正文已经完成。" },
    poster_direction: { replyText: "海报视觉方向与图像生成指令已经完成。" }
  };
  const harness = await createHarness(responses);
  const posterArtifact = await saveTestPng(harness, "novel-poster.png");
  responses.poster_generation = {
    replyText: "海报已经生成。",
    artifacts: [{ id: posterArtifact.id }]
  };

  const result = await harness.orchestrator.startRouterRun(
    startInput(
      harness,
      {
        kind: "gpt_only",
        syncKind: "chat_message",
        gptPayloadText: request,
        sequentialPlan: {
          stages: [
            {
              id: "outline",
              title: "设计小说前3集",
              payloadText:
                "当前只完成第一阶段：原创设定一本适合连载、具有强钩子和戏剧冲突的中文小说，并设计前3集。用户未指定题材，请自行选择一个市场感强、视觉辨识度高的题材。不要写第一集详细正文，也不要设计或生成海报。",
              instruction: "仅完成前3集设计，不抢跑后续正文和海报。"
            },
            {
              id: "episode1",
              title: "撰写第一集详细内容",
              instruction: "基于已完成的前3集设计写第一集正文，不要开始海报。"
            },
            {
              id: "poster_direction",
              title: "设计小说海报方案",
              instruction: "给出最终海报视觉方向与准确的图像生成指令。"
            },
            {
              id: "poster_generation",
              title: "生成小说海报",
              instruction: "依据已确认的海报方向生成最终小说海报图片，并返回可用图像成品。"
            }
          ]
        }
      },
      { originalRequestText: request }
    )
  );

  assert.equal(result.routerRun.status, "succeeded");
  assert.deepEqual(
    harness.transport.submissions.map((submission) => submission.payload.kind),
    ["chat_message", "chat_message", "chat_message", "image_request"]
  );
  assert.deepEqual(
    result.routerRun.stages.map((stage) => stage.status),
    ["succeeded", "succeeded", "succeeded", "succeeded"]
  );
  assert.deepEqual(result.routerRun.stages[3].artifactIds, [posterArtifact.id]);
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
  let cancelling = null;
  try {
    await submitStarted;
    const paddedScope = Object.fromEntries(
      Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
    );
    const uncertain = await secondOrchestrator.cancelRouterRun({
      runId: `  ${created.id}  `,
      scope: paddedScope,
      reason: "concurrent cancellation"
    });
    assert.equal(uncertain.routerRun.status, "running");
    assert.equal(uncertain.routerRun.stages[0].submissionState, "submitting");
    releaseSubmit();
    await continuing;
    cancelling = secondOrchestrator.cancelRouterRun({
      runId: `  ${created.id}  `,
      scope: paddedScope,
      reason: "cancel after concurrent submit"
    });
    await cancelling;

    const persisted = await harness.runStore.get(created.id, SCOPE);
    assert.equal(persisted.status, "cancelled");
    assert.equal(persisted.stages[0].status, "cancelled");
  } finally {
    releaseSubmit();
    await Promise.allSettled([continuing, cancelling].filter(Boolean));
  }
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
  harness.transport.cancel = async () => {
    const error = new Error("prepared request is absent");
    error.code = "ENOENT";
    throw error;
  };
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
