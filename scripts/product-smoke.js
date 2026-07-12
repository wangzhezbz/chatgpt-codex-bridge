import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 4318;

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "INSTALL-CodexBridge.md",
  "ACCEPTANCE-CHECKLIST.md",
  "PRODUCT-READINESS-20-STEPS.md",
  "REAL-BROWSER-ACCEPTANCE.md",
  "Start-CodexBridge.cmd",
  "Start-CodexBridge-MCP.cmd",
  "codex-mcp-config.toml",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  "src/index.js",
  "src/http-server.js",
  "public/index.html",
  "public/app.js",
  "public/styles.css",
  "scripts/acceptance-contract.js",
  "chrome-extension/manifest.json",
  "chrome-extension/background.js",
  "chrome-extension/content-script.js"
];

const MOJIBAKE_PATTERN = /[�]|鍚|瀹|鐗|鏄|锛\?/;
const SMOKE_RESULT_FILE = "PRODUCT-SMOKE-RESULT.md";
const SMOKE_FIXTURE_DIR = ".product-smoke-fixtures";
const SMOKE_PROJECT_URL = "https://chatgpt.com/project/product-smoke";

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function latestPackageDir(releaseRoot = path.resolve("release")) {
  const entries = await readdir(releaseRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("CodexBridge-User-Package-")) continue;
    const fullPath = path.join(releaseRoot, entry.name);
    const info = await stat(fullPath);
    candidates.push({ fullPath, mtimeMs: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) {
    throw new Error(`No CodexBridge user package found under ${releaseRoot}`);
  }
  return candidates[0].fullPath;
}

async function createSmokeRunDir() {
  return mkdtemp(path.join(os.tmpdir(), "codexbridge-smoke-"));
}

async function validatePackageFiles(packageDir) {
  const missing = [];
  for (const relativePath of REQUIRED_FILES) {
    if (!(await exists(path.join(packageDir, relativePath)))) {
      missing.push(relativePath);
    }
  }
  if (missing.length) {
    throw new Error(`Package is missing required files: ${missing.join(", ")}`);
  }

  const guide = await readFile(path.join(packageDir, "INSTALL-CodexBridge.md"), "utf8");
  if (!guide.includes("CodexBridge 安装说明") || !guide.includes("只控制绑定的 GPT 页面")) {
    throw new Error("Install guide does not contain the required Chinese user guidance.");
  }
  if (MOJIBAKE_PATTERN.test(guide)) {
    throw new Error("Install guide appears to contain mojibake.");
  }
  if (/release[\\/]+CodexBridge-User-Package/i.test(guide) || /F:[\\/]+game_code[\\/]+bridge/i.test(guide)) {
    throw new Error("Install guide contains a source-machine package path instead of portable setup guidance.");
  }

  const readme = await readFile(path.join(packageDir, "README.md"), "utf8");
  if (/F:\/game_code\/bridge\/chrome-extension|F:\/game_code\/bridge\/src\/mcp-server\.js/i.test(readme)) {
    throw new Error("README contains source-machine setup paths instead of portable setup guidance.");
  }

  const mcpConfig = await readFile(path.join(packageDir, "codex-mcp-config.toml"), "utf8");
  if (!mcpConfig.includes("<CodexBridge 安装目录>/src/mcp-server.js")) {
    throw new Error("MCP config should use the portable <CodexBridge 安装目录> placeholder.");
  }

  const mcpStartCommand = await readFile(path.join(packageDir, "Start-CodexBridge-MCP.cmd"), "utf8");
  if (!mcpStartCommand.includes("npm install") || !mcpStartCommand.includes("npm run mcp")) {
    throw new Error("MCP start command should install dependencies before running the MCP service.");
  }

  const checklist = await readFile(path.join(packageDir, "ACCEPTANCE-CHECKLIST.md"), "utf8");
  for (const required of [
    "发图片给 GPT 分析",
    "发 zip 给 GPT 分析",
    "发 docx 给 GPT 分析",
    "生成 xlsx",
    "文件没捕获",
    "生成多张图",
    "GPT 卡住",
    "扩展重载",
    "旧任务重试",
    "更新服务或扩展后必须重新加载 Bridge 扩展",
    "不能弹出系统下载确认框",
    "旧扩展不能继续领取新任务"
  ]) {
    if (!checklist.includes(required)) {
      throw new Error(`Acceptance checklist is missing: ${required}`);
    }
  }

  const readiness = await readFile(path.join(packageDir, "PRODUCT-READINESS-20-STEPS.md"), "utf8");
  const readinessRows = readiness.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  if (!readiness.includes("CodexBridge 20 步产品就绪报告") || readinessRows.length !== 20) {
    throw new Error("Product readiness report must document all 20 product steps.");
  }
  for (const required of [
    "固化当前成功链路",
    "修复多图捕获",
    "文件下载体验统一",
    "真实产品体验测试",
    "优先静默捕获 GPT 文件资源",
    "只控制绑定的 GPT 页面",
    "不会自动刷新其它 GPT 标签页"
  ]) {
    if (!readiness.includes(required)) {
      throw new Error(`Product readiness report is missing: ${required}`);
    }
  }

  const realBrowserAcceptance = await readFile(path.join(packageDir, "REAL-BROWSER-ACCEPTANCE.md"), "utf8");
  for (const required of [
    "CodexBridge 真实浏览器体验记录",
    "自动 smoke 通过不等于真实体验通过",
    "图片给 GPT 分析",
    "GPT 生成多图",
    "给 GPT 上传附件时不能弹出下载确认框",
    "优先静默捕获 GPT 文件资源",
    "旧扩展不能继续领取新任务",
    "最终结论"
  ]) {
    if (!realBrowserAcceptance.includes(required)) {
      throw new Error(`Real browser acceptance record is missing: ${required}`);
    }
  }

  const extensionManifest = JSON.parse(
    await readFile(path.join(packageDir, "chrome-extension/manifest.json"), "utf8")
  );
  if (!extensionManifest.name || !extensionManifest.content_scripts?.length) {
    throw new Error("Chrome extension manifest is incomplete.");
  }

  return {
    requiredFiles: REQUIRED_FILES.length,
    extensionName: extensionManifest.name
  };
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function runCommand(command, args, options = {}) {
  const executable =
    process.platform === "win32" && command === "npm" ? process.env.ComSpec || "cmd.exe" : command;
  const finalArgs =
    process.platform === "win32" && command === "npm" ? ["/d", "/s", "/c", command, ...args] : args;
  const child = spawn(executable, finalArgs, {
    ...options,
    stdio: "pipe"
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = await waitForExit(child);
  if (result.code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.code}\n${stdout}\n${stderr}`);
  }
  return { stdout, stderr };
}

async function waitForHttp(url, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

function ensure(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJsonResponse(response, label, expectedStatus = 200) {
  const text = await response.text();
  if (response.status !== expectedStatus) {
    throw new Error(`${label} returned HTTP ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

function smokeFixtures() {
  return [
    {
      filename: "smoke-note.txt",
      contentType: "text/plain",
      data: Buffer.from("Bridge 产品冒烟文本文件\n", "utf8"),
      expectedKind: "text",
      expect(preview) {
        ensure(preview.preview.text.includes("Bridge 产品冒烟文本文件"), "TXT preview did not include fixture text.");
      }
    },
    {
      filename: "smoke-data.json",
      contentType: "application/json",
      data: Buffer.from(JSON.stringify({ bridge: true, scenario: "product-smoke" }, null, 2), "utf8"),
      expectedKind: "text",
      expect(preview) {
        ensure(preview.preview.text.includes("product-smoke"), "JSON preview did not include fixture data.");
      }
    },
    {
      filename: "smoke-sheet.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: zipBuffer({
        "xl/sharedStrings.xml": [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<sst>",
          "<si><t>序号</t></si>",
          "<si><t>内容</t></si>",
          "<si><t>1</t></si>",
          "<si><t>产品冒烟表格</t></si>",
          "</sst>"
        ].join(""),
        "xl/worksheets/sheet1.xml": [
          "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
          "<x:worksheet xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><x:sheetData>",
          "<x:row r=\"1\"><x:c r=\"A1\" t=\"s\"><x:v>0</x:v></x:c><x:c r=\"B1\" t=\"s\"><x:v>1</x:v></x:c></x:row>",
          "<x:row r=\"2\"><x:c r=\"A2\" t=\"s\"><x:v>2</x:v></x:c><x:c r=\"B2\" t=\"s\"><x:v>3</x:v></x:c></x:row>",
          "</x:sheetData></x:worksheet>"
        ].join("")
      }),
      expectedKind: "spreadsheet",
      expect(preview) {
        ensure(preview.preview.rowCount === 2, "XLSX preview row count is wrong.");
        ensure(preview.preview.rows[0]?.[0] === "序号", "XLSX preview did not parse the header row.");
      }
    },
    {
      filename: "smoke-deck.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      data: zipBuffer({
        "ppt/slides/slide1.xml": "<p:sld><a:t>Bridge 冒烟页</a:t><a:t>第一页内容</a:t></p:sld>",
        "ppt/slides/slide2.xml": "<p:sld><a:t>文件预览</a:t><a:t>PPT 卡片应该可读</a:t></p:sld>"
      }),
      expectedKind: "presentation",
      expect(preview) {
        ensure(preview.preview.slideCount === 2, "PPTX preview slide count is wrong.");
        ensure(preview.preview.slides[0]?.title === "Bridge 冒烟页", "PPTX preview did not parse slide text.");
      }
    },
    {
      filename: "smoke-doc.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: zipBuffer({
        "word/document.xml": [
          "<w:document>",
          "<w:p><w:r><w:t>Bridge Word 冒烟文档</w:t></w:r></w:p>",
          "<w:p><w:r><w:t>用于检查 DOCX 预览。</w:t></w:r></w:p>",
          "</w:document>"
        ].join("")
      }),
      expectedKind: "document",
      expect(preview) {
        ensure(preview.preview.paragraphs[0] === "Bridge Word 冒烟文档", "DOCX preview did not parse paragraphs.");
      }
    },
    {
      filename: "smoke-report.pdf",
      contentType: "application/pdf",
      data: Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Page >>\nendobj\n%%EOF\n", "utf8"),
      expectedKind: "pdf",
      expect(preview) {
        ensure(preview.preview.canInlinePreview === true, "PDF preview should allow inline preview.");
      }
    },
    {
      filename: "smoke-bundle.zip",
      contentType: "application/zip",
      data: zipBuffer({ "ok.txt": "Bridge zip smoke" }),
      expectedKind: "archive",
      expect(preview) {
        ensure(preview.preview.entries.some((entry) => entry.name === "ok.txt"), "ZIP preview did not list ok.txt.");
      }
    },
    {
      filename: "smoke-image.png",
      contentType: "image/png",
      data: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
        "base64"
      ),
      expectedKind: "file",
      expect(preview) {
        ensure(preview.preview.message, "PNG fallback preview should return a file message.");
      }
    }
  ];
}

async function writeSmokeFixtures(smokeRunDir) {
  const fixtureDir = path.join(smokeRunDir, SMOKE_FIXTURE_DIR);
  await mkdir(fixtureDir, { recursive: true });
  const fixtures = smokeFixtures();
  for (const fixture of fixtures) {
    fixture.localPath = path.join(fixtureDir, fixture.filename);
    await writeFile(fixture.localPath, fixture.data);
  }
  return fixtures;
}

async function verifyArtifactPreviewFlow(smokeRunDir, port) {
  const fixtures = await writeSmokeFixtures(smokeRunDir);
  const checks = [];

  for (const fixture of fixtures) {
    const importResponse = await fetch(`http://127.0.0.1:${port}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: fixture.localPath,
        contentType: fixture.contentType
      })
    });
    const imported = await readJsonResponse(importResponse, `import ${fixture.filename}`, 201);
    ensure(imported.artifact?.id, `Artifact import did not return an id for ${fixture.filename}.`);
    ensure(imported.artifact.filename === fixture.filename, `Artifact filename mismatch for ${fixture.filename}.`);

    const previewResponse = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/${encodeURIComponent(imported.artifact.id)}/preview`
    );
    const preview = await readJsonResponse(previewResponse, `preview ${fixture.filename}`);
    ensure(preview.kind === fixture.expectedKind, `${fixture.filename} preview kind was ${preview.kind}, expected ${fixture.expectedKind}.`);
    fixture.expect(preview);

    const rawResponse = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/${encodeURIComponent(imported.artifact.id)}/raw`
    );
    ensure(rawResponse.status === 200, `${fixture.filename} raw upload URL returned HTTP ${rawResponse.status}.`);
    ensure(!rawResponse.headers.get("content-disposition"), `${fixture.filename} raw upload URL should not force a browser download.`);
    ensure(Buffer.compare(Buffer.from(await rawResponse.arrayBuffer()), fixture.data) === 0, `${fixture.filename} raw bytes changed.`);

    const downloadResponse = await fetch(
      `http://127.0.0.1:${port}/api/artifacts/${encodeURIComponent(imported.artifact.id)}/download`
    );
    ensure(downloadResponse.status === 200, `${fixture.filename} download URL returned HTTP ${downloadResponse.status}.`);
    ensure(
      /attachment/i.test(downloadResponse.headers.get("content-disposition") || ""),
      `${fixture.filename} download URL should use attachment disposition.`
    );
    ensure(Buffer.compare(Buffer.from(await downloadResponse.arrayBuffer()), fixture.data) === 0, `${fixture.filename} download bytes changed.`);

    checks.push({
      filename: fixture.filename,
      kind: preview.kind,
      bytes: fixture.data.length
    });
  }

  return checks;
}

async function apiJson(port, pathname, options = {}, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  return readJsonResponse(response, `${options.method || "GET"} ${pathname}`, expectedStatus);
}

async function verifyMultiImageAcceptanceFlow(packageDir, port) {
  await apiJson(
    port,
    "/api/workspace",
    {
      method: "PATCH",
      body: JSON.stringify({
        chatgptProjectUrl: SMOKE_PROJECT_URL,
        targetRepo: packageDir
      })
    },
    200
  );

  const roomMessage = await apiJson(
    port,
    "/api/room/messages",
    {
      method: "POST",
      body: JSON.stringify({
        text: "请生成 10 张不同风格的 AI 工作台图片。",
        to: ["gpt"]
      })
    },
    201
  );
  ensure(roomMessage.syncJob?.id, "Multi-image smoke did not create a GPT sync job.");

  const claimed = await apiJson(
    port,
    "/api/sync/jobs/claim",
    {
      method: "POST",
      body: JSON.stringify({
        projectUrl: `${SMOKE_PROJECT_URL}/c/product-smoke`,
        workerId: "product-smoke-extension"
      })
    },
    200
  );
  ensure(claimed.job?.id === roomMessage.syncJob.id, "Multi-image smoke claimed the wrong sync job.");

  const imageData = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64"
  );
  const completed = await apiJson(
    port,
    `/api/sync/jobs/${encodeURIComponent(claimed.job.id)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        replyText: "已生成 10 张图片。",
        artifacts: Array.from({ length: 10 }, (_, index) => ({
          filename: `multi-image-smoke-${String(index).padStart(2, "0")}.png`,
          contentType: "image/png",
          base64Data: imageData.toString("base64")
        }))
      })
    },
    200
  );
  ensure(completed.job?.artifactIds?.length === 10, "Multi-image smoke did not store all 10 image artifact ids.");

  const artifacts = await apiJson(port, `/api/artifacts?syncJobId=${encodeURIComponent(claimed.job.id)}`);
  ensure((artifacts.artifacts || []).length === 10, "Artifact list did not return all 10 images for the sync job.");

  const room = await apiJson(port, "/api/room/messages");
  const gptMessage = (room.messages || []).find((message) =>
    Array.isArray(message.metadata?.artifactIds) && message.metadata.artifactIds.length === 10
  );
  ensure(gptMessage, "Room messages did not expose the 10-image GPT result.");

  const acceptance = await apiJson(port, "/api/acceptance/status");
  const multiImage = (acceptance.checks || []).find((check) => check.id === "multi-image");
  ensure(multiImage?.status === "passed", "Acceptance status did not pass the multi-image check.");

  return {
    artifactCount: artifacts.artifacts.length,
    acceptance: multiImage.status,
    evidence: multiImage.evidence
  };
}

async function verifyFriendlyFailureFlow(packageDir, port) {
  await apiJson(
    port,
    "/api/workspace",
    {
      method: "PATCH",
      body: JSON.stringify({
        chatgptProjectUrl: SMOKE_PROJECT_URL,
        targetRepo: packageDir
      })
    },
    200
  );

  const roomMessage = await apiJson(
    port,
    "/api/room/messages",
    {
      method: "POST",
      body: JSON.stringify({
        text: "看看这个 zip 是什么",
        to: ["gpt"]
      })
    },
    201
  );
  ensure(roomMessage.syncJob?.id, "Failure smoke did not create a GPT sync job.");

  const claimed = await apiJson(
    port,
    "/api/sync/jobs/claim",
    {
      method: "POST",
      body: JSON.stringify({
        projectUrl: `${SMOKE_PROJECT_URL}/c/product-smoke`,
        workerId: "product-smoke-extension"
      })
    },
    200
  );
  ensure(claimed.job?.id === roomMessage.syncJob.id, "Failure smoke claimed the wrong sync job.");

  const failed = await apiJson(
    port,
    `/api/sync/jobs/${encodeURIComponent(claimed.job.id)}/fail`,
    {
      method: "POST",
      body: JSON.stringify({
        error: "Failed to fetch"
      })
    },
    200
  );
  const visibleText = `${failed.roomMessage?.text || ""}\n${failed.chatgptMessage?.text || ""}`;
  ensure(/附件上传失败/.test(visibleText), "Failure smoke did not show a friendly attachment failure.");
  ensure(!/Failed to fetch|ChatGPT Project sync failed/i.test(visibleText), "Failure smoke leaked a raw transport error.");

  return {
    status: failed.job?.status,
    friendly: "附件上传失败"
  };
}

async function verifyMissingDownloadFailureFlow(packageDir, port) {
  await apiJson(
    port,
    "/api/workspace",
    {
      method: "PATCH",
      body: JSON.stringify({
        chatgptProjectUrl: SMOKE_PROJECT_URL,
        targetRepo: packageDir
      })
    },
    200
  );

  const roomMessage = await apiJson(
    port,
    "/api/room/messages",
    {
      method: "POST",
      body: JSON.stringify({
        text: "请生成一个可下载的 xlsx 文件，文件名 bridge-smoke-missing.xlsx。",
        to: ["gpt"]
      })
    },
    201
  );
  ensure(roomMessage.syncJob?.id, "Missing-download smoke did not create a GPT sync job.");

  const claimed = await apiJson(
    port,
    "/api/sync/jobs/claim",
    {
      method: "POST",
      body: JSON.stringify({
        projectUrl: `${SMOKE_PROJECT_URL}/c/product-smoke`,
        workerId: "product-smoke-extension"
      })
    },
    200
  );
  ensure(claimed.job?.id === roomMessage.syncJob.id, "Missing-download smoke claimed the wrong sync job.");

  const completed = await apiJson(
    port,
    `/api/sync/jobs/${encodeURIComponent(claimed.job.id)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        replyText: "已生成 bridge-smoke-missing.xlsx，点击即可下载。"
      })
    },
    200
  );
  ensure(completed.job?.status === "failed", "Missing-download smoke should fail the sync job.");
  ensure(completed.job?.errorCode === "missing_download", "Missing-download smoke used the wrong error code.");
  ensure((completed.job?.artifactIds || []).length === 0, "Missing-download smoke should not invent artifacts.");
  ensure(/文件没有捕获成功/.test(completed.roomMessage?.text || ""), "Missing-download smoke did not show a friendly retry message.");
  ensure(!/ChatGPT Project sync failed/i.test(completed.roomMessage?.text || ""), "Missing-download smoke leaked a raw sync failure.");

  return {
    status: completed.job.status,
    errorCode: completed.job.errorCode,
    friendly: "文件没有捕获成功"
  };
}

async function verifyReplyTimeoutFailureFlow(packageDir, port) {
  await apiJson(
    port,
    "/api/workspace",
    {
      method: "PATCH",
      body: JSON.stringify({
        chatgptProjectUrl: SMOKE_PROJECT_URL,
        targetRepo: packageDir
      })
    },
    200
  );

  const roomMessage = await apiJson(
    port,
    "/api/room/messages",
    {
      method: "POST",
      body: JSON.stringify({
        text: "请回复一个很短的测试消息。",
        to: ["gpt"]
      })
    },
    201
  );
  ensure(roomMessage.syncJob?.id, "Reply-timeout smoke did not create a GPT sync job.");

  const claimed = await apiJson(
    port,
    "/api/sync/jobs/claim",
    {
      method: "POST",
      body: JSON.stringify({
        projectUrl: `${SMOKE_PROJECT_URL}/c/product-smoke`,
        workerId: "product-smoke-extension"
      })
    },
    200
  );
  ensure(claimed.job?.id === roomMessage.syncJob.id, "Reply-timeout smoke claimed the wrong sync job.");

  const failed = await apiJson(
    port,
    `/api/sync/jobs/${encodeURIComponent(claimed.job.id)}/fail`,
    {
      method: "POST",
      body: JSON.stringify({
        error: "Timed out waiting for GPT reply",
        errorCode: "reply_timeout"
      })
    },
    200
  );
  const visibleText = `${failed.roomMessage?.text || ""}\n${failed.chatgptMessage?.text || ""}`;
  ensure(/GPT 卡住了/.test(visibleText), "Reply-timeout smoke did not show the GPT stuck message.");
  ensure(/只刷新绑定/.test(visibleText), "Reply-timeout smoke did not tell the user to refresh only the bound page.");
  ensure(!/Timed out waiting/i.test(visibleText), "Reply-timeout smoke leaked raw timeout text.");

  return {
    status: failed.job?.status,
    errorCode: failed.job?.errorCode,
    friendly: "GPT 卡住了"
  };
}

async function verifyRunningService(packageDir, port, smokeRunDir) {
  const smokeStoreDir = path.join(smokeRunDir, ".bridge");
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: packageDir,
    env: {
      ...process.env,
      BRIDGE_STORE: smokeStoreDir,
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_PORT: String(port)
    },
    stdio: "pipe"
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const configResponse = await waitForHttp(`http://127.0.0.1:${port}/api/config`);
    const config = await configResponse.json();
    const reportResponse = await waitForHttp(`http://127.0.0.1:${port}/api/acceptance/report`);
    const report = await reportResponse.text();
    const realBrowserRecordResponse = await waitForHttp(
      `http://127.0.0.1:${port}/api/acceptance/real-browser-record`
    );
    const realBrowserRecord = await realBrowserRecordResponse.text();
    const pageResponse = await waitForHttp(`http://127.0.0.1:${port}/`);
    const page = await pageResponse.text();

    if (!config.runnerMode && !config.workspace) {
      throw new Error("Config endpoint did not return Bridge runtime information.");
    }
    if (!report.includes("# Bridge 标准验收报告")) {
      throw new Error("Acceptance report endpoint did not return the product smoke report.");
    }
    if (!realBrowserRecord.includes("# CodexBridge 真实浏览器体验记录")) {
      throw new Error("Real browser acceptance record endpoint did not return a usable record.");
    }
    if (!page.includes("Bridge")) {
      throw new Error("Bridge page did not render the expected shell.");
    }

    const artifactChecks = await verifyArtifactPreviewFlow(smokeRunDir, port);
    const multiImageChecks = await verifyMultiImageAcceptanceFlow(packageDir, port);
    const failureCopyChecks = await verifyFriendlyFailureFlow(packageDir, port);
    const missingDownloadChecks = await verifyMissingDownloadFailureFlow(packageDir, port);
    const replyTimeoutChecks = await verifyReplyTimeoutFailureFlow(packageDir, port);

    return {
      config: configResponse.status,
      acceptanceReport: reportResponse.status,
      realBrowserRecord: realBrowserRecordResponse.status,
      page: pageResponse.status,
      artifacts: artifactChecks,
      multiImage: multiImageChecks,
      failureCopy: failureCopyChecks,
      missingDownload: missingDownloadChecks,
      replyTimeout: replyTimeoutChecks
    };
  } finally {
    child.kill();
    await Promise.race([
      waitForExit(child),
      new Promise((resolve) => setTimeout(resolve, 1500))
    ]);
    if (stderr.includes("EADDRINUSE")) {
      throw new Error(`Port ${port} is already in use.`);
    }
  }
}

function renderSmokeResult({ packageDir, smokeRunDir, port, fileChecks, serviceChecks }) {
  const artifactLines = (serviceChecks.artifacts || []).map(
    (artifact) => `- ${artifact.filename}：${artifact.kind}，${artifact.bytes} B`
  );
  return [
    "# CodexBridge 产品冒烟结果",
    "",
    `时间：${new Date().toISOString()}`,
    `包目录：${packageDir}`,
    `运行数据目录：${smokeRunDir}`,
    `服务端口：${port}`,
    "",
    "## 自动检查",
    "",
    `- 必备文件：${fileChecks.requiredFiles} 个`,
    `- Chrome 扩展：${fileChecks.extensionName}`,
    `- /api/config：HTTP ${serviceChecks.config}`,
    `- /api/acceptance/report：HTTP ${serviceChecks.acceptanceReport}`,
    `- /api/acceptance/real-browser-record：HTTP ${serviceChecks.realBrowserRecord}`,
    `- 首页：HTTP ${serviceChecks.page}`,
    `- 本机文件导入/预览/下载链路：${artifactLines.length} 个文件`,
    ...artifactLines,
    `- 同一次 GPT 同步多图链路：${serviceChecks.multiImage?.artifactCount || 0} 张 / ${serviceChecks.multiImage?.acceptance || "未通过"}`,
    serviceChecks.multiImage?.evidence ? `- 多图验收证据：${serviceChecks.multiImage.evidence}` : "",
    `- 附件上传失败提示：${serviceChecks.failureCopy?.friendly || "未验证"}`,
    `- 文件未捕获失败提示：${serviceChecks.missingDownload?.friendly || "未验证"}`,
    `- GPT 卡住提示：${serviceChecks.replyTimeout?.friendly || "未验证"}`,
    "",
    "## 已确认",
    "",
    "- 安装说明可读，没有源码机器路径。",
    "- MCP 配置使用可替换的安装目录占位符。",
    "- 标准验收清单存在，并覆盖 9 个真实场景。",
    "- 20 步产品就绪报告存在，并覆盖完整 20 项。",
    "- 真实浏览器体验记录表存在，用于人工复查 Chrome + GPT 链路。",
    "- 包目录可以独立启动本地服务。",
    "",
    "## 还需要人工真实浏览器复查",
    "",
    "- 加载 Chrome 扩展并绑定真实 GPT 会话。",
    "- 发图片、zip、docx 给 GPT 分析。",
    "- 让 GPT 生成 xlsx 和多张图片。",
    "- 验证 GPT 卡住、扩展重载、旧任务重试这些失败场景的提示是否像产品。",
    "- 确认 Bridge 只控制绑定的 GPT 页面，不影响其它标签页。"
  ].join("\n");
}

async function main() {
  const packageDir = path.resolve(process.argv[2] || (await latestPackageDir()));
  const smokeRunDir = await createSmokeRunDir();
  const port = Number.parseInt(process.env.BRIDGE_SMOKE_PORT || String(DEFAULT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid smoke port: ${process.env.BRIDGE_SMOKE_PORT}`);
  }

  const fileChecks = await validatePackageFiles(packageDir);
  if (!(await exists(path.join(packageDir, "node_modules")))) {
    await runCommand("npm", ["install", "--no-audit", "--no-fund"], { cwd: packageDir });
  }
  const serviceChecks = await verifyRunningService(packageDir, port, smokeRunDir);
  const smokeResult = renderSmokeResult({ packageDir, smokeRunDir, port, fileChecks, serviceChecks });
  await writeFile(path.join(packageDir, SMOKE_RESULT_FILE), smokeResult, "utf8");

  console.log(
    JSON.stringify(
      {
        ok: true,
        packageDir,
        smokeRunDir,
        port,
        resultFile: path.join(packageDir, SMOKE_RESULT_FILE),
        fileChecks,
        serviceChecks
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
