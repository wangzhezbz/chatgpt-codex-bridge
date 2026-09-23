import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http-server.js";
import { createBridgeTools } from "../src/bridge-tools.js";
import { createRouterRunStore } from "../src/router-run-store.js";
import { listSyncJobs, getSyncJob } from "../src/sync-store.js";
import { listRoomMessages } from "../src/room-store.js";

async function post(base, route, body = {}) {
  return fetch(base + route, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Router state did not settle within 5 seconds");
}

async function withFailedRouter(errorCode, operation, { sent = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-router-retry-"));
  const inputPath = path.join(root, "input.txt");
  await writeFile(inputPath, "test input only", "utf8");
  const thread = "router-retry-thread";
  const projectUrl = "https://chatgpt.com/c/router-retry-test";
  const workerId = "test-extension";
  const server = createHttpServer({
    env: {}, storeRoot: root, currentCodexThreadId: thread, routerV2Enabled: true, semanticRouterEnabled: true,
    runnerMode: "manual"
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const bindingResponse = await post(base, "/api/projects/current-session", {
      name: "isolated retry", targetRepo: path.join(root, "project"), chatgptProjectUrl: projectUrl
    });
    assert.equal(bindingResponse.status, 201);
    const { project } = await bindingResponse.json();
    const scope = { projectId: project.id, conversationId: project.conversationId, codexThreadId: thread };
    const delegatedResponse = await post(base, "/api/delegate/current-request", {
      projectId: project.id, conversationId: project.conversationId,
      text: "Read the attachment, then reply with a short confirmation.",
      localFiles: [{ localPath: inputPath, filename: "input.txt", contentType: "text/plain" }],
      modePreference: "high", modelPreference: "gpt-5.6-sol",
      waitForGpt: true, timeoutMs: 5, pollMs: 1, failOnTimeout: false,
      routingProposal: {
        version: "1", routeKind: "gpt_only", confidence: 1, gptRequestKind: "chat_message",
        stages: [
          { id: "read", title: "Read input", actor: "gpt", instruction: "Read the attached input; reply INPUT_OK. Do not generate attachments." },
          { id: "text", title: "Confirm", actor: "gpt", dependsOn: "read", instruction: "Only reply NEXT_OK." }
        ]
      }
    });
    assert.equal(delegatedResponse.status, 201, await delegatedResponse.clone().text());
    const { routerRun } = await delegatedResponse.json();
    assert.deepEqual(routerRun.stages.map(stage => stage.id), ["read", "text"]);
    const jobId = routerRun.stages[0].transportRequestId;
    assert.equal((await getSyncJob(root, jobId)).inputArtifacts.length, 1);
    const claimed = await post(base, "/api/sync/jobs/claim", { projectUrl, workerId });
    assert.equal((await claimed.json()).job.id, jobId);
    if (sent) {
      assert.equal((await post(base, `/api/sync/jobs/${jobId}/sent`, { workerId })).status, 200);
    }
    assert.equal((await post(base, `/api/sync/jobs/${jobId}/fail`, {
      workerId, errorCode, error: "controlled retry failure", recoveryAction: "retry"
    })).status, 200);
    const store = createRouterRunStore({ storeRoot: root });
    await waitFor(async () => (await store.get(routerRun.id, scope)).status ===
      (errorCode === "manual_cancelled" ? "cancelled" : "failed"));
    await waitFor(async () => (await getSyncJob(root, jobId)).routerTerminalSignalPending === false);
    assert.equal((await post(base, "/api/extension/heartbeat", {
      href: projectUrl, workerId, pageStatus: { state: "ready", code: "ready" }
    })).status, 200);
    await operation({ root, base, project, scope, store, routerRun, jobId, workerId, projectUrl });
  } finally {
    await server.close();
  }
}

for (const code of ["input_artifact_fetch_failed", "preference_not_applied", "pre_send_stale", "composer_text_not_applied"]) {
  test(`Router retry retains the original stage after unsent ${code}`, async () => {
    await withFailedRouter(code, async ({ root, base, project, scope, store, routerRun, jobId, workerId, projectUrl }) => {
      const original = await getSyncJob(root, jobId);
      const messageCount = (await listRoomMessages(root, { conversationId: project.conversationId })).length;
      const response = await post(base, `/api/sync/jobs/${jobId}/retry?projectId=${project.id}`);
      assert.equal(response.status, 200);
      const { syncJob } = await response.json();
      assert.equal(syncJob.id, jobId);
      assert.equal(syncJob.status, "pending");
      assert.equal(syncJob.routerRunId, routerRun.id);
      assert.equal(syncJob.projectId, project.id);
      assert.equal(syncJob.codexThreadId, scope.codexThreadId);
      assert.equal(syncJob.routerTerminalSignalRequired, true);
      assert.deepEqual(syncJob.inputArtifacts, original.inputArtifacts);
      assert.equal(syncJob.sourceMessageId, original.sourceMessageId);
      assert.equal(syncJob.payloadText, original.payloadText);
      assert.equal(syncJob.modePreference, "high");
      assert.equal(syncJob.modelPreference, "gpt-5.6-sol");
      assert.equal((await listSyncJobs(root)).length, 1);
      assert.equal((await listRoomMessages(root, { conversationId: project.conversationId })).length, messageCount);
      const observed = await createBridgeTools({storeRoot:root,currentCodexThreadId:scope.codexThreadId}).getRouterRunStatus({projectId:project.id,conversationId:project.conversationId,runId:routerRun.id});
      assert.equal(observed.observationState,"recovering");
      assert.equal(observed.routerRun.status,"queued");
      assert.equal(observed.nextAction.runId,routerRun.id);
      const duplicate = await post(base, `/api/sync/jobs/${jobId}/retry?projectId=${project.id}`);
      assert.equal(duplicate.status, 409);
      const claimed = await post(base, "/api/sync/jobs/claim", { projectUrl, workerId });
      assert.equal((await claimed.json()).job.id, jobId);
      assert.equal((await post(base, `/api/sync/jobs/${jobId}/complete`, { workerId, replyText: "INPUT_OK" })).status, 200);
      const next = await waitFor(async () => {
        const run = await store.get(routerRun.id, scope);
        return run.stages[1].status === "queued" ? run : null;
      });
      assert.equal(next.stages[0].status, "succeeded");
      assert.equal(next.stages[0].transportRequestId, jobId);
      const nextJob = await getSyncJob(root, next.stages[1].transportRequestId);
      assert.deepEqual(nextJob.inputArtifacts, []);
      assert.equal((await listSyncJobs(root)).length, 2);
      assert.equal((await post(base, `/api/sync/jobs/${nextJob.id}/complete`, { replyText: "NEXT_OK" })).status, 200);
      await waitFor(async () => (await store.get(routerRun.id, scope)).status === "succeeded");
    });
  });
}

for (const [code, sent] of [["manual_cancelled", false], ["unknown_failure", true]]) {
  test(`Router retry does not create an unlinked replacement for ${code}`, async () => {
    await withFailedRouter(code, async ({ root, base, project, jobId }) => {
      const before = await getSyncJob(root, jobId);
      const messages = (await listRoomMessages(root, { conversationId: project.conversationId })).length;
      const response = await post(base, `/api/sync/jobs/${jobId}/retry?projectId=${project.id}`);
      assert.equal(response.status, 409);
      assert.equal((await listSyncJobs(root)).length, 1);
      assert.equal((await listRoomMessages(root, { conversationId: project.conversationId })).length, messages);
      assert.deepEqual(await getSyncJob(root, jobId), before);
    }, { sent });
  });
}

test("concurrent Router retries keep one transport job and apply explicit model correction", async () => {
  await withFailedRouter("preference_not_applied", async ({ root, base, project, jobId }) => {
    const route = `/api/sync/jobs/${jobId}/retry?projectId=${project.id}`;
    const replies = await Promise.all(Array.from({ length: 4 }, () =>
      post(base, route, { modelPreference: "gpt-5.5", modePreference: "high" })));
    assert.ok(replies.some(response => response.status === 200));
    assert.ok(replies.every(response => [200, 409].includes(response.status)));
    const jobs = await listSyncJobs(root);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, jobId);
    assert.equal(jobs[0].status, "pending");
    assert.equal(jobs[0].modelPreference, "gpt-5.5");
    assert.equal(jobs[0].modePreference, "high");
  });
});

test("Router retry rejects a different project without modifying the failed job", async () => {
  await withFailedRouter("input_artifact_fetch_failed", async ({ root, base, jobId }) => {
    const before = await getSyncJob(root, jobId);
    const response = await post(base, `/api/sync/jobs/${jobId}/retry?projectId=project_foreign`);
    assert.ok([404, 409].includes(response.status));
    assert.deepEqual(await getSyncJob(root, jobId), before);
    assert.equal((await listSyncJobs(root)).length, 1);
  });
});
