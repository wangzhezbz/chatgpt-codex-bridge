import assert from "node:assert/strict";
import test from "node:test";

import { buildAcceptanceReport, buildAcceptanceStatus } from "../src/acceptance-status.js";

test("acceptance treats captured plain JavaScript as code-block evidence", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [
      {
        id: "msg-code",
        conversationId: "conv-demo",
        from: "gpt",
        text: 'console.log("bridge acceptance ok");',
        createdAt: "2026-06-27T03:20:00.000Z"
      }
    ],
    syncJobs: [],
    artifacts: []
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("code-block").status, "passed");
});

test("acceptance includes route coverage for GPT, Codex and handoff decisions", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo",
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    },
    messages: [],
    syncJobs: [],
    artifacts: []
  });

  const routeChecks = acceptance.groups.find((group) => group.id === "routing")?.checks || [];
  const checks = new Map(routeChecks.map((check) => [check.id, check]));

  assert.equal(routeChecks.length, 5);
  assert.equal(checks.get("route-gpt-attachment").expectedRoute, "gpt_only");
  assert.equal(checks.get("route-gpt-attachment").actualRouteLabel, "GPT");
  assert.equal(checks.get("route-gpt-attachment").status, "passed");
  assert.equal(checks.get("route-codex-local").expectedRoute, "codex_only");
  assert.equal(checks.get("route-codex-local").actualRouteLabel, "Codex");
  assert.equal(checks.get("route-codex-local").status, "passed");
  assert.equal(checks.get("route-gpt-then-codex").expectedRoute, "gpt_then_codex");
  assert.equal(checks.get("route-gpt-then-codex").actualRouteLabel, "GPT -> Codex");
  assert.equal(checks.get("route-gpt-then-codex").status, "passed");
  assert.equal(acceptance.summary.total, 31);
  assert.equal(acceptance.summary.passed, 5);
  assert.equal(acceptance.groupSummaries.formats.total, 10);
  assert.equal(acceptance.groupSummaries.formats.missing, 10);
  assert.equal(acceptance.groupSummaries.reliability.total, 5);
  assert.equal(acceptance.groupSummaries.reliability.missing, 5);
  assert.equal(acceptance.groupSummaries.routing.total, 5);
  assert.equal(acceptance.groupSummaries.routing.passed, 5);
});

test("acceptance only passes multi-image evidence after at least three images from one sync", () => {
  const baseInput = {
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    syncJobs: [],
    artifacts: [
      {
        id: "image-1",
        conversationId: "conv-demo",
        syncJobId: "sync-images",
        filename: "image-1.png",
        contentType: "image/png",
        createdAt: "2026-07-02T00:00:00.000Z"
      },
      {
        id: "image-2",
        conversationId: "conv-demo",
        syncJobId: "sync-images",
        filename: "image-2.png",
        contentType: "image/png",
        createdAt: "2026-07-02T00:00:01.000Z"
      }
    ]
  };

  const twoImages = buildAcceptanceStatus(baseInput);
  const twoImageCheck = twoImages.checks.find((check) => check.id === "multi-image");

  assert.equal(twoImageCheck.status, "missing");

  const threeImages = buildAcceptanceStatus({
    ...baseInput,
    artifacts: [
      ...baseInput.artifacts,
      {
        id: "image-3",
        conversationId: "conv-demo",
        syncJobId: "sync-images",
        filename: "image-3.png",
        contentType: "image/png",
        createdAt: "2026-07-02T00:00:02.000Z"
      }
    ]
  });
  const threeImageCheck = threeImages.checks.find((check) => check.id === "multi-image");

  assert.equal(threeImageCheck.status, "passed");
  assert.match(threeImageCheck.evidence, /3 张图片来自同一次同步/);
});

test("acceptance shows latest single image evidence instead of cumulative history count", () => {
  const artifacts = Array.from({ length: 101 }, (_, index) => {
    const number = index + 1;
    return {
      id: `image-${number}`,
      conversationId: "conv-demo",
      syncJobId: `sync-image-${number}`,
      filename: `image-${String(number).padStart(3, "0")}.png`,
      contentType: "image/png",
      createdAt: new Date(Date.UTC(2026, 6, 2, 0, 0, index)).toISOString()
    };
  });

  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    syncJobs: [],
    artifacts
  });
  const singleImageCheck = acceptance.checks.find((check) => check.id === "single-image");

  assert.equal(singleImageCheck.status, "passed");
  assert.match(singleImageCheck.evidence, /image-101\.png/);
});
test("acceptance tracks the explicit file formats from the product checklist", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    syncJobs: [],
    artifacts: [
      { id: "png", conversationId: "conv-demo", filename: "screen.png", contentType: "image/png" },
      { id: "jpg", conversationId: "conv-demo", filename: "photo.jpg", contentType: "image/jpeg" },
      { id: "pdf", conversationId: "conv-demo", filename: "brief.pdf", contentType: "application/pdf" },
      {
        id: "docx",
        conversationId: "conv-demo",
        filename: "proposal.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      {
        id: "xlsx",
        conversationId: "conv-demo",
        filename: "table.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      },
      {
        id: "pptx",
        conversationId: "conv-demo",
        filename: "deck.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      },
      { id: "zip", conversationId: "conv-demo", filename: "bundle.zip", contentType: "application/zip" },
      { id: "txt", conversationId: "conv-demo", filename: "note.txt", contentType: "text/plain" },
      { id: "md", conversationId: "conv-demo", filename: "plan.md", contentType: "text/markdown" },
      { id: "json", conversationId: "conv-demo", filename: "data.json", contentType: "application/json" }
    ]
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  for (const extension of ["png", "jpg", "pdf", "docx", "xlsx", "pptx", "zip", "txt", "md", "json"]) {
    const check = checks.get(`format-${extension}`);
    assert.ok(check, `missing format-${extension}`);
    assert.equal(check.status, "passed", `format-${extension}`);
    assert.match(check.evidence, new RegExp(`\\.${extension}\\b`, "i"));
  }
});

test("acceptance ignores artifacts whose file extension conflicts with content type", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    syncJobs: [],
    artifacts: [
      {
        id: "fake-xlsx-preview",
        conversationId: "conv-demo",
        filename: "table.xlsx",
        contentType: "image/png"
      }
    ]
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("single-image").status, "missing");
  assert.equal(checks.get("spreadsheet").status, "missing");
  assert.equal(checks.get("format-png").status, "missing");
  assert.equal(checks.get("format-xlsx").status, "missing");
});

test("acceptance tracks reliability failures users must be able to verify", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    artifacts: [],
    extension: {
      needsReload: true,
      version: "v20260629-old",
      expectedVersion: "v20260703-send-ready-diagnostics"
    },
    syncJobs: [
      {
        id: "sync-stuck",
        conversationId: "conv-demo",
        status: "failed",
        errorCode: "reply_timeout",
        error: "Timed out waiting for ChatGPT reply",
        completedAt: "2026-07-02T00:00:00.000Z"
      },
      {
        id: "sync-upload-failed",
        conversationId: "conv-demo",
        status: "failed",
        errorCode: "attachment_upload_failed",
        error: "Failed to fetch",
        completedAt: "2026-07-02T00:00:01.000Z"
      },
      {
        id: "sync-missing-download",
        conversationId: "conv-demo",
        status: "failed",
        errorCode: "missing_download",
        error: "ChatGPT 提到了可下载文件，但 Bridge 没有捕获到真实文件：report.xlsx",
        completedAt: "2026-07-02T00:00:02.000Z"
      }
    ]
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  assert.equal(acceptance.groupSummaries.reliability.total, 5);
  assert.equal(acceptance.groupSummaries.reliability.passed, 4);
  assert.equal(checks.get("gpt-stuck").status, "passed");
  assert.match(checks.get("gpt-stuck").evidence, /sync-stuck/);
  assert.equal(checks.get("extension-reload").status, "passed");
  assert.match(checks.get("extension-reload").evidence, /v20260629-old/);
  assert.equal(checks.get("attachment-upload-failure").status, "passed");
  assert.match(checks.get("attachment-upload-failure").evidence, /sync-upload-failed/);
  assert.equal(checks.get("missing-download").status, "passed");
  assert.match(checks.get("missing-download").evidence, /sync-missing-download/);
  assert.equal(checks.get("legacy-raw-retry").status, "missing");
});

test("acceptance treats a reconnected current extension as reload recovery evidence", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    artifacts: [],
    extension: {
      needsReload: false,
      currentConnected: true,
      currentVersion: "v20260703-send-ready-diagnostics",
      expectedVersion: "v20260703-send-ready-diagnostics",
      currentHref: "https://chatgpt.com/project/demo/c/abc",
      currentPageStatus: {
        state: "ready",
        code: "ready"
      }
    },
    syncJobs: []
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("extension-reload").status, "passed");
  assert.match(checks.get("extension-reload").evidence, /v20260703-send-ready-diagnostics/);
});

test("acceptance keeps reload recovery evidence after the heartbeat ages out", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [],
    artifacts: [],
    extension: {
      needsReload: false,
      currentConnected: false,
      recoveredVersion: "v20260703-send-ready-diagnostics",
      expectedVersion: "v20260703-send-ready-diagnostics",
      recoveredHref: "https://chatgpt.com/project/demo/c/abc",
      recoveredPageStatus: {
        state: "ready",
        code: "ready"
      },
      recoveredAt: "2026-07-02T16:10:37.120Z"
    },
    syncJobs: []
  });

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("extension-reload").status, "passed");
  assert.match(checks.get("extension-reload").evidence, /已恢复连接/);
});

test("acceptance tracks legacy failed task retries through raw upload URLs", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo"
    },
    messages: [
      {
        id: "msg-retry",
        conversationId: "conv-demo",
        from: "user",
        text: "retry old task",
        metadata: {
          retryOfSyncJobId: "sync-old"
        }
      }
    ],
    artifacts: [],
    extension: {},
    syncJobs: [
      {
        id: "sync-retry",
        conversationId: "conv-demo",
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

  const checks = new Map(acceptance.checks.map((check) => [check.id, check]));
  const check = checks.get("legacy-raw-retry");

  assert.ok(check);
  assert.equal(check.status, "passed");
  assert.match(check.evidence, /sync-retry/);
  assert.match(check.evidence, /\/raw/);
});

test("acceptance can render a compact Markdown report for handoff", () => {
  const acceptance = buildAcceptanceStatus({
    workspace: {
      conversationId: "conv-demo",
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    },
    messages: [
      {
        id: "msg-text",
        conversationId: "conv-demo",
        from: "gpt",
        text: "你好，Bridge",
        createdAt: "2026-07-02T00:00:00.000Z"
      }
    ],
    artifacts: [],
    syncJobs: []
  });

  const report = buildAcceptanceReport(acceptance);

  assert.match(report, /# Bridge 标准验收报告/);
  assert.match(report, /总体/);
  assert.match(report, /## GPT 数据读取/);
  assert.match(report, /- \[x\] 普通文字/);
  assert.match(report, /- \[ \] 多张图片/);
  assert.match(report, /旧任务\s*\/raw 重试/);
});
