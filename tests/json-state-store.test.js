import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,readdir,open,rename} from "node:fs/promises";
import path from "node:path";
import {tmpdir} from "node:os";
import test from "node:test";
import {readJsonState,writeJsonState,withJsonStateLock} from "../src/json-state-store.js";

const valid=v=>v && typeof v==="object" && !Array.isArray(v) && typeof v.count==="number";
async function fixture() {
  const root=await mkdtemp(path.join(tmpdir(),"bridge-json-state-")), file=path.join(root,"state.json");
  const original='{"count":1}\n'; await writeFile(file,original);
  return {root,file,original};
}

for(const stage of ["backup_replace","main_replace","partial_write","sync"]) {
  test(`atomic state retains original content when ${stage} fails`,async()=>{
    const {root,file,original}=await fixture(), failure=Object.assign(new Error(stage),{code:"EIO"});
    await writeFile(file+".bak",'{"count":0}\n');
    const operations={
      async rename(from,to){
        if((stage==="backup_replace" && to===file+".bak") || (stage==="main_replace" && to===file)) throw failure;
        return rename(from,to);
      },
      async open(name,...args){
        const h=await open(name,...args);
        if(name.startsWith(file+".") && !name.startsWith(file+".bak.")) return {
          async writeFile(text,...rest){if(stage==="partial_write"){await h.writeFile(text.slice(0,4));throw failure;}return h.writeFile(text,...rest);},
          async sync(){if(stage==="sync")throw failure;return h.sync();},
          close:()=>h.close()
        };
        return h;
      }
    };
    await assert.rejects(withJsonStateLock(file,()=>writeJsonState(file,{count:2},valid,operations)),e=>e===failure);
    assert.equal(await readFile(file,"utf8"),original);
    assert.equal(await readFile(file+".bak","utf8"),stage==="backup_replace"?'{"count":0}\n':original);
    assert.deepEqual((await readdir(root)).sort(),["state.json","state.json.bak"]);
    await withJsonStateLock(file,()=>writeJsonState(file,{count:3},valid));
    assert.equal((await readJsonState(file,valid)).value.count,3,"failure must release the writer lock");
  });
}

test("atomic state readers see old complete data until main replacement",async()=>{
  const {file}=await fixture(); let release, markReady;
  const hold=new Promise(r=>release=r),ready=new Promise(r=>markReady=r);
  const writing=withJsonStateLock(file,()=>writeJsonState(file,{count:2},valid,{async rename(from,to){
    if(to===file){markReady();await hold;} return rename(from,to);
  }}));
  try {await ready; assert.deepEqual((await readJsonState(file,valid)).value,{count:1});}
  finally {release();await writing;}
  assert.deepEqual((await readJsonState(file,valid)).value,{count:2});
});

test("atomic state never replaces a good backup with a corrupt main file",async()=>{
  const {file}=await fixture(); await writeFile(file+".bak",'{"count":0}\n');await writeFile(file,"{broken");
  await assert.rejects(withJsonStateLock(file,()=>writeJsonState(file,{count:2},valid)),e=>e.code==="BRIDGE_STATE_CORRUPT");
  assert.equal(await readFile(file,"utf8"),"{broken");
  assert.equal(await readFile(file+".bak","utf8"),'{"count":0}\n');
});

test("atomic state rejects values that serialize into an invalid persisted shape",async()=>{
  const {root,file,original}=await fixture();
  await assert.rejects(withJsonStateLock(file,()=>writeJsonState(file,{count:NaN},valid)),e=>e.code==="BRIDGE_STATE_CORRUPT");
  assert.equal(await readFile(file,"utf8"),original);
  assert.deepEqual(await readdir(root),["state.json"]);
});
