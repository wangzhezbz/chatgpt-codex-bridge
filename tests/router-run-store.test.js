import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createRouterRunStore } from "../src/router-run-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-router-run-store-"));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Router lease child exited with ${code}: ${stderr}`));
      }
    });
  });
}

const SCOPE = {
  projectId: "project-1",
  conversationId: "conversation-1",
  codexThreadId: "thread-1"
};

function runInput(targetRepo, overrides = {}) {
  return {
    ...SCOPE,
    routeKind: "gpt_only",
    transportId: "mock",
    originalRequestText: "Write an outline, then a chapter.",
    targetRepo,
    chatgptProjectUrl: "https://chatgpt.com/c/conversation-1",
    stages: [
      {
        id: "outline",
        title: "Outline",
        payloadText: "Write only the outline."
      },
      {
        id: "chapter",
        title: "Chapter",
        dependsOn: "outline",
        instruction: "Use the outline and write only the chapter."
      }
    ],
    ...overrides
  };
}

test("router run store persists a complete version 2 run and restores it", async () => {
  const storeRoot = await tempStore();
  const targetRepo = path.join(storeRoot, "project");
  const store = createRouterRunStore({
    storeRoot,
    clock: () => "2026-07-10T12:00:00.000Z",
    runIdFactory: () => "router-run-1"
  });

  const created = await store.create(runInput(targetRepo));

  assert.equal(created.id, "router-run-1");
  assert.equal(created.version, 2);
  assert.equal(created.status, "pending");
  assert.equal(created.routeKind, "gpt_only");
  assert.equal(created.currentStageIndex, 0);
  assert.equal(created.projectId, SCOPE.projectId);
  assert.equal(created.conversationId, SCOPE.conversationId);
  assert.equal(created.codexThreadId, SCOPE.codexThreadId);
  assert.equal(created.transportId, "mock");
  assert.equal(created.targetRepo, path.resolve(targetRepo));
  assert.deepEqual(created.projectArtifactPaths, []);
  assert.equal(created.createdAt, "2026-07-10T12:00:00.000Z");
  assert.equal(created.updatedAt, "2026-07-10T12:00:00.000Z");

  assert.deepEqual(created.stages[0], {
    id: "outline",
    title: "Outline",
    status: "pending",
    payloadText: "Write only the outline.",
    dependsOn: null,
    instruction: null,
    replyText: null,
    artifactIds: [],
    transportRequestId: null,
    submissionState: null,
    inputArtifacts: [],
    projectArtifactPaths: [],
    startedAt: null,
    completedAt: null,
    error: null
  });
  assert.equal(created.stages[1].dependsOn, "outline");
  assert.equal(created.stages[1].payloadText, "");
  assert.match(created.stages[1].instruction, /outline/);

  const jsonPath = path.join(storeRoot, "router-runs", "router-run-1.json");
  const serialized = await readFile(jsonPath, "utf8");
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), created);

  const restoredStore = createRouterRunStore({ storeRoot });
  assert.deepEqual(await restoredStore.get(created.id, SCOPE), created);
});

test("router run store updates a run only under the exact scope", async () => {
  const storeRoot = await tempStore();
  let clockIndex = 0;
  const times = ["2026-07-10T12:00:00.000Z", "2026-07-10T12:01:00.000Z"];
  const store = createRouterRunStore({
    storeRoot,
    clock: () => times[Math.min(clockIndex++, times.length - 1)],
    runIdFactory: () => "router-run-update"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  const updated = await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "running",
    stages: run.stages.map((stage, index) =>
      index === 0
        ? { ...stage, status: "running", transportRequestId: "mock-request-1" }
        : stage
    )
  }));

  assert.equal(updated.status, "running");
  assert.equal(updated.stages[0].transportRequestId, "mock-request-1");
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, "2026-07-10T12:01:00.000Z");
  assert.deepEqual((await store.list(SCOPE)).map((run) => run.id), [created.id]);
});

test("router run store rejects project, conversation, and Codex thread scope mismatches", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-scope"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, projectId: "project-2" }),
    /scope mismatch.*projectId/i
  );
  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, conversationId: "conversation-2" }),
    /scope mismatch.*conversationId/i
  );
  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, codexThreadId: "thread-2" }),
    /scope mismatch.*codexThreadId/i
  );
  await assert.rejects(
    () => store.get(created.id, { projectId: SCOPE.projectId }),
    /scope requires.*conversationId/i
  );
  await assert.rejects(
    () => store.update(created.id, { ...SCOPE, projectId: "project-2" }, { status: "failed" }),
    /scope mismatch.*projectId/i
  );
});

test("router run store validates ids, unique stages, and dependency order", async () => {
  const storeRoot = await tempStore();

  const unsafeStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "../outside"
  });
  await assert.rejects(
    () => unsafeStore.create(runInput(path.join(storeRoot, "project"))),
    /invalid router run id/i
  );

  const duplicateStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-duplicate"
  });
  await assert.rejects(
    () =>
      duplicateStore.create(
        runInput(path.join(storeRoot, "project"), {
          stages: [
            { id: "same", title: "One" },
            { id: "same", title: "Two" }
          ]
        })
      ),
    /duplicate router stage id/i
  );

  const dependencyStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-dependency"
  });
  await assert.rejects(
    () =>
      dependencyStore.create(
        runInput(path.join(storeRoot, "project"), {
          stages: [
            { id: "first", title: "First", dependsOn: "second" },
            { id: "second", title: "Second" }
          ]
        })
      ),
    /dependency.*must reference an earlier stage/i
  );
});

test("router run store requires the full run scope", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-missing-scope"
  });

  await assert.rejects(
    () =>
      store.create(
        runInput(path.join(storeRoot, "project"), {
          codexThreadId: null
        })
      ),
    /codexThreadId is required/i
  );
});

test("router run store serializes concurrent updates without losing fields", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-concurrent"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  await Promise.all([
    store.update(created.id, SCOPE, { modePreference: "deep" }),
    store.update(created.id, SCOPE, { modelPreference: "gpt-test" })
  ]);
  const finalRun = await store.get(created.id, SCOPE);

  assert.equal(finalRun.modePreference, "deep");
  assert.equal(finalRun.modelPreference, "gpt-test");
});

test("router run store operation lease canonicalizes trimmed run ids and scopes across instances", async () => {
  const storeRoot = await tempStore();
  const firstStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-operation-lease"
  });
  const secondStore = createRouterRunStore({ storeRoot });
  const created = await firstStore.create(runInput(path.join(storeRoot, "project")));
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  const first = firstStore.withRunLease(`  ${created.id}  `, paddedScope, async (run) => {
    order.push(`first:${run.id}`);
    markFirstEntered();
    await holdFirst;
    order.push("first:released");
  });
  await firstEntered;

  let secondEntered = false;
  const second = secondStore.withRunLease(created.id, SCOPE, async () => {
    secondEntered = true;
    order.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    `first:${created.id}`,
    "first:released",
    "second"
  ]);
});

test("router run store operation lease serializes independent Node processes", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-cross-process-lease"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));
  const routerStoreUrl = pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const childScript = `
    import { readFile, writeFile } from "node:fs/promises";
    import { createRouterRunStore } from ${JSON.stringify(routerStoreUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = createRouterRunStore({ storeRoot: process.env.STORE_ROOT });
    const scope = JSON.parse(process.env.RUN_SCOPE);
    await writeFile(process.env.READY_FILE, "ready", "utf8");
    await store.withRunLease(process.env.RUN_ID, scope, async () => {
      await writeFile(process.env.ENTERED_FILE, "entered", "utf8");
      if (process.env.RELEASE_FILE) {
        while (true) {
          try {
            await readFile(process.env.RELEASE_FILE);
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await sleep(20);
        }
      }
    });
  `;
  const firstReady = path.join(storeRoot, "first-ready");
  const firstEntered = path.join(storeRoot, "first-entered");
  const firstRelease = path.join(storeRoot, "first-release");
  const secondReady = path.join(storeRoot, "second-ready");
  const secondEntered = path.join(storeRoot, "second-entered");
  const commonEnv = {
    ...process.env,
    STORE_ROOT: storeRoot,
    RUN_ID: created.id,
    RUN_SCOPE: JSON.stringify(SCOPE)
  };
  const firstChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      READY_FILE: firstReady,
      ENTERED_FILE: firstEntered,
      RELEASE_FILE: firstRelease
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const firstResult = waitForChild(firstChild);
  let secondChild = null;
  try {
    await waitForFile(firstReady);
    await waitForFile(firstEntered);
    secondChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: process.cwd(),
      env: {
        ...commonEnv,
        READY_FILE: secondReady,
        ENTERED_FILE: secondEntered,
        RELEASE_FILE: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const secondResult = waitForChild(secondChild);
    await waitForFile(secondReady);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(
      () => readFile(secondEntered),
      (error) => error.code === "ENOENT"
    );

    await writeFile(firstRelease, "release", "utf8");
    await Promise.all([firstResult, secondResult]);
    await waitForFile(secondEntered);
  } finally {
    if (firstChild.exitCode == null) {
      firstChild.kill();
    }
    if (secondChild?.exitCode == null) {
      secondChild.kill();
    }
  }
});

test("router run store submission and finalization leases are independent and expose the latest scoped run", async () => {
  const storeRoot = await tempStore();
  const firstStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-named-leases"
  });
  const secondStore = createRouterRunStore({ storeRoot });
  const created = await firstStore.create(runInput(path.join(storeRoot, "project")));
  await firstStore.update(created.id, SCOPE, { modePreference: "latest" });
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  let releaseSubmission;
  let markSubmissionEntered;
  const submissionEntered = new Promise((resolve) => {
    markSubmissionEntered = resolve;
  });
  const holdSubmission = new Promise((resolve) => {
    releaseSubmission = resolve;
  });

  const submission = firstStore.withSubmissionLease(
    `  ${created.id}  `,
    paddedScope,
    async (run) => {
      assert.equal(run.modePreference, "latest");
      markSubmissionEntered();
      await holdSubmission;
    }
  );
  await submissionEntered;

  try {
    const finalization = secondStore.withFinalizationLease(created.id, SCOPE, async (run) => {
      assert.equal(run.id, created.id);
      assert.equal(run.modePreference, "latest");
      return "finalized";
    });
    assert.equal(
      await Promise.race([
        finalization,
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500))
      ]),
      "finalized"
    );
  } finally {
    releaseSubmission();
    await submission;
  }

  await assert.rejects(
    () =>
      firstStore.withSubmissionLease(
        created.id,
        { ...SCOPE, conversationId: "conversation-2" },
        async () => {}
      ),
    /scope mismatch.*conversationId/i
  );
  await assert.rejects(
    () => firstStore.withFinalizationLease(created.id, {}, async () => {}),
    /scope requires.*projectId/i
  );
});

test("router run store named leases serialize independent Node processes", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-cross-process-named-leases"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));
  const routerStoreUrl = pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const childScript = `
    import { readFile, writeFile } from "node:fs/promises";
    import { createRouterRunStore } from ${JSON.stringify(routerStoreUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = createRouterRunStore({ storeRoot: process.env.STORE_ROOT });
    const scope = JSON.parse(process.env.RUN_SCOPE);
    await writeFile(process.env.READY_FILE, "ready", "utf8");
    await store[process.env.LEASE_METHOD](process.env.RUN_ID, scope, async () => {
      await writeFile(process.env.ENTERED_FILE, "entered", "utf8");
      if (process.env.RELEASE_FILE) {
        while (true) {
          try {
            await readFile(process.env.RELEASE_FILE);
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await sleep(20);
        }
      }
    });
  `;

  for (const leaseMethod of ["withSubmissionLease", "withFinalizationLease"]) {
    const marker = leaseMethod === "withSubmissionLease" ? "submission" : "finalization";
    const firstReady = path.join(storeRoot, `${marker}-first-ready`);
    const firstEntered = path.join(storeRoot, `${marker}-first-entered`);
    const firstRelease = path.join(storeRoot, `${marker}-first-release`);
    const secondReady = path.join(storeRoot, `${marker}-second-ready`);
    const secondEntered = path.join(storeRoot, `${marker}-second-entered`);
    const commonEnv = {
      ...process.env,
      STORE_ROOT: storeRoot,
      RUN_ID: created.id,
      RUN_SCOPE: JSON.stringify(SCOPE),
      LEASE_METHOD: leaseMethod
    };
    const firstChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: process.cwd(),
      env: {
        ...commonEnv,
        READY_FILE: firstReady,
        ENTERED_FILE: firstEntered,
        RELEASE_FILE: firstRelease
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const firstResult = waitForChild(firstChild);
    let secondChild = null;
    try {
      await waitForFile(firstReady);
      await waitForFile(firstEntered);
      secondChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
        cwd: process.cwd(),
        env: {
          ...commonEnv,
          READY_FILE: secondReady,
          ENTERED_FILE: secondEntered,
          RELEASE_FILE: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const secondResult = waitForChild(secondChild);
      await waitForFile(secondReady);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await assert.rejects(
        () => readFile(secondEntered),
        (error) => error.code === "ENOENT"
      );

      await writeFile(firstRelease, "release", "utf8");
      await Promise.all([firstResult, secondResult]);
      await waitForFile(secondEntered);
    } finally {
      if (firstChild.exitCode == null) {
        firstChild.kill();
      }
      if (secondChild?.exitCode == null) {
        secondChild.kill();
      }
    }
  }
});

test("router run store rejects reversing a terminal run or stage", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-terminal"
  });
  const created = await store.create(
    runInput(path.join(storeRoot, "project"), {
      stages: [{ id: "gpt", title: "GPT", payloadText: "done" }]
    })
  );
  await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "succeeded",
    stages: run.stages.map((stage) => ({
      ...stage,
      status: "succeeded",
      replyText: "done",
      completedAt: "2026-07-10T12:00:00.000Z"
    }))
  }));

  await assert.rejects(
    () =>
      store.update(created.id, SCOPE, (run) => ({
        ...run,
        status: "running",
        stages: run.stages.map((stage) => ({ ...stage, status: "running" }))
      })),
    /terminal.*immutable/i
  );
  assert.equal((await store.get(created.id, SCOPE)).status, "succeeded");
});

test("router run store keeps immutable identity even when an updater mutates its input", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-immutable-identity"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  const updated = await store.update(created.id, SCOPE, (run) => {
    run.id = "router-run-hijacked";
    run.createdAt = "1999-01-01T00:00:00.000Z";
    run.modePreference = "deep";
    return run;
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.modePreference, "deep");
  await assert.rejects(
    () => store.get("router-run-hijacked", SCOPE),
    (error) => error.code === "ENOENT"
  );
});

test("router run store does not rewrite data of an already terminal stage", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-terminal-stage-data"
  });
  const created = await store.create(
    runInput(path.join(storeRoot, "project"), {
      stages: [{ id: "gpt", title: "GPT", payloadText: "done" }]
    })
  );
  await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "succeeded",
    stages: run.stages.map((stage) => ({
      ...stage,
      status: "succeeded",
      replyText: "original result",
      artifactIds: ["artifact-original"],
      completedAt: "2026-07-10T12:00:00.000Z"
    }))
  }));

  await assert.rejects(
    () =>
      store.update(created.id, SCOPE, (run) => ({
        ...run,
        stages: run.stages.map((stage) => ({
          ...stage,
          replyText: "rewritten result",
          artifactIds: ["artifact-rewritten"]
        }))
      })),
    /terminal.*immutable/i
  );
  const persisted = await store.get(created.id, SCOPE);
  assert.equal(persisted.stages[0].replyText, "original result");
  assert.deepEqual(persisted.stages[0].artifactIds, ["artifact-original"]);
});
