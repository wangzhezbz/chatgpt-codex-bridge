import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, mkdir, unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {spawn} from "node:child_process";
import {createProject, updateProject, listProjects, selectProject} from "../src/project-store.js";
import {getWorkspaceBinding, updateWorkspaceBinding} from "../src/conversation-store.js";

async function tempStore() { return mkdtemp(path.join(tmpdir(), "bridge-state-persistence-")); }

test("state safety preserves project writes from independent processes",async()=>{
  const root=await tempStore(), moduleUrl=new URL("../src/project-store.js",import.meta.url).href;
  const children=[0,1,2].map(n=>spawn(process.execPath,["--input-type=module","-e",`
    import {createProject} from ${JSON.stringify(moduleUrl)};
    for(let i=0;i<3;i++) await createProject(${JSON.stringify(root)},{name:'child-${n}-'+i});
  `],{stdio:["ignore","ignore","pipe"],windowsHide:true}));
  await Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    let errors="";child.stderr.on("data",d=>errors+=d);child.once("error",reject);
    child.once("exit",code=>code===0?resolve():reject(new Error(errors || `child exited ${code}`)));
  })));
  assert.deepEqual((await listProjects(root)).projects.map(p=>p.name).sort(),[
    "child-0-0","child-0-1","child-0-2","child-1-0","child-1-1","child-1-2","child-2-0","child-2-1","child-2-2"
  ]);
});

test("state safety detects corrupt workspace before changing the selected project",async()=>{
  const root=await tempStore(), a=await createProject(root,{name:"A"}),b=await createProject(root,{name:"B"});
  const before=await readFile(path.join(root,"projects.json"),"utf8");
  await writeFile(path.join(root,"workspace.json"),"{broken");
  await assert.rejects(selectProject(root,b.id),e=>e.code==="BRIDGE_STATE_CORRUPT");
  assert.equal(await readFile(path.join(root,"projects.json"),"utf8"),before);
});

test("state safety preserves simultaneous changes to separate projects", async()=>{
  const root=await tempStore();
  const a=await createProject(root,{name:"A"}), b=await createProject(root,{name:"B"});
  await Promise.all([updateProject(root,a.id,{name:"A updated"}),updateProject(root,b.id,{name:"B updated"})]);
  const state=await listProjects(root);
  assert.equal(state.projects.find(p=>p.id===a.id).name,"A updated");
  assert.equal(state.projects.find(p=>p.id===b.id).name,"B updated");
});

test("state safety merges simultaneous workspace field updates",async()=>{
  const root=await tempStore();
  await updateWorkspaceBinding(root,{conversationId:"original",syncMode:"manual"});
  await Promise.all([updateWorkspaceBinding(root,{syncMode:"auto"}),updateWorkspaceBinding(root,{projectId:"project-next"})]);
  const saved=await getWorkspaceBinding(root);
  assert.equal(saved.syncMode,"auto");
  assert.equal(saved.projectId,"project-next");
  assert.equal(saved.conversationId,"original");
});

for(const kind of ["projects","workspace"]) for(const text of ["{broken", "null", "[]", ...(kind==="projects" ? ['{"projects":{}}'] : [])]) {
  test(`state safety refuses corrupt ${kind} data: ${text}`,async()=>{
    const root=await tempStore(), file=path.join(root,kind+".json");
    await writeFile(file,text);
    const read=()=>kind==="projects"?listProjects(root):getWorkspaceBinding(root);
    const update=()=>kind==="projects"?createProject(root,{name:"must not replace old data"}):updateWorkspaceBinding(root,{syncMode:"auto"});
    await assert.rejects(read(),e=>e.code==="BRIDGE_STATE_CORRUPT");
    await assert.rejects(update(),e=>e.code==="BRIDGE_STATE_CORRUPT");
    assert.equal(await readFile(file,"utf8"),text);
  });
}

for(const kind of ["projects","workspace"]) test(`state safety does not mask ${kind} filesystem read failures`,async()=>{
  const root=await tempStore();
  await mkdir(path.join(root,kind+".json"));
  await assert.rejects(kind==="projects"?listProjects(root):getWorkspaceBinding(root),e=>e.code==="BRIDGE_STATE_READ_FAILED");
});

for(const kind of ["projects","workspace"]) test(`state safety preserves one previous ${kind} snapshot and does not reset a missing main file`,async()=>{
  const root=await tempStore(), file=path.join(root,kind+".json");
  const project=kind==="projects"?await createProject(root,{name:"Before"}):null;
  if(!project)await updateWorkspaceBinding(root,{conversationId:"before"});
  const before=await readFile(file,"utf8");
  if(project)await updateProject(root,project.id,{name:"After"});
  else await updateWorkspaceBinding(root,{conversationId:"after"});
  const backup=await readFile(file+".bak","utf8");
  assert.equal(backup,before);
  await unlink(file);
  await assert.rejects(project?listProjects(root):getWorkspaceBinding(root),e=>e.code==="BRIDGE_STATE_MISSING");
  assert.equal(await readFile(file+".bak","utf8"),before);
});
