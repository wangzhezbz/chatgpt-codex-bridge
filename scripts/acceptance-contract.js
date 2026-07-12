import assert from "node:assert/strict";

import {
  ACCEPTANCE_CHECKS,
  FILE_FORMAT_CHECKS,
  RELIABILITY_CHECKS,
  ROUTE_ACCEPTANCE_CHECKS,
  buildAcceptanceStatus
} from "../src/acceptance-status.js";

const REQUIRED_STANDARD_CASES = [
  "local-file-to-gpt",
  "zip",
  "spreadsheet",
  "multi-image",
  "failed-retry",
  "gpt-stuck",
  "extension-reload",
  "missing-download",
  "legacy-raw-retry"
];

const REQUIRED_FORMATS = ["png", "jpg", "pdf", "docx", "xlsx", "pptx", "zip", "txt", "md", "json"];

function repeatedText(text, minLength) {
  let output = "";
  while (output.length < minLength) output += `${text}\n`;
  return output;
}

function artifact(extension, overrides = {}) {
  return {
    id: `artifact-${extension}`,
    conversationId: "conv-contract",
    syncJobId: overrides.syncJobId || `sync-${extension}`,
    filename: overrides.filename || `contract.${extension}`,
    contentType: overrides.contentType || "application/octet-stream",
    createdAt: overrides.createdAt || "2026-07-02T00:00:00.000Z",
    ...overrides
  };
}

function buildFullySatisfiedAcceptance() {
  const imageArtifacts = [1, 2, 3].map((index) =>
    artifact(`png`, {
      id: `image-${index}`,
      syncJobId: "sync-multi-image",
      filename: `image-${index}.png`,
      contentType: "image/png",
      createdAt: `2026-07-02T00:00:0${index}.000Z`
    })
  );

  const formatArtifacts = [
    artifact("jpg", { filename: "photo.jpg", contentType: "image/jpeg" }),
    artifact("pdf", { filename: "brief.pdf", contentType: "application/pdf" }),
    artifact("docx", {
      filename: "proposal.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }),
    artifact("xlsx", {
      filename: "table.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }),
    artifact("pptx", {
      filename: "deck.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }),
    artifact("zip", { filename: "bundle.zip", contentType: "application/zip" }),
    artifact("txt", { filename: "note.txt", contentType: "text/plain" }),
    artifact("md", { filename: "plan.md", contentType: "text/markdown" }),
    artifact("json", { filename: "data.json", contentType: "application/json" })
  ];

  return buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-contract",
      chatgptProjectUrl: "https://chatgpt.com/project/contract",
      targetRepo: "F:/game_code/contract"
    },
    messages: [
      {
        id: "msg-text",
        conversationId: "conv-contract",
        from: "gpt",
        text: "你好，Bridge 已经收到。",
        createdAt: "2026-07-02T00:00:00.000Z"
      },
      {
        id: "msg-long",
        conversationId: "conv-contract",
        from: "gpt",
        text: repeatedText("AI 工作流产品需要让 GPT 做规划、视觉、长文和附件理解，让 Codex 使用结果落地。", 760),
        createdAt: "2026-07-02T00:00:01.000Z"
      },
      {
        id: "msg-code",
        conversationId: "conv-contract",
        from: "gpt",
        text: "```js\nconsole.log(\"bridge acceptance ok\");\n```",
        createdAt: "2026-07-02T00:00:02.000Z"
      },
      {
        id: "msg-retry",
        conversationId: "conv-contract",
        from: "user",
        text: "retry old task",
        metadata: {
          retryOfSyncJobId: "sync-old"
        }
      }
    ],
    artifacts: [...imageArtifacts, ...formatArtifacts],
    extension: {
      needsReload: true,
      version: "v20260629-old",
      expectedVersion: "v20260703-final-reply-guard"
    },
    syncJobs: [
      {
        id: "sync-local-file",
        conversationId: "conv-contract",
        status: "completed",
        inputArtifacts: [
          {
            id: "artifact-local",
            filename: "local.png",
            downloadUrl: "/api/artifacts/artifact-local/download",
            uploadUrl: "/api/artifacts/artifact-local/raw"
          }
        ]
      },
      {
        id: "sync-stuck",
        conversationId: "conv-contract",
        status: "failed",
        errorCode: "reply_timeout",
        error: "Timed out waiting for ChatGPT reply"
      },
      {
        id: "sync-upload-failed",
        conversationId: "conv-contract",
        status: "failed",
        errorCode: "attachment_upload_failed",
        error: "Failed to fetch"
      },
      {
        id: "sync-missing-download",
        conversationId: "conv-contract",
        status: "failed",
        errorCode: "missing_download",
        error: "ChatGPT 提到了可下载文件，但 Bridge 没有捕获到真实文件：contract.xlsx"
      },
      {
        id: "sync-retry",
        conversationId: "conv-contract",
        status: "pending",
        sourceMessageId: "msg-retry",
        inputArtifacts: [
          {
            id: "artifact-legacy",
            filename: "legacy.zip",
            downloadUrl: "/api/artifacts/artifact-legacy/download",
            uploadUrl: "/api/artifacts/artifact-legacy/raw"
          }
        ]
      }
    ]
  });
}

function assertIds(label, actualIds, requiredIds) {
  for (const id of requiredIds) {
    assert.ok(actualIds.has(id), `${label} missing ${id}`);
  }
}

const standardIds = new Set([
  ...ACCEPTANCE_CHECKS.map((check) => check.id),
  ...RELIABILITY_CHECKS.map((check) => check.id)
]);
assertIds("standard acceptance cases", standardIds, REQUIRED_STANDARD_CASES);

const formatIds = new Set(FILE_FORMAT_CHECKS.map((format) => format.extension));
assert.deepEqual([...formatIds].sort(), [...REQUIRED_FORMATS].sort());

const routeIds = new Set(ROUTE_ACCEPTANCE_CHECKS.map((check) => check.id));
assertIds("routing acceptance cases", routeIds, [
  "route-gpt-attachment",
  "route-gpt-generation",
  "route-codex-local",
  "route-gpt-then-codex",
  "route-simple-file"
]);

const acceptance = buildFullySatisfiedAcceptance();
assert.equal(acceptance.summary.total, 31);
assert.equal(acceptance.summary.failed, 0);
assert.equal(acceptance.summary.missing, 0);
assert.equal(acceptance.summary.passed, acceptance.summary.total);

console.log(
  JSON.stringify(
    {
      ok: true,
      total: acceptance.summary.total,
      passed: acceptance.summary.passed,
      groups: acceptance.groupSummaries
    },
    null,
    2
  )
);
