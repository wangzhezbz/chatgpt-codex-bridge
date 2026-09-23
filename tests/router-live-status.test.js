import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createBridgeTools} from '../src/bridge-tools.js';
import {createProject} from '../src/project-store.js';
import {createRouterRunStore} from '../src/router-run-store.js';
import {createSyncJob,claimNextSyncJob,listSyncJobs,markSyncJobSent,failSyncJob,reopenFailedSyncJobForCapture,reopenFailedSyncJobForResend,getSyncJob,completeSyncJob} from '../src/sync-store.js';

async function setup({foreignThread=false}={}){
  const root=await mkdtemp(path.join(tmpdir(),'bridge-live-status-'));
  const targetRepo=path.join(root,'project');await mkdir(targetRepo);
  const project=await createProject(root,{id:'status-project',conversationId:'status-conversation',currentCodexThreadId:'status-thread',targetRepo,chatgptProjectUrl:'https://chatgpt.com/c/status-fixture'});
  const scope={projectId:project.id,conversationId:project.conversationId,codexThreadId:'status-thread'};
  const runs=createRouterRunStore({storeRoot:root,runIdFactory:()=> 'status-run'});
  const run=await runs.create({...scope,routeKind:'gpt_only',transportId:'web-sync',status:'queued',targetRepo,chatgptProjectUrl:project.chatgptProjectUrl,originalRequestText:'test',currentStageIndex:0,stages:[{id:'outline',title:'Outline',status:'queued',transportRequestId:'sync_router_status_request',payloadText:'test'},{id:'chapter',title:'Chapter',dependsOn:'outline',payloadText:'next'}]});
  await createSyncJob(root,{id:'sync_router_status_request',kind:'user_request',projectId:project.id,conversationId:project.conversationId,codexThreadId:foreignThread?'other-thread':'status-thread',routerRunId:run.id,projectUrl:project.chatgptProjectUrl,targetRepo,payloadText:'test'});
  await claimNextSyncJob(root,{projectUrl:project.chatgptProjectUrl,workerId:'status-worker'});
  return {root,scope,run,runs,tools:createBridgeTools({storeRoot:root,currentCodexThreadId:'status-thread'}),input:{projectId:project.id,conversationId:project.conversationId,runId:run.id}};
}

test('read-only Router status reflects a running transport without submitting or rewriting stages',async()=>{
  const h=await setup();
  const file=path.join(h.root,'router-runs',h.run.id+'.json');
  const before=await readFile(file,'utf8');
  const result=await h.tools.getRouterRunStatus(h.input);
  assert.equal(result.routerRun.status,'running');
  assert.equal(result.routerRun.stages[0].status,'running');
  assert.equal(result.routerRun.stages[1].transportRequestId,null);
  assert.equal((await listSyncJobs(h.root)).length,1);
  assert.equal(await readFile(file,'utf8'),before);
});

test('another thread transport cannot promote this Router run to running',async()=>{
  const h=await setup({foreignThread:true});
  const result=await h.tools.getRouterRunStatus(h.input);
  assert.equal(result.routerRun.status,'queued');
});

for (const mode of ['capture','resend']) {
  test(`read-only failed Router status reports active ${mode} recovery without rewriting history`,async()=>{
    const h=await setup();
    const id='sync_router_status_request';
    if(mode==='capture')await markSyncJobSent(h.root,id,{workerId:'status-worker'});
    await failSyncJob(h.root,id,{error:'original failure',errorCode:mode==='capture'?'reply_timeout':'input_artifact_fetch_failed'});
    await h.runs.update(h.run.id,h.scope,run=>({...run,status:'failed',error:'original failure',stages:run.stages.map((s,i)=>i===0?{...s,status:'failed',submissionState:'submitted',error:'original failure',completedAt:new Date().toISOString()}:s)}));
    const reopened=mode==='capture'?await reopenFailedSyncJobForCapture(h.root,id):await reopenFailedSyncJobForResend(h.root,id,{allowUnsentRouterFailure:true});
    const file=path.join(h.root,'router-runs',h.run.id+'.json');
    const before=await readFile(file,'utf8');
    const result=await h.tools.getRouterRunStatus(h.input);
    assert.equal(result.observationState,'recovering');
    assert.equal(result.routerRun.status,mode==='capture'?'running':'queued');
    assert.equal(result.routerRun.error,null);
    assert.equal(result.routerRun.stages[0].error,null);
    assert.equal(result.routerRun.stages[0].completedAt,null);
    assert.equal(result.recovery.startedAt,reopened.recoveryStartedAt);
    assert.equal(result.recovery.mode,mode);
    assert.equal(result.nextAction.runId,h.run.id);
    assert.equal(result.routerRun.stages[1].transportRequestId,null);
    assert.equal((await listSyncJobs(h.root)).length,1);
    assert.equal(await readFile(file,'utf8'),before);
  });
}

for(const state of ['cancelled','succeeded']){
  test(`active transport cannot reopen a ${state} Router status`,async()=>{
    const h=await setup();
    await h.runs.update(h.run.id,h.scope,run=>({...run,status:state,stages:run.stages.map(s=>({...s,status:state}))}));
    const result=await h.tools.getRouterRunStatus(h.input);
    assert.equal(result.routerRun.status,state);
    assert.equal(result.nextAction,null);
  });
}

test('foreign recovery evidence cannot promote a failed Router run',async()=>{
  const h=await setup({foreignThread:true});
  const id='sync_router_status_request';
  await markSyncJobSent(h.root,id,{workerId:'status-worker'});
  await failSyncJob(h.root,id,{error:'failure',errorCode:'reply_timeout'});
  await h.runs.update(h.run.id,h.scope,run=>({...run,status:'failed',error:'failure',stages:run.stages.map((s,i)=>i===0?{...s,status:'failed',submissionState:'submitted',error:'failure'}:s)}));
  await reopenFailedSyncJobForCapture(h.root,id);
  const result=await h.tools.getRouterRunStatus(h.input);
  assert.equal(result.routerRun.status,'failed');
  assert.equal(result.nextAction,null);
  assert.equal(result.recovery,undefined);
});

async function recoveringFixture(mode='capture',options={}){
  const h=await setup(options),id='sync_router_status_request';
  if(mode==='capture')await markSyncJobSent(h.root,id,{workerId:'status-worker'});
  await failSyncJob(h.root,id,{error:'original failure',errorCode:mode==='capture'?'reply_timeout':'input_artifact_fetch_failed'});
  await h.runs.update(h.run.id,h.scope,run=>({...run,status:'failed',error:'original failure',stages:run.stages.map((s,i)=>i===0?{...s,status:'failed',submissionState:'submitted',error:'original failure'}:s)}));
  if(mode==='capture')await reopenFailedSyncJobForCapture(h.root,id);
  else await reopenFailedSyncJobForResend(h.root,id,{allowUnsentRouterFailure:true});
  return {...h,id};
}

for(const mode of ['capture','resend']){
  test(`continue and query agree during ${mode} recovery without a new submission`,async()=>{
    const h=await recoveringFixture(mode);
    const before=await readFile(path.join(h.root,'router-runs',h.run.id+'.json'),'utf8');
    const continued=await h.tools.continueRouterRun({...h.input,waitForGpt:true,timeoutMs:5,timeoutGraceMs:0,pollMs:1});
    const queried=await h.tools.getRouterRunStatus(h.input);
    assert.equal(continued.observationState,'recovering');
    assert.equal(continued.routerRun.status,queried.routerRun.status);
    assert.equal(continued.routerRun.error,null);
    assert.deepEqual(continued.recovery,queried.recovery);
    assert.equal(continued.nextAction.runId,h.run.id);
    assert.equal((await listSyncJobs(h.root)).length,1);
    assert.equal(await readFile(path.join(h.root,'router-runs',h.run.id+'.json'),'utf8'),before);
  });
  test(`cancel stops a ${mode} recovery and persists cancellation without advancing`,async()=>{
    const h=await recoveringFixture(mode);
    const result=await h.tools.cancelRouterRun({...h.input,reason:'user cancelled recovery'});
    assert.equal(result.routerRun.status,'cancelled');
    assert.equal((await getSyncJob(h.root,h.id)).errorCode,'manual_cancelled');
    assert.equal((await h.runs.get(h.run.id,h.scope)).status,'cancelled');
    assert.equal((await h.tools.getRouterRunStatus(h.input)).nextAction,null);
    assert.equal(result.routerRun.stages[1].transportRequestId,null);
    assert.equal((await listSyncJobs(h.root)).length,1);
    assert.equal((await h.tools.cancelRouterRun(h.input)).routerRun.status,'cancelled');
  });
}

test('cancelling a recovery refuses foreign transport scope',async()=>{
  const h=await recoveringFixture('capture',{foreignThread:true});
  await h.tools.cancelRouterRun(h.input);
  assert.equal((await getSyncJob(h.root,h.id)).status,'running');
  assert.equal((await h.runs.get(h.run.id,h.scope)).status,'failed');
});

test('a completed recovery wins cancellation without submitting the following stage',async()=>{
  const h=await recoveringFixture();
  await completeSyncJob(h.root,h.id,{replyText:'completed before cancellation'});
  const result=await h.tools.cancelRouterRun(h.input);
  assert.equal(result.routerRun.stages[0].status,'succeeded');
  assert.equal(result.routerRun.stages[0].replyText,'completed before cancellation');
  assert.equal((await getSyncJob(h.root,h.id)).status,'succeeded');
  assert.equal((await listSyncJobs(h.root)).length,1);
  assert.equal(result.routerRun.stages[1].transportRequestId,null);
});

test('waiting continuation and concurrent recovery cancellation converge on cancelled',async()=>{
  for(let attempt=0;attempt<8;attempt++){
    const h=await recoveringFixture();
    const waiting=h.tools.continueRouterRun({...h.input,waitForGpt:true,timeoutMs:1000,timeoutGraceMs:0,pollMs:1});
    const cancel=h.tools.cancelRouterRun({...h.input,reason:'cancel while waiting'});
    const [continued,cancelled]=await Promise.all([waiting,cancel]);
    assert.equal(cancelled.routerRun.status,'cancelled');
    assert.equal(continued.routerRun.status,'cancelled');
    assert.equal(continued.nextAction,null);
    assert.equal((await listSyncJobs(h.root)).length,1);
  }
});

test('continuation cannot advertise recovery for a foreign transport',async()=>{
  const h=await recoveringFixture('capture',{foreignThread:true});
  const result=await h.tools.continueRouterRun({...h.input,waitForGpt:true,timeoutMs:1,timeoutGraceMs:0,pollMs:1});
  assert.equal(result.routerRun.status,'failed');
  assert.equal(result.nextAction,null);
});

test('queue-only continuation observes recovery without entering the long wait budget',async()=>{
  const h=await recoveringFixture();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('queue-only continuation unexpectedly waited')),2000);
  try{
    const result=await h.tools.continueRouterRun({...h.input,waitForGpt:false,signal:controller.signal});
    assert.equal(result.observationState,'recovering');
    assert.equal(result.routerRun.status,'running');
    assert.equal((await listSyncJobs(h.root)).length,1);
  }finally{clearTimeout(timer);}
});
