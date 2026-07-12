import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimNextSyncJob,
  completeSyncJob,
  createSyncJob,
  failSyncJob,
  getSyncJob,
  listSyncJobs,
  markSyncJobSent
} from "../src/sync-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-sync-"));
}

function runNodeChild(source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`sync-store child exited ${code}: ${stderr}`));
      }
    });
  });
}

test("createSyncJob persists a pending ChatGPT project sync job", async () => {
  const storeRoot = await tempStore();

  const job = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "请分析这个任务。",
    sourceMessageId: "msg_1",
    modePreference: "balanced",
    modelPreference: "gpt-5.5"
  });

  assert.match(job.id, /^sync_\d{8}T\d{6}_/);
  assert.equal(job.kind, "user_request");
  assert.equal(job.status, "pending");
  assert.equal(job.modePreference, "balanced");
  assert.equal(job.modelPreference, "gpt-5.5");

  const saved = await getSyncJob(storeRoot, job.id);
  assert.equal(saved.modePreference, "balanced");
  assert.equal(saved.modelPreference, "gpt-5.5");
  assert.equal(saved.payloadText, "请分析这个任务。");
});

test("createSyncJob idempotently reuses an explicit Router request id", async () => {
  const storeRoot = await tempStore();
  const input = {
    id: "sync_router_run_1_stage_gpt",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-idempotent",
    targetRepo: "F:/game_code/demo",
    conversationId: "router-conversation",
    payloadText: "Idempotent Router payload"
  };

  const first = await createSyncJob(storeRoot, input);
  const second = await createSyncJob(storeRoot, input);

  assert.equal(first.id, input.id);
  assert.deepEqual(second, first);
  assert.equal((await listSyncJobs(storeRoot)).length, 1);
  await assert.rejects(
    () => createSyncJob(storeRoot, { ...input, payloadText: "different payload" }),
    /already exists.*different payload/i
  );
});

test("createSyncJob rejects likely question-mark encoding loss before GPT sees it", async () => {
  const storeRoot = await tempStore();

  await assert.rejects(
    () =>
      createSyncJob(storeRoot, {
        kind: "user_request",
        projectUrl: "https://chatgpt.com/project/demo",
        payloadText: "????? 10 ????????? AI ?????????????",
        sourceMessageId: "msg_corrupt"
      }),
    /编码异常/
  );
});

test("createSyncJob preserves input artifact upload URLs for extension-side attachment reads", async () => {
  const storeRoot = await tempStore();

  const job = await createSyncJob(storeRoot, {
    kind: "codex_file_analysis",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "请分析附件。",
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        sizeBytes: 549,
        downloadUrl: "/api/artifacts/artifact_zip/download",
        uploadUrl: "/api/artifacts/artifact_zip/raw"
      }
    ]
  });

  assert.equal(job.inputArtifacts[0].downloadUrl, "/api/artifacts/artifact_zip/download");
  assert.equal(job.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_zip/raw");

  const saved = await getSyncJob(storeRoot, job.id);
  assert.equal(saved.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_zip/raw");
});

test("createSyncJob rewrites mistaken download upload URLs to raw attachment URLs", async () => {
  const storeRoot = await tempStore();

  const job = await createSyncJob(storeRoot, {
    kind: "codex_file_analysis",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "请分析这个压缩包",
    inputArtifacts: [
      {
        id: "artifact_zip_download_upload",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        sizeBytes: 549,
        downloadUrl: "/api/artifacts/artifact_zip_download_upload/download",
        uploadUrl: "/api/artifacts/artifact_zip_download_upload/download"
      }
    ]
  });

  assert.equal(job.inputArtifacts[0].downloadUrl, "/api/artifacts/artifact_zip_download_upload/download");
  assert.equal(job.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_zip_download_upload/raw");

  const saved = await getSyncJob(storeRoot, job.id);
  assert.equal(saved.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_zip_download_upload/raw");
});

test("createSyncJob rebuilds raw upload URLs for legacy input artifacts", async () => {
  const storeRoot = await tempStore();

  const job = await createSyncJob(storeRoot, {
    kind: "codex_file_analysis",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "请分析旧任务附件。",
    inputArtifacts: [
      {
        id: "artifact_id_only",
        filename: "legacy-id-only.zip",
        contentType: "application/zip",
        sizeBytes: 549
      },
      {
        id: "artifact_empty_upload",
        filename: "legacy-empty-upload.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 123,
        downloadUrl: "/api/artifacts/artifact_empty_upload/download",
        uploadUrl: ""
      }
    ]
  });

  assert.equal(job.inputArtifacts[0].downloadUrl, "/api/artifacts/artifact_id_only/download");
  assert.equal(job.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_id_only/raw");
  assert.equal(job.inputArtifacts[1].downloadUrl, "/api/artifacts/artifact_empty_upload/download");
  assert.equal(job.inputArtifacts[1].uploadUrl, "/api/artifacts/artifact_empty_upload/raw");
});

test("claimNextSyncJob matches the active ChatGPT project URL and marks it running", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "同步内容"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "chrome-extension"
  });

  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.workerId, "chrome-extension");

  const pending = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "chrome-extension"
  });
  assert.equal(pending.id, job.id);
  assert.equal(pending.status, "running");
  assert.equal(pending.sentAt, null);
});

test("claimNextSyncJob does not force a pre-send refresh for a fresh ready-page job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "hello"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension"
  });

  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.sentAt, null);
  assert.equal(claimed._bridgeNeedsPreSendRefresh, undefined);
  assert.equal(claimed._bridgePreSendRefresh, undefined);
});

test("claimNextSyncJob preserves an explicit forced pre-send refresh request", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "hello"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension",
    forcePreSendRefresh: true
  });

  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.sentAt, null);
  assert.equal(claimed._bridgeNeedsPreSendRefresh, true);
  assert.equal(claimed._bridgePreSendRefresh, undefined);
});

test("claimNextSyncJob normalizes legacy input artifact upload URLs before handing them to the extension", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "codex_file_analysis",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "请分析这个旧压缩包。",
    inputArtifacts: [
      {
        id: "artifact_legacy_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        sizeBytes: 549,
        downloadUrl: "/api/artifacts/artifact_legacy_zip/download",
        uploadUrl: "/api/artifacts/artifact_legacy_zip/raw"
      }
    ]
  });

  const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const oldShapeJob = JSON.parse(await readFile(jobPath, "utf8"));
  oldShapeJob.inputArtifacts = [
    {
      id: "artifact_legacy_zip",
      filename: "Codex-Setup-Tool.zip",
      contentType: "application/zip",
      sizeBytes: 549,
      downloadUrl: "/api/artifacts/artifact_legacy_zip/download"
    }
  ];
  await writeFile(jobPath, `${JSON.stringify(oldShapeJob, null, 2)}\n`, "utf8");

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "chrome-extension"
  });

  assert.equal(claimed.inputArtifacts[0].downloadUrl, "/api/artifacts/artifact_legacy_zip/download");
  assert.equal(claimed.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_legacy_zip/raw");

  const saved = JSON.parse(await readFile(jobPath, "utf8"));
  assert.equal(saved.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_legacy_zip/raw");
});

test("claimNextSyncJob lets a current worker take over an unsent running job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "你好"
  });

  const oldClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "old-extension"
  });
  assert.equal(oldClaim.id, job.id);
  assert.equal(oldClaim.sentAt, null);

  const currentClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "current-extension"
  });

  assert.equal(currentClaim.id, job.id);
  assert.equal(currentClaim.status, "running");
  assert.equal(currentClaim.workerId, "current-extension");
  assert.equal(currentClaim.sentAt, null);
});

test("claimNextSyncJob ignores ChatGPT fallback query parameters", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/6a3d55ba-ca10-83ea-8273-1eb75b124596",
    payloadText: "Generate a spreadsheet"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/6a3d55ba-ca10-83ea-8273-1eb75b124596?mweb_fallback=1",
    workerId: "chrome-extension"
  });

  assert.equal(claimed.id, job.id);
  assert.equal(claimed.status, "running");
});

test("claimNextSyncJob does not treat the ChatGPT root page as a bound conversation", async () => {
  const storeRoot = await tempStore();
  await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/6a3d55ba-ca10-83ea-8273-1eb75b124596",
    payloadText: "Analyze a screenshot"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/",
    workerId: "chrome-extension"
  });

  assert.equal(claimed, null);
});

test("claimNextSyncJob ignores legacy preference sync jobs", async () => {
  const storeRoot = await tempStore();
  await createSyncJob(storeRoot, {
    kind: "preference_sync",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Bridge preference sync",
    modePreference: "advanced",
    modelPreference: "gpt-5.4"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "old-extension"
  });

  assert.equal(claimed, null);
});

test("claimNextSyncJob resumes a sent running job after the ChatGPT page reloads", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Generate an image"
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "chrome-extension:first"
  });
  await markSyncJobSent(storeRoot, claimed.id, {
    workerId: "chrome-extension:first",
    previousAssistantText: "old answer"
  });

  const resumed = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    workerId: "chrome-extension:after-reload"
  });

  assert.equal(resumed.id, job.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.resume, true);
  assert.equal(resumed.workerId, "chrome-extension:after-reload");
  assert.equal(resumed.previousAssistantText, "old answer");
  assert.ok(resumed.sentAt);
});

test("markSyncJobSent preserves sentAt when the same sent job reports again", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Generate an image"
  });

  const first = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:first"
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:retry"
  });

  assert.equal(second.workerId, "chrome-extension:retry");
  assert.equal(second.sentAt, first.sentAt);
});

test("markSyncJobSent can refresh sentAt for an explicit resend", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Generate an image again"
  });

  const first = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:first"
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:resend",
    refreshSentAt: true
  });

  assert.equal(second.workerId, "chrome-extension:resend");
  assert.notEqual(second.sentAt, first.sentAt);
});

test("completeSyncJob stores the ChatGPT reply and listSyncJobs returns newest first", async () => {
  const storeRoot = await tempStore();
  const first = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "one"
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await createSyncJob(storeRoot, {
    kind: "codex_result",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "two"
  });

  const completed = await completeSyncJob(storeRoot, first.id, {
    replyText: "ChatGPT 已分析。",
    thoughtDurationMs: 48000
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.replyText, "ChatGPT 已分析。");
  assert.equal(completed.thoughtDurationMs, 48000);

  const jobs = await listSyncJobs(storeRoot);
  assert.deepEqual(jobs.map((job) => job.id), [second.id, first.id]);
});

test("failSyncJob does not overwrite an already completed sync job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "hello"
  });

  await completeSyncJob(storeRoot, job.id, {
    replyText: "hi"
  });
  const failed = await failSyncJob(storeRoot, job.id, {
    error: "late timeout"
  });

  assert.equal(failed.status, "succeeded");
  assert.equal(failed.replyText, "hi");
  assert.equal(failed.error, null);
});

test("failSyncJob stores structured failure details and completeSyncJob clears them", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "hello"
  });

  const failed = await failSyncJob(storeRoot, job.id, {
    error: "ChatGPT did not show the submitted prompt after clicking send.",
    errorCode: "send_not_confirmed",
    recoveryAction: "manual_send_or_refresh",
    failureDetails: {
      reason: "send_not_confirmed",
      composerStillContainsDraft: true
    }
  });

  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.failureDetails, {
    reason: "send_not_confirmed",
    composerStillContainsDraft: true
  });

  const next = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "hello again"
  });
  await failSyncJob(storeRoot, next.id, {
    error: "temporary",
    failureDetails: {
      reason: "temporary"
    }
  });
  const completed = await completeSyncJob(storeRoot, next.id, {
    replyText: "done"
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.failureDetails, null);
});

test("concurrent completion and cancellation keep sync job JSON valid and preserve success", async () => {
  const storeRoot = await tempStore();
  const jobs = [];
  for (let index = 0; index < 24; index += 1) {
    jobs.push(
      await createSyncJob(storeRoot, {
        id: `sync_router_race_${index}`,
        kind: "chat_message",
        projectUrl: "https://chatgpt.com/c/sync-race",
        conversationId: "sync-race-conversation",
        payloadText: `race payload ${index}`
      })
    );
  }

  await Promise.all(
    jobs.flatMap((job, index) => [
      completeSyncJob(storeRoot, job.id, { replyText: `completed ${index}` }),
      failSyncJob(storeRoot, job.id, {
        error: "cancelled concurrently",
        errorCode: "manual_cancelled"
      })
    ])
  );

  for (let index = 0; index < jobs.length; index += 1) {
    const finalJob = await getSyncJob(storeRoot, jobs[index].id);
    assert.equal(finalJob.status, "succeeded");
    assert.equal(finalJob.replyText, `completed ${index}`);
  }
});

test("cross-process completion and cancellation use the same sync job lock", async () => {
  const storeRoot = await tempStore();
  const moduleUrl = new URL("../src/sync-store.js", import.meta.url).href;
  const jobs = [];
  for (let index = 0; index < 8; index += 1) {
    jobs.push(
      await createSyncJob(storeRoot, {
        id: `sync_router_process_race_${index}`,
        kind: "chat_message",
        projectUrl: "https://chatgpt.com/c/process-race",
        conversationId: "process-race-conversation",
        payloadText: `process race ${index}`
      })
    );
  }

  await Promise.all(
    jobs.flatMap((job, index) => [
      runNodeChild(
        `import { completeSyncJob } from ${JSON.stringify(moduleUrl)};` +
          `await completeSyncJob(${JSON.stringify(storeRoot)}, ${JSON.stringify(job.id)}, ` +
          `{ replyText: ${JSON.stringify(`process completed ${index}`)} });`
      ),
      runNodeChild(
        `import { failSyncJob } from ${JSON.stringify(moduleUrl)};` +
          `await failSyncJob(${JSON.stringify(storeRoot)}, ${JSON.stringify(job.id)}, ` +
          `{ error: "process cancel", errorCode: "manual_cancelled" });`
      )
    ])
  );

  for (let index = 0; index < jobs.length; index += 1) {
    const finalJob = await getSyncJob(storeRoot, jobs[index].id);
    assert.ok(["succeeded", "failed"].includes(finalJob.status));
    if (finalJob.status === "succeeded") {
      assert.equal(finalJob.replyText, `process completed ${index}`);
      assert.equal(finalJob.errorCode, null);
    } else {
      assert.equal(finalJob.errorCode, "manual_cancelled");
      assert.notEqual(finalJob.replyText, `process completed ${index}`);
    }
  }
});

test("concurrent claim cannot revive a cancelled sync job", async () => {
  const storeRoot = await tempStore();
  const jobs = [];
  for (let index = 0; index < 24; index += 1) {
    jobs.push(
      await createSyncJob(storeRoot, {
        id: `sync_router_claim_cancel_${index}`,
        kind: "chat_message",
        projectUrl: `https://chatgpt.com/c/claim-cancel-${index}`,
        conversationId: `claim-cancel-${index}`,
        payloadText: `claim cancel ${index}`
      })
    );
  }

  const raceResults = await Promise.all(
    jobs.flatMap((job, index) => [
      claimNextSyncJob(storeRoot, {
        projectUrl: `https://chatgpt.com/c/claim-cancel-${index}`,
        workerId: `worker-${index}`
      }),
      failSyncJob(storeRoot, job.id, {
        error: "cancelled before claim",
        errorCode: "manual_cancelled"
      })
    ])
  );

  for (let index = 0; index < jobs.length; index += 1) {
    const claimResult = raceResults[index * 2];
    assert.ok(claimResult === null || claimResult.status === "running");
  }

  for (const job of jobs) {
    const finalJob = await getSyncJob(storeRoot, job.id);
    assert.equal(finalJob.status, "failed");
    assert.equal(finalJob.errorCode, "manual_cancelled");
  }
});

test("manual cancellation preserves an existing real failure", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_real_failure",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/real-failure",
    payloadText: "real failure"
  });
  await failSyncJob(storeRoot, job.id, {
    error: "generation failed",
    errorCode: "generation_failed"
  });

  const afterCancel = await failSyncJob(storeRoot, job.id, {
    error: "manual cancel",
    errorCode: "manual_cancelled"
  });

  assert.equal(afterCancel.status, "failed");
  assert.equal(afterCancel.error, "generation failed");
  assert.equal(afterCancel.errorCode, "generation_failed");
});

test("late completion cannot revive a manually cancelled sync job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_cancel_terminal",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/cancel-terminal",
    payloadText: "cancel terminal"
  });
  await failSyncJob(storeRoot, job.id, {
    error: "manual cancel",
    errorCode: "manual_cancelled"
  });

  const lateCompletion = await completeSyncJob(storeRoot, job.id, {
    replyText: "too late"
  });

  assert.equal(lateCompletion.status, "failed");
  assert.equal(lateCompletion.errorCode, "manual_cancelled");
  assert.notEqual(lateCompletion.replyText, "too late");
});
