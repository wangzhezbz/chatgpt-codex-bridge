import assert from "node:assert/strict";
import { mkdtemp, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createHttpServer } from "../src/http-server.js";
import { createProject } from "../src/project-store.js";
import { saveArtifactFromBase64 } from "../src/artifact-store.js";

async function loadBackgroundContext(overrides = {}) {
  const listeners = [];
  const installedListeners = [];
  const startupListeners = [];
  const tabUpdateListeners = [];
  const downloadCreatedListeners = [];
  const downloadChangedListeners = [];
  const calls = [];
  const chrome = {
    runtime: {
      lastError: null,
      reload() {
        calls.push({ method: "runtime.reload" });
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      },
      onInstalled: {
        addListener(listener) {
          installedListeners.push(listener);
        }
      },
      onStartup: {
        addListener(listener) {
          startupListeners.push(listener);
        }
      }
    },
    downloads: {
      download(downloadOptions, callback) {
        calls.push({ method: "downloads.download", downloadOptions });
        callback?.(overrides.downloadId || 77);
      },
      search(query, callback) {
        calls.push({ method: "downloads.search", query });
        callback?.(overrides.downloadSearchItems || []);
      },
      erase(query, callback) {
        calls.push({ method: "downloads.erase", query });
        callback?.([]);
      },
      cancel(downloadId, callback) {
        calls.push({ method: "downloads.cancel", downloadId });
        callback?.();
      },
      onCreated: {
        addListener(listener) {
          downloadCreatedListeners.push(listener);
        }
      },
      onChanged: {
        addListener(listener) {
          downloadChangedListeners.push(listener);
        }
      }
    },
    tabs: {
      update(tabId, updateProperties, callback) {
        calls.push({ method: "tabs.update", tabId, updateProperties });
        callback?.({ id: tabId, ...updateProperties });
      },
      reload(tabId, callback) {
        calls.push({ method: "tabs.reload", tabId });
        callback?.();
      },
      onUpdated: {
        addListener(listener) {
          tabUpdateListeners.push(listener);
        }
      }
    },
    debugger: {
      attach(target, version, callback) {
        calls.push({ method: "attach", target, version });
        callback();
      },
      sendCommand(target, method, params, callback) {
        calls.push({ method: "sendCommand", target, command: method, params });
        callback();
      },
      detach(target, callback) {
        calls.push({ method: "detach", target });
        callback();
      }
    },
    ...overrides.chrome
  };
  const context = {
    chrome,
    clearTimeout: overrides.clearTimeout || clearTimeout,
    console,
    fetch: overrides.fetch || function fetch() {
      throw new Error("fetch should not be called by these unit tests");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    URL,
    setTimeout: overrides.setTimeout || setTimeout
  };
  vm.createContext(context);
  vm.runInContext(await readFile("chrome-extension/bridge-config.js", "utf8"), context);
  vm.runInContext(await readFile("chrome-extension/background.js", "utf8"), context);
  return {
    calls,
    context,
    downloadChangedListeners,
    downloadCreatedListeners,
    installedListeners,
    listeners,
    startupListeners,
    tabUpdateListeners
  };
}

test("native download watches never claim a file navigation for background fetching",async()=>{
  const {context}=await loadBackgroundContext();
  context.startDownloadWatch({nativeDownloadOnly:true,tabId:7,expectedFilename:"native.xlsx"});
  const claimed=context.claimContentUrlForWatch(7,"https://chatgpt.com/backend-api/estuary/content?fn=native.xlsx");
  assert.equal(claimed,null);
});

test("Bridge binary proxy preserves arbitrary input file bytes and project scope", async () => {
  const bytes=Buffer.from([0,255,128,10,13,65]);
  let fetched;
  const {context}=await loadBackgroundContext({fetch:async(url)=>{
    fetched=String(url);
    return {ok:true,status:200,headers:{get:()=>"application/octet-stream"},arrayBuffer:async()=>bytes,text:async()=>{throw new Error("binary content must not use text decoding");}};
  }});
  const result=await context.proxyBridgeApi({bridgeOrigin:"http://127.0.0.1:4317",path:"/api/artifacts/artifact_input/raw?projectId=project_input",options:{method:"GET",responseType:"base64"}});
  assert.equal(fetched,"http://127.0.0.1:4317/api/artifacts/artifact_input/raw?projectId=project_input");
  assert.deepEqual(Buffer.from(result.response.base64Data,"base64"),bytes);
  assert.equal(result.response.contentType,"application/octet-stream");
});

test("multi-megabyte artifact survives real scoped HTTP and serialized extension messages", async () => {
  const storeRoot=await mkdtemp(path.join(tmpdir(),"bridge-binary-roundtrip-"));
  const threadId="binary-roundtrip-thread";
  const project=await createProject(storeRoot,{name:"Binary roundtrip",currentCodexThreadId:threadId,
    conversationId:"binary-roundtrip-conversation",chatgptProjectUrl:"https://chatgpt.com/c/binary-roundtrip",targetRepo:path.join(storeRoot,"repo")});
  const foreign=await createProject(storeRoot,{name:"Other scope",currentCodexThreadId:threadId,
    conversationId:"other-binary-conversation",chatgptProjectUrl:"https://chatgpt.com/c/other-binary",targetRepo:path.join(storeRoot,"other")});
  // Exercise every byte value, multiple encoder chunks and a non-aligned tail.
  const bytes=Buffer.alloc(4*1024*1024+7);
  for(let i=0;i<bytes.length;i++)bytes[i]=(i*73+19)&255;
  const artifact=await saveArtifactFromBase64(storeRoot,{filename:"roundtrip.bin",contentType:"application/octet-stream",
    conversationId:project.conversationId,base64Data:bytes.toString("base64")});
  const server=createHttpServer({storeRoot,currentCodexThreadId:threadId,runnerMode:"manual"});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  try {
    const baseUrl=`http://127.0.0.1:${server.address().port}`;
    const {listeners}=await loadBackgroundContext({fetch});
    const client={console,URL,File,setTimeout,clearTimeout,setInterval(){},sleep:async()=>{},
      document:{querySelector:()=>null,querySelectorAll:()=>[]},
      location:{hostname:"example.invalid",href:"https://example.invalid/"},
      CODEX_BRIDGE_CONFIG:{origin:baseUrl},
      atob:value=>Buffer.from(value,"base64").toString("binary"),
      btoa:value=>Buffer.from(value,"binary").toString("base64"),
      fetch:async()=>{throw new Error("Web-page local network access is unavailable");},
      chrome:{runtime:{lastError:null,sendMessage(message,callback){
        void sendRuntimeMessage(listeners[0],JSON.parse(JSON.stringify(message)),{tab:{id:1}})
          .then(result=>callback(JSON.parse(JSON.stringify(result))));
      }}}
    };
    vm.createContext(client);
    vm.runInContext(await readFile("chrome-extension/content-script.js","utf8"),client);
    client.sleep=async()=>{};
    const input={...artifact,uploadUrl:`/api/artifacts/${artifact.id}/raw`};
    const file=await client.fetchInputArtifactFile(input,{projectId:project.id});
    assert.equal(file.size,4194311);
    assert.equal(file.type,"application/octet-stream");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
    // A genuine server scope failure must not become an uploaded error page.
    await assert.rejects(client.fetchInputArtifactFile(input,{projectId:foreign.id}),
      error=>error.errorCode==="input_artifact_fetch_failed");
  } finally {
    await new Promise(resolve=>server.close(resolve));
    // Remove only this test's explicitly known binary, never a directory tree.
    await unlink(artifact.filePath);
  }
});

test("Bridge binary proxy rejects unscoped or non-artifact reads before fetching", async () => {
  let fetches=0;
  const {context}=await loadBackgroundContext({fetch:async()=>{fetches++;return {ok:true,status:200,text:async()=>""};}});
  for(const path of ["/api/config","/api/artifacts/artifact_input/raw"]){
    await assert.rejects(context.proxyBridgeApi({bridgeOrigin:"http://127.0.0.1:4317",path,options:{method:"GET",responseType:"base64"}}));
  }
  await assert.rejects(context.proxyBridgeApi({bridgeOrigin:"http://127.0.0.1:4317",path:"/api/artifacts/artifact_input/raw?projectId=p",options:{method:"POST",responseType:"base64"}}));
  assert.equal(fetches,0);
});

test("Bridge binary proxy preserves authorization failures instead of returning file bytes", async () => {
  const {context}=await loadBackgroundContext({fetch:async()=>({ok:false,status:403,text:async()=>"Forbidden artifact scope"})});
  const result=await context.proxyBridgeApi({bridgeOrigin:"http://127.0.0.1:4317",path:"/api/artifacts/artifact_input/raw?projectId=wrong_project",options:{method:"GET",responseType:"base64"}});
  assert.equal(result.response.ok,false);
  assert.equal(result.response.status,403);
  assert.equal(result.response.base64Data,undefined);
  assert.equal(result.response.bodyText,"Forbidden artifact scope");
});

for (const [label, item, expected, matches] of [
  ["exact filename", {filename:"C:/Downloads/report.xlsx"}, "report.xlsx", true],
  ["Chrome conflict suffix", {filename:"C:/Downloads/report (2).xlsx"}, "report.xlsx", true],
  ["case-insensitive filename", {filename:"C:/Downloads/REPORT.XLSX"}, "report.xlsx", true],
  ["encoded Chinese URL filename", {url:"https://chatgpt.com/backend-api/estuary/content?fn=%E9%AA%8C%E6%94%B6.xlsx"}, "验收.xlsx", true],
  ["literal percent URL filename", {url:"https://chatgpt.com/backend-api/estuary/content?fn=100%25.xlsx"}, "100%.xlsx", true],
  ["prefix collision", {filename:"C:/Downloads/old_report.xlsx"}, "report.xlsx", false],
  ["extension collision", {filename:"C:/Downloads/report.xlsx.zip"}, "report.xlsx", false],
  ["filename only in a directory", {url:"https://chatgpt.com/files/report.xlsx/other.xlsx"}, "report.xlsx", false],
  ["filename only in unrelated query", {url:"https://chatgpt.com/content?fn=other.xlsx&note=report.xlsx"}, "report.xlsx", false],
  ["URL prefix collision", {url:"https://chatgpt.com/content?fn=old_report.xlsx"}, "report.xlsx", false]
]) {
  test(`background download filename matching: ${label}`, async () => {
    const {context}=await loadBackgroundContext();
    assert.equal(context.matchesExpectedFilename(item, expected), matches);
  });
}

test("background assigns similar filenames to their own watches", async () => {
  const {context}=await loadBackgroundContext();
  context.startDownloadWatch({syncJobId:"sync_current",expectedFilename:"report.xlsx"});
  context.startDownloadWatch({syncJobId:"sync_old",expectedFilename:"old_report.xlsx"});
  const older=context.claimDownloadForWatch({id:301,filename:"C:/Downloads/old_report.xlsx"});
  assert.equal(older.syncJobId,"sync_old");
  const current=context.claimDownloadForWatch({id:302,filename:"C:/Downloads/report (1).xlsx"});
  assert.equal(current.syncJobId,"sync_current");
});

function sendRuntimeMessage(listener, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

test("background imports a completed download once when Chrome events and timeout recovery overlap", async () => {
  const gate = Promise.withResolvers();
  const imports = [];
  const item = { id: 91, filename: "C:/Downloads/current.xlsx", state: "complete",
    url: "https://chatgpt.com/backend-api/estuary/content?fn=current.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  const { context, downloadChangedListeners, calls } = await loadBackgroundContext({
    downloadSearchItems: [item],
    fetch: async (url, options) => {
      imports.push({ url, body: JSON.parse(options.body) });
      await gate.promise;
      return { ok: true, json: async () => ({ artifact: { id: "artifact_current" } }) };
    }
  });
  context.startDownloadWatch({ syncJobId: "sync_current", expectedFilename: "current.xlsx", nativeDownloadOnly: true });
  const watch = context.claimDownloadForWatch(item);
  downloadChangedListeners[0]({ id: 91, state: { current: "complete" } });
  downloadChangedListeners[0]({ id: 91, state: { current: "complete" } });
  const recovery = context.completeDownloadWatchFromRecentSearch(watch);
  await new Promise(setImmediate);
  const pendingImports = imports.length;
  gate.resolve();
  await recovery;
  const result = await context.waitForWatch(watch);
  assert.equal(pendingImports, 1, "a slow import must not be submitted again by another notification");
  assert.equal(result.artifact.id, "artifact_current");
  assert.equal(imports[0].body.syncJobId, "sync_current");
  assert.equal(calls.filter(call => call.method === "downloads.erase").length, 1);
  await context.completeDownloadWatch(watch, item);
  assert.equal(imports.length, 1, "a late completion must not re-import a terminal watch");
});

test("background does not re-import a failed terminal download watch", async () => {
  let imports = 0;
  const { context } = await loadBackgroundContext({
    fetch: async () => { imports += 1; return { ok: false, text: async () => "import rejected" }; }
  });
  const item = { id: 92, filename: "C:/Downloads/rejected.xlsx", state: "complete" };
  context.startDownloadWatch({ syncJobId: "sync_rejected", expectedFilename: "rejected.xlsx", nativeDownloadOnly: true });
  const watch = context.claimDownloadForWatch(item);
  await context.completeDownloadWatch(watch, item);
  await context.completeDownloadWatch(watch, item);
  const result = await context.waitForWatch(watch);
  assert.equal(result.ok, false);
  assert.match(result.error, /import rejected/);
  assert.equal(imports, 1);
});

test("background keeps imports for different jobs independent while one is slow", async () => {
  const gate = Promise.withResolvers();
  const imports = [];
  const { context } = await loadBackgroundContext({
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      imports.push(body.syncJobId);
      if (body.syncJobId === "sync_slow") await gate.promise;
      return { ok: true, json: async () => ({ artifact: { id: `artifact_${body.syncJobId}` } }) };
    }
  });
  const slow = { id: 93, filename: "C:/Downloads/slow.xlsx", state: "complete" };
  const fast = { id: 94, filename: "C:/Downloads/fast.xlsx", state: "complete" };
  context.startDownloadWatch({ syncJobId: "sync_slow", expectedFilename: "slow.xlsx", nativeDownloadOnly: true });
  context.startDownloadWatch({ syncJobId: "sync_fast", expectedFilename: "fast.xlsx", nativeDownloadOnly: true });
  const slowWatch = context.claimDownloadForWatch(slow);
  const fastWatch = context.claimDownloadForWatch(fast);
  const slowCompletion = context.completeDownloadWatch(slowWatch, slow);
  await context.completeDownloadWatch(fastWatch, fast);
  assert.equal((await context.waitForWatch(fastWatch)).artifact.id, "artifact_sync_fast");
  assert.equal(slowWatch.done, false);
  gate.resolve();
  await slowCompletion;
  assert.equal((await context.waitForWatch(slowWatch)).artifact.id, "artifact_sync_slow");
  assert.deepEqual(imports, ["sync_slow", "sync_fast"]);
});

test("background includes the scoped Bridge token when importing a captured file", async () => {
  const calls = [];
  const { context } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          return {
            artifact: {
              id: "artifact_secured_download"
            }
          };
        }
      };
    }
  });

  await context.importFetchedItem(
    {
      bridgeOrigin: "http://127.0.0.1:4317",
      bridgeApiToken: "background-session-token",
      syncJobId: "sync_secured_download",
      expectedFilename: "secured.png"
    },
    {
      filename: "secured.png",
      mime: "image/png",
      url: "https://files.example/secured.png",
      base64Data: "c2VjdXJlZA=="
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers["X-Bridge-Token"], "background-session-token");
});

test("background trustedClick dispatches a real browser click through debugger", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  const response = await sendRuntimeMessage(
    listeners[0],
    { type: "bridge:trustedClick", x: 140, y: 60 },
    { tab: { id: 123 } }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { method: "tabs.update", tabId: 123, updateProperties: { active: true } },
    { method: "attach", target: { tabId: 123 }, version: "1.3" },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 140, y: 60, button: "none", buttons: 0 }
    },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 140, y: 60, button: "left", buttons: 1, clickCount: 1 }
    },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 140, y: 60, button: "left", buttons: 0, clickCount: 1 }
    },
    { method: "detach", target: { tabId: 123 } }
  ]);
});

test("background trustedClick returns an error without a sender tab", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  const response = await sendRuntimeMessage(listeners[0], { type: "bridge:trustedClick", x: 1, y: 2 }, {});

  assert.equal(response.ok, false);
  assert.match(response.error, /No sender tab/);
  assert.deepEqual(calls, []);
});

for (const type of ["bridge:trustedClick", "bridge:trustedInsertText"]) {
  for (const attachFails of [false, true]) {
    test(`${type} cleans a late successful attach without input or detaching another debugger (error=${attachFails})`, async () => {
      const timers = new Set();
      const commands = [];
      const detachedTabs = [];
      let attachCallback;
      let signalAttach;
      let owner = attachFails ? "other-debugger" : null;
      const attachStarted = new Promise(resolve => { signalAttach = resolve; });
      const { context, listeners } = await loadBackgroundContext({
        setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); },
        chrome: { debugger: {
          attach(_target, _version, callback) { attachCallback = callback; signalAttach(); },
          sendCommand(_target, command, _params, callback) { commands.push(command); callback(); },
          detach(target, callback) { detachedTabs.push(target.tabId); owner = null; callback(); }
        } }
      });
      const request = sendRuntimeMessage(listeners[0], { type, x: 10, y: 20, text: "must not be inserted" }, { tab: { id: 654 } });
      await attachStarted;
      assert.equal(timers.size, 1);
      const [deadline] = timers;
      timers.delete(deadline);
      deadline.callback();
      const response = await request;
      assert.equal(response.ok, false);
      assert.match(response.error, /timed out/i);
      assert.deepEqual(detachedTabs, []);
      if (attachFails) context.chrome.runtime.lastError = { message: "Another debugger is already attached" };
      else owner = "bridge";
      attachCallback();
      context.chrome.runtime.lastError = null;
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(commands, [], "timed-out requests must never type or click later");
      assert.equal(owner, attachFails ? "other-debugger" : null, "only Bridge's late-acquired session should be released");
      assert.deepEqual(detachedTabs, attachFails ? [] : [654]);
      assert.equal(timers.size, 0);
    });
  }
}

test("background opens one GPT project tab and reuses it for duplicate requests", async () => {
  const tabCalls = [];
  const tabs = [];
  const { listeners } = await loadBackgroundContext({
    chrome: {
      tabs: {
        query(queryInfo, callback) {
          tabCalls.push({ method: "tabs.query", queryInfo });
          callback(tabs.map((tab) => ({ ...tab })));
        },
        create(createProperties, callback) {
          const tab = { id: 77, url: createProperties.url, active: createProperties.active };
          tabs.push(tab);
          tabCalls.push({ method: "tabs.create", createProperties });
          callback(tab);
        },
        update(tabId, updateProperties, callback) {
          tabCalls.push({ method: "tabs.update", tabId, updateProperties });
          callback({ id: tabId, ...updateProperties });
        },
        reload(_tabId, callback) {
          callback?.();
        },
        onUpdated: {
          addListener() {}
        }
      }
    }
  });
  const message = {
    type: "bridge:openProjectTab",
    jobId: "sync_waiting_page",
    projectUrl: "https://chatgpt.com/c/waiting-page"
  };

  const first = await sendRuntimeMessage(listeners[0], message, { tab: { id: 10 } });
  const second = await sendRuntimeMessage(listeners[0], message, { tab: { id: 10 } });

  assert.deepEqual(JSON.parse(JSON.stringify(first)), { ok: true, opened: true, tabId: 77 });
  assert.deepEqual(JSON.parse(JSON.stringify(second)), { ok: true, opened: false, tabId: 77 });
  assert.equal(tabCalls.filter((call) => call.method === "tabs.create").length, 1);
});

test("background trustedInsertText replaces a long composer draft through Chrome input", async () => {
  const { calls, listeners } = await loadBackgroundContext();
  const prompt = "long routed context ".repeat(900);

  const response = await sendRuntimeMessage(
    listeners[0],
    { type: "bridge:trustedInsertText", text: prompt },
    { tab: { id: 321 } }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { method: "tabs.update", tabId: 321, updateProperties: { active: true } },
    { method: "attach", target: { tabId: 321 }, version: "1.3" },
    {
      method: "sendCommand",
      target: { tabId: 321 },
      command: "Input.dispatchKeyEvent",
      params: {
        type: "keyDown",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65
      }
    },
    {
      method: "sendCommand",
      target: { tabId: 321 },
      command: "Input.dispatchKeyEvent",
      params: {
        type: "keyUp",
        key: "a",
        code: "KeyA",
        modifiers: 2,
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65
      }
    },
    {
      method: "sendCommand",
      target: { tabId: 321 },
      command: "Input.insertText",
      params: { text: prompt }
    },
    { method: "detach", target: { tabId: 321 } }
  ]);
});

test("background trustedInsertText times out and detaches when Chrome input stops responding", async () => {
  const calls = [];
  const { listeners } = await loadBackgroundContext({
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    chrome: {
      debugger: {
        attach(target, version, callback) {
          calls.push({ method: "attach", target, version });
          callback();
        },
        sendCommand(target, method, params) {
          calls.push({ method: "sendCommand", target, command: method, params });
        },
        detach(target, callback) {
          calls.push({ method: "detach", target });
          callback();
        }
      }
    }
  });

  const response = await Promise.race([
    sendRuntimeMessage(
      listeners[0],
      { type: "bridge:trustedInsertText", text: "long routed context ".repeat(900) },
      { tab: { id: 654 } }
    ),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 50))
  ]);

  assert.equal(response.timedOut, undefined);
  assert.equal(response.ok, false);
  assert.match(response.error, /timed out/i);
  assert.ok(calls.some((call) => call.method === "detach"));
});

test("background reloads the extension when Bridge requests a version refresh", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  let response = null;
  const keepAlive = listeners[0]({ type: "bridge:reloadExtension" }, {}, (value) => {
    response = value;
  });

  assert.equal(keepAlive, false);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ method: "runtime.reload" }]);
});

test("background remembers and refreshes the sender tab after an extension version reload", async () => {
  const stored = {};
  const storageCalls = [];
  const storage = {
    local: {
      get(key, callback) {
        storageCalls.push({ method: "storage.get", key });
        callback({ [key]: stored[key] || [] });
      },
      set(value, callback) {
        storageCalls.push({ method: "storage.set", value });
        Object.assign(stored, value);
        callback?.();
      },
      remove(key, callback) {
        storageCalls.push({ method: "storage.remove", key });
        delete stored[key];
        callback?.();
      }
    }
  };
  const first = await loadBackgroundContext({
    chrome: { storage }
  });

  const response = await new Promise((resolve) => {
    const keepAlive = first.listeners[0](
      { type: "bridge:reloadExtension" },
      { tab: { id: 456 } },
      resolve
    );
    assert.equal(keepAlive, true);
  });

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(stored["bridge:reload-tabs"])), [456]);
  assert.deepEqual(first.calls, [{ method: "runtime.reload" }]);

  const second = await loadBackgroundContext({
    chrome: { storage }
  });

  assert.deepEqual(second.calls, [{ method: "tabs.reload", tabId: 456 }]);
  assert.equal(stored["bridge:reload-tabs"], undefined);
  assert.deepEqual(
    storageCalls.map((call) => call.method),
    ["storage.get", "storage.set", "storage.get", "storage.remove"]
  );
});

test("background restores Bridge into already-open GPT tabs after a manual extension reload", async () => {
  const scriptCalls = [];
  const { installedListeners, startupListeners } = await loadBackgroundContext({
    chrome: {
      tabs: {
        query(queryInfo, callback) {
          assert.deepEqual(JSON.parse(JSON.stringify(queryInfo)), {
            url: ["https://chatgpt.com/*"]
          });
          callback([{ id: 912, url: "https://chatgpt.com/c/already-open" }]);
        },
        reload(_tabId, callback) {
          callback?.();
        },
        onUpdated: {
          addListener() {}
        }
      },
      scripting: {
        executeScript(details, callback) {
          scriptCalls.push(details);
          if (typeof details.func === "function") {
            callback([{ result: false }]);
            return;
          }
          callback([]);
        }
      }
    }
  });

  assert.equal(installedListeners.length, 1);
  assert.equal(startupListeners.length, 1);
  assert.equal(scriptCalls.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(scriptCalls[0].target)), { tabId: 912 });
  assert.equal(typeof scriptCalls[0].func, "function");
  assert.deepEqual(JSON.parse(JSON.stringify(scriptCalls[1])), {
    target: { tabId: 912 },
    files: ["bridge-config.js", "content-script.js"]
  });
});

test("background proxies authenticated local Bridge API calls for content scripts", async () => {
  const fetchCalls = [];
  const { listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push({
        url: String(url),
        headers: { ...(options.headers || {}) },
        method: options.method || "GET"
      });
      if (String(url).endsWith("/api/config")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { apiToken: "background-proxy-token" };
          }
        };
      }
      if (!options.headers?.["X-Bridge-Token"]) {
        return {
          ok: false,
          status: 401,
          async text() {
            return JSON.stringify({ error: "Bridge API token is required" });
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ connected: true });
        }
      };
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:api",
      bridgeOrigin: "http://127.0.0.1:4317",
      path: "/api/extension/heartbeat",
      options: {
        method: "POST",
        body: JSON.stringify({ workerId: "worker_background_proxy" })
      }
    },
    { tab: { id: 912 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    fetchCalls.map((call) => [call.method, call.url, call.headers["X-Bridge-Token"] || null]),
    [
      ["POST", "http://127.0.0.1:4317/api/extension/heartbeat", null],
      ["GET", "http://127.0.0.1:4317/api/config", null],
      ["POST", "http://127.0.0.1:4317/api/extension/heartbeat", "background-proxy-token"]
    ]
  );
});

test("background imports ChatGPT estuary content URL for an active download watch", async () => {
  const fetchCalls = [];
  const { listeners, tabUpdateListeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).startsWith("https://chatgpt.com/backend-api/estuary/content")) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "application/zip" : null;
            }
          },
          arrayBuffer: async () => Buffer.from("zip bytes from chatgpt", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        assert.equal(body.syncJobId, "sync_zip");
        assert.equal(body.filename, "multi-image-live-v3-icons.zip");
        assert.equal(body.contentType, "application/zip");
        assert.equal(body.base64Data, Buffer.from("zip bytes from chatgpt", "utf8").toString("base64"));
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_remote_zip",
              filename: "multi-image-live-v3-icons.zip"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        syncJobId: "sync_zip",
        expectedFilename: "multi-image-live-v3-icons.zip",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  tabUpdateListeners[0](
    321,
    {
      url: "https://chatgpt.com/backend-api/estuary/content?id=file_123&fn=multi-image-live-v3-icons.zip&cd=attachment"
    },
    { id: 321 }
  );

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_remote_zip");
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [
      "https://chatgpt.com/backend-api/estuary/content?id=file_123&fn=multi-image-live-v3-icons.zip&cd=attachment",
      "http://127.0.0.1:4317/api/downloads/import"
    ]
  );
});

test("background imports ChatGPT interpreter download URL for an active download watch", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-e2e-note.md";
  const fetchCalls = [];
  const importedBodies = [];
  const { listeners, tabUpdateListeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "text/markdown; charset=utf-8" : null;
            }
          },
          arrayBuffer: async () => Buffer.from("# Bridge note\n\n- captured", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_interpreter_md",
              filename: "bridge-e2e-note.md"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        syncJobId: "sync_md",
        expectedFilename: "bridge-e2e-note.md",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  tabUpdateListeners[0](321, { url: interpreterUrl }, { id: 321 });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_interpreter_md");
  assert.equal(importedBodies[0].syncJobId, "sync_md");
  assert.equal(importedBodies[0].filename, "bridge-e2e-note.md");
  assert.equal(importedBodies[0].contentType, "text/markdown; charset=utf-8");
  assert.equal(importedBodies[0].base64Data, Buffer.from("# Bridge note\n\n- captured", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl, "http://127.0.0.1:4317/api/downloads/import"]);
});

test("background erases visible Chrome download history after importing a watched file", async () => {
  const importedBodies = [];
  const { calls, downloadCreatedListeners, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_visible_pdf",
              filename: "visible.pdf"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        bridgeOrigin: "http://127.0.0.1:4317",
        syncJobId: "sync_visible_pdf",
        expectedFilename: "visible.pdf",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  downloadCreatedListeners[0]({
    id: 404,
    state: "complete",
    filename: "C:\\Users\\Administrator\\Downloads\\visible.pdf",
    finalUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_pdf&fn=visible.pdf",
    url: "https://chatgpt.com/backend-api/estuary/content?id=file_pdf&fn=visible.pdf",
    mime: "application/pdf"
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_visible_pdf");
  assert.equal(importedBodies[0].localPath, "C:\\Users\\Administrator\\Downloads\\visible.pdf");
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.filter((call) => call.method === "downloads.erase"))),
    [{ method: "downloads.erase", query: { id: 404 } }]
  );
});

test("background imports ChatGPT interpreter URLs directly before opening a browser download", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fdirect-quiet.xlsx";
  const importedBodies = [];
  const fetchCalls = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type"
                ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : null;
            }
          },
          arrayBuffer: async () => Buffer.from("xlsx bytes from chatgpt", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_quiet_xlsx",
              filename: "direct-quiet.xlsx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_quiet",
      url: interpreterUrl,
      filename: "direct-quiet.xlsx",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_quiet_xlsx");
  assert.equal(importedBodies[0].syncJobId, "sync_quiet");
  assert.equal(importedBodies[0].filename, "direct-quiet.xlsx");
  assert.equal(importedBodies[0].contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(importedBodies[0].base64Data, Buffer.from("xlsx bytes from chatgpt", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl, "http://127.0.0.1:4317/api/downloads/import"]);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background quiet URL capture does not open a browser download after direct fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fquiet-fail.zip";
  const fetchCalls = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 403,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_quiet_fail",
      url: interpreterUrl,
      filename: "quiet-fail.zip",
      quietOnly: true,
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /direct download failed|status 403/i);
  assert.deepEqual(fetchCalls, [interpreterUrl]);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background quiet URL capture uses page-context fetch after direct fetch is unauthorized", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-live-deck.pptx";
  const importedBodies = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_direct_page_context_pptx",
              filename: "bridge-live-deck.pptx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          assert.deepEqual(JSON.parse(JSON.stringify(details.target)), { tabId: 321 });
          assert.equal(details.world, "MAIN");
          assert.deepEqual(JSON.parse(JSON.stringify(details.args)), [interpreterUrl]);
          callback?.([
            {
              result: {
                ok: true,
                url: interpreterUrl,
                contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                contentDisposition: "attachment; filename=\"bridge-live-deck.pptx\"",
                base64Data: Buffer.from("pptx from direct page context", "utf8").toString("base64")
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_direct_page_context_pptx",
      url: interpreterUrl,
      filename: "bridge-live-deck.pptx",
      quietOnly: true,
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_direct_page_context_pptx");
  assert.deepEqual(
    calls.map((call) => call.method).filter((method) => method !== "downloads.search"),
    ["scripting.executeScript"]
  );
  assert.equal(importedBodies[0].syncJobId, "sync_direct_page_context_pptx");
  assert.equal(importedBodies[0].filename, "bridge-live-deck.pptx");
  assert.equal(
    importedBodies[0].base64Data,
    Buffer.from("pptx from direct page context", "utf8").toString("base64")
  );
});

test("background URL capture does not create a visible Chrome download when GPT URL fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fdirect-10-icons-v2-01.png";
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          callback?.([
            {
              result: {
                ok: false,
                error: "GPT page download failed with status 401"
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_interpreter",
      url: interpreterUrl,
      filename: "direct-10-icons-v2-01.png",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background URL capture fails quietly when page-context fetch also fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-live-deck.pptx";
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          assert.deepEqual(JSON.parse(JSON.stringify(details.target)), { tabId: 321 });
          assert.equal(details.world, "MAIN");
          assert.deepEqual(JSON.parse(JSON.stringify(details.args)), [interpreterUrl]);
          callback?.([
            {
              result: {
                ok: false,
                error: "GPT page download failed with status 401"
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_interrupted_pptx",
      url: interpreterUrl,
      filename: "bridge-live-deck.pptx",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.deepEqual(
    calls.map((call) => call.method).filter((method) => method !== "downloads.search"),
    ["scripting.executeScript"]
  );
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background URL capture ignores Chrome download history when GPT URL fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-table.xlsx";
  const { calls, listeners } = await loadBackgroundContext({
    downloadSearchItems: [
      {
        id: 101,
        filename: "C:\\Users\\Administrator\\Downloads\\bridge-table.xlsx",
        finalUrl: interpreterUrl,
        url: interpreterUrl,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        state: "complete"
      }
    ],
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_table",
      url: interpreterUrl,
      filename: "bridge-table.xlsx",
      timeoutMs: 20
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
  assert.equal(calls.some((call) => call.method === "downloads.search"), false);
});

test("background recovers a button-triggered download by filename when the watch event is missed", async () => {
  const importedBodies = [];
  const { calls, listeners } = await loadBackgroundContext({
    downloadSearchItems: [
      {
        id: 202,
        filename: "C:\\Users\\Administrator\\Downloads\\bridge-live-doc-retry2-20260708043012.docx",
        finalUrl: "",
        url: "",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        state: "complete"
      }
    ],
    fetch: async (url, options = {}) => {
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_recovered_docx",
              filename: "bridge-live-doc-retry2-20260708043012.docx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        bridgeOrigin: "http://127.0.0.1:4317",
        syncJobId: "sync_docx_button",
        expectedFilename: "bridge-live-doc-retry2-20260708043012.docx",
        timeoutMs: 1
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId },
    {}
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_recovered_docx");
  assert.equal(calls.some((call) => call.method === "downloads.search" && !("id" in call.query)), true);
  assert.equal(importedBodies[0].syncJobId, "sync_docx_button");
  assert.equal(importedBodies[0].localPath, "C:\\Users\\Administrator\\Downloads\\bridge-live-doc-retry2-20260708043012.docx");
  assert.equal(importedBodies[0].filename, "bridge-live-doc-retry2-20260708043012.docx");
});
