import assert from "node:assert/strict";
import { mkdtemp,readFile,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http-server.js";
import { updateWorkspaceBinding } from "../src/conversation-store.js";
import { appendRoomMessage } from "../src/room-store.js";
import { createSyncJob, failSyncJob, markSyncJobSent, getSyncJob, listSyncJobs,reopenFailedSyncJobForCapture,claimNextSyncJob } from "../src/sync-store.js";

test('capture recovery gets its own stale clock without changing original send or total duration',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'bridge-recovery-clock-'));
  const projectUrl='https://chatgpt.com/c/recovery-clock';
  await updateWorkspaceBinding(root,{chatgptProjectUrl:projectUrl,conversationId:'clock',targetRepo:root});
  const m=await appendRoomMessage(root,{conversationId:'clock',from:'user',to:['gpt'],text:'clock test'});
  const j=await createSyncJob(root,{projectUrl,conversationId:'clock',payloadText:'clock test',sourceMessageId:m.id});
  await markSyncJobSent(root,j.id,{workerId:'test-extension'});
  const file=path.join(root,'sync','jobs',j.id+'.json');
  const old=JSON.parse(await readFile(file,'utf8'));
  const oldTime=new Date(Date.now()-36*3600000).toISOString();
  await writeFile(file,JSON.stringify({...old,createdAt:oldTime,claimedAt:oldTime,sentAt:oldTime}));
  await failSyncJob(root,j.id,{error:'timeout',errorCode:'reply_timeout'});
  const startedBefore=Date.now();
  const reopened=await reopenFailedSyncJobForCapture(root,j.id);
  assert.ok(Date.parse(reopened.recoveryStartedAt)>=startedBefore);
  assert.equal(reopened.sentAt,oldTime);
  assert.equal(reopened.recoveryMode,'capture');
  const claimed=await claimNextSyncJob(root,{projectUrl,workerId:'test-extension'});
  assert.equal(claimed?.id,j.id,'a fresh recovery must survive abandoned-job expiry');
  assert.equal((await getSyncJob(root,j.id)).status,'running');
  const server=createHttpServer({env:{},storeRoot:root,runnerMode:'manual'});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const b=`http://127.0.0.1:${server.address().port}`;
  try{
    const metadata=async()=>{const r=await(await fetch(b+'/api/room/messages')).json();return r.messages.find(x=>x.id===m.id).metadata;};
    const fresh=await metadata();
    assert.equal(fresh.syncCanRetry,false);
    assert.match(fresh.syncProgress.message,/重新收取/);
    assert.equal(fresh.syncProgress.timeline.sentAt,oldTime);
    assert.equal(fresh.syncProgress.timeline.createdAt,oldTime);
    assert.ok(fresh.syncProgress.durations.responseMs>=3600000);
    assert.ok(fresh.syncProgress.durations.recoveryMs<10000);
    const recovering=await readFile(file,'utf8');
    await reopenFailedSyncJobForCapture(root,j.id);
    assert.equal(await readFile(file,'utf8'),recovering);
    await writeFile(file,JSON.stringify({...JSON.parse(recovering),recoveryStartedAt:new Date(Date.now()-7*60000).toISOString()}));
    assert.equal((await metadata()).syncCanRetry,true);
  }finally{await server.close();}
});

for (const [code, sent, pageState, router, action] of [
  ["missing_download", true, "ready", true, "capture"],
  ["reply_timeout", true, "ready", true, "capture"],
  ["pre_send_expired", false, "working", true, "capture"],
  ["client_blocked", true, "ready", true, "capture"],
  ["client_blocked", true, "blocked", true, null],
  ["manual_cancelled", false, "ready", true, null],
  ["unknown_failure", true, "ready", true, null],
  ["input_artifact_fetch_failed", false, "ready", true, "resend"],
  ["preference_not_applied", false, "ready", true, "resend"],
  ["pre_send_stale", false, "ready", true, "resend"],
  ["composer_text_not_applied", false, "ready", true, "resend"],
  ["send_not_confirmed", true, "ready", true, "resend"],
  ["unknown_failure", false, "ready", false, "resend"]
]) {
  test(`room retry policy matches execution: ${code}/${pageState}/${router}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "bridge-retry-policy-"));
    const projectUrl = "https://chatgpt.com/c/retry-policy";
    await updateWorkspaceBinding(root, { chatgptProjectUrl: projectUrl, conversationId: "default", targetRepo: root });
    const message = await appendRoomMessage(root, { from: "user", to: ["gpt"], text: "hello", conversationId: "default" });
    const job = await createSyncJob(root, {
      projectUrl, conversationId: "default", sourceMessageId: message.id, payloadText: "hello",
      targetRepo: root, projectId: "project_policy", codexThreadId: "thread_policy",
      routerTerminalSignalRequired: router, routerRunId: router ? "router_run_policy" : null
    });
    if (sent) await markSyncJobSent(root, job.id, { workerId: "test-extension" });
    await failSyncJob(root, job.id, { error: "controlled failure", errorCode: code });
    const server = createHttpServer({ env: {}, storeRoot: root, runnerMode: "manual" });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (route, body) => fetch(base + route, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
    });
    try {
      await post("/api/extension/heartbeat", {
        href: projectUrl, workerId: "test-extension", pageStatus: { state: pageState, code: pageState }
      });
      const room = await (await fetch(base + "/api/room/messages")).json();
      const metadata = room.messages.find(item => item.id === message.id).metadata;
      assert.equal(metadata.syncCanRetry, action !== null);
      assert.equal(metadata.syncRetryAction, action);
      if (action === "capture") {
        assert.match(metadata.syncReason, /收取/);
        assert.doesNotMatch(metadata.syncProgress.message, /重新生成/);
      }
      if (!action) assert.ok(metadata.syncRetryReason);
      const before = await getSyncJob(root, job.id);
      // An old frontend sends {}. Safe default capture must never regenerate files.
      const response = await post(`/api/sync/jobs/${job.id}/retry`, {});
      if (action === "capture") {
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.captureOnly, true);
        assert.equal(result.resend, false);
        assert.equal(result.syncJob.id, job.id);
        if (sent) assert.equal(result.syncJob.sentAt, before.sentAt);
        assert.equal((await listSyncJobs(root)).length, 1);
      } else if (action === "resend") {
        assert.ok([200, 201].includes(response.status));
        assert.equal((await response.json()).syncJob.status, "pending");
      } else {
        assert.equal(response.status, 409);
        assert.equal((await listSyncJobs(root)).length, 1);
      }
    } finally { await server.close(); }
  });
}
