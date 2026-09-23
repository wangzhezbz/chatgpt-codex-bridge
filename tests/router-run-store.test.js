import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdtemp, open, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createRouterRunStore } from "../src/router-run-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-router-run-store-"));
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await readFile(filePath);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Router lease child exited with ${code}: ${stderr}`));
      }
    });
  });
}

const SCOPE = {
  projectId: "project-1",
  conversationId: "conversation-1",
  codexThreadId: "thread-1"
};

function runInput(targetRepo, overrides = {}) {
  return {
    ...SCOPE,
    routeKind: "gpt_only",
    transportId: "mock",
    originalRequestText: "Write an outline, then a chapter.",
    targetRepo,
    chatgptProjectUrl: "https://chatgpt.com/c/conversation-1",
    stages: [
      {
        id: "outline",
        title: "Outline",
        payloadText: "Write only the outline."
      },
      {
        id: "chapter",
        title: "Chapter",
        dependsOn: "outline",
        instruction: "Use the outline and write only the chapter."
      }
    ],
    ...overrides
  };
}

test("router run store persists a complete version 2 run and restores it", async () => {
  const storeRoot = await tempStore();
  const targetRepo = path.join(storeRoot, "project");
  const store = createRouterRunStore({
    storeRoot,
    clock: () => "2026-07-10T12:00:00.000Z",
    runIdFactory: () => "router-run-1"
  });

  const created = await store.create(runInput(targetRepo));

  assert.equal(created.id, "router-run-1");
  assert.equal(created.version, 2);
  assert.equal(created.status, "pending");
  assert.equal(created.routeKind, "gpt_only");
  assert.equal(created.currentStageIndex, 0);
  assert.equal(created.projectId, SCOPE.projectId);
  assert.equal(created.conversationId, SCOPE.conversationId);
  assert.equal(created.codexThreadId, SCOPE.codexThreadId);
  assert.equal(created.transportId, "mock");
  assert.equal(created.autoAdvanceOnTransportTerminal, false);
  assert.equal(created.targetRepo, path.resolve(targetRepo));
  assert.deepEqual(created.projectArtifactPaths, []);
  assert.equal(created.createdAt, "2026-07-10T12:00:00.000Z");
  assert.equal(created.updatedAt, "2026-07-10T12:00:00.000Z");

  assert.deepEqual(created.stages[0], {
    id: "outline",
    title: "Outline",
    status: "pending",
    payloadText: "Write only the outline.",
    dependsOn: null,
    instruction: null,
    replyText: null,
    artifactIds: [],
    transportRequestId: null,
    submissionState: null,
    submissionOwnerPid: null,
    submissionOwnerToken: null,
    cancelRequestedAt: null,
    cancelReason: null,
    inputArtifacts: [],
    projectArtifactPaths: [],
    startedAt: null,
    completedAt: null,
    error: null
  });
  assert.equal(created.stages[1].dependsOn, "outline");
  assert.equal(created.stages[1].payloadText, "");
  assert.match(created.stages[1].instruction, /outline/);

  const jsonPath = path.join(storeRoot, "router-runs", "router-run-1.json");
  const serialized = await readFile(jsonPath, "utf8");
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), created);

  const restoredStore = createRouterRunStore({ storeRoot });
  assert.deepEqual(await restoredStore.get(created.id, SCOPE), created);
});

test("router run store updates a run only under the exact scope", async () => {
  const storeRoot = await tempStore();
  let clockIndex = 0;
  const times = ["2026-07-10T12:00:00.000Z", "2026-07-10T12:01:00.000Z"];
  const store = createRouterRunStore({
    storeRoot,
    clock: () => times[Math.min(clockIndex++, times.length - 1)],
    runIdFactory: () => "router-run-update"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  const updated = await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "running",
    stages: run.stages.map((stage, index) =>
      index === 0
        ? { ...stage, status: "running", transportRequestId: "mock-request-1" }
        : stage
    )
  }));

  assert.equal(updated.status, "running");
  assert.equal(updated.stages[0].transportRequestId, "mock-request-1");
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, "2026-07-10T12:01:00.000Z");
  assert.deepEqual((await store.list(SCOPE)).map((run) => run.id), [created.id]);
});

test("router run store validates and preserves an immutable submission owner token", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-owner-token"
  });
  await assert.rejects(
    () => store.create(runInput(path.join(storeRoot, "invalid-project"), {
      id: "router-run-invalid-owner-token",
      status: "running",
      stages: [{
        id: "outline",
        title: "Outline",
        status: "running",
        payloadText: "Write only the outline.",
        transportRequestId: "owner-token-request",
        submissionState: "submitting",
        submissionOwnerPid: process.pid,
        submissionOwnerToken: "invalid owner token"
      }]
    })),
    /submissionOwnerToken/i
  );

  const created = await store.create(runInput(path.join(storeRoot, "project"), {
    status: "running",
    stages: [{
      id: "outline",
      title: "Outline",
      status: "running",
      payloadText: "Write only the outline.",
      transportRequestId: "owner-token-request",
      submissionState: "submitting",
      submissionOwnerPid: process.pid,
      submissionOwnerToken: "owner-token-123"
    }]
  }));
  assert.equal(created.stages[0].submissionOwnerToken, "owner-token-123");
  const cancelIntent = await store.update(created.id, SCOPE, (run) => ({
    ...run,
    stages: run.stages.map((stage, index) =>
      index === 0
        ? {
            ...stage,
            cancelRequestedAt: " 2026-08-02T10:00:00.000Z ",
            cancelReason: " cancel after owner exits "
          }
        : stage
    )
  }));
  assert.equal(cancelIntent.stages[0].submissionOwnerToken, "owner-token-123");
  assert.equal(cancelIntent.stages[0].cancelRequestedAt, "2026-08-02T10:00:00.000Z");
  assert.equal(cancelIntent.stages[0].cancelReason, "cancel after owner exits");
  await assert.rejects(
    () => store.update(created.id, SCOPE, (run) => ({
      ...run,
      stages: run.stages.map((stage, index) =>
        index === 0 ? { ...stage, submissionOwnerToken: "owner-token-456" } : stage
      )
    })),
    /submission owner token.*immutable/i
  );
  assert.equal((await store.get(created.id, SCOPE)).stages[0].submissionOwnerToken, "owner-token-123");
});

test("router run store returns the committed update when abort arrives after atomic write starts", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-commit-point"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));
  const runsDir = path.join(storeRoot, "router-runs");
  const controller = new AbortController();
  let sawTemporaryWrite = false;
  let timeout;
  const watcher = watch(runsDir, (_eventType, filename) => {
    const name = String(filename || "");
    if (name.startsWith(`${created.id}.json.`) && name.endsWith(".tmp")) {
      sawTemporaryWrite = true;
      controller.abort(new Error("abort after commit write started"));
    }
  });

  try {
    timeout = setTimeout(() => controller.abort(new Error("timed out waiting for atomic temp write")), 5_000);
    const updated = await store.update(created.id, SCOPE, (run) => ({
      ...run,
      status: "running",
      stages: run.stages.map((stage, index) =>
        index === 0
          ? { ...stage, status: "running", replyText: "x".repeat(32 * 1024 * 1024) }
          : stage
      )
    }), { signal: controller.signal });
    assert.equal(sawTemporaryWrite, true);
    assert.equal(controller.signal.aborted, true);
    assert.equal(updated.status, "running");
    assert.deepEqual(await store.get(created.id, SCOPE), updated);
  } finally {
    clearTimeout(timeout);
    watcher.close();
  }
});

test("router run file-lock cleanup errors never replace an operation or AbortError", async () => {
  for (const primaryKind of ["operation", "abort"]) {
    const storeRoot = await tempStore();
    const creator = createRouterRunStore({
      storeRoot,
      runIdFactory: () => `router-run-lock-cleanup-${primaryKind}`
    });
    const created = await creator.create(runInput(path.join(storeRoot, "project")));
    const closeError = Object.assign(new Error(`${primaryKind} close cleanup failed`), { code: "ECLOSE" });
    const unlinkError = Object.assign(new Error(`${primaryKind} unlink cleanup failed`), { code: "EUNLINK" });
    const lockOperations = {
      async open(...args) {
        const handle = await open(...args);
        return {
          writeFile: handle.writeFile.bind(handle),
          async close() {
            await handle.close();
            throw closeError;
          }
        };
      },
      readFile,
      async unlink() {
        throw unlinkError;
      }
    };
    const store = createRouterRunStore({ storeRoot, lockOperations });
    const controller = new AbortController();
    const operationError = new Error("operation is the primary failure");
    let caught;
    try {
      await store.withRunLease(created.id, SCOPE, async () => {
        if (primaryKind === "abort") {
          controller.abort(new Error("abort is the primary failure"));
          return;
        }
        throw operationError;
      }, { signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught);
    if (primaryKind === "abort") {
      assert.equal(caught.name, "AbortError");
      assert.equal(caught.code, "ABORT_ERR");
    } else {
      assert.equal(caught, operationError);
    }
    assert.deepEqual(caught.cleanupErrors, [closeError, unlinkError]);
  }
});

test("router run file-lock retries transient unlink cleanup before the next lease", async () => {
  const storeRoot = await tempStore();
  const creator = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-lock-unlink-retry"
  });
  const created = await creator.create(runInput(path.join(storeRoot, "project")));
  let unlinkAttempts = 0;
  const store = createRouterRunStore({
    storeRoot,
    lockOperations: {
      async unlink(filePath) {
        unlinkAttempts += 1;
        if (unlinkAttempts === 1) {
          const error = new Error("transient router lock unlink failure");
          error.code = "EPERM";
          throw error;
        }
        return unlink(filePath);
      }
    }
  });

  assert.equal(await store.withRunLease(created.id, SCOPE, async () => "first"), "first");
  const second = await Promise.race([
    store.withRunLease(created.id, SCOPE, async () => "second"),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("next Router lease blocked on its own lock")), 250);
      timer.unref?.();
    })
  ]);
  assert.equal(second, "second");
  assert.equal(unlinkAttempts >= 3, true);
});

for (const partial of [false,true]) test(`lock ownership cleanup removes only its own failed initialization (partial=${partial})`,async()=>{
  const storeRoot=await tempStore();const creator=createRouterRunStore({storeRoot});
  const created=await creator.create(runInput(path.join(storeRoot,"project")));
  let lockPath,operations=0;const failure=Object.assign(new Error("initial owner write failed"),{code:"EIO"});
  const store=createRouterRunStore({storeRoot,lockOperations:{async open(file,...args){
    lockPath=file;const h=await open(file,...args);
    return {stat:options=>h.stat(options),close:()=>h.close(),async writeFile(text){if(partial)await h.writeFile(text.slice(0,9));throw failure;}};
  }}});
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>{operations++;}),e=>e===failure);
  assert.equal(operations,0);
  await assert.rejects(readFile(lockPath),e=>e.code==="ENOENT");
  assert.equal(await creator.withRunLease(created.id,SCOPE,async()=>"next",{signal:AbortSignal.timeout(1000)}),"next");
});

test("lock ownership cleanup never removes a replacement file after failed initialization",async()=>{
  const storeRoot=await tempStore();const creator=createRouterRunStore({storeRoot});
  const created=await creator.create(runInput(path.join(storeRoot,"project")));let lockPath;
  const failure=new Error("file replaced while initialization failed");
  const store=createRouterRunStore({storeRoot,lockOperations:{async open(file,...args){
    lockPath=file;const h=await open(file,...args);
    return {stat:options=>h.stat(options),close:async()=>{},async writeFile(){await h.close();await rename(file,file+".displaced");await writeFile(file,"");throw failure;}};
  }}});
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>assert.fail("uninitialized lock ran")),e=>e===failure);
  assert.equal(await readFile(lockPath,"utf8"),"");
});

test("lock ownership cleanup preserves distinct file IDs above Number precision",async()=>{
  const storeRoot=await tempStore();const creator=createRouterRunStore({storeRoot});
  const created=await creator.create(runInput(path.join(storeRoot,"project")));let lockPath;
  const inode=9007199254740992n;
  const info=(id,options)=>({dev:options?.bigint?1n:1,ino:options?.bigint?id:Number(id)});
  const failure=new Error("initialization failed with large inode");
  const store=createRouterRunStore({storeRoot,lockOperations:{
    async stat(_file,options){return info(inode+1n,options);},
    async open(file,...args){lockPath=file;const h=await open(file,...args);return {
      stat:async options=>info(inode,options),close:()=>h.close(),async writeFile(){throw failure;}
    };}
  }});
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>assert.fail("uninitialized lock ran")),e=>e===failure);
  assert.equal(await readFile(lockPath,"utf8"),"");
});

test("lock ownership cleanup retries transient owner reads and returns a committed result once",{skip:process.platform!=="win32"},async()=>{
  const storeRoot=await tempStore();const creator=createRouterRunStore({storeRoot});
  const created=await creator.create(runInput(path.join(storeRoot,"project")));let reads=0,operations=0;
  const store=createRouterRunStore({storeRoot,lockOperations:{async readFile(...args){
    reads++;if(reads<3)throw Object.assign(new Error("transient owner read"),{code:"EPERM"});return readFile(...args);
  }}});
  assert.equal(await store.withRunLease(created.id,SCOPE,async()=>{operations++;return "committed";}),"committed");
  assert.equal(operations,1);assert.equal(reads,3);
  assert.equal(await creator.withRunLease(created.id,SCOPE,async()=>"next",{signal:AbortSignal.timeout(1000)}),"next");
});

test("lock ownership cleanup refuses blind deletion when ownership remains unreadable",async()=>{
  const storeRoot=await tempStore();const creator=createRouterRunStore({storeRoot});
  const created=await creator.create(runInput(path.join(storeRoot,"project")));let reads=0,deletes=0;
  const failure=Object.assign(new Error("permanent owner read failure"),{code:"EPERM"});
  const store=createRouterRunStore({storeRoot,lockOperations:{async readFile(){reads++;throw failure;},async unlink(){deletes++;}}});
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>"done"),e=>e===failure);
  assert.equal(reads,process.platform==="win32"?3:1);assert.equal(deletes,0);
});

for (const fault of ["readFile", "unlink"]) test(`released lease recovers after exhausted ${fault} cleanup from another process`, async () => {
  const storeRoot = await tempStore();
  const creator = createRouterRunStore({storeRoot});
  const created = await creator.create(runInput(path.join(storeRoot, "project")));
  let operations = 0;
  const failure = Object.assign(new Error("cleanup access temporarily denied"), {code:"EPERM"});
  const store = createRouterRunStore({storeRoot, lockOperations:{[fault]:async()=>{throw failure;}}});
  await assert.rejects(store.withRunLease(created.id, SCOPE, async()=>{operations++; return "committed";}), e=>e===failure);
  const moduleUrl = pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createRouterRunStore} from ${JSON.stringify(moduleUrl)};
    const store=createRouterRunStore({storeRoot:${JSON.stringify(storeRoot)}});
    await store.withRunLease(${JSON.stringify(created.id)},${JSON.stringify(SCOPE)},async()=>{}, {signal:AbortSignal.timeout(2000)});
  `], {stdio:["ignore","ignore","pipe"], windowsHide:true});
  await waitForChild(child);
  assert.equal(operations, 1, "recovery must not replay the committed operation");
  assert.equal(await creator.withRunLease(created.id,SCOPE,async()=>"third",{signal:AbortSignal.timeout(1000)}), "third");
});

for (const kind of ["legacy_live", "wrong_release_token", "legacy_fake_release", "unknown", "zero_pid", "invalid_date", "corrupt_trailer", "oversized_pid"]) {
  test(`kernel recovery preserves unproven ownership: ${kind}`, async () => {
    const storeRoot = await tempStore(), store = createRouterRunStore({storeRoot});
    const created = await store.create(runInput(path.join(storeRoot, "project")));
    const file = path.join(storeRoot, "router-runs", `${created.id}.json.operation.lock`);
    const token = `${process.pid}-abcdef0123456789`;
    const malformed = {
      zero_pid:"0-abcdef0123456789 2026-01-01T00:00:00.000Z kernel-v1\n",
      invalid_date:"2147483647-abcdef0123456789 not-a-date kernel-v1\n",
      corrupt_trailer:"2147483647-abcdef0123456789 2026-01-01T00:00:00.000Z kernel-v1\nunknown trailing record\n",
      oversized_pid:"99999999999999999-abcdef0123456789 2026-01-01T00:00:00.000Z kernel-v1\n"
    };
    const text = malformed[kind] || (kind === "unknown" ? "partial-owner" :
      `${token} 2026-01-01T00:00:00.000Z${kind==="wrong_release_token"?" kernel-v1":""}\n` +
      (kind === "wrong_release_token" ? "released 123-deadbeefdeadbeef\n" : kind === "legacy_fake_release" ? `released ${token}\n` : ""));
    await writeFile(file,text); await utimes(file,new Date(0),new Date(0));
    await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>assert.fail("unproven lock was stolen"),
      {signal:AbortSignal.timeout(100)}), e=>e.code==="ABORT_ERR");
    assert.equal(await readFile(file,"utf8"),text);
  });
}

test("kernel recovery serializes competing processes after an owner crash", {skip:!["win32","linux"].includes(process.platform)}, async () => {
  const storeRoot=await tempStore(), store=createRouterRunStore({storeRoot});
  const created=await store.create(runInput(path.join(storeRoot,"project")));
  const moduleUrl=pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const setup=`import {createRouterRunStore} from ${JSON.stringify(moduleUrl)};
    const store=createRouterRunStore({storeRoot:${JSON.stringify(storeRoot)}});
    const id=${JSON.stringify(created.id)}, scope=${JSON.stringify(SCOPE)};`;
  const children=[];
  const start=code=>{
    const child=spawn(process.execPath,["--input-type=module","-e",setup+code],{stdio:["ignore","ignore","pipe","ipc"],windowsHide:true});
    children.push(child); return child;
  };
  const watchdog=setTimeout(()=>{for(const c of children)if(c.exitCode===null&&c.signalCode===null)c.kill();},8000);
  try {
    const owner=start(`await store.withRunLease(id,scope,async()=>{process.send('owned');await new Promise(()=>{});});`);
    const ownerExit=once(owner,"exit");
    await Promise.race([once(owner,"message"),ownerExit.then(()=>{throw new Error("owner exited before claim");})]);
    owner.kill(); await ownerExit;
    const probe=path.join(storeRoot,"critical-probe"), events=path.join(storeRoot,"events.txt");
    const childCode=`
      import {open,unlink,appendFile} from 'node:fs/promises';
      for(let i=0;i<3;i++) await store.withRunLease(id,scope,async()=>{
        const h=await open(${JSON.stringify(probe)},'wx');
        try { await appendFile(${JSON.stringify(events)},'entered\\n'); await new Promise(r=>setTimeout(r,30)); }
        finally {await h.close();await unlink(${JSON.stringify(probe)});}
      },{signal:AbortSignal.timeout(3000)});
      process.disconnect();`;
    const a=start(childCode), b=start(childCode);
    await Promise.all([waitForChild(a),waitForChild(b)]);
    assert.equal((await readFile(events,"utf8")).split("\n").filter(Boolean).length,6);
    assert.equal((await store.get(created.id,SCOPE)).status,created.status);
  } finally {
    clearTimeout(watchdog);
    await Promise.all(children.map(async child=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,"exit");child.kill();await exited;}}));
  }
});

for (const code of ["EPERM", "EBUSY", "EACCES"]) {
  test(`router lock acquisition retries ${code} only on Windows before obtaining a handle`, async () => {
    const storeRoot=await tempStore();
    const created=await createRouterRunStore({storeRoot}).create(runInput(path.join(storeRoot,"project")));
    let attempts=0, operations=0, acquired=false;
    const failure=Object.assign(new Error("controlled transient open"),{code});
    const store=createRouterRunStore({storeRoot,lockOperations:{async open(...args){
      attempts++;if(attempts<3)throw failure;
      const handle=await open(...args);acquired=true;return handle;
    }}});
    const result=store.withRunLease(created.id,SCOPE,async()=>{assert.equal(acquired,true);operations++;return "done";});
    if(process.platform==="win32"){
      assert.equal(await result,"done");assert.equal(attempts,3);assert.equal(operations,1);
    }else{
      await assert.rejects(result,error=>error===failure);assert.equal(attempts,1);assert.equal(operations,0);
    }
  });
}

test("router lock acquisition can abort during transient Windows access without running the operation",{skip:process.platform!=="win32"},async()=>{
  const storeRoot=await tempStore();
  const created=await createRouterRunStore({storeRoot}).create(runInput(path.join(storeRoot,"project")));
  const controller=new AbortController();let operations=0,fail=true,attempts=0;
  const store=createRouterRunStore({storeRoot,lockOperations:{async open(...args){
    attempts++;if(fail){setTimeout(()=>controller.abort(),5);throw Object.assign(new Error("busy"),{code:"EPERM"});}return open(...args);
  }}});
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>{operations++;},{signal:controller.signal}),e=>e.name==="AbortError");
  assert.equal(operations,0);fail=false;
  assert.equal(await store.withRunLease(created.id,SCOPE,async()=>"next"),"next");
  assert.ok(attempts>=2);
});

test("router lock acquisition leaves nontransient errors and post-open write errors unretried",async()=>{
  const storeRoot=await tempStore();
  const created=await createRouterRunStore({storeRoot}).create(runInput(path.join(storeRoot,"project")));
  for(const phase of ["open","write"]){
    let attempts=0,operations=0;
    const failure=Object.assign(new Error(phase),{code:phase==="open"?"ENOSPC":"EPERM"});
    const store=createRouterRunStore({storeRoot,lockOperations:{async open(...args){
      attempts++;if(phase==="open")throw failure;
      const handle=await open(...args);
      return {close:()=>handle.close(),async writeFile(...values){await handle.writeFile(...values);throw failure;}};
    }}});
    await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>{operations++;}),e=>e===failure);
    assert.equal(attempts,1);assert.equal(operations,0);
  }
});

test("router lock acquisition bounds persistent Windows permission failures",{skip:process.platform!=="win32"},async()=>{
  const storeRoot=await tempStore();
  const created=await createRouterRunStore({storeRoot}).create(runInput(path.join(storeRoot,"project")));
  let attempts=0;const failure=Object.assign(new Error("persistent denial"),{code:"EACCES"});
  const store=createRouterRunStore({storeRoot,lockOperations:{async open(){attempts++;throw failure;}}});
  const start=Date.now();
  await assert.rejects(store.withRunLease(created.id,SCOPE,async()=>assert.fail("unacquired lock ran operation")),e=>e===failure);
  assert.ok(attempts>1);assert.ok(Date.now()-start<5000,"access retry must not use the 35-second contention deadline");
});

test("router run store rejects project, conversation, and Codex thread scope mismatches", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-scope"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, projectId: "project-2" }),
    /scope mismatch.*projectId/i
  );
  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, conversationId: "conversation-2" }),
    /scope mismatch.*conversationId/i
  );
  await assert.rejects(
    () => store.get(created.id, { ...SCOPE, codexThreadId: "thread-2" }),
    /scope mismatch.*codexThreadId/i
  );
  await assert.rejects(
    () => store.get(created.id, { projectId: SCOPE.projectId }),
    /scope requires.*conversationId/i
  );
  await assert.rejects(
    () => store.update(created.id, { ...SCOPE, projectId: "project-2" }, { status: "failed" }),
    /scope mismatch.*projectId/i
  );
});

test("router run store resolves a transport request only inside its exact conversation and project path", async () => {
  const storeRoot = await tempStore();
  const targetRepo = path.join(storeRoot, "project");
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-transport-lookup"
  });
  const created = await store.create(
    runInput(targetRepo, {
      autoAdvanceOnTransportTerminal: true,
      stages: [
        {
          id: "outline",
          title: "Outline",
          status: "queued",
          payloadText: "Write only the outline.",
          transportRequestId: "sync-request-exact",
          submissionState: "submitted"
        }
      ]
    })
  );

  const matched = await store.findByTransportRequestId("sync-request-exact", {
    conversationId: SCOPE.conversationId,
    targetRepo: process.platform === "win32" ? targetRepo.toUpperCase() : targetRepo
  });
  assert.equal(matched.run.id, created.id);
  assert.equal(matched.stageIndex, 0);
  assert.equal(matched.run.autoAdvanceOnTransportTerminal, true);

  assert.equal(
    await store.findByTransportRequestId("sync-request-exact", {
      conversationId: "another-conversation",
      targetRepo
    }),
    null
  );
  assert.equal(
    await store.findByTransportRequestId("sync-request-exact", {
      conversationId: SCOPE.conversationId,
      targetRepo: path.join(storeRoot, "another-project")
    }),
    null
  );
});

test("router run store resolves a persisted run id before matching its scoped transport request", async () => {
  const storeRoot = await tempStore();
  const targetRepo = path.join(storeRoot, "project");
  const store = createRouterRunStore({ storeRoot });
  const requestId = "sync-shared-transport-request";
  const first = await store.create(runInput(targetRepo, {
    id: "router-run-exact-first",
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "queued",
      payloadText: "First run",
      transportRequestId: requestId,
      submissionState: "submitted"
    }]
  }));
  await store.create(runInput(targetRepo, {
    id: "router-run-exact-second",
    stages: [{
      id: "gpt",
      title: "GPT",
      status: "queued",
      payloadText: "Second run",
      transportRequestId: requestId,
      submissionState: "submitted"
    }]
  }));

  const matched = await store.findByRunIdAndTransportRequestId(
    first.id,
    requestId,
    {
      ...SCOPE,
      targetRepo: process.platform === "win32" ? targetRepo.toUpperCase() : targetRepo
    }
  );
  assert.equal(matched.run.id, first.id);
  assert.equal(matched.stageIndex, 0);
  assert.equal(
    await store.findByRunIdAndTransportRequestId(first.id, "sync-other", {
      ...SCOPE,
      targetRepo
    }),
    null
  );
  await assert.rejects(
    () => store.findByRunIdAndTransportRequestId(first.id, requestId, {
      ...SCOPE,
      projectId: "another-project",
      targetRepo
    }),
    /scope mismatch.*projectId/i
  );
  await assert.rejects(
    () => store.findByRunIdAndTransportRequestId(first.id, requestId, {
      ...SCOPE,
      codexThreadId: "another-thread",
      targetRepo
    }),
    /scope mismatch.*codexThreadId/i
  );
  await assert.rejects(
    () => store.findByRunIdAndTransportRequestId(first.id, requestId, {
      ...SCOPE,
      conversationId: "another-conversation",
      targetRepo
    }),
    /scope mismatch.*conversationId/i
  );
  assert.equal(
    await store.findByRunIdAndTransportRequestId(first.id, requestId, {
      ...SCOPE,
      targetRepo: path.join(storeRoot, "another-project")
    }),
    null
  );
});

test("router run store validates ids, unique stages, and dependency order", async () => {
  const storeRoot = await tempStore();

  const unsafeStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "../outside"
  });
  await assert.rejects(
    () => unsafeStore.create(runInput(path.join(storeRoot, "project"))),
    /invalid router run id/i
  );

  const duplicateStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-duplicate"
  });
  await assert.rejects(
    () =>
      duplicateStore.create(
        runInput(path.join(storeRoot, "project"), {
          stages: [
            { id: "same", title: "One" },
            { id: "same", title: "Two" }
          ]
        })
      ),
    /duplicate router stage id/i
  );

  const dependencyStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-dependency"
  });
  await assert.rejects(
    () =>
      dependencyStore.create(
        runInput(path.join(storeRoot, "project"), {
          stages: [
            { id: "first", title: "First", dependsOn: "second" },
            { id: "second", title: "Second" }
          ]
        })
      ),
    /dependency.*must reference an earlier stage/i
  );
});

test("router run store requires the full run scope", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-missing-scope"
  });

  await assert.rejects(
    () =>
      store.create(
        runInput(path.join(storeRoot, "project"), {
          codexThreadId: null
        })
      ),
    /codexThreadId is required/i
  );
});

test("router run store serializes concurrent updates without losing fields", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-concurrent"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  await Promise.all([
    store.update(created.id, SCOPE, { modePreference: "deep" }),
    store.update(created.id, SCOPE, { modelPreference: "gpt-test" })
  ]);
  const finalRun = await store.get(created.id, SCOPE);

  assert.equal(finalRun.modePreference, "deep");
  assert.equal(finalRun.modelPreference, "gpt-test");
});

test("router run store operation lease canonicalizes trimmed run ids and scopes across instances", async () => {
  const storeRoot = await tempStore();
  const firstStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-operation-lease"
  });
  const secondStore = createRouterRunStore({ storeRoot });
  const created = await firstStore.create(runInput(path.join(storeRoot, "project")));
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  let releaseFirst;
  let markFirstEntered;
  const firstEntered = new Promise((resolve) => {
    markFirstEntered = resolve;
  });
  const holdFirst = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const order = [];

  const first = firstStore.withRunLease(`  ${created.id}  `, paddedScope, async (run) => {
    order.push(`first:${run.id}`);
    markFirstEntered();
    await holdFirst;
    order.push("first:released");
  });
  await firstEntered;

  let secondEntered = false;
  const second = secondStore.withRunLease(created.id, SCOPE, async () => {
    secondEntered = true;
    order.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    `first:${created.id}`,
    "first:released",
    "second"
  ]);
});

test("router run store operation lease serializes independent Node processes", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-cross-process-lease"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));
  const routerStoreUrl = pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const childScript = `
    import { readFile, writeFile } from "node:fs/promises";
    import { createRouterRunStore } from ${JSON.stringify(routerStoreUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = createRouterRunStore({ storeRoot: process.env.STORE_ROOT });
    const scope = JSON.parse(process.env.RUN_SCOPE);
    await writeFile(process.env.READY_FILE, "ready", "utf8");
    await store.withRunLease(process.env.RUN_ID, scope, async () => {
      await writeFile(process.env.ENTERED_FILE, "entered", "utf8");
      if (process.env.RELEASE_FILE) {
        while (true) {
          try {
            await readFile(process.env.RELEASE_FILE);
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await sleep(20);
        }
      }
    });
  `;
  const firstReady = path.join(storeRoot, "first-ready");
  const firstEntered = path.join(storeRoot, "first-entered");
  const firstRelease = path.join(storeRoot, "first-release");
  const secondReady = path.join(storeRoot, "second-ready");
  const secondEntered = path.join(storeRoot, "second-entered");
  const commonEnv = {
    ...process.env,
    STORE_ROOT: storeRoot,
    RUN_ID: created.id,
    RUN_SCOPE: JSON.stringify(SCOPE)
  };
  const firstChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    cwd: process.cwd(),
    env: {
      ...commonEnv,
      READY_FILE: firstReady,
      ENTERED_FILE: firstEntered,
      RELEASE_FILE: firstRelease
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const firstResult = waitForChild(firstChild);
  let secondChild = null;
  try {
    await waitForFile(firstReady);
    await waitForFile(firstEntered);
    secondChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: process.cwd(),
      env: {
        ...commonEnv,
        READY_FILE: secondReady,
        ENTERED_FILE: secondEntered,
        RELEASE_FILE: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const secondResult = waitForChild(secondChild);
    await waitForFile(secondReady);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(
      () => readFile(secondEntered),
      (error) => error.code === "ENOENT"
    );

    await writeFile(firstRelease, "release", "utf8");
    await Promise.all([firstResult, secondResult]);
    await waitForFile(secondEntered);
  } finally {
    if (firstChild.exitCode == null) {
      firstChild.kill();
    }
    if (secondChild?.exitCode == null) {
      secondChild.kill();
    }
  }
});

test("router run store submission and finalization leases are independent and expose the latest scoped run", async () => {
  const storeRoot = await tempStore();
  const firstStore = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-named-leases"
  });
  const secondStore = createRouterRunStore({ storeRoot });
  const created = await firstStore.create(runInput(path.join(storeRoot, "project")));
  await firstStore.update(created.id, SCOPE, { modePreference: "latest" });
  const paddedScope = Object.fromEntries(
    Object.entries(SCOPE).map(([field, value]) => [field, `  ${value}  `])
  );
  let releaseSubmission;
  let markSubmissionEntered;
  const submissionEntered = new Promise((resolve) => {
    markSubmissionEntered = resolve;
  });
  const holdSubmission = new Promise((resolve) => {
    releaseSubmission = resolve;
  });

  const submission = firstStore.withSubmissionLease(
    `  ${created.id}  `,
    paddedScope,
    async (run) => {
      assert.equal(run.modePreference, "latest");
      markSubmissionEntered();
      await holdSubmission;
    }
  );
  await submissionEntered;

  try {
    const finalization = secondStore.withFinalizationLease(created.id, SCOPE, async (run) => {
      assert.equal(run.id, created.id);
      assert.equal(run.modePreference, "latest");
      return "finalized";
    });
    assert.equal(
      await Promise.race([
        finalization,
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 500))
      ]),
      "finalized"
    );
  } finally {
    releaseSubmission();
    await submission;
  }

  await assert.rejects(
    () =>
      firstStore.withSubmissionLease(
        created.id,
        { ...SCOPE, conversationId: "conversation-2" },
        async () => {}
      ),
    /scope mismatch.*conversationId/i
  );
  await assert.rejects(
    () => firstStore.withFinalizationLease(created.id, {}, async () => {}),
    /scope requires.*projectId/i
  );
});

for (const leaseMethod of ["withRunLease", "withSubmissionLease", "withFinalizationLease"]) {
  test(`router run store ${leaseMethod} aborts while queued and releases its queue node`, async () => {
    const storeRoot = await tempStore();
    const firstStore = createRouterRunStore({
      storeRoot,
      runIdFactory: () => `router-run-abort-${leaseMethod}`
    });
    const secondStore = createRouterRunStore({ storeRoot });
    const thirdStore = createRouterRunStore({ storeRoot });
    const created = await firstStore.create(runInput(path.join(storeRoot, "project")));
    let releaseFirst;
    let markFirstEntered;
    const firstEntered = new Promise((resolve) => {
      markFirstEntered = resolve;
    });
    const firstBarrier = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = firstStore[leaseMethod](created.id, SCOPE, async () => {
      markFirstEntered();
      await firstBarrier;
    });
    await firstEntered;

    const controller = new AbortController();
    let secondEntered = false;
    const second = secondStore[leaseMethod](created.id, SCOPE, async () => {
      secondEntered = true;
    }, { signal: controller.signal });
    const secondOutcome = second.then(
      () => "resolved",
      (error) => error?.name === "AbortError" && error?.code === "ABORT_ERR" ? "aborted" : "wrong-error"
    );
    try {
      controller.abort();
      assert.equal(
        await Promise.race([
          secondOutcome,
          new Promise((resolve) => setTimeout(() => resolve("blocked"), 100))
        ]),
        "aborted"
      );
      assert.equal(secondEntered, false);
    } finally {
      releaseFirst();
      await first;
      await second.catch(() => {});
    }

    const third = await Promise.race([
      thirdStore[leaseMethod](created.id, SCOPE, async () => "third-entered"),
      new Promise((resolve) => setTimeout(() => resolve("blocked"), 200))
    ]);
    assert.equal(third, "third-entered");
  });
}

test("router run store named leases serialize independent Node processes", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-cross-process-named-leases"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));
  const routerStoreUrl = pathToFileURL(path.resolve("src/router-run-store.js")).href;
  const childScript = `
    import { readFile, writeFile } from "node:fs/promises";
    import { createRouterRunStore } from ${JSON.stringify(routerStoreUrl)};
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const store = createRouterRunStore({ storeRoot: process.env.STORE_ROOT });
    const scope = JSON.parse(process.env.RUN_SCOPE);
    await writeFile(process.env.READY_FILE, "ready", "utf8");
    await store[process.env.LEASE_METHOD](process.env.RUN_ID, scope, async () => {
      await writeFile(process.env.ENTERED_FILE, "entered", "utf8");
      if (process.env.RELEASE_FILE) {
        while (true) {
          try {
            await readFile(process.env.RELEASE_FILE);
            break;
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          await sleep(20);
        }
      }
    });
  `;

  for (const leaseMethod of ["withSubmissionLease", "withFinalizationLease"]) {
    const marker = leaseMethod === "withSubmissionLease" ? "submission" : "finalization";
    const firstReady = path.join(storeRoot, `${marker}-first-ready`);
    const firstEntered = path.join(storeRoot, `${marker}-first-entered`);
    const firstRelease = path.join(storeRoot, `${marker}-first-release`);
    const secondReady = path.join(storeRoot, `${marker}-second-ready`);
    const secondEntered = path.join(storeRoot, `${marker}-second-entered`);
    const commonEnv = {
      ...process.env,
      STORE_ROOT: storeRoot,
      RUN_ID: created.id,
      RUN_SCOPE: JSON.stringify(SCOPE),
      LEASE_METHOD: leaseMethod
    };
    const firstChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
      cwd: process.cwd(),
      env: {
        ...commonEnv,
        READY_FILE: firstReady,
        ENTERED_FILE: firstEntered,
        RELEASE_FILE: firstRelease
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const firstResult = waitForChild(firstChild);
    let secondChild = null;
    try {
      await waitForFile(firstReady);
      await waitForFile(firstEntered);
      secondChild = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
        cwd: process.cwd(),
        env: {
          ...commonEnv,
          READY_FILE: secondReady,
          ENTERED_FILE: secondEntered,
          RELEASE_FILE: ""
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      const secondResult = waitForChild(secondChild);
      await waitForFile(secondReady);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await assert.rejects(
        () => readFile(secondEntered),
        (error) => error.code === "ENOENT"
      );

      await writeFile(firstRelease, "release", "utf8");
      await Promise.all([firstResult, secondResult]);
      await waitForFile(secondEntered);
    } finally {
      if (firstChild.exitCode == null) {
        firstChild.kill();
      }
      if (secondChild?.exitCode == null) {
        secondChild.kill();
      }
    }
  }
});

test("router run store rejects reversing a terminal run or stage", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-terminal"
  });
  const created = await store.create(
    runInput(path.join(storeRoot, "project"), {
      stages: [{ id: "gpt", title: "GPT", payloadText: "done" }]
    })
  );
  await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "succeeded",
    stages: run.stages.map((stage) => ({
      ...stage,
      status: "succeeded",
      replyText: "done",
      completedAt: "2026-07-10T12:00:00.000Z"
    }))
  }));

  await assert.rejects(
    () =>
      store.update(created.id, SCOPE, (run) => ({
        ...run,
        status: "running",
        stages: run.stages.map((stage) => ({ ...stage, status: "running" }))
      })),
    /terminal.*immutable/i
  );
  assert.equal((await store.get(created.id, SCOPE)).status, "succeeded");
});

test("router run store keeps immutable identity even when an updater mutates its input", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-immutable-identity"
  });
  const created = await store.create(runInput(path.join(storeRoot, "project")));

  const updated = await store.update(created.id, SCOPE, (run) => {
    run.id = "router-run-hijacked";
    run.createdAt = "1999-01-01T00:00:00.000Z";
    run.modePreference = "deep";
    return run;
  });

  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.modePreference, "deep");
  await assert.rejects(
    () => store.get("router-run-hijacked", SCOPE),
    (error) => error.code === "ENOENT"
  );
});

test("router run store does not rewrite data of an already terminal stage", async () => {
  const storeRoot = await tempStore();
  const store = createRouterRunStore({
    storeRoot,
    runIdFactory: () => "router-run-terminal-stage-data"
  });
  const created = await store.create(
    runInput(path.join(storeRoot, "project"), {
      stages: [{ id: "gpt", title: "GPT", payloadText: "done" }]
    })
  );
  await store.update(created.id, SCOPE, (run) => ({
    ...run,
    status: "succeeded",
    stages: run.stages.map((stage) => ({
      ...stage,
      status: "succeeded",
      replyText: "original result",
      artifactIds: ["artifact-original"],
      completedAt: "2026-07-10T12:00:00.000Z"
    }))
  }));

  await assert.rejects(
    () =>
      store.update(created.id, SCOPE, (run) => ({
        ...run,
        stages: run.stages.map((stage) => ({
          ...stage,
          replyText: "rewritten result",
          artifactIds: ["artifact-rewritten"]
        }))
      })),
    /terminal.*immutable/i
  );
  const persisted = await store.get(created.id, SCOPE);
  assert.equal(persisted.stages[0].replyText, "original result");
  assert.deepEqual(persisted.stages[0].artifactIds, ["artifact-original"]);
});
