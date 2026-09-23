import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {once} from "node:events";
import net from "node:net";
import {acquireRouterLockGuard} from "../src/router-lock-guard.js";

async function lockPath() { return path.join(await mkdtemp(path.join(tmpdir(), "bridge-kernel-lock-")), "lease.lock"); }

test("kernel guard excludes same-path contenders but permits different locks", async () => {
  const file = await lockPath();
  const release = await acquireRouterLockGuard(file);
  try {
    await assert.rejects(acquireRouterLockGuard(file, {timeoutMs:60}), e=>e.code === "ROUTER_LOCK_TIMEOUT");
    const independent = await acquireRouterLockGuard(file+".other", {timeoutMs:200});
    await independent();
  } finally { await release(); }
  const next = await acquireRouterLockGuard(file, {timeoutMs:200});
  await next();
  await next();
});

test("kernel guard cancellation cannot release the current owner", async () => {
  const file = await lockPath();
  const release = await acquireRouterLockGuard(file);
  try {
    await assert.rejects(acquireRouterLockGuard(file, {signal:AbortSignal.timeout(30)}), e=>e.code === "ABORT_ERR");
    await assert.rejects(acquireRouterLockGuard(file, {timeoutMs:60}), e=>e.code === "ROUTER_LOCK_TIMEOUT");
  } finally { await release(); }
  const next = await acquireRouterLockGuard(file, {timeoutMs:200});
  await next();
});

test("kernel guard canonicalizes Windows case aliases", {skip:process.platform!=="win32"}, async () => {
  const file = await lockPath();
  const release = await acquireRouterLockGuard(file);
  try { await assert.rejects(acquireRouterLockGuard(file.toUpperCase(), {timeoutMs:60}), e=>e.code==="ROUTER_LOCK_TIMEOUT"); }
  finally { await release(); }
});

test("kernel guard pre-abort never acquires a listener", async () => {
  const file = await lockPath();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(acquireRouterLockGuard(file, {signal:controller.signal}), e=>e.code==="ABORT_ERR");
  const release = await acquireRouterLockGuard(file, {timeoutMs:200});
  await release();
});

test("kernel guard closes a listener whose bind callback arrives after the deadline", async t => {
  const file = await lockPath();
  const originalListen = net.Server.prototype.listen;
  let callbackDelayed = false;
  t.mock.method(net.Server.prototype, "listen", function(endpoint, callback) {
    return originalListen.call(this, endpoint, () => {
      callbackDelayed = true;
      setTimeout(callback, 150);
    });
  });
  let unexpectedRelease;
  try {
    await assert.rejects(async()=>{unexpectedRelease=await acquireRouterLockGuard(file,{timeoutMs:100});},e=>e.code==="ROUTER_LOCK_TIMEOUT");
    assert.equal(callbackDelayed,true);
  } finally {
    if(unexpectedRelease) await unexpectedRelease();
    t.mock.restoreAll();
  }
  const release = await acquireRouterLockGuard(file,{timeoutMs:500});
  await release();
});

test("kernel guard is released when an independent owner dies", {skip:!["win32","linux"].includes(process.platform)}, async () => {
  const file = await lockPath();
  const moduleUrl = new URL("../src/router-lock-guard.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {acquireRouterLockGuard} from ${JSON.stringify(moduleUrl)};
    await acquireRouterLockGuard(${JSON.stringify(file)});
    process.send('owned');
  `], {stdio:["ignore","ignore","pipe","ipc"],windowsHide:true});
  const exited = once(child, "exit");
  let stderr = ""; child.stderr.on("data", data=>{stderr+=data;});
  const watchdog = setTimeout(()=>child.kill(),5000);
  try {
    const ready = await Promise.race([once(child,"message"), exited.then(()=>{throw new Error(stderr || "owner exited before acquiring");})]);
    assert.equal(ready[0],"owned");
    await assert.rejects(acquireRouterLockGuard(file,{timeoutMs:60}),e=>e.code==="ROUTER_LOCK_TIMEOUT");
    child.kill(); await exited;
    const release = await acquireRouterLockGuard(file,{timeoutMs:1000}); await release();
  } finally { clearTimeout(watchdog); if(child.exitCode===null && child.signalCode===null) child.kill(); await exited; }
});
