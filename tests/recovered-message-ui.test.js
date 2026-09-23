import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

function section(source, name, next) {
  return source.slice(source.indexOf(`function ${name}(`), source.indexOf(`\nfunction ${next}(`));
}
function element(tag) {
  return {tag,children:[],dataset:{},className:'',textContent:'',classList:{add(){}},
    append(...nodes){this.children.push(...nodes);},setAttribute(){},addEventListener(){}};
}
function text(node) {return typeof node==='string'?node:(node?.textContent||'')+(node?.children||[]).map(text).join('');}
async function ui() {
  const source=await readFile('public/app.js','utf8');
  const c=vm.createContext({document:{createElement:element},
    state:{artifactCache:new Map()},visualMessageFrom:()=> 'gpt',roleLabel:()=> 'GPT',
    formatMessageTime:x=>x,displayTextForMessage:m=>m.text,renderCodeBlocks:s=>s,
    renderMessageStatus:()=>null,renderSyncActions:()=>null,renderMessageArtifacts:()=>null,
    createMessageDeleteButton:()=>element('button')});
  vm.runInContext(section(source,'renderArtifactErrors','renderMessageArtifacts')+'\n'+section(source,'renderMessage','displayTextForMessage'),c);
  return c;
}
test('room projection marks only a verified same-conversation failed reply as recovered without rewriting history',async()=>{
  const source=await readFile('src/http-server.js','utf8');
  const c=vm.createContext({syncProgress:()=>null,syncRetryPlan:()=>({}),syncInputArtifactReason:()=>'',syncInputArtifactMetadata:()=>({})});
  vm.runInContext(section(source,'decorateRoomMessagesWithSyncState','normalizeInputArtifactIds'),c);
  const old={id:'failure',conversationId:'room',from:'gpt',text:'old failure',metadata:{syncJobId:'job',syncStatus:'failed'}};
  const original=JSON.stringify(old);
  for(const status of ['succeeded','failed','running']){
    const job={id:'job',conversationId:'room',status};
    const [result]=c.decorateRoomMessagesWithSyncState([old],[job]);
    assert.equal(result.metadata.syncRecovered,status==='succeeded');
    assert.equal(result.metadata.syncStatus,'failed');
    assert.equal(result.text,'old failure');
  }
  for(const job of [{id:'other',conversationId:'room',status:'succeeded'},{id:'job',conversationId:'foreign',status:'succeeded'}]){
    const [result]=c.decorateRoomMessagesWithSyncState([old],[job]);
    assert.equal(Boolean(result.metadata.syncRecovered),false);
  }
  assert.equal(JSON.stringify(old),original);
});
test('successful GPT reply receives current status even though historical reply metadata omitted it',async()=>{
  const source=await readFile('src/http-server.js','utf8');
  const c=vm.createContext({});
  vm.runInContext(section(source,'decorateRoomMessagesWithSyncState','normalizeInputArtifactIds'),c);
  const [message]=c.decorateRoomMessagesWithSyncState([{id:'reply',from:'gpt',conversationId:'room',metadata:{syncJobId:'job'}}],[{id:'job',conversationId:'room',status:'succeeded'}]);
  assert.equal(message.metadata.syncCurrentStatus,'succeeded');
});
test('recovered historical failure remains readable inside a collapsed disclosure',async()=>{
  const c=await ui();
  const result=c.renderMessage({from:'gpt',text:'ORIGINAL_FAILURE',metadata:{syncStatus:'failed',syncRecovered:true}});
  const disclosure=result.children.find(n=>n.tag==='details');
  assert.ok(disclosure);assert.notEqual(disclosure.open,true);
  assert.match(text(disclosure.children[0]),/已恢复/);
  assert.match(text(disclosure),/ORIGINAL_FAILURE/);
});
test('skipped unnamed control is diagnostic only after verified output success; missing output remains an error',async()=>{
  const c=await ui();
  const errors=[{code:'download_filename_ambiguous',error:'cannot identify'},{code:'missing_download',filename:'missing.txt'}];
  const recovered=c.renderArtifactErrors(errors,{outputSucceeded:true});
  const details=recovered.children.find(n=>n.tag==='details');
  assert.ok(details);assert.match(text(details),/诊断|跳过/);assert.notEqual(details.open,true);
  assert.ok(recovered.children.some(n=>n.className==='artifact-error'&&text(n).includes('missing.txt')));
  const failed=c.renderArtifactErrors(errors,{outputSucceeded:false});
  assert.equal(failed.children.some(n=>n.tag==='details'),false);
});

for(const scenario of ['output-ready','input-only','output-not-cached','not-succeeded']){
  test(`message artifact diagnostics respect actual output evidence: ${scenario}`,async()=>{
    const c=await ui();
    const source=await readFile('public/app.js','utf8');
    c.isImageArtifact=()=>false;c.renderImageGrid=()=>null;c.renderFileCard=()=>element('article');
    vm.runInContext(section(source,'renderMessageArtifacts','syncArtifactSummary'),c);
    c.state.artifactCache.set('input',{id:'input'});
    if(scenario!=='output-not-cached'&&scenario!=='input-only')c.state.artifactCache.set('output',{id:'output'});
    const result=c.renderMessageArtifacts({metadata:{
      syncCurrentStatus:scenario==='not-succeeded'?'running':'succeeded',
      artifactIds:scenario==='input-only'?[]:['output'],inputArtifactIds:['input'],
      artifactErrors:[{code:'download_filename_ambiguous',error:'unresolved'}]
    }});
    const diagnostics=result.children.find(n=>n.className==='artifact-errors');
    assert.equal(diagnostics.children.some(n=>n.tag==='details'),scenario==='output-ready');
  });
}
