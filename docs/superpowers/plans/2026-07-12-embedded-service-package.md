# ChatGPT Codex Bridge Embedded Service Package Implementation Plan

> **For agentic workers:** Execute inline in this session. Do not initialize Git, commit, push, or modify the separate CodexBridge Router repository.

**Goal:** Produce a clean, host-managed embedded distribution with stable environment variables, service identity endpoints, graceful process shutdown, unified extension origin configuration, and no user/runtime data.

**Architecture:** Keep the existing HTTP and MCP entrypoints intact. Add small shared runtime/configuration helpers, expose host-safe metadata endpoints, make both entrypoints close cleanly, and generate an allowlisted embedded package for `vendor/chatgpt-codex-bridge/`.

**Tech Stack:** Node.js ESM, `node:http`, MCP SDK stdio transport, Chrome Manifest V3, `node:test`.

## Global Constraints

- Preserve existing `BRIDGE_STORE` compatibility while preferring `BRIDGE_DATA_DIR`.
- Resolve the extension source from `BRIDGE_EXTENSION_DIR` when supplied.
- Bind HTTP to the configured host/port; direct `src/index.js` startup must not open a browser.
- Do not bundle `node_modules`, `.bridge`, `release`, tests, logs, docs, user data, or artifacts.
- Do not bulk-delete files or directories.

---

### Task 1: Embedded runtime contract

**Files:**
- Create: `src/runtime-config.js`
- Create: `src/service-lifecycle.js`
- Modify: `src/http-server.js`
- Modify: `src/index.js`
- Modify: `src/bridge-tools.js`
- Modify: `src/router-run-store.js`
- Test: `tests/embedded-runtime.test.js`

- [ ] Write failing tests for data/extension environment resolution, `/health`, `/version`, and HTTP signal shutdown.
- [ ] Run the directed test and confirm failures are caused by missing behavior.
- [ ] Implement the smallest runtime helpers and endpoints.
- [ ] Run the directed test until green.

### Task 2: MCP shutdown contract

**Files:**
- Modify: `src/mcp-server.js`
- Test: `tests/embedded-runtime.test.js`

- [ ] Write a failing signal-close test with an injected process emitter.
- [ ] Confirm the missing shutdown API causes the failure.
- [ ] Add idempotent SIGTERM/SIGINT/stdin close handling.
- [ ] Re-run the directed test.

### Task 3: Unified Chrome extension origin

**Files:**
- Create: `chrome-extension/bridge-config.js`
- Modify: `chrome-extension/manifest.json`
- Modify: `chrome-extension/content-script.js`
- Modify: `chrome-extension/background.js`
- Test: `tests/embedded-extension.test.js`

- [ ] Write failing tests for manifest load order and configured origin use.
- [ ] Confirm they fail against the hard-coded 4317 implementation.
- [ ] Add one shared config with a 4317 fallback and update both extension contexts.
- [ ] Re-run extension and existing Chrome tests.

### Task 4: Clean embedded distribution

**Files:**
- Create: `src/embedded-package.js`
- Create: `scripts/create-embedded-package.js`
- Create: `embedded-manifest.json`
- Create: `LICENSE`
- Modify: `package.json`
- Test: `tests/embedded-package.test.js`

- [ ] Write failing allowlist and manifest tests.
- [ ] Confirm the missing package API/script causes failure.
- [ ] Implement `npm run package:embedded` with exact allowlisted content.
- [ ] Generate the package and recursively audit forbidden paths.

### Task 5: Verification and live process evidence

- [ ] Run all embedded directed tests.
- [ ] Run the complete `npm test` suite with sufficient timeout.
- [ ] Run `npm run package:embedded` and record the absolute output paths.
- [ ] Start the generated HTTP entrypoint on an isolated port and capture `/health` and `/version` JSON.
- [ ] Send a graceful shutdown signal through the lifecycle test harness and verify the listener closes with exit code 0 semantics.
- [ ] Report modified files, package contents, test counts, endpoint output, and known platform limitations without claiming unrun checks.
