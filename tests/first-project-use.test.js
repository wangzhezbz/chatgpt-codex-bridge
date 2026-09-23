import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createHttpServer} from '../src/http-server.js';
import {createBridgeApiClient} from '../public/bridge-api-client.js';
import {createBridgeTools} from '../src/bridge-tools.js';
import {createProject,getProject} from '../src/project-store.js';

test('ordinary workbench creation does not inherit the HTTP startup task',async t=>{
  const storeRoot=await mkdtemp(path.join(tmpdir(),'bridge-first-'));
  const server=createHttpServer({storeRoot,currentCodexThreadId:'maintenance-task',env:{}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const client=createBridgeApiClient({fetchImpl:(url,options)=>fetch(base+url,options)});
  const config=await (await client.fetch('/api/config')).json();
  assert.equal(config.currentCodexThreadId,null);
  const result=await (await client.fetch('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Novel',chatgptProjectUrl:'https://chatgpt.com/c/first'})})).json();
  assert.equal(result.project.currentCodexThreadId,null);
  await client.fetch(`/api/projects/${result.project.id}/select`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  await fetch(base+'/api/projects');
  assert.equal((await getProject(storeRoot,result.project.id)).currentCodexThreadId,null,'legacy list reads must not claim a standalone project');
});

for(const scenario of ['same-directory','wrong-directory','owned-wrong-directory','wrong-conversation']){
  test(`first delegation associates only an unowned project from its real directory: ${scenario}`,async()=>{
    const storeRoot=await mkdtemp(path.join(tmpdir(),'bridge-first-'));
    const targetRepo=await mkdtemp(path.join(tmpdir(),'bridge-first-project-'));
    const owner=scenario==='owned-wrong-directory'?'other-task':null;
    const project=await createProject(storeRoot,{name:'Novel',targetRepo,chatgptProjectUrl:'https://chatgpt.com/c/first',currentCodexThreadId:owner});
    const tools=createBridgeTools({storeRoot,cwd:scenario.includes('wrong-directory')?storeRoot:targetRepo,env:{},currentCodexThreadId:'novel-task'});
    const input={projectId:project.id,conversationId:scenario==='wrong-conversation'?'other-conversation':project.conversationId,text:'让 GPT 写一篇小说大纲',waitForGpt:false};
    if(scenario==='same-directory'){
      await tools.delegateCurrentRequest(input);
      assert.equal((await getProject(storeRoot,project.id)).currentCodexThreadId,'novel-task');
    }else{
      await assert.rejects(()=>tools.delegateCurrentRequest(input));
      assert.equal((await getProject(storeRoot,project.id)).currentCodexThreadId,owner);
    }
  });
}

test('two Codex tasks in the same real project can delegate without rebinding or taking over each other runs',async()=>{
  const storeRoot=await mkdtemp(path.join(tmpdir(),'bridge-shared-'));
  const targetRepo=await mkdtemp(path.join(tmpdir(),'bridge-shared-project-'));
  const project=await createProject(storeRoot,{name:'Novel',targetRepo,chatgptProjectUrl:'https://chatgpt.com/c/shared',currentCodexThreadId:'first-task'});
  const first=createBridgeTools({storeRoot,cwd:targetRepo,env:{},currentCodexThreadId:'first-task'});
  const second=createBridgeTools({storeRoot,cwd:targetRepo,env:{},currentCodexThreadId:'second-task'});
  const input={projectId:project.id,conversationId:project.conversationId,text:'让 GPT 写一篇小说大纲',waitForGpt:false};
  const a=await first.delegateCurrentRequest(input);
  const b=await second.delegateCurrentRequest(input);
  assert.ok(a.routerRun.id);
  assert.ok(b.routerRun.id);
  assert.notEqual(a.routerRun.id,b.routerRun.id);
  assert.equal(a.routerRun.codexThreadId,'first-task');
  assert.equal(b.routerRun.codexThreadId,'second-task');
  assert.equal((await getProject(storeRoot,project.id)).currentCodexThreadId,'first-task');
  assert.equal((await second.getRouterRunStatus(input)).routerRun.id,b.routerRun.id);
  await assert.rejects(()=>second.cancelRouterRun({...input,runId:a.routerRun.id}));
});
