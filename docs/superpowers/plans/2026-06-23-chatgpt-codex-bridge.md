# ChatGPT Codex Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local task-board bridge where ChatGPT/MCP hosts can create and inspect Codex tasks while Codex execution stays behind a safe runner adapter.

**Architecture:** A Node.js service provides reusable core modules, a local HTTP UI/API, and a stdio MCP server. Task state is stored in `.bridge/tasks` so the board, MCP tools, and runner all share one durable state layer.

**Tech Stack:** Node.js 24, built-in `node:test`, built-in HTTP server, optional Codex CLI runner, `@modelcontextprotocol/sdk` plus `zod` for MCP stdio tools.

## Global Constraints

- Do not bulk delete files or directories.
- Default runner mode must not execute shell commands against target projects.
- Automatic Codex execution requires `BRIDGE_RUNNER=codex`.
- Bind the local web server to `127.0.0.1` by default.
- Store bridge runtime state under `.bridge/tasks`.

---

### Task 1: Task Store

**Files:**
- Create: `tests/task-store.test.js`
- Create: `src/task-store.js`

**Interfaces:**
- Produces: `createTask(storeRoot, input)`, `getTask(storeRoot, id)`, `listTasks(storeRoot)`, `appendEvent(storeRoot, id, event)`, `updateTask(storeRoot, id, patch)`, `writeResult(storeRoot, id, text)`.

- [x] Write failing tests for task creation and event persistence.
- [x] Run `node --test tests/task-store.test.js` and verify it fails because `src/task-store.js` is missing.
- [x] Implement task store functions.
- [x] Run `node --test tests/task-store.test.js` and verify it passes.

### Task 2: Runner Adapter

**Files:**
- Create: `tests/codex-runner.test.js`
- Create: `src/codex-runner.js`

**Interfaces:**
- Consumes: task store functions from Task 1.
- Produces: `runTask(storeRoot, taskId, options)`.

- [x] Write failing tests for manual fallback mode.
- [x] Run `node --test tests/codex-runner.test.js` and verify it fails because `src/codex-runner.js` is missing.
- [x] Implement manual fallback and opt-in Codex CLI mode.
- [x] Run `node --test tests/codex-runner.test.js` and verify it passes.

### Task 3: HTTP API And Board

**Files:**
- Create: `src/http-server.js`
- Create: `src/index.js`
- Create: `public/index.html`
- Create: `public/styles.css`
- Create: `public/app.js`

**Interfaces:**
- Consumes: task store and runner.
- Produces: `createHttpServer(options)` and CLI entry `npm start`.

- [x] Add HTTP routes for listing, creating, reading, and revising tasks.
- [x] Add static UI that consumes the API.
- [x] Verify by starting `npm start` and opening the local URL.

### Task 4: MCP Stdio Tools

**Files:**
- Create: `src/mcp-server.js`

**Interfaces:**
- Consumes: task store and runner.
- Produces: MCP tools `create_task`, `list_tasks`, `get_task_status`, `get_task_result`, `request_revision`.

- [x] Register MCP tools with narrow schemas.
- [x] Verify the module imports cleanly with Node.
- [x] Document how to wire it into Codex or another MCP host.

### Task 5: Documentation And Verification

**Files:**
- Create: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: local commands and ChatGPT/Codex setup notes.

- [x] Document local board startup.
- [x] Document MCP stdio command.
- [x] Document safe default runner behavior.
- [x] Run `npm test`.
