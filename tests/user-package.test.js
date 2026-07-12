import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildUserPackagePlan,
  renderAcceptanceChecklist,
  renderInstallGuide,
  renderMcpConfig,
  renderMcpStartCommand,
  renderProductReadinessPlan,
  renderRealBrowserAcceptanceRecord,
  renderStartCommand
} from "../src/user-package.js";

test("CodexBridge exposes a plugin manifest with MCP server metadata", async () => {
  const plugin = JSON.parse(await readFile(".codex-plugin/plugin.json", "utf8"));
  assert.equal(plugin.name, "chatgpt-codex-bridge");
  assert.equal(plugin.version, "0.1.0");
  assert.match(plugin.description, /GPT/);
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.interface.displayName, "CodexBridge");
  assert.match(plugin.interface.shortDescription, /GPT/);
  assert.doesNotMatch(JSON.stringify(plugin), /\[TODO:/);

  const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
  assert.equal(mcp.mcpServers.chatgpt_codex_bridge.command, "node");
  assert.deepEqual(mcp.mcpServers.chatgpt_codex_bridge.args, ["./src/mcp-server.js"]);
});

test("user package plan includes service, extension, MCP, and user-facing docs", async () => {
  const plan = buildUserPackagePlan({ version: "0.1.0", packageName: "CodexBridge-Test" });
  const entries = new Set(plan.entries.map((entry) => entry.from || entry.generatedPath));
  assert.equal(plan.archiveName, "CodexBridge-Test.zip");

  for (const required of [
    "package.json",
    "package-lock.json",
    "README.md",
    "src",
    "public",
    "chrome-extension",
    "scripts",
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "INSTALL-CodexBridge.md",
    "ACCEPTANCE-CHECKLIST.md",
    "PRODUCT-READINESS-20-STEPS.md",
    "REAL-BROWSER-ACCEPTANCE.md",
    "Start-CodexBridge.cmd",
    "Start-CodexBridge-MCP.cmd",
    "codex-mcp-config.toml"
  ]) {
    assert.ok(entries.has(required), `missing ${required}`);
  }

  for (const forbidden of [".bridge", "node_modules", ".git", "output"]) {
    assert.equal(entries.has(forbidden), false, `should not package ${forbidden}`);
  }
});

test("product readiness report maps the full 20-step goal to evidence", () => {
  const report = renderProductReadinessPlan();

  for (const required of [
    "CodexBridge 20 步产品就绪报告",
    "固化当前成功链路",
    "补旧任务兼容",
    "测试常见文件上传给 GPT",
    "修正文件预览展示",
    "完善大文件处理",
    "优化 GPT 结果捕获",
    "处理 GPT 页面卡住",
    "限制自动控制范围",
    "修复多图捕获",
    "多图展示产品化",
    "文件下载体验统一",
    "本地文件给 GPT 的规则完善",
    "自动路由规则写入项目说明",
    "用户 override 机制",
    "结果复用规则",
    "状态栏精简",
    "失败提示重写",
    "标准验收用例",
    "打包用户可安装版本",
    "真实产品体验测试",
    "npm run smoke:product",
    "ACCEPTANCE-CHECKLIST.md"
  ]) {
    assert.match(report, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const numberedRows = report.split("\n").filter((line) => /^\| \d+ \|/.test(line));
  assert.equal(numberedRows.length, 20);
});

test("real browser acceptance record documents the manual product experience gate", () => {
  const record = renderRealBrowserAcceptanceRecord();

  for (const required of [
    "CodexBridge 真实浏览器体验记录",
    "真实 Chrome + GPT 页面复查",
    "自动 smoke 通过不等于真实体验通过",
    "图片给 GPT 分析",
    "ZIP 给 GPT 分析",
    "DOCX 给 GPT 分析",
    "GPT 生成 XLSX",
    "文件没捕获",
    "GPT 生成多图",
    "GPT 卡住恢复",
    "扩展重载",
    "旧任务重试",
    "给 GPT 上传附件时不能弹出下载确认框",
    "GPT 页面没收到",
    "附件上传失败",
    "文件没有捕获成功",
    "需要刷新扩展",
    "最终结论"
  ]) {
    assert.match(record, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("user-facing package docs explain extension reload and quiet capture rules", () => {
  const checklist = renderAcceptanceChecklist();
  const readiness = renderProductReadinessPlan();
  const guide = renderInstallGuide({ packageDir: "<CodexBridge 安装目录>" });
  const record = renderRealBrowserAcceptanceRecord();
  const docs = [checklist, readiness, guide, record].join("\n\n");

  for (const required of [
    "更新服务或扩展后必须重新加载 Bridge 扩展",
    "优先静默捕获 GPT 文件资源",
    "不能弹出系统下载确认框",
    "只控制绑定的 GPT 页面",
    "不会自动刷新其它 GPT 标签页",
    "旧扩展不能继续领取新任务"
  ]) {
    assert.match(docs, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("real browser acceptance record can be prefilled from current acceptance state", () => {
  const record = renderRealBrowserAcceptanceRecord({
    generatedAt: "2026-07-02T12:34:00.000Z",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    },
    acceptance: {
      summary: {
        total: 30,
        passed: 2,
        missing: 27,
        failed: 1
      },
      checks: [
        {
          id: "multi-image",
          status: "passed",
          evidence: "3 张图片来自同一次同步"
        },
        {
          id: "format-docx",
          status: "failed",
          evidence: "DOCX 预览被截断"
        },
        {
          id: "legacy-raw-retry",
          status: "passed",
          evidence: "job_demo / 1 个附件使用 /raw"
        }
      ]
    }
  });

  assert.match(record, /当前自动覆盖：2\/30 已通过，27 项待测，1 项需处理/);
  assert.match(record, /https:\/\/chatgpt\.com\/project\/demo/);
  assert.match(record, /F:\/game_code\/demo/);
  assert.match(record, /GPT 生成多图[\s\S]*通过[\s\S]*3 张图片来自同一次同步/);
  assert.match(record, /DOCX 给 GPT 分析[\s\S]*需处理[\s\S]*DOCX 预览被截断/);
  assert.match(record, /旧任务重试[\s\S]*通过[\s\S]*job_demo \/ 1 个附件使用 \/raw/);
});

test("real browser acceptance record includes recent room evidence when available", () => {
  const record = renderRealBrowserAcceptanceRecord({
    syncJobs: [
      {
        id: "sync_demo",
        status: "succeeded",
        createdAt: "2026-07-02T12:00:00.000Z",
        completedAt: "2026-07-02T12:00:33.000Z",
        result: "GPT 已分析 1 个附件，总耗时 33 秒。",
        artifacts: [{ id: "artifact_image" }]
      },
      {
        id: "sync_failed",
        status: "failed",
        createdAt: "2026-07-02T11:00:00.000Z",
        failure: { friendly: "附件上传失败" }
      }
    ],
    artifacts: [
      {
        id: "artifact_image",
        filename: "chatgpt-image.png",
        kind: "image",
        bytes: 8647,
        createdAt: "2026-07-02T12:00:31.000Z"
      },
      {
        id: "artifact_doc",
        filename: "summary.docx",
        kind: "document",
        bytes: 19456,
        createdAt: "2026-07-02T11:59:00.000Z"
      }
    ],
    messages: [
      {
        from: "gpt",
        text: "这是 Steam 的桌面快捷方式图标。",
        createdAt: "2026-07-02T12:00:34.000Z"
      }
    ]
  });

  assert.match(record, /## 最近真实证据/);
  assert.match(record, /最近 GPT 结果[\s\S]*这是 Steam 的桌面快捷方式图标。/);
  assert.match(record, /最近附件[\s\S]*chatgpt-image\.png/);
  assert.match(record, /最近附件[\s\S]*summary\.docx/);
  assert.match(record, /最近失败[\s\S]*附件上传失败/);
  assert.match(record, /最近耗时[\s\S]*33 秒/);
});

test("real browser acceptance record skips historical question-mark encoding loss", () => {
  const record = renderRealBrowserAcceptanceRecord({
    messages: [
      {
        from: "gpt",
        text: "????? 10 ????????? AI ?????????????",
        createdAt: "2026-07-03T19:33:00.000Z"
      },
      {
        from: "gpt",
        text: "这是一条正常的 GPT 回复。",
        createdAt: "2026-07-03T19:32:00.000Z"
      }
    ]
  });

  assert.match(record, /最近 GPT 结果[\s\S]*这是一条正常的 GPT 回复。/);
  assert.doesNotMatch(record, /\?\?\?\?\?/);
});

test("real browser acceptance record explains the latest GPT handoff path", () => {
  const record = renderRealBrowserAcceptanceRecord({
    syncJobs: [
      {
        id: "sync_handoff",
        status: "succeeded",
        userText: "看看这个文件",
        payloadText: "请分析我上传的文件。",
        inputArtifacts: [
          {
            id: "artifact_doc",
            filename: "吉豆屋双十一钜惠活动.docx",
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            sizeBytes: 18718
          }
        ],
        replyText: "这是一个吉豆屋双十一招生/续费促销活动方案。",
        createdAt: "2026-07-02T13:00:00.000Z",
        sentAt: "2026-07-02T13:00:04.000Z",
        completedAt: "2026-07-02T13:00:23.000Z"
      }
    ],
    messages: [
      {
        from: "user",
        to: ["gpt"],
        text: "看看这个文件",
        createdAt: "2026-07-02T13:00:00.000Z"
      }
    ]
  });

  assert.match(record, /最近用户请求[\s\S]*看看这个文件/);
  assert.match(record, /最近链路[\s\S]*用户 -> GPT/);
  assert.match(record, /GPT 输入附件[\s\S]*吉豆屋双十一钜惠活动\.docx/);
  assert.match(record, /GPT 捕获结果[\s\S]*吉豆屋双十一招生\/续费促销活动方案/);
});

test("acceptance checklist documents the real product smoke path", () => {
  const checklist = renderAcceptanceChecklist();

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
    "png",
    "jpg",
    "pdf",
    "docx",
    "xlsx",
    "pptx",
    "zip",
    "txt",
    "md",
    "json",
    "?qa=1"
  ]) {
    assert.match(checklist, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("generated install guide explains the ordinary user setup path", () => {
  const guide = renderInstallGuide({ packageDir: "C:/CodexBridge", version: "0.1.0" });
  assert.match(guide, /启动本地服务/);
  assert.match(guide, /自动打开/);
  assert.match(guide, /Chrome 扩展/);
  assert.match(guide, /MCP/);
  assert.match(guide, /不会切换账号/);
  assert.match(guide, /只控制绑定的 GPT 页面/);
  assert.match(guide, /REAL-BROWSER-ACCEPTANCE\.md/);

  const cmd = renderStartCommand();
  assert.match(cmd, /npm install/);
  assert.match(cmd, /npm start/);
  assert.match(cmd, /BRIDGE_PORT=4317/);
  assert.match(cmd, /BRIDGE_URL=http:\/\/127\.0\.0\.1:%BRIDGE_PORT%\//);
  assert.match(cmd, /Start-Process \$env:BRIDGE_URL/);
  assert.match(cmd, /需要先安装 Node\.js/);
  assert.match(cmd, /依赖安装失败/);
  assert.match(cmd, /New-Object Net\.Sockets\.TcpClient/);
  assert.match(cmd, /端口 %BRIDGE_PORT% 已被占用/);
  assert.match(cmd, /已有 Bridge 正在运行/);
  assert.match(cmd, /如果打开的不是 Bridge/);
  assert.match(cmd, /服务已停止/);
  assert.match(guide, /端口 4317/);
  assert.match(guide, /BRIDGE_PORT=4320/);
  assert.match(guide, /已有 Bridge 在运行/);

  const mcpCmd = renderMcpStartCommand();
  assert.match(mcpCmd, /npm install/);
  assert.match(mcpCmd, /npm run mcp/);
  assert.match(mcpCmd, /需要先安装 Node\.js/);
  assert.match(mcpCmd, /依赖安装失败/);
  assert.match(mcpCmd, /MCP 服务已停止/);
  assert.match(mcpCmd, /pause/);
});

test("install guide and MCP config stay portable after the zip is moved", () => {
  const guide = renderInstallGuide({ packageDir: "<CodexBridge 安装目录>", version: "0.1.0" });
  assert.match(guide, /<CodexBridge 安装目录>\/chrome-extension/);
  assert.match(guide, /替换成你实际解压后的完整路径/);
  assert.doesNotMatch(guide, /F:\/game_code\/bridge\/release/);
  assert.doesNotMatch(guide, /F:\\game_code\\bridge\\release/);

  const mcpConfig = renderMcpConfig({ packageDir: "<CodexBridge 安装目录>" });
  assert.match(mcpConfig, /<CodexBridge 安装目录>\/src\/mcp-server\.js/);
  assert.doesNotMatch(mcpConfig, /release\/CodexBridge-User-Package/);
});

test("README documents the user package workflow", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, /npm run package:user/);
  assert.match(readme, /npm run smoke:product/);
  assert.match(readme, /npm run acceptance:contract/);
  assert.match(readme, /INSTALL-CodexBridge\.md/);
  assert.match(readme, /ACCEPTANCE-CHECKLIST\.md/);
  assert.match(readme, /REAL-BROWSER-ACCEPTANCE\.md/);
  assert.match(readme, /Start-CodexBridge\.cmd/);
  assert.match(readme, /chrome-extension/);
  assert.match(readme, /<CodexBridge 安装目录>\/src\/mcp-server\.js/);
  assert.doesNotMatch(readme, /F:\/game_code\/bridge\/chrome-extension/);
  assert.doesNotMatch(readme, /F:\/game_code\/bridge\/src\/mcp-server\.js/);
});

test("product smoke script writes a user-facing smoke result record", async () => {
  const script = await readFile("scripts/product-smoke.js", "utf8");
  assert.match(script, /PRODUCT-SMOKE-RESULT\.md/);
  assert.match(script, /REAL-BROWSER-ACCEPTANCE\.md/);
  assert.match(script, /\/api\/acceptance\/real-browser-record/);
  assert.match(script, /verifyArtifactPreviewFlow/);
  assert.match(script, /verifyMultiImageAcceptanceFlow/);
  assert.match(script, /verifyFriendlyFailureFlow/);
  assert.match(script, /verifyMissingDownloadFailureFlow/);
  assert.match(script, /verifyReplyTimeoutFailureFlow/);
  assert.match(script, /smoke-sheet\.xlsx/);
  assert.match(script, /smoke-deck\.pptx/);
  assert.match(script, /smoke-doc\.docx/);
  assert.match(script, /smoke-report\.pdf/);
  assert.match(script, /smoke-bundle\.zip/);
  assert.match(script, /smoke-image\.png/);
  assert.match(script, /raw upload URL should not force a browser download/);
  assert.match(script, /download URL should use attachment disposition/);
  assert.match(script, /multi-image-smoke-/);
  assert.match(script, /请生成 10 张不同风格的 AI 工作台图片。/);
  assert.match(script, /all 10 image artifact ids/);
  assert.match(script, /Failure smoke did not show a friendly attachment failure/);
  assert.match(script, /Failure smoke leaked a raw transport error/);
  assert.match(script, /Missing-download smoke should fail the sync job/);
  assert.match(script, /Reply-timeout smoke did not show the GPT stuck message/);
  assert.match(script, /Acceptance status did not pass the multi-image check/);
  assert.match(script, /产品冒烟结果/);
  assert.match(script, /还需要人工真实浏览器复查/);
  assert.match(script, /只控制绑定的 GPT 页面/);
  assert.match(script, /writeFile\(path\.join\(packageDir, SMOKE_RESULT_FILE\)/);
  assert.match(script, /createSmokeRunDir/);
  assert.match(script, /BRIDGE_STORE: smokeStoreDir/);
  assert.match(script, /writeSmokeFixtures\(smokeRunDir\)/);
  assert.doesNotMatch(script, /writeSmokeFixtures\(packageDir\)/);
});
