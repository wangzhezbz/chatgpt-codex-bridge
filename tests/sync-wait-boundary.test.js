import assert from "node:assert/strict";
import { mkdir, readFile, unlink, rmdir } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import { waitForSyncJobResult } from "../src/gpt-file-analysis.js";
import { createSyncJob, completeSyncJob, failSyncJob, getSyncJob } from "../src/sync-store.js";

test("file analysis sanitizes standalone stream failures without hiding explanatory text", async () => {
  const source = await readFile("src/gpt-file-analysis.js", "utf8");
  const c = vm.createContext({});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), c);
  for (const text of ["消息流中的错误", "Error in message stream", "Error in message stream. Try again"])
    assert.match(c.sanitizeGptFileAnalysisReply(text), /没有拿到最终可用回复/);
  const explanation = "昨天出现“消息流中的错误”，今天结果已正常返回。";
  assert.equal(c.sanitizeGptFileAnalysisReply(explanation), explanation);
});

for (const winner of ["succeeded", "manual_cancelled", "generation_failed", "reply_timeout"]) {
  test(`timeout mutation preserves the result that wins the store lock: ${winner}`, async t => {
    const root = path.resolve(".bridge", `test-wait-lock-${process.pid}-${winner}-${Date.now()}`);
    await mkdir(root);
    const job = await createSyncJob(root, { id: "sync_wait_lock", kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/lock-test", payloadText: "isolated test" });
    t.after(async () => {
      await unlink(path.join(root, "sync", "jobs", `${job.id}.json`));
      await rmdir(path.join(root, "sync", "jobs"));
      await rmdir(path.join(root, "sync"));
      await rmdir(root);
    });
    let clock = 0, timeoutAttempts = 0;
    class Clock extends Date { static now() { return clock += 10; } }
    // Run the real wait module and real file store. Inject the competing write
    // immediately before failSyncJob takes its lock, not a fake final result.
    const context = vm.createContext({ Date: Clock, path, setTimeout, clearTimeout, getSyncJob,
      failSyncJob: async (store, id, input) => {
        timeoutAttempts++;
        if (winner === "succeeded") await completeSyncJob(store, id, { replyText: "LOCK_WINNER_RESULT", artifactIds: ["artifact_lock_winner"] });
        else if (winner !== "reply_timeout") await failSyncJob(store, id, { errorCode: winner, error: "Original failure" });
        return failSyncJob(store, id, input);
      }
    });
    const source = await readFile("src/gpt-file-analysis.js", "utf8");
    vm.runInContext(source.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
    const result = await context.waitForSyncJobResult(root, job.id, { timeoutMs: 1, timeoutGraceMs: 0, failOnTimeout: true });
    assert.equal(timeoutAttempts, 1);
    assert.equal(result.timedOut, winner === "reply_timeout");
    assert.equal(result.finalJob.status, winner === "succeeded" ? "succeeded" : "failed");
    if (winner === "succeeded") {
      assert.equal(result.replyText, "LOCK_WINNER_RESULT");
      assert.deepEqual(result.finalJob.artifactIds, ["artifact_lock_winner"]);
    } else assert.equal(result.finalJob.errorCode, winner);
    assert.equal((await getSyncJob(root, job.id)).status, result.finalJob.status);
  });
}

for (const terminal of ["succeeded", "manual_cancelled"]) {
  for (const failOnTimeout of [false, true]) {
    test(`wait deadline returns the result committed during its last sleep: ${terminal}/${failOnTimeout}`, async t => {
      const root = path.resolve(".bridge", `test-wait-boundary-${process.pid}-${terminal}-${failOnTimeout}-${Date.now()}`);
      await mkdir(root);
      const job = await createSyncJob(root, {
        id: "sync_wait_boundary", kind: "user_request", projectUrl: "https://chatgpt.com/c/wait-boundary",
        targetRepo: root, conversationId: "conv_wait_boundary", payloadText: "isolated boundary test"
      });
      t.after(async () => {
        t.mock.restoreAll();
        await unlink(path.join(root, "sync", "jobs", `${job.id}.json`));
        await rmdir(path.join(root, "sync", "jobs"));
        await rmdir(path.join(root, "sync"));
        await rmdir(root);
      });
      let now = Date.now(), slept = false, completionError;
      const realSetTimeout = globalThis.setTimeout;
      t.mock.method(Date, "now", () => now);
      t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        if (ms !== 100 || slept) return realSetTimeout(callback, ms, ...args);
        slept = true;
        return realSetTimeout(async () => {
          try {
            if (terminal === "succeeded") await completeSyncJob(root, job.id, { replyText: "BOUNDARY_RESULT" });
            else await failSyncJob(root, job.id, { error: "Stopped by user", errorCode: "manual_cancelled" });
          } catch (error) { completionError = error; }
          now += 101;
          callback(...args);
        }, 0);
      });
      const result = await waitForSyncJobResult(root, job.id, {
        timeoutMs: 100, pollMs: 100, timeoutGraceMs: 0, failOnTimeout
      });
      assert.equal(completionError, undefined);
      assert.equal(slept, true);
      const stored = await getSyncJob(root, job.id);
      assert.equal(stored.status, terminal === "succeeded" ? "succeeded" : "failed");
      assert.equal(result.finalJob.status, stored.status, "must not return the stale pre-sleep pending snapshot");
      assert.equal(result.timedOut, false, "a committed result is not a wait timeout");
      assert.equal(result.stillRunning, false);
      assert.equal(result.observationTimedOut, false);
      if (terminal === "succeeded") assert.equal(result.replyText, "BOUNDARY_RESULT");
      else assert.equal(result.finalJob.errorCode, "manual_cancelled");
    });
  }
}
