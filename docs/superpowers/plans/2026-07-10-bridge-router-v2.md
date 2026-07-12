# CodexBridge Router 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every production change and superpowers:verification-before-completion before reporting success. This workspace has no valid Git metadata, so do not create a worktree or commit.

**Goal:** 在默认不改变现有网页 GPT 链路的前提下，增加统一 Transport、离线 Mock、持久化 Router Run、严格顺序编排、三重作用域隔离和确定的项目产物路径。

**Architecture:** `delegate_current_request` 保留原有实现，并仅在 `BRIDGE_ROUTER_V2=1` 时旁路到 `RouterOrchestrator`。Orchestrator 通过 Transport Registry 选择 `web-sync` 或 `mock`，以稳定 requestId 幂等提交阶段，把状态在跨进程锁内原子写入 `.bridge/router-runs/<runId>.json`，成功结果写入绑定项目的 `.bridge/artifacts/<runId>/`。

**Tech Stack:** Node.js ESM、`node:test`、`node:assert/strict`、`node:fs/promises`，不增加 npm 依赖。

## Global Constraints

- `BRIDGE_ROUTER_V2` 未设置或不等于 `1` 时，`delegate_current_request` 必须完整走旧逻辑。
- `BRIDGE_GPT_TRANSPORT` 默认 `web-sync`，仅允许选择已注册 Transport。
- 不接入 CCSwitch 私有 OAuth、ChatGPT 私有 `backend-api` 或用户 Cookie。
- 不修改 Chrome 扩展同步任务格式和状态机，不破坏旧 `chatgpt-artifacts`。
- Transport 公共状态只能是 `queued | running | succeeded | failed | cancelled`。
- Router Run 必须同时校验 `projectId、conversationId、codexThreadId`。
- 失败、超时和取消不得推进下一阶段；恢复不得重复成功阶段或已提交请求。
- 文本产物固定保存为 `<targetRepo>/.bridge/artifacts/<runId>/<stageId>.md`，所有返回路径为绝对路径。
- 禁止批量删除；本计划不删除任何文件。
- `.git` 为空；不得初始化 Git、创建 worktree、commit 或声称已提交。

---

### Task 1: Transport 注册表与离线 Mock

**Files:**

- Create: `tests/gpt-transport-registry.test.js`
- Create: `tests/mock-gpt-transport.test.js`
- Create: `src/gpt-transports/transport-registry.js`
- Create: `src/gpt-transports/mock-transport.js`

**Interfaces:**

- `createGptTransportRegistry({ transports, defaultTransportId, env }) -> { register, resolve, has, list }`
- `createMockGptTransport({ responses, clock, requestIdFactory }) -> transport`
- Mock transport exposes read-only-by-convention `submissions` entries containing `sequence、kind、requestId、stageId、payload、submittedAt`.
- Every transport result contains `transportId、requestId、status、replyText、artifacts、error、raw`.

- [ ] **Step 1: Write registry tests before modules exist**

  Tests must assert:

  ```js
  const registry = createGptTransportRegistry({ transports: [web, mock], env: {} });
  assert.equal(registry.resolve().id, "web-sync");
  assert.equal(registry.resolve("mock").id, "mock");
  assert.equal(createGptTransportRegistry({ transports: [web, mock], env: { BRIDGE_GPT_TRANSPORT: "mock" } }).resolve().id, "mock");
  assert.throws(() => registry.resolve("missing"), /not registered/);
  assert.throws(() => registry.register({ id: "bad" }), /submitText/);
  ```

- [ ] **Step 2: Write Mock tests before module exists**

  Cover text/artifact submission order, stage-keyed replies, complete envelope, configured `failed`, `cancel()` to `cancelled`, and no network/global fetch usage. Use injected fixed clock and request IDs so assertions are deterministic.

- [ ] **Step 3: Run RED tests**

  Run:

  ```powershell
  node --test tests/gpt-transport-registry.test.js tests/mock-gpt-transport.test.js
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND` for the two production modules.

- [ ] **Step 4: Implement minimal registry**

  Validate `id` and all four required methods at registration. Resolution precedence is explicit ID, `env.BRIDGE_GPT_TRANSPORT`, then `defaultTransportId || "web-sync"`. Duplicate IDs replace only when `register(transport, { replace: true })` is explicit; otherwise throw.

- [ ] **Step 5: Implement minimal Mock transport**

  Store request records in an internal `Map`; `submitText` and `submitArtifacts` return `queued`; `wait` resolves the response selected by `stageId` or submission index; `cancel` overwrites terminal state with `cancelled` only while nonterminal. Normalize all envelopes so optional values become `null` or `[]`, never `undefined`.

- [ ] **Step 6: Run GREEN tests**

  Re-run the Step 3 command. Expected: all tests pass, zero failures.

### Task 2: Web Sync Transport 兼容适配

**Files:**

- Create: `src/gpt-transports/web-sync-transport.js`
- Extend: `tests/gpt-transport-registry.test.js`

**Interfaces:**

- `createWebSyncTransport({ storeRoot, enqueueText, enqueueArtifacts, waitForJob, getJob, cancelJob }) -> transport`
- `enqueueText(input)` and `enqueueArtifacts(input)` return an object containing `syncJob` or a sync job object.
- `wait(requestId, options)` maps existing job state into the public envelope and keeps the original queue/wait objects only in `raw`.

- [ ] **Step 1: Add failing web-sync normalization tests**

  Inject in-memory semantic functions; assert `pending -> queued`、`running -> running`、`succeeded -> succeeded`、`failed -> failed`、timeout failure -> `failed` and cancel failure raw job -> public `cancelled`. Assert no sync-job-only field appears at envelope top level.

- [ ] **Step 2: Run RED test**

  ```powershell
  node --test tests/gpt-transport-registry.test.js
  ```

  Expected: FAIL because `web-sync-transport.js` is missing.

- [ ] **Step 3: Implement the adapter**

  Use injected semantic functions so `bridge-tools.js` can bind its existing `askChatGptProject()` and file helper without moving Chrome logic. Default low-level dependencies may call existing `createSyncJob`、`queueArtifactForGptAnalysis`、`waitForSyncJobResult`、`getSyncJob` and `failSyncJob`; adapter code must not create a second sync state machine.

- [ ] **Step 4: Run GREEN tests**

  Re-run Step 2. Expected: pass with no network access.

### Task 3: Router Run 持久化与三重隔离

**Files:**

- Create: `tests/router-run-store.test.js`
- Create: `src/router-run-store.js`

**Interfaces:**

- `createRouterRunStore({ storeRoot, clock, runIdFactory }) -> { create, get, update, withRunLease, withSubmissionLease, withFinalizationLease, list, assertScope }`
- Scope object is exactly `{ projectId, conversationId, codexThreadId }`.
- Files are `<storeRoot>/router-runs/<runId>.json`.

- [ ] **Step 1: Write failing persistence tests**

  Create a run with two stages and assert the JSON contains all required run and stage fields, version `2`, `currentStageIndex: 0`, `status: "pending"`, and absolute `targetRepo`. Re-create the store instance and confirm `get()` restores the same data.

- [ ] **Step 2: Write failing isolation and validation tests**

  Assert exact scope can read/update. Independently alter project, conversation, and thread and assert each is rejected. Assert missing scope fields, path separators in run IDs, duplicate stage IDs, and a dependency pointing to a later/nonexistent stage are rejected.

- [ ] **Step 3: Run RED test**

  ```powershell
  node --test tests/router-run-store.test.js
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 4: Implement minimal store**

  Normalize each stage to:

  ```js
  {
    id, title, status: "pending", payloadText: "", dependsOn: null,
    replyText: null, artifactIds: [], transportRequestId: null,
    submissionState: null, inputArtifacts: [], projectArtifactPaths: [],
    startedAt: null, completedAt: null, error: null
  }
  ```

  `update(runId, scope, updaterOrPatch)` must acquire the per-Run in-process and cross-process lock, reload from disk, assert scope before invoking an updater, refresh `updatedAt`, write a trailing newline to a unique temporary file, and atomically rename it over the Run JSON with bounded Windows sharing-violation retries. Add independent cross-process leases for long orchestration, submit linearization and succeeded-result finalization; each lease callback receives the latest scoped Run.

- [ ] **Step 5: Run GREEN test**

  Re-run Step 3. Expected: all store tests pass.

### Task 4: Router Orchestrator 单阶段、顺序推进与项目产物

**Files:**

- Create: `tests/router-orchestrator.test.js`
- Create: `src/router-orchestrator.js`

**Interfaces:**

- `createRouterOrchestrator({ runStore, transportRegistry, artifactResolver, clock, transportRequestIdFactory })`
- Methods: `startRouterRun(input)`, `continueRouterRun(input)`, `cancelRouterRun(input)`.
- `input` includes `route、originalRequestText、workspace、scope、transportId、waitForGpt、waitOptions`.
- Return includes `{ routerRun, transportResult, projectArtifactPaths }`.

- [ ] **Step 1: Write failing codex-only and single-stage tests**

  Assert `codex_only` causes zero Mock submissions. Assert a `gpt_only` run submits one payload, persists queued state when `waitForGpt:false`, and persists succeeded text plus exact `<targetRepo>/.bridge/artifacts/<runId>/gpt.md` when waiting.

- [ ] **Step 2: Write failing stop/recovery tests**

  Assert configured `failed` and `cancelled` outcomes stop with no next submission. Start an async run, create a new Orchestrator using the same run store and transport, continue it, and assert the existing request is waited rather than re-submitted. Pre-mark stage 0 succeeded and assert resume starts at stage 1 only.

- [ ] **Step 3: Write failing strict novel-chain test**

  Use `decideRoomRoute()` on the confirmed Chinese request. With `waitForGpt:false`, assert only outline submits. Continue and assert chapter submits only after outline success; chapter payload includes the injected outline reply and excludes the original poster instruction. Continue again and assert poster submits only after chapter success; poster payload includes relevant prior replies. With `waitForGpt:true`, assert submission order is exactly `outline, chapter, poster` and every prior stage was persisted as succeeded before the next submission callback runs.

- [ ] **Step 4: Write failing artifact-copy test**

  Create a global artifact with existing artifact-store, make Mock return it for `poster`, and assert the copied absolute file path is under the run directory. Assert text and binary paths are both present in stage, run and top-level `projectArtifactPaths`.

- [ ] **Step 5: Run RED test**

  ```powershell
  node --test tests/router-orchestrator.test.js
  ```

  Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 6: Implement stage creation and payload building**

  For sequential routes copy `route.sequentialPlan.stages`; for other GPT routes create one `gpt` stage. Later-stage payloads contain the stage instruction and all successful prerequisite context, followed by an explicit “只完成当前阶段，不要继续后续阶段”; never append the original composite request.

- [ ] **Step 7: Implement submit/wait/persist loop**

  On a pending stage, preallocate a stable `transportRequestId` and atomically persist `startedAt`, payload/input artifacts and `submissionState:"prepared"` before submit. Pass that ID into the Transport, whose adapter must create the underlying request idempotently, then persist `submissionState:"submitted"` and queued/running status. A recovered `prepared` stage resubmits the same ID/payload; an existing `submitted` request only calls `wait()`. Serialize same-Run operations; wrap final status check, submit and submit-result persistence in the short submission lease; wrap successful artifact materialization and terminal persistence in the short finalization lease. Do not hold either short lease during `transport.wait()`. Persist success before increasing `currentStageIndex`, and stop on every failed/cancelled outcome.

- [ ] **Step 8: Implement project artifact materialization**

  Validate `targetRepo` is a non-root project directory. Create `<targetRepo>/.bridge/artifacts/<runId>/`; always write `<stageId>.md` for a successful reply. Resolve artifact IDs through injected `artifactResolver`, copy their stored files with sanitized collision-safe names, and persist absolute paths.

- [ ] **Step 9: Run GREEN test**

  Re-run Step 5. Expected: all orchestration tests pass.

### Task 5: Bridge 功能开关、继续/取消接口与 MCP 暴露

**Files:**

- Modify: `src/bridge-tools.js`
- Modify: `src/mcp-server.js`
- Modify: `tests/bridge-tools.test.js`
- Modify: `tests/mcp-server.test.js`

**Interfaces:**

- `createBridgeTools()` adds injectable `routerV2Enabled、gptTransports、gptTransportRegistry、routerRunStore、routerOrchestrator`.
- Existing `delegateCurrentRequest(input)` signature remains unchanged.
- New methods: `continueRouterRun(input)` and `cancelRouterRun(input)`.
- New MCP tools: `continue_router_run` and `cancel_router_run` with required `runId、projectId、conversationId`, plus `waitForGpt?、timeoutMs?/pollMs?` as applicable. The current `codexThreadId` is injected by the running Bridge process and must also match the persisted Run.

- [ ] **Step 1: Add failing default-off compatibility test**

  Inject an Orchestrator whose methods throw. With the option omitted and with `routerV2Enabled:false`, call legacy GPT delegation and assert the existing message/syncJob fields and one sync job are unchanged; injected Router must not be called.

- [ ] **Step 2: Add failing default-on V2 tests**

  Bind a real project to `thread-current`, inject Mock Transport, set `routerV2Enabled:true`, and assert return fields include all existing keys plus `routerRun、transportResult、projectArtifactPaths`. Assert `BRIDGE_GPT_TRANSPORT=mock` selection through injected env/registry without mutating process-global environment.

- [ ] **Step 3: Add failing isolation tests**

  Create two projects and assert mismatched explicit project/conversation is rejected before any Mock submission. Assert a different `currentCodexThreadId` cannot start, continue or cancel the Run. Assert exact scope can continue.

- [ ] **Step 4: Add failing MCP registration tests**

  Assert the new tool names are registered and forward validated input to the matching Bridge methods; existing `delegate_current_request` schema and handler still work.

- [ ] **Step 5: Run RED tests**

  ```powershell
  node --test tests/bridge-tools.test.js tests/mcp-server.test.js
  ```

  Expected: new assertions fail because Router injection and methods do not exist; all pre-existing tests should remain green.

- [ ] **Step 6: Refactor without changing the legacy body**

  Rename the existing nested implementation to `delegateCurrentRequestLegacy`. Add a small dispatcher:

  ```js
  async function delegateCurrentRequest(input = {}) {
    return routerV2Enabled
      ? delegateCurrentRequestV2(input)
      : delegateCurrentRequestLegacy(input);
  }
  ```

  Lazily build the default Registry/RunStore/Orchestrator only in the V2 branch. Bind `web-sync` semantic functions to the existing nested text/file/wait helpers so old message and job formats remain authoritative.

- [ ] **Step 7: Implement strict V2 workspace resolution and compatibility mapping**

  Require a bound project, exact conversation and current Codex thread before side effects. Convert the Orchestrator result to the existing return shape; extract web-sync `message、syncJob、finalJob、timedOut` only from `transportResult.raw`, and use `null`/`[]` for Mock.

- [ ] **Step 8: Implement continue/cancel Bridge and MCP methods**

  Resolve the caller workspace through the same project/conversation path, build the exact three-field scope, then call Orchestrator. Do not accept scope values directly from an unverified Run payload.

- [ ] **Step 9: Run GREEN tests**

  Re-run Step 5. Expected: all bridge and MCP tests pass.

### Task 6: Directed Integration Verification

**Files:** No production edits unless a failing test exposes a defect; every defect fix first receives a focused regression assertion.

- [ ] **Step 1: Run the exact required directed suite**

  ```powershell
  node --test tests/gpt-transport-registry.test.js tests/mock-gpt-transport.test.js tests/router-run-store.test.js tests/router-orchestrator.test.js tests/bridge-tools.test.js
  ```

  Expected: exit code `0`, zero failed tests.

- [ ] **Step 2: Run MCP and existing routing/store regressions**

  ```powershell
  node --test tests/mcp-server.test.js tests/room-routing-policy.test.js tests/sync-store.test.js tests/artifact-store.test.js
  ```

  Expected: exit code `0`, zero failed tests.

- [ ] **Step 3: Inspect generated fixtures**

  For one test run, read the persisted Run JSON and assert the three scope values, stage request IDs/statuses, `currentStageIndex` and absolute project paths agree with test assertions. Do not delete test directories in bulk.

### Task 7: Full Regression and Requirement Audit

**Files:** No edits unless a failing regression first receives a focused test.

- [ ] **Step 1: Run the full suite with at least ten minutes budget**

  ```powershell
  npm test
  ```

  Tool timeout must be at least `600000` ms. If the process is still running, continue waiting and report only final exit status, pass/fail counts and relevant failures.

- [ ] **Step 2: Re-run the directed suite after any full-suite fix**

  Use Task 6 Step 1 command. Expected: exit `0`.

- [ ] **Step 3: Perform a line-by-line requirement audit**

  Confirm: default-off legacy path; web-sync wrapper; offline Mock; persisted stage fields; strict sequence; failure/cancel stop; resume no duplicate GPT task; exact artifact paths; three-way isolation; no private API/Cookie access; sync-store/Chrome job format compatibility; cross-process terminal locking; no Git initialization or commit.

- [ ] **Step 4: Final handoff**

  Report modified files, `BRIDGE_ROUTER_V2` and `BRIDGE_GPT_TRANSPORT` usage, exact directed/full test results, the fact that no real API Transport was added, and remaining web-sync/extension isolation risks.
