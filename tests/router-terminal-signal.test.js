import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendChatMessage,
  listChatMessages,
  updateWorkspaceBinding
} from "../src/conversation-store.js";
import {
  __withSyncJobMessageProjectionLock,
  createHttpServer
} from "../src/http-server.js";
import { appendRoomMessage, listRoomMessages } from "../src/room-store.js";
import { createRouterRunStore } from "../src/router-run-store.js";
import {
  completeSyncJob,
  createSyncJob,
  failSyncJob,
  getSyncJob,
  listSyncJobs,
  markSyncJobTerminalMessageProjected,
  withSyncJobRouterTerminalReconciliationLease
} from "../src/sync-store.js";

async function tempStore(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function withServer(options, operation) {
  const server = createHttpServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await operation(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

async function bounded(promise, label, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withProjectionBarrier(lockKey, operation) {
  let releaseLock;
  let markEntered;
  let released = false;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const releaseGate = new Promise((resolve) => {
    releaseLock = resolve;
  });
  const held = __withSyncJobMessageProjectionLock(lockKey, async () => {
    markEntered();
    await releaseGate;
  });
  const pending = new Set();
  const track = (promise) => {
    const tracked = Promise.resolve(promise);
    void tracked.catch(() => {});
    pending.add(tracked);
    return tracked;
  };
  const releaseAndWait = async () => {
    if (!released) {
      released = true;
      releaseLock();
    }
    await bounded(held, "projection barrier release");
  };
  try {
    await bounded(entered, "projection barrier entry");
    return await operation({ releaseAndWait, track });
  } finally {
    await releaseAndWait();
    if (pending.size > 0) {
      await bounded(Promise.allSettled([...pending]), "projection barrier requests settle");
    }
  }
}

test("terminal message projection mutex serializes a key and releases it after errors", async () => {
  const entered = [];
  let releaseFirst;
  const firstBarrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = __withSyncJobMessageProjectionLock("terminal-mutex-job", async () => {
    entered.push("first");
    await firstBarrier;
    throw new Error("controlled projection failure");
  });
  const firstRejected = assert.rejects(first, /controlled projection failure/);
  await waitFor(() => entered.length === 1);

  const second = __withSyncJobMessageProjectionLock("terminal-mutex-job", async () => {
    entered.push("second");
    return "second completed";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(entered, ["first"]);

  releaseFirst();
  await firstRejected;
  assert.equal(await second, "second completed");
  assert.deepEqual(entered, ["first", "second"]);
});

test("claim schedules slow Router reconciliation without delaying the extension response", async () => {
  const storeRoot = await tempStore("bridge-router-async-claim-store-");
  const targetRepo = await tempStore("bridge-router-async-claim-project-");
  const projectUrl = "https://chatgpt.com/c/router-async-claim";
  let releaseLookup;
  let markLookupEntered;
  const lookupEntered = new Promise((resolve) => {
    markLookupEntered = resolve;
  });
  const lookupBarrier = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_async_claim",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-async-claim-conversation",
    projectId: "router-async-claim-project",
    codexThreadId: "router-async-claim-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-async-claim",
    payloadText: "claim must not wait for Router reconciliation"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });

  await withServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-async-claim-thread",
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        markLookupEntered();
        await lookupBarrier;
        return null;
      }
    }
  }, async (baseUrl) => {
    const responsePromise = postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-async-claim-worker"
    });
    void responsePromise.catch(() => {});
    try {
      const [, response] = await bounded(
        Promise.all([lookupEntered, responsePromise]),
        "claim response while Router reconciliation is blocked",
        2_000
      );
      assert.equal(response.status, 200);
    } finally {
      releaseLookup();
      await bounded(
        Promise.allSettled([responsePromise]),
        "claim response cleanup"
      );
    }
    await waitFor(async () =>
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationFailureKind === "run_missing"
    );
  });
});

test("server close drains one deduplicated background Router reconciliation", async () => {
  const storeRoot = await tempStore("bridge-router-close-drain-store-");
  const targetRepo = await tempStore("bridge-router-close-drain-project-");
  const projectUrl = "https://chatgpt.com/c/router-close-drain";
  let releaseLookup;
  let markLookupEntered;
  let exactLookups = 0;
  const lookupEntered = new Promise((resolve) => {
    markLookupEntered = resolve;
  });
  const lookupBarrier = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_close_drain",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-close-drain-conversation",
    projectId: "router-close-drain-project",
    codexThreadId: "router-close-drain-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-close-drain",
    payloadText: "close must drain this background reconciliation"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });

  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-close-drain-thread",
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        exactLookups += 1;
        markLookupEntered();
        await lookupBarrier;
        return null;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  let closePromise = null;
  try {
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        postJson(`${baseUrl}/api/sync/jobs/claim`, {
          projectUrl,
          workerId: `router-close-drain-worker-${index}`
        })
      )
    );
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
    await lookupEntered;

    closePromise = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    const closeState = await Promise.race([
      closePromise.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 40))
    ]);
    assert.equal(closeState, "waiting");
    assert.equal(exactLookups, 1);

    releaseLookup();
    await closePromise;
    const persisted = await getSyncJob(storeRoot, job.id);
    assert.equal(persisted.routerTerminalReconciliationErrorCount, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationErrorCount,
      1
    );
  } finally {
    releaseLookup();
    if (closePromise) {
      await closePromise.catch(() => {});
    } else {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("a retry pulse received during single-flight reconciliation is replayed after it settles", async () => {
  const storeRoot = await tempStore("bridge-router-single-flight-replay-store-");
  const targetRepo = await tempStore("bridge-router-single-flight-replay-project-");
  const projectUrl = "https://chatgpt.com/c/router-single-flight-replay";
  let retryNow = new Date("2026-08-02T00:00:00.000Z");
  let exactLookups = 0;
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_single_flight_replay",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-single-flight-replay-conversation",
    projectId: "router-single-flight-replay-project",
    codexThreadId: "router-single-flight-replay-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-single-flight-replay",
    payloadText: "The second retry pulse must not be swallowed."
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const jobLockPath = `${jobPath}.lock`;
  await writeFile(jobLockPath, "test lock\n", "utf8");
  let fixtureLockHeld = true;
  async function releaseFixtureLock() {
    const deadline = Date.now() + 2000;
    while (fixtureLockHeld) {
      try {
        await unlink(jobLockPath);
        fixtureLockHeld = false;
      } catch (error) {
        if (error.code === "ENOENT") {
          fixtureLockHeld = false;
        } else if (process.platform === "win32" &&
                   ["EPERM", "EBUSY", "EACCES"].includes(error.code) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 20));
        } else {
          throw error;
        }
      }
    }
  }

  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-single-flight-replay-thread",
    routerTerminalReconciliationBaseDelayMs: 100,
    routerTerminalReconciliationClock: () => retryNow,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        exactLookups += 1;
        throw new Error("controlled reconciliation failure");
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const claimUrl = `http://127.0.0.1:${port}/api/sync/jobs/claim`;
  try {
    const firstResponse = await postJson(claimUrl, {
      projectUrl,
      workerId: "router-single-flight-replay-worker-1"
    });
    assert.equal(firstResponse.status, 200);
    await waitFor(() => exactLookups === 1);

    retryNow = new Date("2026-08-02T00:00:00.101Z");
    const secondResponse = await postJson(claimUrl, {
      projectUrl,
      workerId: "router-single-flight-replay-worker-2"
    });
    assert.equal(secondResponse.status, 200);

    await releaseFixtureLock();
    await waitFor(() => exactLookups === 2);
    const persisted = await waitFor(async () => {
      const current = await getSyncJob(storeRoot, job.id);
      return current.routerTerminalReconciliationErrorCount === 2 ? current : null;
    }, 15_000);
    assert.equal(persisted.routerTerminalReconciliationErrorCount, 2);
  } finally {
    try {
      await releaseFixtureLock();
    } finally {
      await server.close();
    }
  }
});

test("server close times out a hung reconciliation and forbids its late write", async () => {
  const storeRoot = await tempStore("bridge-router-close-timeout-store-");
  const targetRepo = await tempStore("bridge-router-close-timeout-project-");
  const projectUrl = "https://chatgpt.com/c/router-close-timeout";
  let releaseLookup;
  let markLookupEntered;
  const lookupEntered = new Promise((resolve) => {
    markLookupEntered = resolve;
  });
  const lookupBarrier = new Promise((resolve) => {
    releaseLookup = resolve;
  });
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_close_timeout",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-close-timeout-conversation",
    projectId: "router-close-timeout-project",
    codexThreadId: "router-close-timeout-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-close-timeout",
    payloadText: "close must not hang on this reconciliation"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-close-timeout-thread",
    routerTerminalBackgroundDrainTimeoutMs: 50,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        markLookupEntered();
        await lookupBarrier;
        return null;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let closePromise;
  try {
    const response = await postJson(`http://127.0.0.1:${port}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-close-timeout-worker"
    });
    assert.equal(response.status, 200);
    await lookupEntered;
    closePromise = server.close();
    const closeState = await Promise.race([
      closePromise.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 250))
    ]);
    assert.equal(closeState, "closed");
    assert.equal((await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationErrorCount, 0);

    releaseLookup();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const persisted = await getSyncJob(storeRoot, job.id);
    assert.equal(persisted.routerTerminalReconciliationErrorCount, 0);
    assert.equal(persisted.routerTerminalSignalPending, true);
  } finally {
    releaseLookup();
    await closePromise?.catch(() => {});
  }
});

test("server close waits for a terminal reconciliation write that started before timeout", async () => {
  const storeRoot = await tempStore("bridge-router-close-write-gate-store-");
  const targetRepo = await tempStore("bridge-router-close-write-gate-project-");
  const projectUrl = "https://chatgpt.com/c/router-close-write-gate";
  let exactLookups = 0;
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_close_write_gate",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-close-write-gate-conversation",
    projectId: "router-close-write-gate-project",
    codexThreadId: "router-close-write-gate-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-close-write-gate",
    payloadText: "Close must wait for an already-started acknowledgement write."
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const jobLockPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json.lock`);
  await writeFile(jobLockPath, "test lock\n", "utf8");

  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-close-write-gate-thread",
    routerTerminalBackgroundDrainTimeoutMs: 40,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        exactLookups += 1;
        return null;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let closePromise;
  try {
    const response = await postJson(`http://127.0.0.1:${port}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-close-write-gate-worker"
    });
    assert.equal(response.status, 200);
    await waitFor(() => exactLookups === 1);
    await new Promise((resolve) => setImmediate(resolve));

    closePromise = server.close();
    const closeState = await Promise.race([
      closePromise.then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("waiting"), 100))
    ]);
    assert.equal(closeState, "waiting");

    await unlink(jobLockPath);
    await closePromise;
    assert.equal(
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationErrorCount,
      1
    );
  } finally {
    await unlink(jobLockPath).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
    await closePromise?.catch(() => {});
  }
});

test("close timeout cooperatively aborts an in-flight Router continuation and releases its lease", async () => {
  const storeRoot = await tempStore("bridge-router-close-abort-store-");
  const targetRepo = await tempStore("bridge-router-close-abort-project-");
  const currentCodexThreadId = "router-close-abort-thread";
  const projectUrl = "https://chatgpt.com/c/router-close-abort";
  let binding;
  let delegated;

  await withServer({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId,
    routerV2Enabled: true
  }, async (baseUrl) => {
    const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
      name: "Router close abort project",
      chatgptProjectUrl: projectUrl,
      targetRepo
    });
    binding = await bindingResponse.json();
    const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
      projectId: binding.project.id,
      conversationId: binding.project.conversationId,
      text:
        "先设计前3集大纲，" +
        "再写第一集详细正文，" +
        "最后生成小说海报。",
      waitForGpt: true,
      timeoutMs: 5,
      pollMs: 1,
      failOnTimeout: false
    });
    assert.equal(delegateResponse.status, 201);
    delegated = await delegateResponse.json();
  });

  const runStore = createRouterRunStore({ storeRoot });
  const scope = {
    projectId: binding.project.id,
    conversationId: binding.project.conversationId,
    codexThreadId: currentCodexThreadId
  };
  const firstRequestId = delegated.routerRun.stages[0].transportRequestId;
  await completeSyncJob(storeRoot, firstRequestId, {
    replyText: "First stage completed before reconciliation."
  });

  let releaseBlockedWait;
  let markWaitEntered;
  const waitEntered = new Promise((resolve) => {
    markWaitEntered = resolve;
  });
  const blockedWait = new Promise((resolve) => {
    releaseBlockedWait = resolve;
  });
  let oldTransportSubmits = 0;
  const blockingTransport = {
    id: "web-sync",
    preservesConversationContext: true,
    async submitText() {
      oldTransportSubmits += 1;
      throw new Error("aborted server must not submit the next stage");
    },
    async submitArtifacts() {
      oldTransportSubmits += 1;
      throw new Error("aborted server must not submit the next stage");
    },
    async wait(requestId) {
      markWaitEntered();
      await blockedWait;
      return {
        transportId: "web-sync",
        requestId,
        status: "succeeded",
        replyText: "late result from the stopped server",
        artifacts: [],
        error: null,
        raw: null
      };
    },
    async cancel(requestId) {
      return {
        transportId: "web-sync",
        requestId,
        status: "cancelled",
        replyText: null,
        artifacts: [],
        error: null,
        raw: null
      };
    }
  };
  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId,
    routerV2Enabled: true,
    routerTerminalBackgroundDrainTimeoutMs: 50,
    gptTransportRegistry: {
      resolve() {
        return blockingTransport;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  let recoveryServer;
  try {
    const claimResponse = await postJson(
      `http://127.0.0.1:${port}/api/sync/jobs/claim`,
      { projectUrl, workerId: "router-close-abort-worker-old" }
    );
    assert.equal(claimResponse.status, 200);
    await waitEntered;
    await server.close();

    const afterClose = await runStore.get(delegated.routerRun.id, scope);
    assert.equal(afterClose.stages[0].status, "queued");
    assert.equal(afterClose.stages[1].status, "pending");
    assert.equal(oldTransportSubmits, 0);
    assert.equal((await listSyncJobs(storeRoot)).length, 1);
    assert.equal((await getSyncJob(storeRoot, firstRequestId)).routerTerminalSignalPending, true);

    recoveryServer = createHttpServer({
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    });
    await new Promise((resolve) => recoveryServer.listen(0, "127.0.0.1", resolve));
    const recoveryPort = recoveryServer.address().port;
    const recoveryClaim = await postJson(
      `http://127.0.0.1:${recoveryPort}/api/sync/jobs/claim`,
      { projectUrl, workerId: "router-close-abort-worker-new" }
    );
    assert.equal(recoveryClaim.status, 200);
    const recovered = await waitFor(async () => {
      const current = await runStore.get(delegated.routerRun.id, scope);
      return current.stages[0].status === "succeeded" && current.stages[1].status === "queued"
        ? current
        : null;
    }, 1_000);
    assert.equal(recovered.stages[2].status, "pending");
    await waitFor(async () =>
      (await getSyncJob(storeRoot, firstRequestId)).routerTerminalSignalPending === false
    );

    releaseBlockedWait();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(oldTransportSubmits, 0);
    assert.equal((await listSyncJobs(storeRoot)).length, 2);
  } finally {
    releaseBlockedWait();
    await server.close().catch(() => {});
    if (recoveryServer) {
      await recoveryServer.close().catch(() => {});
    }
  }
});

test("server close aborts reconciliation queued on the persisted lease without a late lookup", async () => {
  const storeRoot = await tempStore("bridge-router-close-queued-lease-store-");
  const targetRepo = await tempStore("bridge-router-close-queued-lease-project-");
  const projectUrl = "https://chatgpt.com/c/router-close-queued-lease";
  const conversationId = "router-close-queued-lease-conversation";
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_close_queued_lease",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId,
    projectId: "router-close-queued-lease-project",
    codexThreadId: "router-close-queued-lease-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-close-queued-lease",
    payloadText: "close must abort the queued reconciliation lease"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: projectUrl,
    targetRepo,
    conversationId
  });

  let releaseHeldLease;
  let markHeldLeaseEntered;
  const heldLeaseEntered = new Promise((resolve) => {
    markHeldLeaseEntered = resolve;
  });
  const heldLeaseBarrier = new Promise((resolve) => {
    releaseHeldLease = resolve;
  });
  const heldLease = withSyncJobRouterTerminalReconciliationLease(
    storeRoot,
    job.id,
    async () => {
      markHeldLeaseEntered();
      await heldLeaseBarrier;
    }
  );
  await heldLeaseEntered;
  let lateLookupCount = 0;
  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-close-queued-lease-thread",
    routerTerminalBackgroundDrainTimeoutMs: 20,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        lateLookupCount += 1;
        return null;
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const claim = await postJson(`http://127.0.0.1:${port}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-close-queued-lease-worker"
    });
    assert.equal(claim.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await server.close();
    releaseHeldLease();
    await heldLease;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(lateLookupCount, 0);
  } finally {
    releaseHeldLease();
    await heldLease.catch(() => {});
    await server.close().catch(() => {});
  }
});

test("server rejects invalid background reconciliation drain timeouts", () => {
  for (const timeoutMs of [0, -1, 60_001, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createHttpServer({
        storeRoot: path.join(tmpdir(), "bridge-invalid-drain-timeout"),
        routerTerminalBackgroundDrainTimeoutMs: timeoutMs
      }),
      /background.*drain.*timeout.*1.*60000/i
    );
  }
});

for (const transition of ["complete", "fail", "cancel"]) {
  test(`${transition} schedules slow Router reconciliation after responding`, async () => {
    const storeRoot = await tempStore(`bridge-router-async-${transition}-store-`);
    const targetRepo = await tempStore(`bridge-router-async-${transition}-project-`);
    const projectUrl = `https://chatgpt.com/c/router-async-${transition}`;
    const conversationId = `router-async-${transition}-conversation`;
    await updateWorkspaceBinding(storeRoot, {
      chatgptProjectUrl: projectUrl,
      targetRepo,
      conversationId
    });
    let releaseLookup;
    let markLookupEntered;
    const lookupEntered = new Promise((resolve) => {
      markLookupEntered = resolve;
    });
    const lookupBarrier = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    const job = await createSyncJob(storeRoot, {
      id: `sync_router_async_${transition}`,
      kind: "preference_sync",
      projectUrl,
      targetRepo,
      conversationId,
      projectId: `router-async-${transition}-project`,
      codexThreadId: `router-async-${transition}-thread`,
      routerTerminalSignalRequired: true,
      routerRunId: `router-run-async-${transition}`,
      payloadText: `${transition} must not wait for Router reconciliation`
    });
    const unhandled = [];
    const onUnhandled = (error) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      await withServer({
        storeRoot,
        runnerMode: "manual",
        routerV2Enabled: true,
        currentCodexThreadId: `router-async-${transition}-thread`,
        routerRunStore: {
          async findByRunIdAndTransportRequestId() {
            markLookupEntered();
            await lookupBarrier;
            return null;
          }
        }
      }, async (baseUrl) => {
        const body = transition === "complete"
          ? { replyText: "terminal" }
          : transition === "fail"
            ? { error: "controlled failure", errorCode: "controlled_failure" }
            : {};
        const responsePromise = postJson(
          `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/${transition}`,
          body
        );
        let responseDeadline;
        const blocked = new Promise((resolve) => {
          responseDeadline = setTimeout(() => resolve("blocked"), 1_000);
        });
        const outcome = await Promise.race([
          Promise.all([lookupEntered, responsePromise]).then(() => "responded"),
          blocked
        ]);
        clearTimeout(responseDeadline);
        releaseLookup();
        const response = await responsePromise;
        assert.equal(outcome, "responded");
        assert.equal(response.status, 200);
        await waitFor(async () =>
          (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationFailureKind === "run_missing"
        );
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
}

test("extension completion reconciles the exact Router run and queues only its next stage", async () => {
  const storeRoot = await tempStore("bridge-router-signal-store-");
  const targetRepo = await tempStore("bridge-router-signal-project-");
  const currentCodexThreadId = "router-signal-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-signal-conversation";

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router signal project",
        chatgptProjectUrl,
        targetRepo
      });
      assert.equal(bindingResponse.status, 201);
      const binding = await bindingResponse.json();

      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u6211\u8981\u5199\u4e00\u672c\u7384\u5e7b\u5c0f\u8bf4\u3002" +
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: true,
        timeoutMs: 5,
        pollMs: 1,
        failOnTimeout: false
      });
      assert.equal(delegateResponse.status, 201);
      const delegated = await delegateResponse.json();
      assert.deepEqual(
        delegated.routerRun.stages.map((stage) => stage.id),
        ["outline", "chapter", "poster"]
      );

      const firstRequestId = delegated.routerRun.stages[0].transportRequestId;
      const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl: chatgptProjectUrl,
        workerId: "router-signal-test-worker"
      });
      assert.equal(claimResponse.status, 200);
      assert.equal((await claimResponse.json()).job.id, firstRequestId);

      const completeResponse = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/complete`,
        {
          replyText: "\u7b2c\u4e00\u9636\u6bb5\u5927\u7eb2\u5df2\u5b8c\u6210\u3002"
        }
      );
      assert.equal(completeResponse.status, 200);

      const runStore = createRouterRunStore({ storeRoot });
      const scope = {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        codexThreadId: currentCodexThreadId
      };
      const persisted = await waitFor(async () => {
        const current = await runStore.get(delegated.routerRun.id, scope);
        return current.stages[0].status === "succeeded" &&
          current.stages[1].status === "queued"
          ? current
          : null;
      });
      assert.equal(persisted.stages[0].status, "succeeded");
      assert.equal(persisted.stages[0].replyText, "\u7b2c\u4e00\u9636\u6bb5\u5927\u7eb2\u5df2\u5b8c\u6210\u3002");
      assert.equal(persisted.stages[1].status, "queued");
      assert.equal(persisted.stages[2].status, "pending");

      const jobs = await listSyncJobs(storeRoot);
      assert.equal(jobs.length, 2);
      assert.equal(jobs[0].id, persisted.stages[1].transportRequestId);
      assert.match(jobs[0].payloadText, /\u53ea\u5b8c\u6210\u5f53\u524d\u9636\u6bb5/);
      assert.doesNotMatch(
        jobs[0].payloadText,
        /\u7b2c\u4e00\u9636\u6bb5\u5927\u7eb2\u5df2\u5b8c\u6210/
      );

      const secondRequestId = persisted.stages[1].transportRequestId;
      const secondCompleteResponse = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(secondRequestId)}/complete`,
        {
          replyText: "\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\u5df2\u5b8c\u6210\u3002"
        }
      );
      assert.equal(secondCompleteResponse.status, 200);

      const posterReady = await waitFor(async () => {
        const current = await runStore.get(delegated.routerRun.id, scope);
        return current.stages[1].status === "succeeded" &&
          current.stages[2].status === "queued"
          ? current
          : null;
      });
      assert.equal((await listSyncJobs(storeRoot)).length, 3);

      const posterRequestId = posterReady.stages[2].transportRequestId;
      const posterCompleteResponse = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(posterRequestId)}/complete`,
        {
          replyText: "\u5c0f\u8bf4\u6d77\u62a5\u5df2\u751f\u6210\u3002",
          artifacts: [
            {
              filename: "router-signal-poster.png",
              contentType: "image/png",
              base64Data: Buffer.from("router signal poster").toString("base64")
            }
          ]
        }
      );
      assert.equal(posterCompleteResponse.status, 200);

      const completedRun = await waitFor(async () => {
        const current = await runStore.get(delegated.routerRun.id, scope);
        return current.status === "succeeded" ? current : null;
      });
      assert.deepEqual(
        completedRun.stages.map((stage) => stage.status),
        ["succeeded", "succeeded", "succeeded"]
      );
      assert.equal((await listSyncJobs(storeRoot)).length, 3);
    }
  );
});

test("extension completion settles the manual Router stage without queuing the next stage", async () => {
  const storeRoot = await tempStore("bridge-router-manual-store-");
  const targetRepo = await tempStore("bridge-router-manual-project-");
  const currentCodexThreadId = "router-manual-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-manual-conversation";

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router manual project",
        chatgptProjectUrl,
        targetRepo
      });
      const binding = await bindingResponse.json();
      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: false
      });
      const delegated = await delegateResponse.json();
      const firstRequestId = delegated.routerRun.stages[0].transportRequestId;

      const completeResponse = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/complete`,
        {
          replyText: "\u624b\u52a8\u6a21\u5f0f\u5927\u7eb2\u5df2\u5b8c\u6210\u3002"
        }
      );
      assert.equal(completeResponse.status, 200);
      const runStore = createRouterRunStore({ storeRoot });
      const persisted = await waitFor(async () => {
        const run = await runStore.get(delegated.routerRun.id, {
          projectId: binding.project.id,
          conversationId: binding.project.conversationId,
          codexThreadId: currentCodexThreadId
        });
        return run.stages[0].status === "succeeded" ? run : null;
      });
      assert.equal(persisted.autoAdvanceOnTransportTerminal, false);
      assert.equal(persisted.stages[0].status, "succeeded");
      assert.equal(persisted.stages[0].replyText, "手动模式大纲已完成。");
      assert.equal(persisted.stages[1].status, "pending");
      assert.equal((await listSyncJobs(storeRoot)).length, 1);
    }
  );
});

test("a completed manual final image stage closes the run and materializes only its artifact", async () => {
  const storeRoot = await tempStore("bridge-router-manual-final-image-store-");
  const targetRepo = await tempStore("bridge-router-manual-final-image-project-");
  const projectId = "router-manual-final-image-project";
  const conversationId = "router-manual-final-image-conversation";
  const codexThreadId = "router-manual-final-image-thread";
  const routerRunId = "router-run-manual-final-image";
  const requestId = "sync_router_manual_final_image";
  const projectUrl = "https://chatgpt.com/c/router-manual-final-image";
  const runStore = createRouterRunStore({ storeRoot });

  await runStore.create({
    id: routerRunId,
    projectId,
    conversationId,
    codexThreadId,
    routeKind: "gpt_only",
    transportId: "web-sync",
    originalRequestText: "Generate exactly one final poster.",
    targetRepo,
    chatgptProjectUrl: projectUrl,
    autoAdvanceOnTransportTerminal: false,
    status: "queued",
    stages: [{
      id: "poster",
      title: "Poster",
      status: "queued",
      payloadText: "Generate exactly one final poster.",
      transportRequestId: requestId,
      submissionState: "submitted"
    }]
  });
  await createSyncJob(storeRoot, {
    id: requestId,
    kind: "image_request",
    projectUrl,
    targetRepo,
    projectId,
    conversationId,
    codexThreadId,
    routerRunId,
    routerTerminalSignalRequired: true,
    payloadText: "Generate exactly one final poster."
  });

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: codexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const response = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(requestId)}/complete`,
        {
          replyText: "Final poster generated.",
          artifacts: [{
            filename: "final-poster.png",
            contentType: "image/png",
            base64Data: Buffer.from("one final poster").toString("base64")
          }]
        }
      );
      assert.equal(response.status, 200);

      const scope = { projectId, conversationId, codexThreadId };
      const completed = await waitFor(async () => {
        const current = await runStore.get(routerRunId, scope);
        return current.status === "succeeded" ? current : null;
      });
      assert.equal(completed.stages[0].status, "succeeded");
      assert.equal(completed.stages[0].artifactIds.length, 1);
      const imagePaths = completed.projectArtifactPaths.filter((item) => item.endsWith(".png"));
      assert.equal(imagePaths.length, 1);
      assert.equal(await readFile(imagePaths[0], "utf8"), "one final poster");

      const reconciled = await waitFor(async () => {
        const current = await getSyncJob(storeRoot, requestId);
        return current.routerTerminalSignalPending === false ? current : null;
      });
      assert.ok(reconciled.routerTerminalReconciledAt);
    }
  );
});

test("the first claim after a service restart reconciles a persisted terminal Router stage", async () => {
  const storeRoot = await tempStore("bridge-router-restart-store-");
  const targetRepo = await tempStore("bridge-router-restart-project-");
  const currentCodexThreadId = "router-restart-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-restart-conversation";
  let binding;
  let delegated;

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router restart project",
        chatgptProjectUrl,
        targetRepo
      });
      binding = await bindingResponse.json();
      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: true,
        timeoutMs: 5,
        pollMs: 1,
        failOnTimeout: false
      });
      delegated = await delegateResponse.json();
    }
  );

  const firstRequestId = delegated.routerRun.stages[0].transportRequestId;
  await completeSyncJob(storeRoot, firstRequestId, {
    replyText: "\u91cd\u542f\u524d\u5df2\u7ecf\u5b8c\u6574\u843d\u76d8\u7684\u7b2c\u4e00\u9636\u6bb5\u7ed3\u679c\u3002"
  });

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl: chatgptProjectUrl,
        workerId: "router-restart-test-worker"
      });
      assert.equal(claimResponse.status, 200);
      const claim = await claimResponse.json();

      const runStore = createRouterRunStore({ storeRoot });
      const scope = {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        codexThreadId: currentCodexThreadId
      };
      const recovered = await waitFor(async () => {
        const current = await runStore.get(delegated.routerRun.id, scope);
        return current.stages[1].status === "queued" ? current : null;
      });
      assert.equal(recovered.stages[0].status, "succeeded");
      assert.equal(recovered.stages[1].status, "queued");
      assert.equal(recovered.stages[2].status, "pending");
      assert.equal(recovered.stages[2].transportRequestId, null);
      // Reconciliation runs in the background. It may finish before the first
      // claim's disk read, so validate its identity rather than scheduler order.
      const nextClaim = claim.job ? claim : await (await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl: chatgptProjectUrl,
        workerId: "router-restart-test-worker"
      })).json();
      assert.equal(nextClaim.job.id, recovered.stages[1].transportRequestId);
      assert.equal(nextClaim.job.status, "running");
      assert.equal(nextClaim.job.routerRunId, delegated.routerRun.id);
      assert.equal(nextClaim.job.conversationId, scope.conversationId);
      assert.equal(nextClaim.job.codexThreadId, currentCodexThreadId);
    }
  );
});

test("terminal replay keeps Router acknowledgement pending when no matching run exists", async () => {
  const storeRoot = await tempStore("bridge-router-missing-run-store-");
  const targetRepo = await tempStore("bridge-router-missing-run-project-");
  const conversationId = "router-missing-run-conversation";
  const projectUrl = "https://chatgpt.com/c/router-missing-run-conversation";
  let retryNow = new Date("2026-08-02T00:00:00.000Z");
  const job = await createSyncJob(storeRoot, {
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId,
    projectId: "router-missing-run-project",
    codexThreadId: "router-missing-run-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-created-after-terminal",
    payloadText: "Persist this terminal signal until its Router run exists."
  });
  await completeSyncJob(storeRoot, job.id, {
    replyText: "Preference synchronization completed."
  });
  const terminal = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(terminal.routerTerminalSignalRequired, true);
  assert.equal(terminal.routerRunId, "router-run-created-after-terminal");
  assert.equal(terminal.projectId, "router-missing-run-project");
  assert.equal(terminal.codexThreadId, "router-missing-run-thread");

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "router-missing-run-thread",
      routerV2Enabled: true,
      routerTerminalReconciliationBaseDelayMs: 100,
      routerTerminalReconciliationMaxAttempts: 1,
      routerTerminalReconciliationClock: () => retryNow
    },
    async (baseUrl) => {
      const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: "router-missing-run-worker"
      });
      assert.equal(claimResponse.status, 200);
      assert.equal((await claimResponse.json()).job, null);
    }
  );

  const persisted = await waitFor(async () => {
    const current = (await listSyncJobs(storeRoot)).find(
      (candidate) => candidate.id === job.id
    );
    return current?.routerTerminalReconciliationErrorCount === 1 ? current : null;
  });
  assert.equal(persisted.routerTerminalSignalPending, true);
  assert.equal(persisted.routerTerminalReconciledAt, null);
  assert.equal(persisted.routerTerminalReconciliationErrorCount, 1);
  assert.equal(persisted.routerTerminalReconciliationQuarantinedAt, null);
  assert.equal(
    persisted.routerTerminalReconciliationNextAttemptAt,
    "2026-08-02T00:00:00.100Z"
  );

  const legacyQuarantinedPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const legacyQuarantined = JSON.parse(await readFile(legacyQuarantinedPath, "utf8"));
  legacyQuarantined.routerTerminalReconciliationLastError = "router_run_not_found";
  delete legacyQuarantined.routerTerminalReconciliationFailureKind;
  legacyQuarantined.routerTerminalReconciliationNextAttemptAt = null;
  legacyQuarantined.routerTerminalReconciliationQuarantinedAt =
    "2026-08-02T00:00:00.050Z";
  await writeFile(
    legacyQuarantinedPath,
    `${JSON.stringify(legacyQuarantined, null, 2)}\n`,
    "utf8"
  );

  retryNow = new Date("2026-08-02T00:00:00.101Z");

  const runStore = createRouterRunStore({ storeRoot });
  await runStore.create({
    id: "router-run-created-after-terminal",
    projectId: "router-missing-run-project",
    conversationId,
    codexThreadId: "router-missing-run-thread",
    routeKind: "gpt_only",
    transportId: "web-sync",
    originalRequestText: job.payloadText,
    targetRepo,
    chatgptProjectUrl: projectUrl,
    autoAdvanceOnTransportTerminal: false,
    stages: [
      {
        id: "gpt",
        title: "GPT",
        status: "queued",
        payloadText: job.payloadText,
        transportRequestId: job.id,
        submissionState: "submitted"
      }
    ]
  });

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "router-missing-run-thread",
      routerV2Enabled: true,
      routerTerminalReconciliationBaseDelayMs: 100,
      routerTerminalReconciliationMaxAttempts: 1,
      routerTerminalReconciliationClock: () => retryNow
    },
    async (baseUrl) => {
      const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: "router-late-run-worker"
      });
      assert.equal(claimResponse.status, 200);
      assert.equal((await claimResponse.json()).job, null);
    }
  );

  const acknowledged = await waitFor(async () => {
    const current = (await listSyncJobs(storeRoot)).find(
      (candidate) => candidate.id === job.id
    );
    return current?.routerTerminalSignalPending === false ? current : null;
  });
  assert.equal(acknowledged.routerTerminalSignalPending, false);
  assert.ok(acknowledged.routerTerminalReconciledAt);
});

test("Router terminal reconciliation failures back off and quarantine without acknowledging", async () => {
  const storeRoot = await tempStore("bridge-router-terminal-quarantine-store-");
  const targetRepo = await tempStore("bridge-router-terminal-quarantine-project-");
  const conversationId = "router-terminal-quarantine-conversation";
  const projectUrl = "https://chatgpt.com/c/router-terminal-quarantine";
  const job = await createSyncJob(storeRoot, {
    id: "sync_terminal_quarantine",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId,
    projectId: "router-terminal-quarantine-project",
    codexThreadId: "router-terminal-quarantine-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-terminal-quarantine",
    payloadText: "Persist reconciliation failures without acknowledging the Router terminal."
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "Terminal result" });
  let exactLookups = 0;
  let fallbackLookups = 0;
  let retryNow = new Date("2026-08-02T01:00:00.000Z");

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      routerV2Enabled: true,
      currentCodexThreadId: "router-terminal-quarantine-thread",
      routerTerminalReconciliationBaseDelayMs: 100,
      routerTerminalReconciliationMaxAttempts: 2,
      routerTerminalReconciliationClock: () => retryNow,
      routerRunStore: {
        async findByRunIdAndTransportRequestId() {
          exactLookups += 1;
          throw new Error("controlled Router reconciliation failure");
        },
        async findByTransportRequestId() {
          fallbackLookups += 1;
          throw new Error("new Router jobs must not scan all runs");
        }
      }
    },
    async (baseUrl) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
          projectUrl,
          workerId: `router-terminal-quarantine-worker-${attempt}`
        });
        assert.equal(claimResponse.status, 200);
        await waitFor(
          async () =>
            (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationErrorCount ===
            attempt + 1,
          15_000
        );
        retryNow = new Date(retryNow.getTime() + 101);
      }
    }
  );

  const persisted = await waitFor(async () => {
    const current = await getSyncJob(storeRoot, job.id);
    return current.routerTerminalReconciliationErrorCount === 2 ? current : null;
  });
  assert.equal(exactLookups, 2);
  assert.equal(fallbackLookups, 0);
  assert.equal(persisted.routerTerminalReconciliationErrorCount, 2);
  assert.match(persisted.routerTerminalReconciliationLastError, /controlled Router/);
  assert.equal(persisted.routerTerminalReconciliationNextAttemptAt, null);
  assert.ok(persisted.routerTerminalReconciliationQuarantinedAt);
  assert.equal(persisted.routerTerminalSignalPending, true);
  assert.equal(persisted.routerTerminalReconciledAt, null);
});

test("a thrown router_run_not_found error is an exception and reaches quarantine", async () => {
  const storeRoot = await tempStore("bridge-router-thrown-not-found-store-");
  const targetRepo = await tempStore("bridge-router-thrown-not-found-project-");
  const projectUrl = "https://chatgpt.com/c/router-thrown-not-found";
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_thrown_not_found",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-thrown-not-found-conversation",
    projectId: "router-thrown-not-found-project",
    codexThreadId: "router-thrown-not-found-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-thrown-not-found",
    payloadText: "thrown error text must not select recoverable control flow"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  let exactLookups = 0;
  let fallbackLookups = 0;

  await withServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-thrown-not-found-thread",
    routerTerminalReconciliationMaxAttempts: 1,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        exactLookups += 1;
        throw new Error("router_run_not_found");
      },
      async findByTransportRequestId() {
        fallbackLookups += 1;
        return null;
      }
    }
  }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-thrown-not-found-worker"
    });
    assert.equal(response.status, 200);
    await waitFor(async () =>
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationQuarantinedAt
    );
  });

  const persisted = await waitFor(async () => {
    const current = await getSyncJob(storeRoot, job.id);
    return current.routerTerminalReconciliationErrorCount === 1 ? current : null;
  });
  assert.equal(exactLookups, 1);
  assert.equal(fallbackLookups, 0);
  assert.equal(persisted.routerTerminalReconciliationFailureKind, "exception");
  assert.ok(persisted.routerTerminalReconciliationQuarantinedAt);
});

test("an AbortError without server cancellation records an exception retry", async () => {
  const storeRoot = await tempStore("bridge-router-unsignalled-abort-store-");
  const targetRepo = await tempStore("bridge-router-unsignalled-abort-project-");
  const projectUrl = "https://chatgpt.com/c/router-unsignalled-abort";
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_unsignalled_abort",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-unsignalled-abort-conversation",
    projectId: "router-unsignalled-abort-project",
    codexThreadId: "router-unsignalled-abort-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-unsignalled-abort",
    payloadText: "An unrelated AbortError must remain an ordinary reconciliation failure."
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const abortError = new Error("handler aborted independently");
  abortError.name = "AbortError";

  await withServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-unsignalled-abort-thread",
    routerTerminalReconciliationMaxAttempts: 1,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        throw abortError;
      }
    }
  }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-unsignalled-abort-worker"
    });
    assert.equal(response.status, 200);
    await waitFor(async () =>
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationErrorCount === 1
    );
  });

  const persisted = await getSyncJob(storeRoot, job.id);
  assert.equal(persisted.routerTerminalSignalPending, true);
  assert.equal(persisted.routerTerminalReconciliationFailureKind, "exception");
  assert.equal(persisted.routerTerminalReconciliationLastError, "handler aborted independently");
});

test("router_v2_disabled remains recoverable and never quarantines", async () => {
  const storeRoot = await tempStore("bridge-router-disabled-recovery-store-");
  const targetRepo = await tempStore("bridge-router-disabled-recovery-project-");
  const projectUrl = "https://chatgpt.com/c/router-disabled-recovery";
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_disabled_recovery",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-disabled-recovery-conversation",
    projectId: "router-disabled-recovery-project",
    codexThreadId: "router-disabled-recovery-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-disabled-recovery",
    payloadText: "disabled Router should wait without quarantine"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const legacyPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const legacy = JSON.parse(await readFile(legacyPath, "utf8"));
  legacy.routerTerminalReconciliationErrorCount = 1;
  legacy.routerTerminalReconciliationLastError = "router_v2_disabled";
  delete legacy.routerTerminalReconciliationFailureKind;
  legacy.routerTerminalReconciliationNextAttemptAt = null;
  legacy.routerTerminalReconciliationQuarantinedAt = "2026-08-02T00:00:00.000Z";
  await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  await withServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: false,
    currentCodexThreadId: "router-disabled-recovery-thread",
    routerTerminalReconciliationMaxAttempts: 1
  }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-disabled-recovery-worker"
    });
    assert.equal(response.status, 200);
    await waitFor(async () => {
      const current = await getSyncJob(storeRoot, job.id);
      return current.routerTerminalReconciliationFailureKind === "router_disabled" &&
        current.routerTerminalReconciliationQuarantinedAt === null &&
        current.routerTerminalReconciliationErrorCount > 1;
    });
  });

  const persisted = await getSyncJob(storeRoot, job.id);
  assert.equal(persisted.routerTerminalSignalPending, true);
  assert.equal(persisted.routerTerminalReconciliationQuarantinedAt, null);
});

test("versioned Router terminal scope gaps fail without legacy run scanning", async () => {
  const storeRoot = await tempStore("bridge-router-versioned-gap-store-");
  const targetRepo = await tempStore("bridge-router-versioned-gap-project-");
  const projectUrl = "https://chatgpt.com/c/router-versioned-gap";
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_versioned_gap",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-versioned-gap-conversation",
    projectId: "router-versioned-gap-project",
    codexThreadId: "router-versioned-gap-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-versioned-gap",
    payloadText: "versioned scope gap must not scan"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const broken = JSON.parse(await readFile(jobPath, "utf8"));
  delete broken.projectId;
  await writeFile(jobPath, `${JSON.stringify(broken, null, 2)}\n`, "utf8");
  let exactLookups = 0;
  let fallbackLookups = 0;

  await withServer({
    storeRoot,
    runnerMode: "manual",
    routerV2Enabled: true,
    currentCodexThreadId: "router-versioned-gap-thread",
    routerTerminalReconciliationMaxAttempts: 1,
    routerRunStore: {
      async findByRunIdAndTransportRequestId() {
        exactLookups += 1;
        return null;
      },
      async findByTransportRequestId() {
        fallbackLookups += 1;
        return null;
      }
    }
  }, async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "router-versioned-gap-worker"
    });
    assert.equal(response.status, 200);
    await waitFor(async () =>
      (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationQuarantinedAt
    );
  });

  const persisted = await getSyncJob(storeRoot, job.id);
  assert.equal(exactLookups, 0);
  assert.equal(fallbackLookups, 0);
  assert.equal(persisted.routerTerminalReconciliationFailureKind, "exception");
});

test("concurrent claims reconcile one Router terminal job through a single flight", async () => {
  const storeRoot = await tempStore("bridge-router-terminal-single-flight-store-");
  const targetRepo = await tempStore("bridge-router-terminal-single-flight-project-");
  const projectUrl = "https://chatgpt.com/c/router-terminal-single-flight";
  const job = await createSyncJob(storeRoot, {
    id: "sync_terminal_single_flight",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId: "router-terminal-single-flight-conversation",
    projectId: "router-terminal-single-flight-project",
    codexThreadId: "router-terminal-single-flight-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-terminal-single-flight",
    payloadText: "Only reconcile this terminal once."
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "Terminal result" });
  let exactLookups = 0;

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      routerV2Enabled: true,
      currentCodexThreadId: "router-terminal-single-flight-thread",
      routerTerminalReconciliationBaseDelayMs: 100,
      routerTerminalReconciliationMaxAttempts: 5,
      routerTerminalReconciliationClock: () => new Date("2026-08-02T02:00:00.000Z"),
      routerRunStore: {
        async findByRunIdAndTransportRequestId() {
          exactLookups += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error("controlled concurrent reconciliation failure");
        },
        async findByTransportRequestId() {
          throw new Error("new Router jobs must not scan all runs");
        }
      }
    },
    async (baseUrl) => {
      const responses = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          postJson(`${baseUrl}/api/sync/jobs/claim`, {
            projectUrl,
            workerId: `router-terminal-single-flight-worker-${index}`
          })
        )
      );
      assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
    }
  );

  const persisted = await waitFor(async () => {
    const current = await getSyncJob(storeRoot, job.id);
    return current.routerTerminalReconciliationErrorCount === 1 ? current : null;
  });
  assert.equal(exactLookups, 1);
  assert.equal(persisted.routerTerminalReconciliationErrorCount, 1);
  assert.equal(persisted.routerTerminalSignalPending, true);
});

test("legacy Router job with missing identity scope falls back strictly and backfills ownership", async () => {
  const storeRoot = await tempStore("bridge-router-terminal-legacy-scope-store-");
  const targetRepo = await tempStore("bridge-router-terminal-legacy-scope-project-");
  const projectUrl = "https://chatgpt.com/c/router-terminal-legacy-scope";
  const conversationId = "router-terminal-legacy-scope-conversation";
  const runStore = createRouterRunStore({ storeRoot });
  const run = await runStore.create({
    id: "router-run-terminal-legacy-scope",
    projectId: "router-terminal-legacy-scope-project",
    conversationId,
    codexThreadId: "router-terminal-legacy-scope-thread",
    routeKind: "gpt_only",
    transportId: "web-sync",
    originalRequestText: "legacy scoped terminal",
    targetRepo,
    chatgptProjectUrl: projectUrl,
    autoAdvanceOnTransportTerminal: false,
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "queued",
      payloadText: "legacy scoped terminal",
      transportRequestId: "sync_router_terminal_legacy_scope",
      submissionState: "submitted"
    }]
  });
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_terminal_legacy_scope",
    kind: "preference_sync",
    projectUrl,
    targetRepo,
    conversationId,
    projectId: run.projectId,
    codexThreadId: run.codexThreadId,
    routerTerminalSignalRequired: true,
    routerRunId: run.id,
    payloadText: "legacy scoped terminal"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "legacy terminal result" });
  const legacyJobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const legacyJob = JSON.parse(await readFile(legacyJobPath, "utf8"));
  delete legacyJob.projectId;
  delete legacyJob.codexThreadId;
  delete legacyJob.routerTerminalScopeVersion;
  await writeFile(legacyJobPath, `${JSON.stringify(legacyJob, null, 2)}\n`, "utf8");

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      routerV2Enabled: true,
      currentCodexThreadId: "router-terminal-legacy-scope-thread"
    },
    async (baseUrl) => {
      const response = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: "router-terminal-legacy-scope-worker"
      });
      assert.equal(response.status, 200);
    }
  );

  const backfilled = await waitFor(async () => {
    const current = await getSyncJob(storeRoot, job.id);
    return current.routerTerminalSignalPending === false ? current : null;
  });
  assert.equal(backfilled.routerTerminalSignalPending, false);
  assert.equal(backfilled.projectId, run.projectId);
  assert.equal(backfilled.codexThreadId, run.codexThreadId);
  assert.equal(backfilled.routerTerminalScopeVersion, 1);
  assert.ok(backfilled.routerTerminalReconciledAt);
});

test("ordinary HTTP terminal transitions never enter Router reconciliation", async () => {
  const storeRoot = await tempStore("bridge-ordinary-terminal-guard-store-");
  const targetRepo = await tempStore("bridge-ordinary-terminal-guard-project-");
  const conversationId = "ordinary-terminal-guard-conversation";
  const projectUrl = "https://chatgpt.com/c/ordinary-terminal-guard";
  const routerLookups = [];
  const jobs = {};
  for (const transition of ["complete", "fail", "cancel"]) {
    jobs[transition] = await createSyncJob(storeRoot, {
      id: `sync_ordinary_terminal_${transition}`,
      kind: "preference_sync",
      projectUrl,
      targetRepo,
      conversationId,
      payloadText: `Ordinary ${transition} transition must not touch Router state.`
    });
  }

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      routerV2Enabled: true,
      routerRunStore: {
        async findByTransportRequestId(requestId) {
          routerLookups.push(requestId);
          return null;
        }
      }
    },
    async (baseUrl) => {
      const completed = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(jobs.complete.id)}/complete`,
        { replyText: "Ordinary completed result." }
      );
      assert.equal(completed.status, 200);

      const failed = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(jobs.fail.id)}/fail`,
        { error: "Ordinary controlled failure", errorCode: "ordinary_failure" }
      );
      assert.equal(failed.status, 200);

      const cancelled = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(jobs.cancel.id)}/cancel`,
        {}
      );
      assert.equal(cancelled.status, 200);
    }
  );

  assert.deepEqual(routerLookups, []);
  for (const job of await listSyncJobs(storeRoot)) {
    assert.equal(job.routerTerminalSignalRequired, false);
    assert.equal(job.routerTerminalSignalPending, false);
    assert.equal(job.routerTerminalReconciledAt, null);
  }
});

test("the first claim after restart completes a partial successful message projection exactly once", async () => {
  const storeRoot = await tempStore("bridge-terminal-projection-store-");
  const conversationId = "terminal-projection-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-projection";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Return one durable result."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    targetRepo: "F:/game_code/terminal-projection",
    conversationId,
    sourceMessageId: sourceMessage.id,
    userText: sourceMessage.text,
    payloadText: sourceMessage.text
  });

  await completeSyncJob(storeRoot, job.id, {
    replyText: "Durable GPT result after restart."
  });
  await appendChatMessage(storeRoot, {
    role: "chatgpt",
    kind: "chatgpt_reply",
    text: "Durable GPT result after restart.",
    metadata: {
      conversationId,
      syncJobId: job.id,
      source: "chatgpt_project"
    }
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const claimResponses = await Promise.all(
      [0, 1].map((attempt) => postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: `terminal-projection-worker-${attempt}`
      }))
    );
    for (const claimResponse of claimResponses) {
      assert.equal(claimResponse.status, 200);
      assert.equal((await claimResponse.json()).job, null);
    }
    const repeatedClaimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "terminal-projection-worker-repeat"
    });
    assert.equal(repeatedClaimResponse.status, 200);
    assert.equal((await repeatedClaimResponse.json()).job, null);
  });

  const projectedChatMessages = (await listChatMessages(storeRoot, { conversationId }))
    .filter((message) => message.metadata?.syncJobId === job.id);
  const projectedRoomMessages = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter(
    (message) => message.from === "gpt" && message.metadata?.syncJobId === job.id
  );
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter((candidate) => candidate.id === job.id);

  assert.equal(projectedChatMessages.length, 1);
  assert.equal(projectedRoomMessages.length, 1);
  assert.equal(projectedRoomMessages[0].text, "Durable GPT result after restart.");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("concurrent claims serialize one successful terminal message projection", async () => {
  const storeRoot = await tempStore("bridge-terminal-projection-concurrent-");
  const conversationId = "terminal-projection-concurrent-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-projection-concurrent";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Project this result once under concurrent reconnects."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    userText: sourceMessage.text,
    payloadText: sourceMessage.text
  });
  await completeSyncJob(storeRoot, job.id, {
    replyText: "One projection under concurrent reconnects."
  });

  const jobLockPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json.lock`);
  await writeFile(jobLockPath, "held by deterministic concurrency test\n", "utf8");
  try {
    await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
      const claims = [0, 1].map((attempt) => postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: `terminal-projection-concurrent-worker-${attempt}`
      }));
      await waitFor(async () => {
        const messages = await listChatMessages(storeRoot, { conversationId });
        return messages.some((message) => message.metadata?.syncJobId === job.id);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await unlink(jobLockPath);
      const responses = await Promise.all(claims);
      for (const response of responses) {
        assert.equal(response.status, 200);
      }
    });
  } finally {
    try {
      await unlink(jobLockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const projectedChatMessages = (await listChatMessages(storeRoot, { conversationId }))
    .filter((message) => message.metadata?.syncJobId === job.id);
  const projectedRoomMessages = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter(
    (message) => message.from === "gpt" && message.metadata?.syncJobId === job.id
  );
  assert.equal(projectedChatMessages.length, 1);
  assert.equal(projectedRoomMessages.length, 1);
});

test("a legacy pending successful job without conversation scope is neither projected nor acknowledged", async () => {
  const storeRoot = await tempStore("bridge-terminal-projection-unscoped-");
  const workspaceConversationId = "current-workspace-conversation";
  const projectUrl = "https://chatgpt.com/c/unscoped-terminal-projection";
  await updateWorkspaceBinding(storeRoot, {
    conversationId: workspaceConversationId,
    chatgptProjectUrl: projectUrl,
    targetRepo: "F:/game_code/current-workspace"
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    payloadText: "This legacy job has no conversation scope."
  });
  await completeSyncJob(storeRoot, job.id, {
    replyText: "This must not enter the current workspace."
  });
  const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const legacyJob = JSON.parse(await readFile(jobPath, "utf8"));
  legacyJob.terminalMessageProjectionPending = true;
  legacyJob.terminalMessageProjectedAt = null;
  await writeFile(jobPath, `${JSON.stringify(legacyJob, null, 2)}\n`, "utf8");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "terminal-projection-unscoped-worker"
    });
    assert.equal(claimResponse.status, 200);
    assert.equal((await claimResponse.json()).job, null);
  });

  const chatPollution = (await listChatMessages(storeRoot, {
    conversationId: workspaceConversationId
  })).filter((message) => message.metadata?.syncJobId === job.id);
  const roomPollution = (await listRoomMessages(storeRoot, {
    includeHidden: true
  })).filter((message) => message.metadata?.syncJobId === job.id);
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter((candidate) => candidate.id === job.id);
  assert.equal(chatPollution.length, 0);
  assert.equal(roomPollution.length, 0);
  assert.equal(persistedJob.terminalMessageProjectionPending, true);
  assert.equal(persistedJob.terminalMessageProjectedAt, null);
});

test("repeated failure reports project one chat error and one room error", async () => {
  const storeRoot = await tempStore("bridge-terminal-failure-repeat-");
  const conversationId = "terminal-failure-repeat-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-failure-repeat";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Fail this request once."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    userText: sourceMessage.text,
    payloadText: sourceMessage.text
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/fail`,
        {
          error: "Timed out waiting for GPT reply",
          errorCode: "reply_timeout",
          recoveryAction: "refresh_bound_page"
        }
      );
      assert.equal(response.status, 200);
    }
  });

  const chatErrors = (await listChatMessages(storeRoot, { conversationId })).filter(
    (message) =>
      message.role === "chatgpt" &&
      message.kind === "chatgpt_error" &&
      message.metadata?.syncJobId === job.id
  );
  const roomErrors = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter(
    (message) =>
      message.from === "gpt" &&
      message.metadata?.syncJobId === job.id &&
      message.metadata?.syncStatus === "failed"
  );
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter(
    (candidate) => candidate.id === job.id
  );

  assert.equal(chatErrors.length, 1);
  assert.equal(roomErrors.length, 1);
  assert.equal(chatErrors[0].text, "GPT 卡住了\n\nGPT 长时间没有返回结果。请只刷新绑定的 GPT 页面后重试。");
  assert.equal(roomErrors[0].text, chatErrors[0].text);
  assert.equal(chatErrors[0].metadata.syncErrorCode, "reply_timeout");
  assert.equal(chatErrors[0].metadata.syncRecoveryAction, "refresh_bound_page");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("the first claim after restart completes a partial failed message projection exactly once", async () => {
  const storeRoot = await tempStore("bridge-terminal-failure-restart-");
  const conversationId = "terminal-failure-restart-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-failure-restart";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Recover this failed result after restart."
  });
  const failedJob = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    userText: sourceMessage.text,
    payloadText: sourceMessage.text
  });
  await failSyncJob(storeRoot, failedJob.id, {
    error: "Generation failed in the bound page",
    errorCode: "generation_failed",
    recoveryAction: "retry"
  });
  await appendChatMessage(storeRoot, {
    role: "chatgpt",
    kind: "chatgpt_error",
    text: "GPT 生成失败\n\n可以点击重试；如果连续失败，请换一个会话。",
    metadata: {
      conversationId,
      syncJobId: failedJob.id,
      syncStatus: "failed",
      error: "Generation failed in the bound page",
      syncErrorCode: "generation_failed",
      syncRecoveryAction: "retry",
      source: "chatgpt_project"
    }
  });

  const queuedJob = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    payloadText: "This new job must still be claimable."
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const responses = await Promise.all(
      [0, 1].map((attempt) => postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: `terminal-failure-restart-worker-${attempt}`
      }))
    );
    const claimedIds = [];
    for (const response of responses) {
      assert.equal(response.status, 200);
      const body = await response.json();
      if (body.job?.id) claimedIds.push(body.job.id);
    }
    assert.ok(claimedIds.includes(queuedJob.id));
  });

  const chatErrors = (await listChatMessages(storeRoot, { conversationId })).filter(
    (message) => message.kind === "chatgpt_error" && message.metadata?.syncJobId === failedJob.id
  );
  const roomErrors = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter(
    (message) =>
      message.from === "gpt" &&
      message.metadata?.syncJobId === failedJob.id &&
      message.metadata?.syncStatus === "failed"
  );
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter(
    (candidate) => candidate.id === failedJob.id
  );

  assert.equal(chatErrors.length, 1);
  assert.equal(roomErrors.length, 1);
  assert.equal(chatErrors[0].text, "GPT 生成失败\n\n可以点击重试；如果连续失败，请换一个会话。");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("one failed terminal replay does not block later projections or claiming new work", async () => {
  const storeRoot = await tempStore("bridge-terminal-replay-isolation-");
  const projectUrl = "https://chatgpt.com/c/terminal-replay-isolation";
  const brokenConversationId = "terminal-replay-broken-conversation";
  const healthyConversationId = "terminal-replay-healthy-conversation";
  const brokenJob = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId: brokenConversationId,
    sourceMessageId: "source_broken_projection",
    payloadText: "This projection will hit a real room-store write error."
  });
  await completeSyncJob(storeRoot, brokenJob.id, {
    replyText: "The chat half of this successful projection already exists.",
    artifactIds: [null]
  });
  await appendChatMessage(storeRoot, {
    role: "chatgpt",
    kind: "chatgpt_reply",
    text: "The chat half of this successful projection already exists.",
    metadata: {
      conversationId: brokenConversationId,
      syncJobId: brokenJob.id,
      source: "chatgpt_project"
    }
  });

  const healthyFailedJob = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl,
    conversationId: healthyConversationId,
    payloadText: "This failure projection must still complete."
  });
  await failSyncJob(storeRoot, healthyFailedJob.id, {
    error: "Generation failed",
    errorCode: "generation_failed",
    recoveryAction: "retry"
  });
  const queuedJob = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl,
    conversationId: healthyConversationId,
    payloadText: "This queued job must still be claimed."
  });

  await mkdir(path.join(storeRoot, "room", "messages.ndjson"), { recursive: true });
  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "terminal-replay-isolation-worker"
    });
    assert.equal(claimResponse.status, 200);
    assert.equal((await claimResponse.json()).job?.id, queuedJob.id);
  });

  const jobs = await listSyncJobs(storeRoot);
  const persistedBroken = jobs.find((job) => job.id === brokenJob.id);
  const persistedHealthyFailure = jobs.find((job) => job.id === healthyFailedJob.id);
  const projectedHealthyErrors = (await listChatMessages(storeRoot, {
    conversationId: healthyConversationId
  })).filter(
    (message) =>
      message.kind === "chatgpt_error" &&
      message.metadata?.syncJobId === healthyFailedJob.id
  );

  assert.equal(persistedBroken.terminalMessageProjectionPending, true);
  assert.equal(persistedBroken.terminalMessageProjectedAt, null);
  assert.equal(projectedHealthyErrors.length, 1);
  assert.equal(persistedHealthyFailure.terminalMessageProjectionPending, false);
  assert.ok(persistedHealthyFailure.terminalMessageProjectedAt);
});

test("missing download failure projection recovers compatible metadata after restart", async () => {
  const storeRoot = await tempStore("bridge-terminal-missing-download-restart-");
  const conversationId = "terminal-missing-download-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-missing-download";
  const artifactErrors = [
    {
      filename: "requested-report.xlsx",
      originalUrl: "https://chatgpt.com/download/requested-report.xlsx",
      error: "Download capture returned no local file"
    }
  ];
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Generate requested-report.xlsx."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    payloadText: sourceMessage.text
  });
  await failSyncJob(storeRoot, job.id, {
    error: "GPT 提到了可下载文件，但 Bridge 没有捕获到真实文件: requested-report.xlsx",
    errorCode: "missing_download",
    recoveryAction: "regenerate_file",
    artifactIds: [],
    artifactErrors
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "terminal-missing-download-worker"
    });
    assert.equal(claimResponse.status, 200);
    assert.equal((await claimResponse.json()).job, null);
  });

  const chatErrors = (await listChatMessages(storeRoot, { conversationId })).filter(
    (message) => message.kind === "chatgpt_error" && message.metadata?.syncJobId === job.id
  );
  const roomErrors = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter(
    (message) => message.metadata?.syncJobId === job.id && message.metadata?.syncStatus === "failed"
  );
  const persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);

  assert.equal(chatErrors.length, 1);
  assert.equal(roomErrors.length, 1);
  assert.equal(chatErrors[0].metadata.syncErrorCode, "missing_download");
  assert.deepEqual(chatErrors[0].metadata.artifactErrors, artifactErrors);
  assert.equal(chatErrors[0].metadata.syncRecoveryAction, "regenerate_file");
  assert.equal(roomErrors[0].metadata.syncErrorCode, "missing_download");
  assert.deepEqual(roomErrors[0].metadata.artifactIds, []);
  assert.deepEqual(roomErrors[0].metadata.artifactErrors, artifactErrors);
  assert.equal(roomErrors[0].metadata.syncRecoveryAction, "regenerate_file");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("a stale failed projection ack cannot clear a newer successful projection", async () => {
  const storeRoot = await tempStore("bridge-terminal-projection-status-token-");
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/terminal-projection-status-token",
    conversationId: "terminal-projection-status-token-conversation",
    payloadText: "Recover a missing download as success."
  });
  await failSyncJob(storeRoot, job.id, {
    error: "Missing download",
    errorCode: "missing_download"
  });
  await completeSyncJob(storeRoot, job.id, {
    replyText: "The recovered artifact is now available."
  });

  await markSyncJobTerminalMessageProjected(storeRoot, job.id, "failed");
  let persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(persistedJob.status, "succeeded");
  assert.equal(persistedJob.terminalMessageProjectionPending, true);
  assert.equal(persistedJob.terminalMessageProjectedAt, null);

  await markSyncJobTerminalMessageProjected(storeRoot, job.id, "succeeded");
  persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("a queued failed projector cannot append stale errors after the job succeeds", async () => {
  const storeRoot = await tempStore("bridge-terminal-stale-projector-");
  const conversationId = "terminal-stale-projector-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-stale-projector";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Recover this failed task before its old projector runs."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    payloadText: sourceMessage.text
  });
  await failSyncJob(storeRoot, job.id, {
    error: "Missing download",
    errorCode: "missing_download",
    recoveryAction: "regenerate_file"
  });

  const lockKey = `${path.resolve(storeRoot)}\n${job.id}`;
  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
      const staleClaimPromise = track(postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: "terminal-stale-projector-worker"
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await bounded(completeSyncJob(storeRoot, job.id, {
        replyText: "Recovered current result."
      }), "complete recovered sync job");
      await releaseAndWait();

      const staleClaimResponse = await bounded(staleClaimPromise, "stale projection claim");
      assert.equal(staleClaimResponse.status, 200);
      const recoveryClaimResponse = await bounded(postJson(`${baseUrl}/api/sync/jobs/claim`, {
        projectUrl,
        workerId: "terminal-stale-projector-worker"
      }), "recovery projection claim");
      assert.equal(recoveryClaimResponse.status, 200);
    });
  });

  const chatMessages = (await listChatMessages(storeRoot, { conversationId }))
    .filter((message) => message.metadata?.syncJobId === job.id);
  const roomMessages = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter((message) => message.metadata?.syncJobId === job.id);
  const failedChatMessages = chatMessages.filter(
    (message) => message.kind === "chatgpt_error" || message.metadata?.syncStatus === "failed"
  );
  const failedRoomMessages = roomMessages.filter(
    (message) => message.metadata?.syncStatus === "failed"
  );
  const successfulChatMessages = chatMessages.filter(
    (message) => message.kind === "chatgpt_reply"
  );
  const successfulRoomMessages = roomMessages.filter(
    (message) => message.from === "gpt" && message.metadata?.syncStatus !== "failed"
  );
  const persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);

  assert.equal(failedChatMessages.length, 0);
  assert.equal(failedRoomMessages.length, 0);
  assert.equal(successfulChatMessages.length, 1);
  assert.equal(successfulRoomMessages.length, 1);
  assert.equal(successfulChatMessages[0].text, "Recovered current result.");
  assert.equal(successfulRoomMessages[0].text, "Recovered current result.");
  assert.equal(persistedJob.status, "succeeded");
  assert.equal(persistedJob.replyText, "Recovered current result.");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("HTTP failure transition waits for the same lock as its message projection", async () => {
  const storeRoot = await tempStore("bridge-terminal-fail-transaction-");
  const conversationId = "terminal-fail-transaction-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-fail-transaction";
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: "terminal_fail_transaction_source",
    payloadText: "Fail atomically with its visible message."
  });
  const lockKey = `${path.resolve(storeRoot)}\n${job.id}`;
  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
      const failPromise = track(postJson(`${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/fail`, {
        error: "Generation failed",
        errorCode: "generation_failed",
        recoveryAction: "retry"
      }));
      await new Promise((resolve) => setTimeout(resolve, 75));
      const beforeRelease = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
      await releaseAndWait();
      const failResponse = await bounded(failPromise, "HTTP failure response");
      assert.equal(failResponse.status, 200);
      assert.equal((await failResponse.json()).job.status, "failed");
      assert.equal(beforeRelease.status, "pending");
      assert.equal(beforeRelease.terminalMessageProjectionPending, false);
    });
  });

  const persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("missing download failure transition waits for its failure projection lock", async () => {
  const storeRoot = await tempStore("bridge-terminal-missing-fail-transaction-");
  const conversationId = "terminal-missing-fail-transaction-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-missing-fail-transaction";
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: "terminal_missing_fail_source",
    userText: "Generate report.xlsx as a real downloadable file.",
    payloadText: "Generate report.xlsx as a real downloadable file."
  });
  const lockKey = `${path.resolve(storeRoot)}\n${job.id}`;
  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
      const completePromise = track(postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/complete`,
        { replyText: "Generated report.xlsx for download." }
      ));
      await new Promise((resolve) => setTimeout(resolve, 75));
      const beforeRelease = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
      await releaseAndWait();
      const completeResponse = await bounded(completePromise, "missing download failure response");
      assert.equal(completeResponse.status, 200);
      assert.equal((await completeResponse.json()).job.status, "failed");
      assert.equal(beforeRelease.status, "pending");
      assert.equal(beforeRelease.terminalMessageProjectionPending, false);
    });
  });

  const persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(persistedJob.errorCode, "missing_download");
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("missing download success recovery waits for its success projection lock", async () => {
  const storeRoot = await tempStore("bridge-terminal-missing-success-transaction-");
  const conversationId = "terminal-missing-success-transaction-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-missing-success-transaction";
  const replyText = "Generated recovered.txt for download.";
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: "terminal_missing_success_source",
    userText: "Generate recovered.txt as a real downloadable file.",
    payloadText: "Generate recovered.txt as a real downloadable file."
  });
  await failSyncJob(storeRoot, job.id, {
    error: "GPT 提到了可下载文件，但 Bridge 没有捕获到真实文件: recovered.txt",
    errorCode: "missing_download",
    replyText,
    artifactIds: [],
    artifactErrors: [{ filename: "recovered.txt", error: "No local file" }]
  });
  const lockKey = `${path.resolve(storeRoot)}\n${job.id}`;
  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
      const completePromise = track(postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/complete`,
        {
          replyText,
          artifacts: [
            {
              filename: "recovered.txt",
              contentType: "text/plain",
              originalUrl: "data:text/plain;base64,cmVjb3ZlcmVk",
              base64Data: "cmVjb3ZlcmVk"
            }
          ]
        }
      ));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const beforeRelease = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
      await releaseAndWait();
      const completeResponse = await bounded(completePromise, "missing download recovery response");
      assert.equal(completeResponse.status, 200);
      assert.equal((await completeResponse.json()).job.status, "succeeded");
      assert.equal(beforeRelease.status, "failed");
      assert.equal(beforeRelease.terminalMessageProjectionPending, true);
    });
  });

  const persistedJob = (await listSyncJobs(storeRoot)).find((candidate) => candidate.id === job.id);
  assert.equal(persistedJob.status, "succeeded");
  assert.equal(persistedJob.replyText, replyText);
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.ok(persistedJob.terminalMessageProjectedAt);
});

test("preference sync failures never project terminal chat or room messages", async () => {
  const storeRoot = await tempStore("bridge-terminal-failure-preference-");
  const conversationId = "terminal-failure-preference-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-failure-preference";
  const job = await createSyncJob(storeRoot, {
    kind: "preference_sync",
    projectUrl,
    conversationId,
    payloadText: "Sync model preferences."
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const response = await postJson(
      `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/fail`,
      {
        error: "Preference sync failed",
        errorCode: "preference_sync_failed"
      }
    );
    assert.equal(response.status, 200);
  });

  const projectedChatMessages = (await listChatMessages(storeRoot, { conversationId }))
    .filter((message) => message.metadata?.syncJobId === job.id);
  const projectedRoomMessages = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter((message) => message.metadata?.syncJobId === job.id);
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter(
    (candidate) => candidate.id === job.id
  );

  assert.equal(projectedChatMessages.length, 0);
  assert.equal(projectedRoomMessages.length, 0);
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.equal(persistedJob.terminalMessageProjectedAt, null);
});

test("manual cancellation keeps its existing no-terminal-message behavior", async () => {
  const storeRoot = await tempStore("bridge-terminal-failure-cancel-");
  const conversationId = "terminal-failure-cancel-conversation";
  const projectUrl = "https://chatgpt.com/c/terminal-failure-cancel";
  const sourceMessage = await appendRoomMessage(storeRoot, {
    conversationId,
    from: "user",
    to: ["gpt"],
    text: "Cancel this request without adding an error reply."
  });
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    conversationId,
    sourceMessageId: sourceMessage.id,
    userText: sourceMessage.text,
    payloadText: sourceMessage.text
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const cancelResponse = await postJson(
      `${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}/cancel`,
      {}
    );
    assert.equal(cancelResponse.status, 200);
    const claimResponse = await postJson(`${baseUrl}/api/sync/jobs/claim`, {
      projectUrl,
      workerId: "terminal-failure-cancel-worker"
    });
    assert.equal(claimResponse.status, 200);
    assert.equal((await claimResponse.json()).job, null);
  });

  const projectedChatMessages = (await listChatMessages(storeRoot, { conversationId }))
    .filter((message) => message.metadata?.syncJobId === job.id);
  const projectedRoomMessages = (await listRoomMessages(storeRoot, {
    conversationId,
    includeHidden: true
  })).filter((message) => message.metadata?.syncJobId === job.id);
  const [persistedJob] = (await listSyncJobs(storeRoot)).filter(
    (candidate) => candidate.id === job.id
  );

  assert.equal(projectedChatMessages.length, 0);
  assert.equal(projectedRoomMessages.length, 0);
  assert.equal(persistedJob.terminalMessageProjectionPending, false);
  assert.equal(persistedJob.terminalMessageProjectedAt, null);
});

test("completion queued after cancellation stops when cancellation wins", async () => {
  const storeRoot = await tempStore("bridge-router-cancel-wins-store-");
  const targetRepo = await tempStore("bridge-router-cancel-wins-project-");
  const currentCodexThreadId = "router-cancel-wins-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-cancel-wins-conversation";

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router cancel wins project",
        chatgptProjectUrl,
        targetRepo
      });
      const binding = await bindingResponse.json();
      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: true,
        timeoutMs: 5,
        pollMs: 1,
        failOnTimeout: false
      });
      const delegated = await delegateResponse.json();
      const firstRequestId = delegated.routerRun.stages[0].transportRequestId;
      const lockKey = `${path.resolve(storeRoot)}\n${firstRequestId}`;
      await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
        const cancelPromise = track(postJson(
          `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/cancel`,
          {}
        ));
        await new Promise((resolve) => setTimeout(resolve, 75));
        const completePromise = track(postJson(
          `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/complete`,
          { replyText: "Late completed outline must not advance the run." }
        ));
        await new Promise((resolve) => setTimeout(resolve, 75));
        await releaseAndWait();

        const cancelResponse = await bounded(cancelPromise, "cancellation response");
        assert.equal(cancelResponse.status, 200);

        const completeResponse = await bounded(completePromise, "late completion response");
        const completed = await completeResponse.json();
        assert.equal(completeResponse.status, 409);
        assert.equal(completed.code, "sync_job_not_active");
        assert.equal(completed.job.status, "failed");
        assert.equal(completed.job.errorCode, "manual_cancelled");
        assert.equal(completed.chatgptMessage, null);
        assert.equal(completed.roomMessage, null);
        assert.equal(completed.sequentialContinuationMessage, null);
        assert.equal(completed.sequentialContinuationJob, null);
        assert.equal(completed.imageContinuationMessage, null);
        assert.equal(completed.imageContinuationJob, null);
        assert.equal(completed.task, null);
        assert.equal(completed.resultMessage, null);
        assert.equal(completed.resultSyncJob, null);
        assert.equal(completed.inboxItem, null);

        const runStore = createRouterRunStore({ storeRoot });
        const scope = {
          projectId: binding.project.id,
          conversationId: binding.project.conversationId,
          codexThreadId: currentCodexThreadId
        };
        const cancelledRun = await waitFor(async () => {
          const current = await runStore.get(delegated.routerRun.id, scope);
          return current.status === "cancelled" ? current : null;
        });
        assert.equal(cancelledRun.status, "cancelled");
        assert.equal(cancelledRun.stages[0].status, "cancelled");
        assert.equal(cancelledRun.stages[1].status, "pending");
        assert.equal(cancelledRun.stages[2].status, "pending");
        assert.equal((await listSyncJobs(storeRoot)).length, 1);

        const successChatMessages = (await listChatMessages(storeRoot, {
          conversationId: binding.project.conversationId
        })).filter(
          (message) =>
            message.metadata?.syncJobId === firstRequestId &&
            message.role === "chatgpt" &&
            message.kind === "chatgpt_reply"
        );
        const successRoomMessages = (await listRoomMessages(storeRoot, {
          conversationId: binding.project.conversationId,
          includeHidden: true
        })).filter((message) => message.metadata?.syncJobId === firstRequestId && message.from === "gpt");
        assert.equal(successChatMessages.length, 0);
        assert.equal(successRoomMessages.length, 0);
      });
    }
  );
});

test("cancellation queued behind projection lock reports conflict when completion wins", async () => {
  const storeRoot = await tempStore("bridge-router-complete-wins-store-");
  const targetRepo = await tempStore("bridge-router-complete-wins-project-");
  const currentCodexThreadId = "router-complete-wins-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-complete-wins-conversation";

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router complete wins project",
        chatgptProjectUrl,
        targetRepo
      });
      const binding = await bindingResponse.json();
      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: true,
        timeoutMs: 5,
        pollMs: 1,
        failOnTimeout: false
      });
      const delegated = await delegateResponse.json();
      const firstRequestId = delegated.routerRun.stages[0].transportRequestId;
      const lockKey = `${path.resolve(storeRoot)}\n${firstRequestId}`;
      await withProjectionBarrier(lockKey, async ({ releaseAndWait, track }) => {
        const completePromise = track(postJson(
          `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/complete`,
          { replyText: "Completed outline advances the run exactly once." }
        ));
        await new Promise((resolve) => setTimeout(resolve, 75));
        const cancelPromise = track(postJson(
          `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/cancel`,
          {}
        ));
        await new Promise((resolve) => setTimeout(resolve, 75));
        await releaseAndWait();

        const completeResponse = await bounded(completePromise, "winning completion response");
        const completed = await completeResponse.json();
        assert.equal(completeResponse.status, 200);
        assert.equal(completed.job.status, "succeeded");

        const cancelResponse = await bounded(cancelPromise, "losing cancellation response");
        const cancelled = await cancelResponse.json();
        assert.equal(cancelResponse.status, 409);
        assert.equal(cancelled.code, "sync_job_not_active");
        assert.equal(cancelled.job.status, "succeeded");

        const runStore = createRouterRunStore({ storeRoot });
        const scope = {
          projectId: binding.project.id,
          conversationId: binding.project.conversationId,
          codexThreadId: currentCodexThreadId
        };
        const advancedRun = await waitFor(async () => {
          const current = await runStore.get(delegated.routerRun.id, scope);
          return current.stages[1].status === "queued" ? current : null;
        });
        assert.notEqual(advancedRun.status, "cancelled");
        assert.equal(advancedRun.stages[0].status, "succeeded");
        assert.equal(advancedRun.stages[1].status, "queued");
        assert.equal(advancedRun.stages[2].status, "pending");
        assert.equal((await listSyncJobs(storeRoot)).length, 2);

        const successChatMessages = (await listChatMessages(storeRoot, {
          conversationId: binding.project.conversationId
        })).filter(
          (message) =>
            message.metadata?.syncJobId === firstRequestId &&
            message.role === "chatgpt" &&
            message.kind === "chatgpt_reply"
        );
        const successRoomMessages = (await listRoomMessages(storeRoot, {
          conversationId: binding.project.conversationId,
          includeHidden: true
        })).filter(
          (message) =>
            message.metadata?.syncJobId === firstRequestId &&
            message.from === "gpt" &&
            message.metadata?.syncStatus !== "failed"
        );
        assert.equal(successChatMessages.length, 1);
        assert.equal(successRoomMessages.length, 1);
      });
    }
  );
});

test("extension failure marks the exact Router stage failed and never queues its successor", async () => {
  const storeRoot = await tempStore("bridge-router-failure-store-");
  const targetRepo = await tempStore("bridge-router-failure-project-");
  const currentCodexThreadId = "router-failure-thread";
  const chatgptProjectUrl = "https://chatgpt.com/c/router-failure-conversation";

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId,
      routerV2Enabled: true
    },
    async (baseUrl) => {
      const bindingResponse = await postJson(`${baseUrl}/api/projects/current-session`, {
        name: "Router failure project",
        chatgptProjectUrl,
        targetRepo
      });
      const binding = await bindingResponse.json();
      const delegateResponse = await postJson(`${baseUrl}/api/delegate/current-request`, {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        text:
          "\u5148\u8bbe\u8ba1\u524d3\u96c6\u5927\u7eb2\uff0c" +
          "\u518d\u5199\u7b2c\u4e00\u96c6\u8be6\u7ec6\u6b63\u6587\uff0c" +
          "\u6700\u540e\u751f\u6210\u5c0f\u8bf4\u6d77\u62a5\u3002",
        waitForGpt: true,
        timeoutMs: 5,
        pollMs: 1,
        failOnTimeout: false
      });
      const delegated = await delegateResponse.json();
      const firstRequestId = delegated.routerRun.stages[0].transportRequestId;

      const failResponse = await postJson(
        `${baseUrl}/api/sync/jobs/${encodeURIComponent(firstRequestId)}/fail`,
        {
          error: "Controlled extension failure",
          errorCode: "test_failure"
        }
      );
      assert.equal(failResponse.status, 200);

      const runStore = createRouterRunStore({ storeRoot });
      const scope = {
        projectId: binding.project.id,
        conversationId: binding.project.conversationId,
        codexThreadId: currentCodexThreadId
      };
      const failedRun = await waitFor(async () => {
        const current = await runStore.get(delegated.routerRun.id, scope);
        return current.status === "failed" ? current : null;
      });
      assert.equal(failedRun.stages[0].status, "failed");
      assert.equal(failedRun.stages[1].status, "pending");
      assert.equal(failedRun.stages[2].status, "pending");
      assert.equal((await listSyncJobs(storeRoot)).length, 1);
    }
  );
});
