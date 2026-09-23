import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as sync from '../src/sync-store.js';

test('missing-artifact recovery is additive, capture-only and idempotent',async()=>{
  assert.equal(typeof sync.createMissingArtifactRecovery,'function');
  const root=await mkdtemp(path.join(tmpdir(),'bridge-missing-recovery-'));
  const source=await sync.createSyncJob(root,{kind:'chat_message',payloadText:'Generate a.txt and b.txt',projectUrl:'https://chatgpt.com/c/recovery',targetRepo:path.join(root,'project'),conversationId:'conv_recovery',projectId:'project_recovery',codexThreadId:'thread_recovery'});
  await sync.markSyncJobSent(root,source.id,{submittedPromptTurnId:'original-turn'});
  await sync.completeSyncJob(root,source.id,{replyText:'Download a.txt and b.txt',artifactIds:['artifact_a'],artifactErrors:[{filename:'b.txt',error:'download timed out'},{filename:null,code:'download_filename_ambiguous',error:'skip'}]});
  const before=await sync.getSyncJob(root,source.id);
  const results=await Promise.all([1,2].map(()=>sync.createMissingArtifactRecovery(root,source.id,{capturedFilenames:['a.txt']})));
  assert.equal(results[0].id,results[1].id);
  const child=results[0];
  assert.notEqual(child.id,source.id);assert.equal(child.recoverySourceJobId,source.id);
  assert.deepEqual(child.recoveryFilenames,['b.txt']);assert.equal(child.recoveryMode,'capture');
  assert.equal(child.sentAt,before.sentAt);assert.equal(child.submittedPromptTurnId,'original-turn');
  assert.equal(child.routerTerminalSignalRequired,false);assert.equal(child.routerRunId,null);
  assert.equal(child.sourceMessageId,null);assert.deepEqual(child.inputArtifacts,[]);
  assert.deepEqual(await sync.getSyncJob(root,source.id),before);
  const claimed=await sync.claimNextSyncJob(root,{projectUrl:source.projectUrl,workerId:'test'});
  assert.equal(claimed.id,child.id);assert.ok(claimed.sentAt);
});

test('missing recovery eligibility rejects unanchored, unscoped, input, captured and unnamed files',()=>{
  const base={id:'sync_source',status:'succeeded',sentAt:new Date().toISOString(),submittedPromptTurnId:'turn',projectId:'project',conversationId:'conv',codexThreadId:'thread',projectUrl:'https://chatgpt.com/c/test',targetRepo:'F:/test',inputArtifacts:[{filename:'input.txt'}],artifactErrors:[{filename:'input.txt',error:'x'},{filename:'a.txt',error:'x'},{filename:'b.txt',error:'x'},{filename:'../escape.txt',error:'x'},{filename:null,error:'x'}]};
  assert.deepEqual(sync.missingArtifactRecoveryFilenames(base,['a.txt']),['b.txt']);
  for(const patch of [{status:'running'},{sentAt:null},{submittedPromptTurnId:null},{projectId:null},{codexThreadId:null},{recoverySourceJobId:'parent'}]){
    assert.deepEqual(sync.missingArtifactRecoveryFilenames({...base,...patch},['a.txt']),[]);
  }
});

test('recovery completeness is independent of natural-language file signals',async()=>{
  const source=await readFile('src/http-server.js','utf8');
  const code=source.slice(source.indexOf('function shouldFailForMissingArtifactCapture('),source.indexOf('\nfunction missingArtifactFailureMessage('));
  const c=vm.createContext({hasArtifactRequestSignal:()=>false,hasArtifactReplySignal:()=>false});vm.runInContext(code,c);
  assert.equal(c.shouldFailForMissingArtifactCapture({kind:'chat_message',recoverySourceJobId:'parent'},'完成',[],[{code:'missing_download',filename:'b.py'}]),true);
});

test('one numbered artifact cannot satisfy two separately requested missing files',async()=>{
  const source=await readFile('src/http-server.js','utf8');
  const start=source.indexOf('function unmatchedRecoveryFilenames(');
  assert.ok(start>=0);
  const c=vm.createContext({});vm.runInContext(source.slice(start,source.indexOf('\nfunction ',start+1)),c);
  assert.deepEqual(Array.from(c.unmatchedRecoveryFilenames(['b.txt','b (2).txt'],[{filename:'b (2).txt'}])),['b.txt']);
  assert.deepEqual(Array.from(c.unmatchedRecoveryFilenames(['b.txt'],[{filename:'b (2).txt'}])),[]);
});
