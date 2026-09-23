import assert from "node:assert/strict";
import { mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TIMEOUT_GRACE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  queueArtifactForGptAnalysis,
  waitForSyncJobResult
} from "../src/gpt-file-analysis.js";
import { createSyncJob } from "../src/sync-store.js";

test("default GPT wait window is enlarged for long creative work", () => {
  assert.equal(DEFAULT_WAIT_TIMEOUT_MS, 15 * 60_000);
  assert.equal(DEFAULT_TIMEOUT_GRACE_MS, 2 * 60_000);
});

test("file analysis preserves case-sensitive targetRepo comparison off Windows", async () => {
  await assert.rejects(
    () => queueArtifactForGptAnalysis(path.resolve(".bridge", "file-case-scope"), {
      workspace: {
        conversationId: "file-case-scope-conversation",
        targetRepo: "F:/Game_Code/CaseSensitive"
      },
      artifact: {
        id: "artifact-file-case-scope",
        filename: "scope.txt",
        contentType: "text/plain",
        sizeBytes: 1,
        downloadUrl: "/api/artifacts/artifact-file-case-scope/download"
      },
      metadata: { targetRepo: "F:/game_code/casesensitive" },
      scopePlatform: "linux"
    }),
    /scope mismatch.*targetRepo/i
  );
});

test("an observation deadline keeps a live sync job running instead of reporting a task timeout", async (t) => {
  const storeRoot = path.resolve(".bridge", `test-live-wait-${process.pid}-${Date.now()}`);
  const syncDir = path.join(storeRoot, "sync");
  const syncJobsDir = path.join(syncDir, "jobs");
  await mkdir(storeRoot, { recursive: false });

  const job = await createSyncJob(storeRoot, {
    id: `sync_live_wait_${Date.now()}`,
    kind: "user_request",
    projectUrl: "https://chatgpt.com/c/live-wait",
    targetRepo: "F:\\game_code\\live-wait",
    conversationId: "conv_live_wait",
    payloadText: "keep generating"
  });

  t.after(async () => {
    await rm(path.join(syncJobsDir, `${job.id}.json`), { force: true });
    await rmdir(syncJobsDir);
    await rmdir(syncDir);
    await rmdir(storeRoot);
  });

  const result = await waitForSyncJobResult(storeRoot, job.id, {
    timeoutMs: 5,
    timeoutGraceMs: 0,
    pollMs: 1,
    failOnTimeout: false
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.stillRunning, true);
  assert.equal(result.observationTimedOut, true);
  assert.equal(result.finalJob.status, "pending");
});
