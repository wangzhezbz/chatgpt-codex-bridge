import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function ui({ result = { captureOnly: true, resend: false }, apiImpl } = {}) {
  const source = await readFile("public/app.js", "utf8");
  const render = source.slice(source.indexOf("function renderSyncActions("), source.indexOf("async function deleteRoomMessage("));
  const retry = source.slice(source.indexOf("async function retrySyncJob("), source.indexOf("function syncCancelControls("));
  const calls = [], notices = [];
  const element = () => ({ children: [], append(...items) { this.children.push(...items); }, setAttribute() {} });
  const context = vm.createContext({
    document: { createElement: element, querySelectorAll: () => [] },
    state: { cancellingSyncJobIds: new Set(), retryingSyncJobIds: new Set() },
    createButton(label, className, click) { return { textContent: label, className, click, setAttribute() {} }; },
    markGptActionControl: button => button,
    ensureGptActionReady: async () => {},
    showToast: text => notices.push(text),
    refreshWorkspaceSurface: async () => {},
    api: async (url, options) => { calls.push({ url, options }); return apiImpl ? apiImpl() : result; }
  });
  vm.runInContext(`${render}\n${retry}`, context);
  return { context, calls, notices };
}

for (const [action, label] of [["capture", "重新收取结果"], ["resend", "重新发送"]]) {
  test(`retry button describes and submits ${action}`, async () => {
    const { context, calls } = await ui();
    const actions = context.renderSyncActions({ metadata: { syncJobId: "sync_fixture", syncCanRetry: true, syncRetryAction: action } });
    assert.equal(actions.children[0].textContent, label);
    await actions.children[0].click();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].options.body), { captureOnly: action === "capture" });
  });
}

test("unavailable retry metadata cannot render an actionable retry button", async () => {
  const { context } = await ui();
  const actions = context.renderSyncActions({ metadata: {
    syncJobId: "sync_fixture", syncCanRetry: true, syncRetryAction: null,
    syncRetryReason: "已停止，不会重新启动"
  } });
  assert.ok(!actions || actions.children.every(child => !child.click));
});

test('missing-file action creates only a capture-only recovery request',async()=>{
  const {context,calls}=await ui();
  context.scopedProjectPath=p=>`${p}?projectId=project_test`;
  const actions=context.renderSyncActions({metadata:{syncJobId:'parent',syncMissingArtifactNames:['b.txt']}});
  assert.ok(actions);assert.equal(actions.children[0].textContent,'补收缺失附件');
  await actions.children[0].click();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/sync/jobs/parent/recover-artifacts?projectId=project_test');
  assert.deepEqual(JSON.parse(calls[0].options.body),{captureOnly:true});
});

test("capture feedback follows the actual response, not a stale resend button", async () => {
  const { context, notices } = await ui();
  await context.retrySyncJob("sync_fixture", "resend");
  assert.match(notices[0], /收取/);
  assert.doesNotMatch(notices[0], /已重新发送/);
});

test("queued resend feedback does not claim GPT has already received it", async () => {
  const { context, notices } = await ui({ result: { syncJob: { status: "pending" }, captureOnly: false, resend: true } });
  await context.retrySyncJob("sync_fixture", "resend");
  assert.match(notices[0], /队列|排队/);
  assert.doesNotMatch(notices[0], /已重新发送给/);
});

test("retry click is deduplicated while in flight and released after failure", async () => {
  let reject;
  const waiting = new Promise((_, r) => { reject = r; });
  const { context, calls, notices } = await ui({ apiImpl: () => waiting });
  const first = context.retrySyncJob("sync_fixture", "capture");
  const second = context.retrySyncJob("sync_fixture", "capture");
  await new Promise(resolve => setImmediate(resolve));
  reject(new Error("任务已经完成，请刷新状态"));
  await Promise.allSettled([first, second]);
  assert.equal(calls.length, 1);
  assert.equal(context.state.retryingSyncJobIds.size, 0);
  assert.ok(notices.some(text => text.includes("已经完成")));
});

test("recovery duration distinguishes the current attempt from the old send",async()=>{
  const source=await readFile('public/app.js','utf8');
  const start=source.indexOf('function formatSyncProgressDuration(');
  const end=source.indexOf('\nfunction ',start+1);
  const c=vm.createContext({formatDurationMs:n=>`${n}ms`});
  vm.runInContext(source.slice(start,end),c);
  const progress={stage:'waiting_reply',timeline:{recoveryStartedAt:'2026-09-12T00:00:00Z'},durations:{responseMs:3600000,recoveryMs:5000}};
  assert.equal(c.formatSyncProgressDuration(progress),'本次恢复 5000ms');
});
