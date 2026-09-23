import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, open, readFile, unlink, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  backfillSyncJobRouterScope,
  claimNextSyncJob,
  completeSyncJob,
  createSyncJob,
  failSyncJob,
  getSyncJob,
  listSyncJobs,
  markSyncJobRecoveryIssued,
  markSyncJobRouterTerminalReconciled,
  markSyncJobSent,
  recordSyncJobRouterTerminalReconciliationFailure,
  reopenFailedSyncJobForCapture,
  reopenFailedSyncJobForResend,
  withSyncJobRouterTerminalReconciliationLease
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
    modePreference: "high",
    modelPreference: "gpt-5.6-sol"
  });

  assert.match(job.id, /^sync_\d{8}T\d{6}_/);
  assert.equal(job.kind, "user_request");
  assert.equal(job.status, "pending");
  assert.equal(job.routerTerminalSignalRequired, false);
  assert.equal(job.modePreference, "high");
  assert.equal(job.modelPreference, "gpt-5.6-sol");

  const saved = await getSyncJob(storeRoot, job.id);
  assert.equal(saved.modePreference, "high");
  assert.equal(saved.modelPreference, "gpt-5.6-sol");
  assert.equal(saved.payloadText, "请分析这个任务。");
});

test("ordinary sync jobs do not request Router terminal reconciliation when they finish", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl: "https://chatgpt.com/c/ordinary-terminal",
    targetRepo: "F:/game_code/ordinary-terminal",
    conversationId: "ordinary-terminal-conversation",
    payloadText: "Complete without creating Router replay work."
  });

  const completed = await completeSyncJob(storeRoot, job.id, {
    replyText: "Ordinary result"
  });

  assert.equal(completed.routerTerminalSignalRequired, false);
  assert.equal(completed.routerTerminalSignalPending, false);
  assert.equal(completed.routerTerminalReconciledAt, null);

  const failedJob = await createSyncJob(storeRoot, {
    kind: "user_request",
    projectUrl: "https://chatgpt.com/c/ordinary-terminal",
    targetRepo: "F:/game_code/ordinary-terminal",
    conversationId: "ordinary-terminal-conversation",
    payloadText: "Fail without creating Router replay work."
  });
  const failed = await failSyncJob(storeRoot, failedJob.id, {
    error: "Ordinary failure"
  });
  assert.equal(failed.routerTerminalSignalRequired, false);
  assert.equal(failed.routerTerminalSignalPending, false);
  assert.equal(failed.routerTerminalReconciledAt, null);
});

test("createSyncJob idempotently reuses an explicit Router request id", async () => {
  const storeRoot = await tempStore();
  const input = {
    id: "sync_router_run_1_stage_gpt",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-idempotent",
    targetRepo: "F:/game_code/demo",
    conversationId: "router-conversation",
    projectId: "router-project",
    codexThreadId: "router-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-idempotent",
    payloadText: "Idempotent Router payload"
  };

  const first = await createSyncJob(storeRoot, input);
  const second = await createSyncJob(storeRoot, {
    ...input,
    targetRepo: process.platform === "win32" ? input.targetRepo.toLowerCase() : input.targetRepo
  });

  assert.equal(first.id, input.id);
  assert.equal(first.routerTerminalSignalRequired, true);
  assert.equal(first.routerRunId, "router-run-idempotent");
  assert.equal(first.routerTerminalScopeVersion, 1);
  assert.deepEqual(second, first);
  assert.equal((await listSyncJobs(storeRoot)).length, 1);
  await assert.rejects(
    () => createSyncJob(storeRoot, { ...input, payloadText: "different payload" }),
    /already exists.*different payload/i
  );
});

test("explicit sync job reuse atomically promotes Router ownership and rejects cross-run reuse", async () => {
  const storeRoot = await tempStore();
  const input = {
    id: "sync_explicit_router_promotion",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-promotion",
    targetRepo: "F:/game_code/router-promotion",
    conversationId: "router-promotion-conversation",
    projectId: "router-promotion-project",
    codexThreadId: "router-promotion-thread",
    payloadText: "Promote this existing request to Router ownership."
  };

  const ordinary = await createSyncJob(storeRoot, input);
  assert.equal(ordinary.routerTerminalSignalRequired, false);
  assert.equal(ordinary.routerRunId, null);

  const promoted = await createSyncJob(storeRoot, {
    ...input,
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-promotion-a"
  });
  assert.equal(promoted.routerTerminalSignalRequired, true);
  assert.equal(promoted.routerRunId, "router-run-promotion-a");
  assert.deepEqual(await getSyncJob(storeRoot, input.id), promoted);

  const notDowngraded = await createSyncJob(storeRoot, {
    ...input,
    routerTerminalSignalRequired: false
  });
  assert.equal(notDowngraded.routerTerminalSignalRequired, true);
  assert.equal(notDowngraded.routerRunId, "router-run-promotion-a");

  await assert.rejects(
    () =>
      createSyncJob(storeRoot, {
        ...input,
        routerTerminalSignalRequired: true,
        routerRunId: "router-run-promotion-b"
      }),
    /different Router run/i
  );
});

for (const terminalStatus of ["succeeded", "failed"]) {
  test(`late Router ownership promotion replays an already ${terminalStatus} sync job`, async () => {
    const storeRoot = await tempStore();
    const input = {
      id: `sync_late_router_${terminalStatus}`,
      kind: "chat_message",
      projectUrl: `https://chatgpt.com/c/late-router-${terminalStatus}`,
      targetRepo: `F:/game_code/late-router-${terminalStatus}`,
      conversationId: `late-router-${terminalStatus}-conversation`,
      projectId: `late-router-${terminalStatus}-project`,
      codexThreadId: `late-router-${terminalStatus}-thread`,
      payloadText: `Promote the ${terminalStatus} result after Router ownership arrives.`
    };
    const job = await createSyncJob(storeRoot, input);
    if (terminalStatus === "succeeded") {
      await completeSyncJob(storeRoot, job.id, { replyText: "Terminal result" });
    } else {
      await failSyncJob(storeRoot, job.id, { error: "Terminal failure" });
    }
    const acknowledged = await markSyncJobRouterTerminalReconciled(storeRoot, job.id);
    assert.equal(acknowledged.routerTerminalSignalPending, false);
    assert.ok(acknowledged.routerTerminalReconciledAt);

    const promoted = await createSyncJob(storeRoot, {
      ...input,
      routerTerminalSignalRequired: true,
      routerRunId: `router-run-late-${terminalStatus}`
    });

    assert.equal(promoted.status, terminalStatus);
    assert.equal(promoted.routerTerminalSignalRequired, true);
    assert.equal(promoted.routerTerminalSignalPending, true);
    assert.equal(promoted.routerTerminalReconciledAt, null);
  });
}

test("legacy Router id fallback applies only when the marker is omitted", async () => {
  const storeRoot = await tempStore();
  const base = {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-marker-fallback",
    targetRepo: "F:/game_code/router-marker-fallback",
    conversationId: "router-marker-fallback-conversation",
    payloadText: "Test the legacy Router id fallback."
  };

  const fallback = await createSyncJob(storeRoot, {
    ...base,
    id: "sync_router_marker_omitted"
  });
  const explicitFalse = await createSyncJob(storeRoot, {
    ...base,
    id: "sync_router_marker_explicit_false",
    routerTerminalSignalRequired: false
  });

  assert.equal(fallback.routerTerminalSignalRequired, false);
  assert.equal(explicitFalse.routerTerminalSignalRequired, false);
  assert.equal((await getSyncJob(storeRoot, explicitFalse.id)).routerTerminalSignalRequired, false);

  const legacyId = "sync_router_legacy_disk_record";
  const legacyPath = path.join(storeRoot, "sync", "jobs", `${legacyId}.json`);
  const legacy = JSON.parse(
    await readFile(path.join(storeRoot, "sync", "jobs", `${explicitFalse.id}.json`), "utf8")
  );
  legacy.id = legacyId;
  delete legacy.routerTerminalSignalRequired;
  delete legacy.routerRunId;
  await writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
  assert.equal((await getSyncJob(storeRoot, legacyId)).routerTerminalSignalRequired, true);
});

test("new Router terminal jobs require complete ownership and persist scope version 1", async () => {
  const storeRoot = await tempStore();
  const complete = {
    id: "sync_router_complete_scope",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/complete-router-scope",
    targetRepo: "F:/game_code/complete-router-scope",
    conversationId: "complete-router-scope-conversation",
    projectId: "complete-router-scope-project",
    codexThreadId: "complete-router-scope-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "complete-router-scope-run",
    payloadText: "complete Router scope"
  };

  for (const field of ["routerRunId", "projectId", "conversationId", "codexThreadId", "targetRepo"]) {
    const input = { ...complete, id: `sync_router_missing_${field.toLowerCase()}` };
    delete input[field];
    await assert.rejects(
      () => createSyncJob(storeRoot, input),
      new RegExp(`Router terminal scope.*${field}`, "i")
    );
  }

  const created = await createSyncJob(storeRoot, complete);
  assert.equal(created.routerTerminalScopeVersion, 1);
  assert.equal((await getSyncJob(storeRoot, created.id)).routerTerminalScopeVersion, 1);
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

test("claimNextSyncJob lets the same tab take over an unsent job after an extension upgrade", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "你好"
  });

  const oldClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "old-extension:runtime-ok:tab_stable"
  });
  assert.equal(oldClaim.id, job.id);
  assert.equal(oldClaim.sentAt, null);

  const currentClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "current-extension:runtime-ok:tab_stable"
  });

  assert.equal(currentClaim.id, job.id);
  assert.equal(currentClaim.status, "running");
  assert.equal(currentClaim.workerId, "current-extension:runtime-ok:tab_stable");
  assert.equal(currentClaim.sentAt, null);
});

test("claimNextSyncJob prevents a duplicate tab from stealing an unsent running job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "Send this from one tab only."
  });

  const owner = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "current-extension:runtime-ok:tab-a"
  });
  assert.equal(owner.id, job.id);

  const duplicate = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "current-extension:runtime-ok:tab-b"
  });

  assert.equal(duplicate, null);
  assert.equal((await getSyncJob(storeRoot, job.id)).workerId, "current-extension:runtime-ok:tab-a");
});

test("claimNextSyncJob keeps one active job per GPT conversation across duplicate tabs", async () => {
  const storeRoot = await tempStore();
  const projectUrl = "https://chatgpt.com/c/one-active-conversation";
  const first = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    payloadText: "Send this first."
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    payloadText: "Keep this queued until the first task completes."
  });

  const claims = await Promise.all([
    claimNextSyncJob(storeRoot, {
      projectUrl,
      workerId: "current-extension:runtime-ok:tab-a"
    }),
    claimNextSyncJob(storeRoot, {
      projectUrl,
      workerId: "current-extension:runtime-ok:tab-b"
    })
  ]);

  assert.equal(claims.filter(Boolean).length, 1);
  const saved = await Promise.all([getSyncJob(storeRoot, first.id), getSyncJob(storeRoot, second.id)]);
  assert.equal(saved.filter((job) => job.status === "running").length, 1);
  assert.equal(saved.filter((job) => job.status === "pending").length, 1);
});

test("claimNextSyncJob clears a recovery instruction issued to the previous worker", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "continue on the current page only"
  });

  await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "previous-extension:runtime-ok:tab_stable"
  });
  const issued = await markSyncJobRecoveryIssued(storeRoot, job.id, {
    action: "reload",
    workerId: "previous-extension:runtime-ok:tab_stable"
  });
  assert.equal(issued._bridgeRecoveryWorkerId, "previous-extension:runtime-ok:tab_stable");

  const currentClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "current-extension:runtime-ok:tab_stable"
  });

  assert.equal(currentClaim.workerId, "current-extension:runtime-ok:tab_stable");
  assert.equal(currentClaim._bridgeRecoveryIssued, false);
  assert.equal(currentClaim._bridgeRecoveryIssuedAt, null);
  assert.equal(currentClaim._bridgeRecoveryAction, null);
  assert.equal(currentClaim._bridgeRecoveryWorkerId, null);
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
    workerId: "chrome-extension:first"
  });

  assert.equal(resumed.id, job.id);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.resume, true);
  assert.equal(resumed.workerId, "chrome-extension:first");
  assert.equal(resumed.previousAssistantText, "old answer");
  assert.ok(resumed.sentAt);
});

test("claimNextSyncJob expires an abandoned sent job before claiming a fresh pending job", async () => {
  const storeRoot = await tempStore();
  const projectUrl = "https://chatgpt.com/c/bound-chat";
  const abandoned = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl,
    payloadText: "This old task must not block the queue forever."
  });
  await claimNextSyncJob(storeRoot, {
    projectUrl,
    workerId: "current-extension:runtime-ok:tab-stable"
  });
  await markSyncJobSent(storeRoot, abandoned.id, {
    workerId: "current-extension:runtime-ok:tab-stable"
  });

  const abandonedPath = path.join(storeRoot, "sync", "jobs", `${abandoned.id}.json`);
  const abandonedRecord = JSON.parse(await readFile(abandonedPath, "utf8"));
  abandonedRecord.claimedAt = "2026-07-01T00:00:00.000Z";
  abandonedRecord.sentAt = "2026-07-01T00:00:01.000Z";
  abandonedRecord.updatedAt = "2026-07-01T00:00:01.000Z";
  await writeFile(abandonedPath, `${JSON.stringify(abandonedRecord, null, 2)}\n`, "utf8");

  const fresh = await createSyncJob(storeRoot, {
    kind: "image_request",
    projectUrl,
    payloadText: "Generate the current poster."
  });

  const claimed = await claimNextSyncJob(storeRoot, {
    projectUrl,
    workerId: "current-extension:runtime-ok:tab-stable"
  });

  assert.equal(claimed.id, fresh.id);
  assert.equal(claimed.status, "running");
  const expired = await getSyncJob(storeRoot, abandoned.id);
  assert.equal(expired.status, "failed");
  assert.equal(expired.errorCode, "abandoned_running_job");
});

test("claimNextSyncJob prevents a duplicate tab from stealing a sent running job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "Keep this reply capture on one tab."
  });

  await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension:tab-a"
  });
  await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:tab-a",
    previousAssistantText: "old answer"
  });

  const duplicateClaim = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension:tab-b"
  });

  assert.equal(duplicateClaim, null);
  const saved = await getSyncJob(storeRoot, job.id);
  assert.equal(saved.workerId, "chrome-extension:tab-a");
});

test("claimNextSyncJob allows an explicitly assigned recovery tab to resume a sent job", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    payloadText: "Recover this reply on the assigned tab."
  });

  await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension:tab-a"
  });
  await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:tab-a"
  });
  await markSyncJobRecoveryIssued(storeRoot, job.id, {
    action: "capture_existing_reply",
    workerId: "chrome-extension:tab-b"
  });

  const recovered = await claimNextSyncJob(storeRoot, {
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "chrome-extension:tab-b"
  });

  assert.equal(recovered.id, job.id);
  assert.equal(recovered.resume, true);
  assert.equal(recovered.workerId, "chrome-extension:tab-b");
});

test("markSyncJobSent preserves sentAt when the same sent job reports again", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Generate an image"
  });

  const first = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:first",
    submittedPromptTurnIndex: 12
  });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:retry"
  });

  assert.equal(second.workerId, "chrome-extension:retry");
  assert.equal(second.sentAt, first.sentAt);
  assert.equal(second.submittedPromptTurnIndex, 12);
});

test("markSyncJobSent persists the pre-send image baseline for recovery capture", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "image_request",
    projectUrl: "https://chatgpt.com/project/demo",
    payloadText: "Generate a new poster"
  });

  const sent = await markSyncJobSent(storeRoot, job.id, {
    workerId: "chrome-extension:image-baseline",
    artifactBaselineImageKeys: [
      "https://chatgpt.com/backend-api/estuary/content?id=old-1",
      "https://chatgpt.com/backend-api/estuary/content?id=old-2"
    ]
  });

  assert.deepEqual(sent.artifactBaselineImageKeys, [
    "https://chatgpt.com/backend-api/estuary/content?id=old-1",
    "https://chatgpt.com/backend-api/estuary/content?id=old-2"
  ]);
});

test("stable turn identity survives sent acknowledgements without accepting a conflicting retarget",async()=>{
  const storeRoot=await tempStore();
  const job=await createSyncJob(storeRoot,{kind:"chat_message",projectUrl:"https://chatgpt.com/c/stable",payloadText:"same"});
  await markSyncJobSent(storeRoot,job.id,{submittedPromptTurnId:"prompt-stable",submittedPromptTurnIndex:9});
  const read=await markSyncJobSent(storeRoot,job.id,{submittedPromptTurnId:null,submittedPromptTurnIndex:0});
  assert.equal(read.submittedPromptTurnId,"prompt-stable");
  await assert.rejects(markSyncJobSent(storeRoot,job.id,{submittedPromptTurnId:"different-prompt"}),/turn identity/i);
  assert.equal((await getSyncJob(storeRoot,job.id)).submittedPromptTurnId,"prompt-stable");
});

test("stable turn identity validates the persisted ID before altering the job",async()=>{
  const storeRoot=await tempStore();
  const job=await createSyncJob(storeRoot,{kind:"chat_message",projectUrl:"https://chatgpt.com/c/stable-validate",payloadText:"same"});
  for(const bad of ["", " ", "x\nother", "x".repeat(257), 123, {id:"x"}]) {
    await assert.rejects(markSyncJobSent(storeRoot,job.id,{submittedPromptTurnId:bad}),/turn identity/i);
    assert.equal((await getSyncJob(storeRoot,job.id)).sentAt,null);
  }
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

test("reopenFailedSyncJobForResend can recover a confirmed unsent pre-send timeout", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "image_request",
    projectUrl: "https://chatgpt.com/c/medium-prompt",
    payloadText: "海".repeat(3345)
  });
  await claimNextSyncJob(storeRoot, {
    projectUrl: job.projectUrl,
    workerId: "test-extension"
  });
  await failSyncJob(storeRoot, job.id, {
    error: "The page froze before the prompt was sent.",
    errorCode: "pre_send_expired",
    recoveryAction: "retry"
  });

  const reopened = await reopenFailedSyncJobForResend(storeRoot, job.id, {
    allowPreSendExpired: true
  });

  assert.equal(reopened.id, job.id);
  assert.equal(reopened.status, "pending");
  assert.equal(reopened.workerId, null);
  assert.equal(reopened.claimedAt, null);
  assert.equal(reopened.sentAt, null);
  assert.equal(reopened.errorCode, null);
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

test("Windows reconciliation lease retries a transient exclusive-open access race", {skip:process.platform!=="win32"}, async () => {
  const root=await tempStore();
  let attempts=0;
  let operations=0;
  const result=await withSyncJobRouterTerminalReconciliationLease(root,"sync_windows_open_race",async()=>{operations++;return "locked";},{lockOperations:{
    async open(...args){attempts++;if(attempts===1)throw Object.assign(new Error("delete pending"),{code:"EPERM"});return open(...args);}
  }});
  assert.equal(result,"locked");
  assert.equal(attempts,2);
  assert.equal(operations,1);
});

test("Windows reconciliation lease retries an owner-read race before acquiring the lease", {skip:process.platform!=="win32"}, async () => {
  const root=await tempStore();
  const id="sync_windows_owner_read_race";
  let opens=0;
  let reads=0;
  let operations=0;
  await withSyncJobRouterTerminalReconciliationLease(root,id,async()=>{
    operations++;
    const owner=await readFile(path.join(root,"sync","jobs",`${id}.json.reconcile.lock`),"utf8");
    assert.match(owner,new RegExp(`^${process.pid}-`));
  },{lockOperations:{
    async open(...args){opens++;if(opens===1)throw Object.assign(new Error("racing owner released"),{code:"EEXIST"});return open(...args);},
    async readFile(...args){reads++;if(reads===1)throw Object.assign(new Error("owner deletion pending"),{code:"EPERM"});return readFile(...args);}
  }});
  assert.equal(opens,2);
  assert.equal(reads,2);
  assert.equal(operations,1);
});

test("Windows reconciliation access retries remain abortable", {skip:process.platform!=="win32"}, async () => {
  const root=await tempStore();
  const controller=new AbortController();
  let operations=0;
  await assert.rejects(withSyncJobRouterTerminalReconciliationLease(root,"sync_windows_access_abort",async()=>{operations++;},{signal:controller.signal,lockOperations:{
    async open(){controller.abort();throw Object.assign(new Error("sharing violation"),{code:"EPERM"});}
  }}),error=>error.code==="ABORT_ERR");
  assert.equal(operations,0);
});

test("reconciliation lease still rejects non-transient I/O errors", async () => {
  const root=await tempStore();
  let attempts=0;
  let operations=0;
  await assert.rejects(withSyncJobRouterTerminalReconciliationLease(root,"sync_real_io_error",async()=>{operations++;},{lockOperations:{
    async open(){attempts++;throw Object.assign(new Error("disk failure"),{code:"EIO"});}
  }}),error=>error.code==="EIO");
  assert.equal(attempts,1);
  assert.equal(operations,0);
});

test("Windows persistent lock permissions fail within a bound and release the local queue", {skip:process.platform!=="win32",timeout:8_000}, async () => {
  const root=await tempStore();
  const id="sync_windows_persistent_access";
  const permissionError=Object.assign(new Error("permission remains denied"),{code:"EACCES"});
  let attempts=0;
  let operations=0;
  await assert.rejects(withSyncJobRouterTerminalReconciliationLease(root,id,async()=>{operations++;},{lockOperations:{
    async open(){attempts++;throw permissionError;}
  }}),error=>error===permissionError);
  assert.ok(attempts>1);
  assert.equal(operations,0);
  const result=await withSyncJobRouterTerminalReconciliationLease(root,id,async()=>"queue released");
  assert.equal(result,"queue released");
});

test("Router terminal reconciliation lease serializes the same job across processes", async () => {
  const syncStore = await import("../src/sync-store.js");
  assert.equal(
    typeof syncStore.withSyncJobRouterTerminalReconciliationLease,
    "function",
    "sync-store must expose a cross-process Router reconciliation lease"
  );
  const storeRoot = await tempStore();
  const orderPath = path.join(storeRoot, "reconciliation-order.txt");
  const moduleUrl = new URL("../src/sync-store.js", import.meta.url).href;
  let releaseFirst;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const barrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = syncStore.withSyncJobRouterTerminalReconciliationLease(
    storeRoot,
    "sync_router_cross_process_lease",
    async () => {
      await appendFile(orderPath, "first-start\n", "utf8");
      markEntered();
      await barrier;
      await appendFile(orderPath, "first-end\n", "utf8");
    }
  );
  await entered;
  const second = runNodeChild(
    `import { appendFile } from "node:fs/promises";` +
      `import { withSyncJobRouterTerminalReconciliationLease as lease } from ${JSON.stringify(moduleUrl)};` +
      `await lease(${JSON.stringify(storeRoot)}, "sync_router_cross_process_lease", async () => {` +
      `await appendFile(${JSON.stringify(orderPath)}, "second-start\\nsecond-end\\n", "utf8");` +
      `});`
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(await readFile(orderPath, "utf8"), "first-start\n");
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(
    await readFile(orderPath, "utf8"),
    "first-start\nfirst-end\nsecond-start\nsecond-end\n"
  );
});

test("Router terminal reconciliation lease aborts while queued and releases its queue node", async () => {
  const syncStore = await import("../src/sync-store.js");
  const storeRoot = await tempStore();
  const jobId = "sync_router_abort_reconciliation_lease";
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const firstBarrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const first = syncStore.withSyncJobRouterTerminalReconciliationLease(
    storeRoot,
    jobId,
    async () => {
      markFirstEntered();
      await firstBarrier;
    }
  );
  await firstEntered;
  const controller = new AbortController();
  let secondEntered = false;
  const second = syncStore.withSyncJobRouterTerminalReconciliationLease(
    storeRoot,
    jobId,
    async () => {
      secondEntered = true;
    },
    { signal: controller.signal }
  );
  const secondOutcome = second.then(
    () => "resolved",
    (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR" ? "aborted" : "wrong-error"
  );
  try {
    controller.abort();
    assert.equal(
      await Promise.race([
        secondOutcome,
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))
      ]),
      "aborted"
    );
    assert.equal(secondEntered, false);
  } finally {
    releaseFirst();
    await first;
    await second.catch(() => {});
  }

  const third = await Promise.race([
    syncStore.withSyncJobRouterTerminalReconciliationLease(
      storeRoot,
      jobId,
      async () => "third-entered"
    ),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))
  ]);
  assert.equal(third, "third-entered");
});

test("sync reconciliation file-lock cleanup errors never replace an operation or AbortError", async () => {
  for (const primaryKind of ["operation", "abort"]) {
    const storeRoot = await tempStore();
    const closeError = Object.assign(new Error(`${primaryKind} close cleanup failed`), { code: "ECLOSE" });
    const unlinkError = Object.assign(new Error(`${primaryKind} unlink cleanup failed`), { code: "EUNLINK" });
    const lockOperations = {
      async open(...args) {
        const handle = await open(...args);
        return {
          writeFile: handle.writeFile.bind(handle),
          async close() {
            await handle.close();
            throw closeError;
          }
        };
      },
      readFile,
      async unlink() {
        throw unlinkError;
      }
    };
    const controller = new AbortController();
    const operationError = new Error("operation is the primary failure");
    let caught;
    try {
      await withSyncJobRouterTerminalReconciliationLease(
        storeRoot,
        `sync_router_cleanup_${primaryKind}`,
        async () => {
          if (primaryKind === "abort") {
            controller.abort(new Error("abort is the primary failure"));
            return;
          }
          throw operationError;
        },
        { signal: controller.signal, lockOperations }
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    if (primaryKind === "abort") {
      assert.equal(caught.name, "AbortError");
      assert.equal(caught.code, "ABORT_ERR");
    } else {
      assert.equal(caught, operationError);
    }
    assert.deepEqual(caught.cleanupErrors, [closeError, unlinkError]);
  }
});

test("sync job file-lock cleanup errors never replace its primary operation error", async () => {
  const storeRoot = await tempStore();
  const id = "sync_lock_cleanup_primary";
  const input = {
    id,
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/lock-cleanup-primary",
    conversationId: "lock-cleanup-primary",
    payloadText: "preserve the duplicate error"
  };
  await createSyncJob(storeRoot, input);
  const closeError = Object.assign(new Error("sync close cleanup failed"), { code: "ECLOSE" });
  const unlinkError = Object.assign(new Error("sync unlink cleanup failed"), { code: "EUNLINK" });
  const lockOperations = {
    async open(...args) {
      const handle = await open(...args);
      return {
        writeFile: handle.writeFile.bind(handle),
        async close() {
          await handle.close();
          throw closeError;
        }
      };
    },
    async unlink() {
      throw unlinkError;
    }
  };
  let caught;
  try {
    await createSyncJob(
      storeRoot,
      { ...input, payloadText: "different payload must keep the duplicate error" },
      { lockOperations }
    );
  } catch (error) {
    caught = error;
  }
  assert.match(caught?.message || "", /already exists/i);
  assert.deepEqual(caught.cleanupErrors, [closeError, unlinkError]);
});

test("sync reconciliation file-lock retries transient unlink cleanup before the next lease", async () => {
  const storeRoot = await tempStore();
  let unlinkAttempts = 0;
  const lockOperations = {
    async unlink(filePath) {
      unlinkAttempts += 1;
      if (unlinkAttempts === 1) {
        const error = new Error("transient sync lock unlink failure");
        error.code = "EBUSY";
        throw error;
      }
      return unlink(filePath);
    }
  };
  const options = { lockOperations };
  assert.equal(
    await withSyncJobRouterTerminalReconciliationLease(
      storeRoot,
      "sync_router_unlink_retry",
      async () => "first",
      options
    ),
    "first"
  );
  const second = await Promise.race([
    withSyncJobRouterTerminalReconciliationLease(
      storeRoot,
      "sync_router_unlink_retry",
      async () => "second",
      options
    ),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("next sync lease blocked on its own lock")), 250);
      timer.unref?.();
    })
  ]);
  assert.equal(second, "second");
  assert.equal(unlinkAttempts >= 3, true);
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

test("Router terminal reconciliation failures use exponential backoff before quarantine", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_backoff",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-backoff",
    targetRepo: storeRoot,
    conversationId: "router-backoff-conversation",
    projectId: "router-backoff-project",
    codexThreadId: "router-backoff-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-backoff",
    payloadText: "back off terminal reconciliation"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal result" });

  const first = await recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
    error: "first failure",
    now: "2026-08-02T00:00:00.000Z",
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 3
  });
  assert.equal(first.routerTerminalReconciliationErrorCount, 1);
  assert.equal(first.routerTerminalReconciliationNextAttemptAt, "2026-08-02T00:00:00.100Z");
  assert.equal(first.routerTerminalReconciliationQuarantinedAt, null);

  const second = await recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
    error: "second failure",
    now: "2026-08-02T00:00:01.000Z",
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 3
  });
  assert.equal(second.routerTerminalReconciliationErrorCount, 2);
  assert.equal(second.routerTerminalReconciliationNextAttemptAt, "2026-08-02T00:00:01.200Z");

  const third = await recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
    error: "third failure",
    now: "2026-08-02T00:00:02.000Z",
    baseDelayMs: 100,
    maxDelayMs: 10_000,
    maxAttempts: 3
  });
  assert.equal(third.routerTerminalReconciliationErrorCount, 3);
  assert.equal(third.routerTerminalReconciliationLastError, "third failure");
  assert.equal(third.routerTerminalReconciliationNextAttemptAt, null);
  assert.equal(third.routerTerminalReconciliationQuarantinedAt, "2026-08-02T00:00:02.000Z");
  assert.equal(third.routerTerminalSignalPending, true);
  assert.equal(third.routerTerminalReconciledAt, null);
});

test("Router reconciliation retry configuration rejects invalid delays and attempt limits", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_positive_backoff",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/positive-backoff",
    targetRepo: storeRoot,
    conversationId: "positive-backoff-conversation",
    projectId: "positive-backoff-project",
    codexThreadId: "positive-backoff-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-positive-backoff",
    payloadText: "reject invalid backoff"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });

  await assert.rejects(
    () => recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
      error: "invalid base",
      baseDelayMs: 0,
      maxDelayMs: 100
    }),
    /baseDelayMs.*positive/i
  );
  await assert.rejects(
    () => recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
      error: "invalid max",
      baseDelayMs: 100,
      maxDelayMs: -1
    }),
    /maxDelayMs.*positive/i
  );
  for (const maxAttempts of [0, -1, 0.5, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      () => recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
        error: "invalid attempts",
        maxAttempts
      }),
      /maxAttempts.*integer.*1.*100/i
    );
  }
});

test("Router scope backfill compares Windows targetRepo paths case-insensitively", async () => {
  const storeRoot = await tempStore();
  const input = {
    id: "sync_router_case_insensitive_backfill",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/router-case-backfill",
    targetRepo: "F:/Game_Code/Case_Backfill",
    conversationId: "router-case-backfill-conversation",
    projectId: "router-case-backfill-project",
    codexThreadId: "router-case-backfill-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-case-backfill",
    payloadText: "Case-insensitive Router scope backfill"
  };
  await createSyncJob(storeRoot, input);
  const updated = await backfillSyncJobRouterScope(storeRoot, input.id, {
    routerRunId: input.routerRunId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    codexThreadId: input.codexThreadId,
    targetRepo: process.platform === "win32" ? input.targetRepo.toLowerCase() : input.targetRepo
  });
  assert.equal(updated.routerTerminalScopeVersion, 1);
});

test("Router reconciliation retry delay is hard capped at sixty seconds", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_hard_retry_cap",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/hard-retry-cap",
    targetRepo: storeRoot,
    conversationId: "hard-retry-cap-conversation",
    projectId: "hard-retry-cap-project",
    codexThreadId: "hard-retry-cap-thread",
    routerTerminalSignalRequired: true,
    routerRunId: "router-run-hard-retry-cap",
    payloadText: "hard cap Router retry"
  });
  await completeSyncJob(storeRoot, job.id, { replyText: "terminal" });
  const failed = await recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
    error: "recoverable missing run",
    failureKind: "run_missing",
    baseDelayMs: 120_000,
    maxDelayMs: 900_000,
    maxAttempts: 3,
    now: "2026-08-02T00:00:00.000Z"
  });
  assert.equal(failed.routerTerminalReconciliationFailureKind, "run_missing");
  assert.equal(failed.routerTerminalReconciliationNextAttemptAt, "2026-08-02T00:01:00.000Z");
  assert.equal(failed.routerTerminalReconciliationQuarantinedAt, null);
});

test("invalid Router reconciliation timestamps normalize to retryable null", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    id: "sync_router_invalid_retry_date",
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/invalid-retry-date",
    payloadText: "normalize invalid retry date"
  });
  const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
  const persisted = JSON.parse(await readFile(jobPath, "utf8"));
  persisted.routerTerminalReconciliationNextAttemptAt = "not-a-date";
  await writeFile(jobPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

  assert.equal(
    (await getSyncJob(storeRoot, job.id)).routerTerminalReconciliationNextAttemptAt,
    null
  );
});

for (const reopenKind of ["capture", "resend"]) {
  test(`Router reconciliation retry metadata clears when a failed job reopens for ${reopenKind}`, async () => {
    const storeRoot = await tempStore();
    const job = await createSyncJob(storeRoot, {
      id: `sync_router_reopen_${reopenKind}`,
      kind: "chat_message",
      projectUrl: `https://chatgpt.com/c/reopen-${reopenKind}`,
      targetRepo: storeRoot,
      conversationId: `reopen-${reopenKind}-conversation`,
      projectId: `reopen-${reopenKind}-project`,
      codexThreadId: `reopen-${reopenKind}-thread`,
      routerTerminalSignalRequired: true,
      routerRunId: `router-run-reopen-${reopenKind}`,
      payloadText: `reopen ${reopenKind}`
    });
    await claimNextSyncJob(storeRoot, {
      projectUrl: job.projectUrl,
      workerId: `worker-${reopenKind}`
    });
    if (reopenKind === "capture") {
      await markSyncJobSent(storeRoot, job.id, { workerId: `worker-${reopenKind}` });
    }
    await failSyncJob(storeRoot, job.id, {
      error: "retryable failure",
      errorCode: reopenKind === "capture" ? "reply_timeout" : "send_not_confirmed"
    });
    await recordSyncJobRouterTerminalReconciliationFailure(storeRoot, job.id, {
      error: "Router reconcile failed",
      now: "2026-08-02T00:00:00.000Z",
      baseDelayMs: 100,
      maxDelayMs: 1_000,
      maxAttempts: 3
    });

    const reopened = reopenKind === "capture"
      ? await reopenFailedSyncJobForCapture(storeRoot, job.id)
      : await reopenFailedSyncJobForResend(storeRoot, job.id);
    assert.equal(reopened.routerTerminalReconciliationErrorCount, 0);
    assert.equal(reopened.routerTerminalReconciliationLastError, null);
    assert.equal(reopened.routerTerminalReconciliationFailureKind, null);
    assert.equal(reopened.routerTerminalReconciliationNextAttemptAt, null);
    assert.equal(reopened.routerTerminalReconciliationQuarantinedAt, null);
  });
}
