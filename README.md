# Codex 工作台

这是一个本地原型，用来验证这个产品形态：

```text
Codex 是主工作台。
页面是一个 ChatGPT Project 风格的聊天窗口。
用户像聊天一样发任务。绑定 ChatGPT Project 后，底层会把上下文发给真实 ChatGPT Project；ChatGPT 回复后，本地桥会把“给 Codex 的指令”放入 Codex 收件箱，等待 Codex 侧领取执行。执行结果默认只写回本地，只有显式确认时才同步给 ChatGPT 分析。
```

当前版本已经不再显示任务板。它只保留一个用户面对的聊天窗口：

- 顶部：绑定真实 ChatGPT Project URL 和本地项目目录。
- 中间：聊天记录，包括 ChatGPT 回复、Codex 收件箱状态、Codex 执行结果。
- 底部：输入任务并发送。

后台会保存 ChatGPT 同步 payload、Codex 收件箱项、执行结果和可选回传任务，但这些不再作为任务板暴露给用户。

## 启动

```powershell
$env:BRIDGE_RUNNER="codex"
npm start
```

打开：

```text
http://127.0.0.1:4317
```

当前绑定 ChatGPT Project 后不会让网页桥自动运行 Codex；`BRIDGE_RUNNER` 只影响未绑定 Project 时的本地 fallback 和旧任务接口。

```powershell
$env:BRIDGE_RUNNER="manual"
npm start
```

## 当前使用流程

1. 在 `ChatGPT Project` 区域填入真实项目 URL。
2. 填入本地项目目录，例如 `F:/game_code/project`。
3. 点击 `保存绑定`。
4. 在聊天窗口输入你要做的事。
5. 点击 `发送`。
6. 如果已绑定 ChatGPT Project，消息会先进入 ChatGPT 同步队列。
7. Chrome 扩展在真实 ChatGPT Project 页面领取消息、发送给 ChatGPT，并把回复写回本地。
8. 本地收到 ChatGPT 回复后，创建一条 `Codex 收件箱` 待办，不会自动跑后台子进程。
9. 当前 Codex 线程通过 MCP 工具或本地 API 领取收件箱项，执行后把结果写回本地。
10. 需要 ChatGPT 继续分析时，再显式创建回传同步任务。

如果没有绑定 ChatGPT Project，会 fallback 到本地 Codex 直接执行。

## Chrome 自动同步扩展

开发环境扩展目录：

```text
<当前 CodexBridge 项目目录>/chrome-extension
```

安装方式：

1. 打开 Chrome 的 `chrome://extensions/`。
2. 开启开发者模式。
3. 点击 `Load unpacked` / `加载已解压的扩展程序`。
4. 选择当前 CodexBridge 目录里的 `chrome-extension` 文件夹。
5. 打开你绑定的 ChatGPT Project 页面，并保持本地服务运行。

扩展会在 `chatgpt.com` 页面后台轮询 `http://127.0.0.1:4317/api/sync/jobs/claim`。有待同步消息时，它会自动填入 ChatGPT 输入框、点击发送、等待回复稳定，再回写到本地。

这一层依赖 ChatGPT 网页结构，属于第一版可验证原型；后续需要继续加选择器兼容和可见连接状态。

## API

- `GET /api/workspace`：读取 ChatGPT Project 绑定。
- `PATCH /api/workspace`：保存 `chatgptProjectUrl` 和 `targetRepo`。
- `GET /api/chat/messages`：读取聊天记录。
- `POST /api/chat/turns`：写入用户消息；有绑定 Project 时创建同步任务，未绑定时 fallback 到 Codex。
- `POST /api/chat/replies`：兼容旧流程的导入接口，当前 UI 不再使用。
- `POST /api/sync/jobs/claim`：Chrome 扩展领取待同步任务。
- `POST /api/sync/jobs/:id/complete`：Chrome 扩展回写 ChatGPT 回复；如果是用户请求，会创建 Codex 收件箱项。
- `POST /api/sync/jobs/:id/fail`：Chrome 扩展回写同步失败。
- `GET /api/codex-inbox`：读取 Codex 收件箱项。
- `POST /api/codex-inbox/next`：当前 Codex 侧领取下一条待执行指令。
- `POST /api/codex-inbox/:id/complete`：当前 Codex 侧写回执行结果；传 `syncToChatGpt: true` 时才创建回传同步任务。
- `POST /api/codex-inbox/:id/fail`：当前 Codex 侧写回执行失败。
- `GET /api/tasks`：读取 Codex 任务队列。
- `POST /api/tasks/:id/run`：运行一个 Codex 任务。

## MCP 服务

启动 stdio MCP 服务：

```powershell
npm run mcp
```

本地 MCP 配置示例：

```toml
[mcp_servers.chatgpt_codex_bridge]
command = "node"
args = ["<CodexBridge 安装目录>/src/mcp-server.js"]
```

把 `<CodexBridge 安装目录>` 替换成你实际解压或克隆后的完整路径。

当前 MCP 工具：

- `create_task`
- `list_tasks`
- `get_task_status`
- `get_task_result`
- `request_revision`
- `list_codex_inbox`
- `claim_next_codex_inbox_item`
- `complete_codex_inbox_item`
- `fail_codex_inbox_item`

## 数据位置

运行数据保存在：

```text
.bridge/
  workspace.json
  chat/messages.ndjson
  sync/jobs/<sync_job_id>.json
  codex-inbox/items/<inbox_item_id>.json
  tasks/<task_id>/
    task.json
    PROMPT.md
    RESULT.md
    events.ndjson
```

## 验证

```powershell
npm test
```

## 生成用户安装包

开发者可以生成一个普通用户可解压使用的便携包：

```powershell
npm run package:user
```

默认输出到 `release/CodexBridge-User-Package-v<version>-<time>/`。包内包含：

- `Start-CodexBridge.cmd`：启动本地服务，首次运行会安装依赖。
- `Start-CodexBridge-MCP.cmd`：启动 MCP 服务。
- `INSTALL-CodexBridge.md`：给普通用户看的安装说明。
- `PRODUCT-READINESS-20-STEPS.md`：逐条对照 20 步产品目标和验收证据。
- `REAL-BROWSER-ACCEPTANCE.md`：真实 Chrome + ChatGPT 页面体验记录表。
- `codex-mcp-config.toml`：可复制到 Codex MCP 配置里的示例。
- `chrome-extension/`：需要在 Chrome 扩展页加载的 Bridge 扩展。
- `.codex-plugin/plugin.json` 和 `.mcp.json`：Codex 插件与 MCP 元数据。

这个包不会携带 `.bridge/` 运行数据、`node_modules/`、`.git/` 或本地输出目录，避免把用户历史、登录状态或测试垃圾一起打进去。

生成后可以跑一遍产品冒烟，模拟普通用户从包目录启动服务并检查关键入口：

```powershell
npm run smoke:product -- release/CodexBridge-User-Package-v<version>-<time>
```

冒烟会检查安装说明、标准验收清单、20 步产品就绪报告、真实浏览器体验记录表、Chrome 扩展、MCP 配置、本地服务、首页、验收报告接口和当前状态版真实体验记录接口。它还会在包目录生成一组小型本机测试文件，自动验证 `txt`、`json`、`xlsx`、`pptx`、`docx`、`pdf`、`zip`、`png` 的导入、预览、给 GPT 上传用 raw 链路和用户下载链路，并模拟一次 GPT 同步返回 3 张图片，确认多图能进入 artifact 列表、房间消息和标准验收。默认用 `4318` 端口，不影响当前开发服务。通过后会在包目录写入 `PRODUCT-SMOKE-RESULT.md`，记录自动检查结果和后续需要人工真实浏览器复查的项目。

包内还会包含 `ACCEPTANCE-CHECKLIST.md`，用于从零安装后人工复查真实产品链路：发图片、发 zip、发 docx、生成 xlsx、文件没捕获、生成多图、GPT 卡住、扩展重载、旧任务重试，以及 `png`、`jpg`、`pdf`、`docx`、`xlsx`、`pptx`、`zip`、`txt`、`md`、`json` 的格式展示。`REAL-BROWSER-ACCEPTANCE.md` 用来记录真实 Chrome + ChatGPT 体验结果和半成品问题；运行服务时也可以打开 `/api/acceptance/real-browser-record` 导出一份按当前房间状态预填的 Markdown 记录。`PRODUCT-READINESS-20-STEPS.md` 则用来确认这 20 步目标每一项都有对应的自动或人工验收依据。

开发时可以先跑验收合同，确认隐藏验收台和标准用例没有漂移：

```powershell
npm run acceptance:contract
```

## CodexBridge delegation bootstrap

每个项目第一次绑定或第一次通过 MCP/本地 API 使用 Bridge 时，会自动在目标项目根目录写入两份说明：

- `BRIDGE.md`：面向产品和用户的分工规则。
- `AGENTS.md`：面向当前 Codex 线程的执行规则。

`AGENTS.md` 会被追加一个 `CODEXBRIDGE CODEX DELEGATION` 标记块，不会覆盖项目里已有的说明。这个块会要求 Codex 在以下场景优先调用 `delegate_current_request`：

- 用户把图片、截图、附件、PDF、Word、PPT、Excel、PSD 等文件直接发给 Codex。
- 用户要做图片生成、视觉方案、文案、长文、调研、头脑风暴、Office 文件或压缩包生成。
- 用户的问题明显适合先由 GPT 分析、设计或生成，再由 Codex 使用结果落地。

默认规则是：除非用户明确说“让 Codex 做”“不要交给 GPT”“你直接处理”“本地执行”，否则上面这些高成本分析/生成任务先交给 GPT。Codex 拿到 GPT 的 `replyText`、文件或图片后，只消费结果，不重复分析一遍。

MCP 推荐入口：

```text
delegate_current_request
```

常见调用形态：

```json
{
  "text": "请分析这张图片是什么，并用中文回答。",
  "localPath": "C:/path/to/image.png",
  "contentType": "image/png",
  "waitForGpt": true
}
```

如果返回 `action: "codex_only"`，当前 Codex 线程直接执行本地任务；如果返回 `gpt_only` 或 `gpt_then_codex`，优先使用 GPT 返回的结果继续回复用户或落地到项目。
