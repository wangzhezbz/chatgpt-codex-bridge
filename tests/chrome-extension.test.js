import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

test("message stream error notices are not final content or historical incident reports", async () => {
  const c = await loadContentScriptContext();
  for (const text of ["消息流中的错误", "Error in message stream", "消息流中的错误。 重试", "Error in message stream. Try again"]) {
    assert.equal(c.isInterimAssistantText(text), true, text);
    assert.equal(c.hasGenerationFailureText(text), true, text);
    assert.equal(c.hasUsableAssistantText(text, ""), false, text);
  }
  for (const text of ["The label Error in message stream describes a past incident; the repair is complete.", "昨天出现“消息流中的错误”，今天结果已正常返回。"])
    assert.equal(c.hasGenerationFailureText(text), false, text);
});

for (const phase of ["upload_preview", "send_button"]) {
  for (const scenario of ["cancelled", "offline", "expired", "ready"]) {
    test(`pre-send wait releases its worker without page mutations: ${phase}/${scenario}`, async () => {
      const context = await loadContentScriptContext();
      const start = Date.now();
      let now = start, cancelled = false, offline = false, checks = 0;
      const job = { id: "sync_wait_guard", status: "running", claimedAt: new Date(start - (scenario === "expired" ? 59000 : 0)).toISOString(),
        inputArtifacts: [{ id: "artifact_wait_guard", filename: "wait.png", contentType: "image/png" }] };
      class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
      context.Date = Clock;
      context.installAssistantActivityObserver = () => true;
      context.assertNoChatGptBlocker = () => {};
      context.waitForAssistantActivity = async ms => {
        now += ms;
        cancelled = scenario === "cancelled";
        offline = scenario === "offline";
        return scenario === "ready" && now - start >= 5000;
      };
      context.bridgeApi = async () => {
        checks++;
        if (offline) throw new Error("Bridge disconnected");
        return { job: { ...job, status: cancelled ? "failed" : "running", errorCode: cancelled ? "manual_cancelled" : null } };
      };
      const button = {};
      const ready = () => scenario === "ready" && now - start >= 5000;
      context.findSendButton = () => ready() ? button : null;
      context.isDisabledButton = () => false;
      // Only DOM evidence is controlled; the waiting loop and state guard are real.
      context.uploadPreviewElements = () => [];
      context.missingInputArtifacts = () => ready() ? [] : job.inputArtifacts;
      const waiting = phase === "upload_preview"
        ? context.waitForInputArtifactsVisible(job.inputArtifacts, 60000, job)
        : context.waitForReadySendButton(60000, job);
      const result = await waiting.then(value => ({ value }), error => ({ error }));
      if (scenario === "ready") {
        assert.equal(result.error, undefined);
        assert.equal(now - start, 5000);
        if (phase === "send_button") assert.equal(result.value, button);
        assert.ok(checks >= 2 && checks <= 4, "state reads must be throttled, not performed on every DOM poll");
      } else {
        assert.ok(now - start <= 3500, "cancelled/unconfirmed work must not hold the worker until the 60-second UI timeout");
        if (scenario === "cancelled") assert.equal(result.error?.bridgeJobStopped, true);
        if (scenario === "offline") assert.equal(result.error?.errorCode, "pre_send_state_unconfirmed");
        if (scenario === "expired") assert.equal(result.error?.errorCode, "pre_send_stale");
      }
    });
  }
}

for (const scenario of ["cancelled_before_read", "cancelled_between_reads", "cancelled_after_last_read", "expired_after_read", "offline_after_read", "active"]) {
  test(`attachment upload commit guard: ${scenario}`, async () => {
    const context = await loadContentScriptContext();
    let now = Date.now(), cancelled = scenario === "cancelled_before_read", offline = false;
    let assignments = 0, changes = 0, previews = 0;
    const fetched = [];
    const job = { id: "sync_upload_guard", projectId: "project_upload_guard", status: "running",
      claimedAt: new Date(now).toISOString(), inputArtifacts: [{ id: "one", filename: "one.png" }, { id: "two", filename: "two.png" }] };
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    context.Date = Clock;
    context.DataTransfer = class { files = []; items = { add: file => this.files.push(file) }; };
    context.Event = class { constructor(type) { this.type = type; } };
    context.findFileInput = () => ({
      set files(value) { assignments++; assert.deepEqual(Array.from(value, f => f.name), ["one.png", "two.png"]); },
      dispatchEvent(event) { assert.equal(event.type, "change"); changes++; }
    });
    context.bridgeApi = async () => {
      if (offline) throw new Error("connection lost during file read");
      return { job: { ...job, status: cancelled ? "failed" : "running", errorCode: cancelled ? "manual_cancelled" : null } };
    };
    context.fetchInputArtifactFile = async (artifact, options) => {
      assert.equal(options.projectId, "project_upload_guard");
      fetched.push(artifact.id);
      await Promise.resolve();
      if (scenario === "cancelled_between_reads" || (scenario === "cancelled_after_last_read" && artifact.id === "two")) cancelled = true;
      if (scenario === "expired_after_read") now += 61000;
      if (scenario === "offline_after_read") offline = true;
      return { name: artifact.filename };
    };
    context.waitForInputArtifactsVisible = async (_artifacts, _timeout, waitJob) => { assert.equal(waitJob, job); previews++; };
    const result = await context.uploadInputArtifacts(job).then(files => ({ files }), error => ({ error }));
    const active = scenario === "active";
    assert.equal(assignments, active ? 1 : 0, "cancelled or unconfirmed files must not enter the page");
    assert.equal(changes, active ? 1 : 0, "must not trigger the page upload after cancellation");
    assert.equal(previews, active ? 1 : 0);
    assert.deepEqual(fetched, scenario === "cancelled_before_read" ? [] : active || scenario === "cancelled_after_last_read" ? ["one", "two"] : ["one"]);
    if (scenario.startsWith("cancelled")) assert.equal(result.error?.bridgeJobStopped, true);
    if (scenario === "expired_after_read") assert.equal(result.error?.errorCode, "pre_send_stale");
    if (scenario === "offline_after_read") assert.equal(result.error?.errorCode, "pre_send_state_unconfirmed");
    if (active) assert.deepEqual(Array.from(result.files, f => f.name), ["one.png", "two.png"]);
  });
}

for (const scenario of ["slow_preferences", "slow_button", "cancelled_button", "offline_button", "slow_final_check", "ready_without_fixed_sleep", "draft_wrong", "draft_changed_before_send"]) {
  test(`pre-send guard prevents delayed submission: ${scenario}`, async () => {
    const context = await loadContentScriptContext();
    const start = Date.parse("2026-09-12T00:00:00Z");
    let now = start, cancelled = false, offline = false, finalCheck = false, sends = 0;
    const job = { id: "sync_guard_fixture", status: "running", claimedAt: new Date(start).toISOString(), payloadText: "test draft", modelPreference: "latest" };
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    context.Date = Clock;
    context.sleep = async ms => { if(scenario === "ready_without_fixed_sleep" && [300,700].includes(ms)) now += 61000; };
    context.ensureExpectedChatGptPage = () => true;
    context.stopStaleGenerationIfNeeded = async () => {};
    context.dismissArtifactPreviewIfNeeded = async () => {};
    const composerNode = { value: "", tagName: "TEXTAREA" };
    context.waitForComposer = async () => composerNode;
    context.preferencesAlreadyApplied = () => false;
    context.applyJobPreferences = async () => { if (scenario === "slow_preferences") now += 61000; };
    context.fillComposerText = async (composer,text) => {composer.value=scenario === "draft_wrong" ? "different draft" : text;};
    context.uploadInputArtifacts = async () => {};
    context.waitForReadySendButton = async (_timeout, waitJob) => {
      assert.equal(waitJob, job);
      if (scenario === "slow_button") now += 61000;
      cancelled = scenario === "cancelled_button";
      offline = scenario === "offline_button";
      finalCheck = true;
      if(scenario === "draft_changed_before_send") composerNode.value = "user changed draft";
      return {};
    };
    context.conversationTurns = () => [];
    context.directUserPromptNodes = () => [];
    context.generatedImageBaselineKeys = () => [];
    context.triggerSendButton = async () => { sends++; return {}; };
    context.waitForSubmittedPrompt = async () => ({ index: 0 });
    context.markJobSent = async () => {};
    context.waitForAssistantReply = async () => { throw Object.assign(new Error("end fixture"), { bridgeJobStopped: true }); };
    context.clearBridgeDraftIfPresent = () => {};
    context.bridgeApi = async (route) => {
      if (offline) throw new Error("Bridge disconnected");
      if (scenario === "slow_final_check" && finalCheck) now += 61000;
      return { job: { ...job, status: cancelled ? "failed" : "running", errorCode: cancelled ? "manual_cancelled" : null } };
    };
    const error = await context.processJob(job).then(() => null, e => e);
    assert.equal(sends, scenario === "ready_without_fixed_sleep" ? 1 : 0,
      "ready inputs must not need fixed sleeps; invalid or cancelled inputs must not send");
    if (scenario.startsWith("slow")) assert.equal(error?.errorCode, "pre_send_stale");
    if (scenario.startsWith("draft_")) assert.equal(error?.errorCode, "composer_text_not_applied");
  });
}

test("draft fallback stops before another submit when cancellation arrives after its DOM click", async () => {
  const c=await loadContentScriptContext();
  const job={id:'sync_fallback_guard',status:'running',claimedAt:new Date().toISOString(),payloadText:'draft'};
  let cancelled=false, clicks=0, forms=0, enters=0;
  c.sleep=async()=>{};
  c.composerContainsBridgeDraft=()=>true;
  c.isDisabledButton=()=>false;
  c.buttonDiagnosticInfo=()=>({});
  c.dispatchEnterSubmit=()=>{enters++;};
  c.bridgeApi=async()=>({job:{...job,status:cancelled?'failed':'running',errorCode:cancelled?'manual_cancelled':null}});
  const composer={focus(){},closest(){return {requestSubmit(){forms++;}};}};
  const button={click(){clicks++;cancelled=true;}};
  await assert.rejects(c.retryUnsentComposerDraft(job,{composer,sendButton:button}),e=>e.bridgeJobStopped===true);
  assert.equal(clicks,1);
  assert.equal(forms,0);
  assert.equal(enters,0);
});

test("pre-send diagnostics include visibility and claim age without the draft", async()=>{
  const c=await loadContentScriptContext();
  c.document.visibilityState='hidden';
  const record=c.traceCapturePhase({id:'sync_trace_guard',claimedAt:new Date(Date.now()-1000).toISOString(),payloadText:'PRIVATE_DRAFT'},'pre_send_preferences');
  assert.equal(record.trace[0].visibilityState,'hidden');
  assert.ok(record.trace[0].claimAgeMs>=1000);
  assert.doesNotMatch(JSON.stringify(record),/PRIVATE_DRAFT/);
});

test("content script exposes an active sentinel for safe background reinjection", async () => {
  const source = await readFile("chrome-extension/content-script.js", "utf8");

  assert.match(
    source,
    /globalThis\.__CODEX_GPT_BRIDGE_CONTENT_SCRIPT_ACTIVE__ = true;/
  );
});

test("content script proxies Bridge API through the extension background when the page origin is blocked", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  context.fetch = async () => ({
    ok: false,
    status: 403,
    async text() {
      return JSON.stringify({ error: "Origin is not allowed" });
    }
  });
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(message);
        callback({
          ok: true,
          response: {
            ok: true,
            status: 200,
            bodyText: JSON.stringify({ connected: true })
          }
        });
      }
    }
  };

  const result = await context.bridgeApi("/api/extension/heartbeat", {
    method: "POST",
    body: JSON.stringify({ workerId: "worker_background_proxy" })
  });

  assert.equal(result.connected, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "bridge:api");
  assert.equal(messages[0].bridgeOrigin, "http://127.0.0.1:4317");
  assert.equal(messages[0].path, "/api/extension/heartbeat");
});

test("content script aborts a stuck heartbeat request before it can block later polling", async () => {
  const context = await loadContentScriptContext();
  let scheduledTimeoutMs = null;
  let observedSignal = null;

  context.AbortController = class {
    constructor() {
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(type, listener) {
          if (type === "abort") listeners.push(listener);
        }
      };
      this.abort = () => {
        this.signal.aborted = true;
        for (const listener of listeners) listener();
      };
    }
  };
  context.setTimeout = (callback, timeoutMs) => {
    scheduledTimeoutMs = timeoutMs;
    queueMicrotask(callback);
    return 1;
  };
  context.clearTimeout = () => {};
  context.fetch = async (_url, options = {}) => {
    observedSignal = options.signal || null;
    if (!observedSignal) {
      throw new Error("heartbeat request is not abortable");
    }
    return new Promise((_, reject) => {
      observedSignal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };

  await assert.rejects(
    () => context.sendHeartbeat(),
    (error) => error.errorCode === "bridge_api_timeout"
  );
  assert.equal(scheduledTimeoutMs, 5_000);
  assert.equal(observedSignal.aborted, true);
});

async function loadContentScriptContext() {
  const bridgeConfigSource = await readFile("chrome-extension/bridge-config.js", "utf8");
  const source = await readFile("chrome-extension/content-script.js", "utf8");
  const context = {
    console,
    document: {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    fetch() {
      throw new Error("fetch should not be called by these unit tests");
    },
    InputEvent: class {},
    location: {
      hostname: "example.com",
      href: "https://example.com/"
    },
    URL,
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    setInterval() {},
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(bridgeConfigSource, context);
  vm.runInContext(source, context);
  return context;
}

test("Excel output is captured when the request forbids images only", async () => {
  const context=await loadContentScriptContext();
  assert.equal(context.shouldSkipArtifactCapture({kind:"user_request",payloadText:"请生成一个真实可下载的 Excel 文件 bridge_excel_acceptance.xlsx。不要生成图片。"},"下载 Excel 文件 bridge_excel_acceptance.xlsx"),false);
  assert.equal(context.expectsImageArtifact({kind:"user_request",payloadText:"生成 Excel 文件 report.xlsx，不要生成图片"}),false);
});

test("input artifact upload uses scoped background bytes when page fetch is unavailable", async () => {
  const context=await loadContentScriptContext();
  const bytes=Buffer.from([0,255,128,65]);
  context.File=File;
  context.atob=value=>Buffer.from(value,"base64").toString("binary");
  context.sleep=async()=>{};
  context.canAskBackgroundForDownloads=()=>true;
  context.fetch=async()=>{throw new Error("Page network access blocked");};
  const messages=[];
  context.chromeRuntimeMessage=async message=>{
    messages.push(message);
    return {ok:true,response:{ok:true,status:200,base64Data:bytes.toString("base64"),contentType:"application/octet-stream"}};
  };
  const file=await context.fetchInputArtifactFile({id:"artifact_input",filename:"input.bin",sizeBytes:4,uploadUrl:"/api/artifacts/artifact_input/raw"},{projectId:"project_upload"});
  assert.deepEqual(Buffer.from(await file.arrayBuffer()),bytes);
  assert.equal(file.name,"input.bin");
  assert.equal(messages.length,1);
  assert.equal(messages[0].type,"bridge:api");
  assert.equal(messages[0].path,"/api/artifacts/artifact_input/raw?projectId=project_upload");
  assert.equal(messages[0].options.responseType,"base64");
});

test("input artifact upload rejects byte loss before constructing the upload file", async () => {
  const context=await loadContentScriptContext();
  context.sleep=async()=>{};
  context.canAskBackgroundForDownloads=()=>true;
  context.atob=value=>Buffer.from(value,"base64").toString("binary");
  let constructed=0;
  context.File=class {constructor(){constructed++;}};
  context.chromeRuntimeMessage=async()=>({ok:true,response:{ok:true,status:200,base64Data:"AA=="}});
  await assert.rejects(context.fetchInputArtifactFile({id:"artifact_input",sizeBytes:2,uploadUrl:"/api/artifacts/artifact_input/raw"},{projectId:"project_upload"}),error=>error.errorCode==="input_artifact_fetch_failed" && /byte length/.test(error.message));
  assert.equal(constructed,0);
});

test("input artifact upload accepts a genuinely empty file", async () => {
  const context=await loadContentScriptContext();
  context.File=File;
  context.canAskBackgroundForDownloads=()=>true;
  context.atob=value=>Buffer.from(value,"base64").toString("binary");
  context.chromeRuntimeMessage=async()=>({ok:true,response:{ok:true,status:200,base64Data:"",contentType:"text/plain"}});
  const file=await context.fetchInputArtifactFile({id:"artifact_empty",filename:"empty.txt",sizeBytes:0,uploadUrl:"/api/artifacts/artifact_empty/raw"},{projectId:"project_upload"});
  assert.equal(file.size,0);
  assert.equal(file.type,"text/plain");
});

test("authoritative manual cancellation ends capture diagnostics without later idle overwrites", async () => {
  const context=await loadContentScriptContext();
  const job={id:"cancel_diagnostics",status:"running",sentAt:"2026-09-10T00:00:00Z"};
  context.traceCapturePhase(job,"waiting_reply");
  context.bridgeApi=async()=>({job:{id:job.id,status:"failed",errorCode:"manual_cancelled"}});
  assert.equal(await context.syncJobStillActive(job),false);
  const status=vm.runInContext("lastCaptureStatus",context);
  assert.equal(status.state,"cancelled");
  assert.equal(status.trace.at(-1).phase,"cancelled");
  await context.syncJobStillActive(job);
  assert.equal(vm.runInContext("lastCaptureStatus.trace.length",context),2);
  assert.equal(context.updateCaptureStatus(job,"job_inactive").state,"cancelled");
  assert.equal(context.updateCaptureStatus(job,"job_ended_during_capture").state,"cancelled");
});

test("a late cancellation check for an old job cannot replace current capture diagnostics", async () => {
  const context=await loadContentScriptContext();
  context.traceCapturePhase({id:"new_job"},"waiting_reply");
  context.bridgeApi=async()=>({job:{id:"old_job",status:"failed",errorCode:"manual_cancelled"}});
  assert.equal(await context.syncJobStillActive({id:"old_job",status:"running",sentAt:"2026-09-10T00:00:00Z"}),false);
  const status=vm.runInContext("lastCaptureStatus",context);
  assert.equal(status.jobId,"new_job");
  assert.equal(status.state,"waiting_reply");
});

test("a successful terminal observation is not classified as cancellation", async () => {
  const context=await loadContentScriptContext();
  const job={id:"success_wins",status:"running",sentAt:"2026-09-10T00:00:00Z"};
  context.recordCompletionCaptureStatus(job,{job:{status:"succeeded"}});
  context.bridgeApi=async()=>({job:{id:job.id,status:"succeeded"}});
  assert.equal(await context.syncJobStillActive(job),false);
  assert.equal(vm.runInContext("lastCaptureStatus.state",context),"captured");
});

test("capture timing trace is bounded and never carries another job's history", async () => {
  const context = await loadContentScriptContext();
  let result;
  for (let index = 0; index < 40; index += 1) {
    result = context.traceCapturePhase({id:"trace_a"}, "waiting_download", {
      filename:"test.zip",url:"https://example.invalid/private?sig=secret",text:"private reply",
      controlLabel:"Download https://example.invalid/private?sig=secret"
    });
  }
  assert.equal(result.trace.length, 24);
  assert.equal(result.trace[0].filename,"test.zip");
  assert.equal(result.trace[0].controlLabel,"Download [url]");
  assert.equal(JSON.stringify(result).includes("secret"),false);
  assert.equal(JSON.stringify(result).includes("private reply"),false);
  context.updateCaptureStatus({id:"trace_a"},"reply_not_final");
  result = context.recordCompletionCaptureStatus({id:"trace_a"},{job:{status:"succeeded"}});
  assert.equal(result,true);
  const finished = vm.runInContext("lastCaptureStatus",context);
  assert.equal(finished.trace.at(-1).phase,"captured");
  const next = context.traceCapturePhase({id:"trace_b"},"waiting_reply");
  assert.equal(next.trace.length,1);
  assert.equal(next.trace[0].phase,"waiting_reply");
});

test("native download exposes its waiting phase before the file import completes", async () => {
  const context = await loadContentScriptContext();
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  context.sleep = async () => {};
  context.expectedFilenameForButton = () => "trace.zip";
  context.chromeRuntimeMessage = async (message) => {
    if(message.type === "bridge:startDownloadWatch") return {ok:true,watchId:"trace_watch"};
    if(message.type === "bridge:awaitDownloadWatch") {
      entered.resolve();
      await gate.promise;
      return {ok:true,artifact:{id:"trace_artifact"}};
    }
    throw new Error(`Unexpected message ${message.type}`);
  };
  const operation = context.captureArtifactFromDownloadButtonAttempt({getAttribute:()=>"下载文件",focus(){},click(){}},{syncJobId:"trace_download"});
  await entered.promise;
  const pending = vm.runInContext("lastCaptureStatus",context);
  gate.resolve();
  await operation;
  assert.equal(pending?.state,"waiting_download");
  assert.deepEqual(Array.from(pending.trace,entry=>entry.phase),["starting_download_watch","clicking_download","native_dom_click","waiting_download"]);
  const completed = vm.runInContext("lastCaptureStatus",context);
  assert.equal(completed.trace.at(-1).phase,"download_received");
});

for (const label of ["复制", "复制链接", "Copy", "Copy link"]) {
  test(`download candidates exclude the card's ${label} control`, async () => {
    const context = await loadContentScriptContext();
    const card = {textContent:"bundle.zip",querySelectorAll:()=>[copy,download]};
    const copy = {getAttribute:name=>name==="aria-label"?label:null,parentElement:card,getClientRects:()=>[{}]};
    const download = {getAttribute:name=>name==="aria-label"?"下载 bundle.zip":null,parentElement:card,getClientRects:()=>[{}]};
    assert.deepEqual(Array.from(context.downloadButtonCandidates(card)),[download]);
  });
}

for (const label of ["已思考 20 秒", "Thought for 20s", "更多操作", "分享"]) {
  test(`a file in the reply does not turn the ${label} button into a download`, async () => {
    const context = await loadContentScriptContext();
    const card = {textContent:`${label} bundle.zip`,querySelectorAll:()=>[unrelated,download]};
    const unrelated = {textContent:label,className:"inline-block",getAttribute:()=>null,parentElement:card,getClientRects:()=>[{}]};
    const download = {getAttribute:name=>name==="aria-label"?"下载 bundle.zip":null,parentElement:card,getClientRects:()=>[{}]};
    assert.deepEqual(Array.from(context.downloadButtonCandidates(card)),[download]);
  });
}

test("content script preserves mixed Chinese filenames without inventing an ASCII suffix file", async () => {
  const context = await loadContentScriptContext();
  assert.deepEqual(Array.from(context.filenamesFromText("下载 bridge_验收068.zip")), ["bridge_验收068.zip"]);
  assert.deepEqual(Array.from(context.filenamesFromText("验收068.zip")), ["验收068.zip"]);
});

test("content script recognizes a download anchor in the current assistant turn", async () => {
  const context = await loadContentScriptContext();
  const anchor = {href:"https://chatgpt.com/files/current.zip",textContent:"下载 current.zip",getAttribute:()=>null};
  const turn = {querySelectorAll:s=>s==="a[href]"?[anchor]:[]};
  const message = {closest:()=>turn,querySelectorAll:()=>[]};
  assert.equal(context.hasDownloadableArtifact(message),true);
  turn.querySelectorAll = () => [];
  context.document.querySelectorAll = () => [anchor];
  assert.equal(context.hasDownloadableArtifact(message),false,"a previous turn's download must not qualify");
});

test("non-image Office requests are recognized without requiring a filename extension",async()=>{
  const context=await loadContentScriptContext();
  for(const prompt of ["制作可下载的Excel，不要图片","导出Word文档，不生成图片","Generate an Excel workbook, do not generate images"]){
    assert.equal(context.shouldSkipArtifactCapture({kind:"user_request",payloadText:prompt},"文件已准备好"),false,prompt);
  }
});

test("explicit no-file instructions still prevent artifact capture",async()=>{
  const context=await loadContentScriptContext();
  for(const prompt of ["报告叫 report.xlsx，但不要生成文件，只解释步骤","写小说大纲，不要生成图片","Analyze input.xlsx, do not generate files"]){
    assert.equal(context.shouldSkipArtifactCapture({kind:"user_request",payloadText:prompt},"完成"),true,prompt);
  }
});

test("content script wakes reply processing when the assistant DOM changes", async () => {
  const context = await loadContentScriptContext();
  let observerCallback = null;
  let observedTarget = null;
  let observedOptions = null;
  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    constructor(callback) {
      observerCallback = callback;
    }

    observe(target, options) {
      observedTarget = target;
      observedOptions = options;
    }
  };

  assert.equal(context.installAssistantActivityObserver(), true);
  let settled = false;
  const waiting = context.waitForAssistantActivity(10_000).then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.equal(settled, false);
  observerCallback([{ type: "childList" }]);
  await waiting;

  assert.equal(settled, true);
  assert.equal(observedTarget, context.document.documentElement);
  assert.equal(observedOptions.childList, true);
  assert.equal(observedOptions.characterData, true);
  assert.equal(observedOptions.subtree, true);
});

test("content script coalesces rapid assistant DOM mutations before rescanning the conversation", async () => {
  const context = await loadContentScriptContext();
  let observerCallback = null;
  const timers = [];
  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    constructor(callback) {
      observerCallback = callback;
    }

    observe() {}
  };
  context.setTimeout = (callback, timeoutMs) => {
    timers.push({ callback, timeoutMs, cleared: false });
    return timers.length;
  };
  context.clearTimeout = (timerId) => {
    if (timers[timerId - 1]) timers[timerId - 1].cleared = true;
  };

  assert.equal(context.installAssistantActivityObserver(), true);
  let settled = false;
  const waiting = context.waitForAssistantActivity(10_000).then(() => {
    settled = true;
  });
  observerCallback([{ type: "characterData" }]);
  observerCallback([{ type: "characterData" }]);
  observerCallback([{ type: "childList" }]);
  await Promise.resolve();

  assert.equal(settled, false);
  const coalescedTimer = timers.find((timer) => timer.timeoutMs === 250);
  assert.ok(coalescedTimer, "rapid DOM mutations should schedule one 250ms coalesced wake-up");
  assert.equal(timers.filter((timer) => timer.timeoutMs === 250).length, 1);

  coalescedTimer.callback();
  await waiting;
  assert.equal(settled, true);
});

test("reply scoping skips prompt-text fallback once a stable identity identifies an assistant turn", async () => {
  const context = await loadContentScriptContext();
  const indexedMessage = { id: "assistant-indexed" };
  let promptFallbackScans = 0;
  context.assistantTurnsAfterTurnId = () => [indexedMessage];
  context.assistantTurnsAfterUserTexts = () => {
    promptFallbackScans += 1;
    return [{ id: "assistant-fallback" }];
  };

  const messages = context.assistantMessagesForReplyScope(3, ["a long prompt"], null, "stable-prompt");

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "assistant-indexed");
  assert.equal(promptFallbackScans, 0);
});

function fakeText(value) {
  return {
    nodeType: 3,
    textContent: value,
    innerText: value
  };
}

function logicalTurn(id, role, text = "") {
  return fakeElement("div", { "data-turn-id-container": id }, role
    ? [fakeElement("section", { "data-turn-id": id, "data-message-author-role": role }, [fakeText(text)])]
    : []);
}

test("file capture stays inside the modern assistant turn instead of a wider legacy wrapper",async()=>{
  const c=await loadContentScriptContext();
  const answer=logicalTurn("answer","assistant","result.txt");
  fakeElement("article",{"data-testid":"conversation-turn-wide"},[logicalTurn("prompt","user","input.txt"),answer]);
  const body=answer.querySelector('[data-message-author-role="assistant"]');
  assert.equal(c.assistantDownloadScope(body),answer);
});

test("file capture uses the local card title before filenames mentioned in reply prose",async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const title=fakeElement("span",{title:"bridge_accept_result.txt"},[fakeText("bridge_accept_…")]);
  const card=fakeElement("div",{},[title,button]);
  const message=fakeElement("section",{},[fakeText("读取 input.txt 后生成结果。"),card]);
  assert.equal(c.expectedFilenameForButton(button,message),"bridge_accept_result.txt");
});

test("file capture skips user upload controls without rejecting same-named assistant output",async()=>{
  const c=await loadContentScriptContext(); c.isVisibleElement=()=>true;
  const upload=fakeElement("button",{"aria-label":"下载文件"});
  const output=fakeElement("button",{"aria-label":"下载文件"});
  const root=fakeElement("div",{},[
    fakeElement("section",{"data-message-author-role":"user"},[fakeText("input.txt"),upload]),
    fakeElement("section",{"data-message-author-role":"assistant"},[fakeText("input.txt"),output])
  ]);
  const captured=[];
  c.captureArtifactFromDownloadButton=async button=>{captured.push(button);return{id:"edited-file"};};
  const result=await c.collectDownloadArtifacts(root,{syncJobId:"input-output-scope"});
  assert.deepEqual(captured,[output]);
  assert.deepEqual(Array.from(result.artifactIds),["edited-file"]);
});

test("file capture does not guess the first filename for an ambiguous native download",async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const message=fakeElement("section",{},[fakeText("input.txt result.txt"),button]);
  assert.equal(c.expectedFilenameForButton(button,message),null);
});

test("file capture never borrows a sibling card title for an unnamed control",async()=>{
  const c=await loadContentScriptContext();
  const a=fakeElement("button",{"aria-label":"下载文件"}),b=fakeElement("button",{"aria-label":"下载文件"});
  const message=fakeElement("section",{},[
    fakeElement("div",{},[fakeText("file-a…"),a]),
    fakeElement("div",{},[fakeElement("span",{title:"b.txt"},[fakeText("file-b…")]),b])
  ]);
  assert.equal(c.expectedFilenameForButton(a,message),null);
  assert.equal(c.expectedFilenameForButton(b,message),"b.txt");
});

for(const name of ["script.py","clip.mp4"]) test(`file capture trusts explicit filename metadata for ${name}`,async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const card=fakeElement("div",{"data-filename":name},[button]);
  assert.equal(c.expectedFilenameForButton(button,card),name);
});

test("file capture cannot borrow a sibling anchor download name",async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const root=fakeElement("section",{},[fakeElement("div",{},[fakeText("unknown…"),button]),
    fakeElement("a",{href:"https://chatgpt.com/files/b.txt",download:"b.txt"},[fakeText("b.txt")])]);
  assert.equal(c.expectedFilenameForButton(button,root),null);
});

test("file capture preserves Download as part of an explicit filename",async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const card=fakeElement("div",{"data-filename":"Download report.txt"},[button]);
  assert.equal(c.expectedFilenameForButton(button,card),"Download report.txt");
});

test("file capture permits a same-name link and native control within one explicit card",async()=>{
  const c=await loadContentScriptContext();
  const button=fakeElement("button",{"aria-label":"下载文件"});
  const card=fakeElement("div",{"data-filename":"result.txt"},[
    fakeElement("a",{href:"https://chatgpt.com/files/result.txt",download:"result.txt"},[fakeText("result.txt")]),button]);
  assert.equal(c.expectedFilenameForButton(button,card),"result.txt");
});

test("explicit result link is collected even when native controls and Python filenames coexist",async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const link=fakeElement("a",{href:"https://chatgpt.com/files/result.txt",download:"result.txt"},[fakeText("下载 result.txt")]);
  const button=fakeElement("button",{"aria-label":"下载文件","data-filename":"result.txt"});
  const message=fakeElement("section",{"data-message-author-role":"assistant"},[fakeText("src=input.txt; out=result.txt"),link,button]);
  let downloads=0,clicks=0;
  c.downloadArtifactFromAnchor=async a=>{assert.equal(a,link);downloads++;return{filename:"result.txt",contentType:"text/plain",base64Data:"T0s="};};
  c.captureArtifactFromDownloadButton=async()=>{clicks++;throw new Error("duplicate click");};
  const result=await c.collectDownloadArtifacts(message,{syncJobId:"explicit-link"});
  assert.equal(result.artifacts[0]?.filename,"result.txt");
  assert.equal(downloads,1);
  assert.equal(clicks,0,"do not reclick the same named file already collected via its link");
});

test('missing-file recovery collects only its named output and never reconstructs text or images',async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const a=fakeElement('button',{},[fakeText('下载 a.txt')]),b=fakeElement('button',{},[fakeText('下载 b.txt')]);
  const root=fakeElement('section',{},[a,b]);
  c.generatedTextArtifactsFromMessage=()=>assert.fail('must not reconstruct a missing original');
  c.collectImageArtifacts=()=>assert.fail('must not collect images');
  const clicked=[];
  c.captureArtifactFromDownloadButton=async control=>{clicked.push(control);return{id:'b-artifact',filename:'b.txt'};};
  const result=await c.collectDownloadArtifacts(root,{onlyFilenames:['b.txt'],syncJobId:'sync_missing'});
  assert.deepEqual(clicked,[b]);assert.deepEqual(Array.from(result.artifactIds),['b-artifact']);
});

test('missing-file recovery downloads an already-open preview from a native source control',async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;c.sleep=async()=>{};
  const source=fakeElement('button',{'aria-label':'下载文件','data-filename':'b.txt'});
  source.click=()=>assert.fail('matching preview is already open');
  const download=fakeElement('button',{'aria-label':'下载'});
  const panel=fakeElement('div',{},[fakeText('Library / b.txt'),download,fakeElement('button',{'aria-label':'Close'})]);
  c.document.querySelectorAll=selector=>panel.querySelectorAll(selector);
  let clicked=false;download.click=()=>{clicked=true;};
  c.bridgeApi=async()=>({job:{id:'sync_recovery',status:'running'}});
  c.chromeRuntimeMessage=async r=>r.type==='bridge:startDownloadWatch'?{ok:true,watchId:'watch'}:
    new Promise(resolve=>setImmediate(()=>resolve(clicked?{ok:true,artifact:{id:'b'}}:{ok:false,error:'preview download was not clicked'})));
  assert.equal((await c.captureArtifactFromDownloadButtonAttempt(source,{syncJobId:'sync_recovery',preferExistingPreview:true})).id,'b');
});

test('missing-file recovery cannot enter the send path with a missing original anchor',async()=>{
  const c=await loadContentScriptContext();c.syncJobStillActive=async()=>true;
  c.waitForComposer=()=>assert.fail('capture-only must never look for a composer');
  c.ensureExpectedChatGptPage=()=>true;
  await assert.rejects(c.processJob({id:'sync_missing',recoverySourceJobId:'parent',recoveryFilenames:['b.txt'],payloadText:'old prompt'}),e=>e.errorCode==='capture_only_invalid');
});

test('missing-file recovery reads the original stable turn without sending or uploading',async()=>{
  const c=await loadContentScriptContext();c.syncJobStillActive=async()=>true;c.ensureExpectedChatGptPage=()=>true;
  const answer={textContent:'existing reply'};
  c.lastAssistantMessage=options=>{assert.equal(options.afterUserTurnId,'original');return answer;};
  c.visibleReplyTextFromAssistant=()=> 'existing reply';
  c.waitForComposer=()=>assert.fail('must not send');c.uploadInputArtifacts=()=>assert.fail('must not upload');
  let captured=0;
  c.completeAssistantReplyOnce=async(job,node,text)=>{assert.equal(node,answer);assert.equal(text,'existing reply');captured++;};
  await c.processJob({id:'sync_missing',recoverySourceJobId:'parent',recoveryFilenames:['b.txt'],sentAt:new Date().toISOString(),submittedPromptTurnId:'original',payloadText:'old prompt'});
  assert.equal(captured,1);
});

test("explicit download label wins over ambiguous surrounding code",async()=>{
  const c=await loadContentScriptContext();
  const result=fakeElement("button",{},[fakeText("下载 result.txt")]);
  const a=fakeElement("button",{"aria-label":"下载文件"});
  const b=fakeElement("button",{"aria-label":"下载文件"});
  const message=fakeElement("section",{},[fakeText("input.txt result.txt"),result,a,b]);
  assert.equal(c.expectedFilenameForButton(result,message),"result.txt");
});

test("explicit link falls back to its own scoped click if direct fetching fails",async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const link=fakeElement("a",{href:"sandbox:/mnt/data/result.txt"},[fakeText("下载 result.txt")]);
  const native=fakeElement("button",{"aria-label":"下载文件","data-filename":"result.txt"});
  const message=fakeElement("section",{},[link,native]);
  let clicks=0;
  c.downloadArtifactFromAnchor=async()=>{throw new Error("unsupported URL scheme");};
  c.captureArtifactFromDownloadButton=async control=>{assert.equal(control,link);clicks++;return{id:"existing-output",filename:"result.txt"};};
  const result=await c.collectDownloadArtifacts(message,{syncJobId:"explicit-link-fallback"});
  assert.deepEqual(Array.from(result.artifactIds),["existing-output"]);
  assert.equal(clicks,1);
});

test("explicit text link returning HTML falls back without suppressing its native file",async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const link=fakeElement("a",{href:"https://chatgpt.com/files/result.txt",download:"result.txt"},[fakeText("下载 result.txt")]);
  const native=fakeElement("button",{"aria-label":"下载文件","data-filename":"result.txt"});
  const message=fakeElement("section",{},[link,native]);
  c.fetch=async()=>({ok:true,url:"https://chatgpt.com/auth/login",headers:{get:name=>name==="content-type"?"text/html; charset=utf-8":null},arrayBuffer:async()=>Buffer.from("<html>Sign in</html>")});
  const clicks=[];
  c.captureArtifactFromDownloadButton=async control=>{clicks.push(control);if(control===link)throw new Error("link did not download");return{id:"real-output",filename:"result.txt"};};
  const result=await c.collectDownloadArtifacts(message,{syncJobId:"html-mismatch"});
  assert.equal(result.artifacts.length,0);
  assert.deepEqual(Array.from(result.artifactIds),["real-output"]);
  assert.deepEqual(clicks,[link,native]);
});

test("explicit file link follows the matching library preview download in the same watch",async()=>{
  const c=await loadContentScriptContext(); c.isVisibleElement=()=>true;c.sleep=async()=>{};
  const link=fakeElement("button",{},[fakeText("下载 result.txt")]);
  const message=fakeElement("section",{"data-message-author-role":"assistant"},[link]);
  const download=fakeElement("button",{"aria-label":"下载"});
  const close=fakeElement("button",{"aria-label":"关闭"});
  const panel=fakeElement("div",{},[fakeText("资料库 / result.txt"),download,close]);
  let shown=false,received=false,watches=0;
  c.document.querySelectorAll=selector=>shown?panel.querySelectorAll(selector):[];
  const captured=Promise.withResolvers();
  link.click=()=>{shown=true;};download.click=()=>{received=true;captured.resolve({ok:true,artifact:{id:"real-file",filename:"result.txt"}});};
  c.canAskBackgroundForDownloads=()=>false;
  c.bridgeApi=async()=>({job:{id:"sync_preview",status:"running"}});
  c.chromeRuntimeMessage=async request=>{
    if(request.type==="bridge:startDownloadWatch"){watches++;return{ok:true,watchId:"one-watch"};}
    if(request.type==="bridge:awaitDownloadWatch")return captured.promise;
    throw new Error(request.type);
  };
  const artifact=await c.captureArtifactFromDownloadButtonAttempt(link,{messageNode:message,syncJobId:"sync_preview"});
  assert.equal(artifact.id,"real-file");assert.equal(watches,1);
});

test("explicit HTML file downloads remain supported",async()=>{
  const c=await loadContentScriptContext();
  const link=fakeElement("a",{href:"https://chatgpt.com/files/report.html",download:"report.html"},[fakeText("下载 report.html")]);
  c.fetch=async()=>({ok:true,url:link.getAttribute("href"),headers:{get:name=>name==="content-type"?"text/html":null},arrayBuffer:async()=>Buffer.from("<html>Report</html>")});
  assert.equal((await c.downloadArtifactFromAnchor(link)).filename,"report.html");
});

for (const scenario of ["different-file","body-mention","unsupported-title","chat-turn","modern-turn","turn-container","two-previews","cancelled","offline","changed-during-check","navigated"]) {
  test(`library preview download refuses unsafe second click: ${scenario}`,async()=>{
    const c=await loadContentScriptContext();c.isVisibleElement=()=>true;c.sleep=async()=>{};
    const source=fakeElement("button",{},[fakeText("下载 result.txt")]);
    const download=fakeElement("button",{"aria-label":"下载"});
    const close=fakeElement("button",{"aria-label":"关闭"});
    const title=scenario==="different-file"?"other.txt":scenario==="body-mention"?"other.txt result.txt":scenario==="unsupported-title"?"other.py result.txt":"result.txt";
    const attrs=scenario==="chat-turn"?{"data-message-author-role":"assistant"}:scenario==="modern-turn"?{"data-turn":"assistant"}:scenario==="turn-container"?{"data-turn-id-container":"other-turn"}:{};
    const panel=fakeElement("div",attrs,[fakeText(`资料库 / ${title}`),download,close]);
    const secondDownload=fakeElement("button",{"aria-label":"下载"});
    const second=fakeElement("div",{},[fakeText("Library / result.txt"),secondDownload,fakeElement("button",{"aria-label":"Close"})]);
    let changed=false,clicks=0;
    c.document.querySelectorAll=selector=>changed?[]:[...panel.querySelectorAll(selector),...(scenario==="two-previews"?second.querySelectorAll(selector):[])];
    download.click=()=>{clicks++;};secondDownload.click=()=>{clicks++;};
    c.canAskBackgroundForDownloads=()=>false;
    c.bridgeApi=async()=>{
      if(scenario==="offline")throw new Error("offline");
      if(scenario==="changed-during-check")changed=true;
      if(scenario==="navigated")c.location.href="https://chatgpt.com/c/different";
      return{job:{id:"sync_preview",status:scenario==="cancelled"?"failed":"running"}};
    };
    await c.followMatchingLibraryPreview(source,"result.txt",{syncJobId:"sync_preview"});
    assert.equal(clicks,0);
  });
}

test("library preview refuses navigation caused by the original file link",async()=>{
  const c=await loadContentScriptContext();c.sleep=async()=>{};c.isVisibleElement=()=>true;
  const source=fakeElement("button",{},[fakeText("下载 result.txt")]);
  const download=fakeElement("button",{"aria-label":"下载"});
  const panel=fakeElement("div",{},[fakeText("Library / result.txt"),download,fakeElement("button",{"aria-label":"Close"})]);
  let clicks=0;
  source.click=()=>{c.location.href="https://chatgpt.com/c/foreign";};download.click=()=>{clicks++;};
  c.document.querySelectorAll=selector=>panel.querySelectorAll(selector);
  c.canAskBackgroundForDownloads=()=>false;
  c.bridgeApi=async()=>({job:{id:"sync_preview",status:"running"}});
  c.chromeRuntimeMessage=async r=>r.type==="bridge:startDownloadWatch"?{ok:true,watchId:"watch"}:{ok:false,error:"No download event"};
  await assert.rejects(c.captureArtifactFromDownloadButtonAttempt(source,{syncJobId:"sync_preview"}),/No download event/);
  assert.equal(clicks,0);
});

for(const scenario of ["late-preview","remounted-button"]){
  test(`library preview continues waiting for the same file: ${scenario}`,async()=>{
    const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
    const source=fakeElement('button',{},[fakeText('下载 result.txt')]);
    const first=fakeElement('button',{'aria-label':'下载'});
    const second=fakeElement('button',{'aria-label':'下载'});
    const panel=button=>fakeElement('div',{},[fakeText('资料库 / result.txt'),button,fakeElement('button',{'aria-label':'关闭'})]);
    const original=panel(first),replacement=panel(second);
    let sleeps=0,checks=0,remounted=false,clicked=0;
    c.sleep=async()=>{sleeps++;};
    c.document.querySelectorAll=selector=>scenario==='late-preview'&&sleeps<25?[]:(remounted?replacement:original).querySelectorAll(selector);
    first.click=()=>{assert.equal(remounted,false);clicked++;};second.click=()=>{clicked++;};
    c.bridgeApi=async()=>{checks++;if(scenario==='remounted-button')remounted=true;return{job:{id:'sync_preview',status:'running'}};};
    await c.followMatchingLibraryPreview(source,'result.txt',{syncJobId:'sync_preview',timeoutMs:5000});
    assert.equal(clicked,1);assert.ok(checks>=1);
  });
}

for(const duringCheck of [false,true]){
  test(`library preview stops when its download watch settles (during check=${duringCheck})`,async()=>{
    const c=await loadContentScriptContext();c.isVisibleElement=()=>true;c.sleep=async()=>{};
    const source=fakeElement('button',{},[fakeText('下载 result.txt')]);
    const download=fakeElement('button',{'aria-label':'下载'});
    const panel=fakeElement('div',{},[fakeText('Library / result.txt'),download,fakeElement('button',{'aria-label':'Close'})]);
    let stopped=!duringCheck,clicks=0;
    c.document.querySelectorAll=selector=>panel.querySelectorAll(selector);
    download.click=()=>{clicks++;};
    c.bridgeApi=async()=>{stopped=true;return{job:{id:'sync_preview',status:'running'}};};
    await c.followMatchingLibraryPreview(source,'result.txt',{syncJobId:'sync_preview',shouldStop:()=>stopped});
    assert.equal(clicks,0);
  });
}

test('finished download releases capture even when preview status HTTP is stuck',async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;c.sleep=async()=>{};
  const source=fakeElement('button',{},[fakeText('下载 result.txt')]);source.click=()=>{};
  const download=fakeElement('button',{'aria-label':'下载'});
  const panel=fakeElement('div',{},[fakeText('Library / result.txt'),download,fakeElement('button',{'aria-label':'Close'})]);
  c.document.querySelectorAll=selector=>panel.querySelectorAll(selector);c.canAskBackgroundForDownloads=()=>false;
  const check=Promise.withResolvers(),entered=Promise.withResolvers(),watch=Promise.withResolvers();
  let clicks=0,requestOptions;
  download.click=()=>{clicks++;};
  c.bridgeApi=async(_path,options)=>{requestOptions=options;entered.resolve();return check.promise;};
  c.chromeRuntimeMessage=async r=>r.type==='bridge:startDownloadWatch'?{ok:true,watchId:'watch'}:watch.promise;
  const operation=c.captureArtifactFromDownloadButtonAttempt(source,{syncJobId:'sync_preview',timeoutMs:15000});
  await entered.promise;
  watch.resolve({ok:true,artifact:{id:'real-file'}});
  const outcome=await Promise.race([operation.then(()=> 'captured'),new Promise(resolve=>setImmediate(()=>resolve('hung')))]);
  check.resolve({job:{id:'sync_preview',status:'running'}});
  await operation;
  assert.equal(outcome,'captured');assert.equal(clicks,0);
  assert.ok(requestOptions.bridgeRequestTimeoutMs>0&&requestOptions.bridgeRequestTimeoutMs<=15000);
  assert.equal(requestOptions.skipBackgroundOnTimeout,true);
});

test("explicit labelled download button is not hidden by an unnamed native control",async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const linkButton=fakeElement("button",{},[fakeText("下载 result.txt")]);
  const native=fakeElement("button",{"aria-label":"下载文件"});
  const root=fakeElement("section",{},[fakeText("input.txt result.txt"),linkButton,native]);
  let clicks=0;
  c.captureArtifactFromDownloadButton=async button=>{assert.equal(button,linkButton);clicks++;return{id:"output",filename:"result.txt"};};
  const result=await c.collectDownloadArtifacts(root,{syncJobId:"explicit-control"});
  assert.deepEqual(Array.from(result.artifactIds),["output"]);assert.equal(clicks,1);
});

test("explicit upload download links remain excluded from assistant output capture",async()=>{
  const c=await loadContentScriptContext();c.isVisibleElement=()=>true;
  const upload=fakeElement("a",{href:"https://chatgpt.com/files/input.txt",download:"input.txt"},[fakeText("下载 input.txt")]);
  const native=fakeElement("button",{"aria-label":"下载文件","data-filename":"result.txt"});
  const root=fakeElement("div",{},[fakeElement("section",{"data-message-author-role":"user"},[upload]),fakeElement("section",{"data-message-author-role":"assistant"},[native])]);
  c.downloadArtifactFromAnchor=async()=>assert.fail("user upload is not an output");
  c.captureArtifactFromDownloadButton=async button=>{assert.equal(button,native);return{id:"output",filename:"result.txt"};};
  assert.deepEqual(Array.from((await c.collectDownloadArtifacts(root,{syncJobId:"user-link-filter"})).artifactIds),["output"]);
});

test("generation failure probe honors a stable anchor despite virtualized history",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[logicalTurn("old-placeholder",null),logicalTurn("own","user","image request"),logicalTurn("answer","assistant","image ready")];
  assert.equal(c.detectScopedGenerationFailure({afterUserTurnId:"own",afterUserText:"image request"}),null);
});

test("generation failure probe cannot borrow historical failure when a stable anchor is missing",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[logicalTurn("old","user","same request"),logicalTurn("old-answer","assistant","Something went wrong while generating the response.")];
  assert.equal(c.detectScopedGenerationFailure({afterUserTurnId:"missing",afterUserText:"same request",includeGenerationFailure:true}),null);
});

test("generation failure probe still reports the current anchored failure",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[logicalTurn("old-placeholder",null),logicalTurn("own","user","image request"),logicalTurn("answer","assistant","Something went wrong while generating the response.")];
  assert.equal(c.detectScopedGenerationFailure({afterUserTurnId:"own",afterUserText:"image request"})?.code,"generation_failed");
});

test("image settling waiter passes stable identity into its failure probe",async()=>{
  const c=await loadContentScriptContext(), answer=logicalTurn("answer","assistant","已生成图片");
  c.conversationTurns=()=>[logicalTurn("old-placeholder",null),logicalTurn("own","user","image request"),answer];
  c.isGenerating=()=>false;
  c.uniqueGeneratedImageCount=node=>node===answer?1:0;
  c.hasDownloadableArtifact=()=>false;
  c.waitForAssistantActivity=async()=>true;
  let probes=0,now=100000;
  c.Date=class extends Date { static now(){now+=1000;return now;} };
  c.assertNoChatGptBlocker=options=>{
    probes++;
    const failure=c.detectScopedGenerationFailure(options);
    if(failure)throw new Error(failure.message);
  };
  const reply=await c.waitForAssistantReply("old reply",{afterUserTurnId:"own",afterUserText:"image request",expectedImageCount:1});
  assert.match(reply,/图片/);
  assert.ok(probes>0,"exercise the image settling blocker probe, not only stable-ID lookup");
});

test("stable turn identity follows a remounted prompt, not its old array index or repeated text", async () => {
  const c = await loadContentScriptContext();
  const own = logicalTurn("answer-own", "assistant", "CURRENT_OK");
  const later = logicalTurn("answer-later", "assistant", "WRONG_LATER");
  const turns = [logicalTurn("prompt-own", "user", "same request"), own,
    logicalTurn("prompt-later", "user", "same request"), later];
  c.conversationTurns = () => turns;
  assert.equal(c.lastAssistantMessage({ afterUserTurnId: "prompt-own", afterUserTurnIndex: 9, afterUserText: "same request", requireAfterUserText: true }), own);
  assert.deepEqual(Array.from(c.assistantMessagesForReplyScope(9, ["same request"], turns, "prompt-own")), [own]);
});

test("stable turn identity never falls back to a repeated historical prompt when the anchor is absent", async () => {
  const c = await loadContentScriptContext();
  const turns = [logicalTurn("old-prompt", "user", "same request"), logicalTurn("old-answer", "assistant", "OLD")];
  c.conversationTurns = () => turns;
  c.assistantMessages = () => [turns[1]];
  assert.equal(c.lastAssistantMessage({afterUserTurnId:"missing",afterUserTurnIndex:0,afterUserText:"same request"}), null);
  assert.deepEqual(Array.from(c.assistantMessagesForReplyScope(0,["same request"],turns,"missing")), []);
});

test("stable turn identity rejects duplicate logical anchors", async () => {
  const c = await loadContentScriptContext();
  c.conversationTurns = () => [logicalTurn("duplicate", "user", "one"), logicalTurn("duplicate", "user", "two"), logicalTurn("answer", "assistant", "WRONG")];
  assert.throws(() => c.lastAssistantMessage({afterUserTurnId:"duplicate",afterUserText:"two"}), e=>e.errorCode==="reply_scope_ambiguous");
});

test("stable turn identity retains virtualized empty wrappers as scope boundaries", async () => {
  const c = await loadContentScriptContext();
  const own = logicalTurn("own-answer", "assistant", "OWN");
  const turns = [logicalTurn("own-prompt", null),own,logicalTurn("unknown-next",null),logicalTurn("foreign-answer","assistant","FOREIGN")];
  c.document.querySelectorAll = selector => selector === '[data-turn-id-container]' ? turns : [];
  assert.deepEqual(Array.from(c.conversationTurns()),turns);
  assert.equal(c.lastAssistantMessage({afterUserTurnId:"own-prompt"}),own);
});

test("stable turn identity submission baseline survives index renumbering", async () => {
  const c = await loadContentScriptContext();
  const turns = [logicalTurn("old", "user", "same request"), logicalTurn("new", "user", "same request")];
  const info=c.latestUserPromptTurnInfo(["same request"],{turns,afterTurnIndex:20,initialTurnIds:["old"]});
  assert.equal(info?.turnId,"new");
  assert.equal(info?.index,1);
});

test("stable turn identity is persisted through the sent request and retained locally for recovery", async () => {
  const c=await loadContentScriptContext(); let sent;
  const job={id:"stable-sent"};
  c.bridgeApi=async (_url, options)=>{sent=JSON.parse(options.body);return {job:{...job,...sent}};};
  await c.markJobSent(job,"previous",{index:3,turnId:"prompt-stable"});
  assert.equal(sent.submittedPromptTurnId,"prompt-stable");
  assert.equal(job.submittedPromptTurnId,"prompt-stable");
});

test("stable turn identity waiter does not accept unscoped text while its anchor is missing", async () => {
  const c=await loadContentScriptContext(); let appeared=false, waits=0;
  const own=logicalTurn("own-answer","assistant","CURRENT_OK");
  c.conversationTurns=()=>appeared?[logicalTurn("own-prompt","user","same"),own]:[];
  c.assistantMessages=()=>[logicalTurn("old-answer","assistant","WRONG_OLD")];
  c.isGenerating=()=>false;
  c.assertNoChatGptBlocker=()=>{};
  c.effectiveStableTarget=()=>1;
  c.waitForAssistantActivity=async()=>{waits++;appeared=true;return true;};
  const result=await c.waitForAssistantReply("previous",{afterUserTurnId:"own-prompt",afterUserTurnIndex:5,afterUserText:"same"});
  assert.equal(result,"CURRENT_OK");
  assert.equal(waits,1);
});

test("stable turn identity recovery refuses historical content and gallery when its prompt is missing",async()=>{
  const c=await loadContentScriptContext();let completions=0;
  c.isGenerating=()=>false;c.syncJobStillActive=async()=>true;
  c.conversationTurns=()=>[logicalTurn("old-prompt","user","same"),logicalTurn("old-answer","assistant","OLD_FINAL_OK")];
  c.hasUsableAssistantContent=()=>true;
  c.visibleReplyTextFromAssistant=()=>"OLD_FINAL_OK";
  c.looksLikePossiblyStreamingReply=()=>false;
  c.completeAssistantReplyOnce=async()=>{completions++;return true;};
  const result=await c.captureExistingReply({id:"stable-recovery",sentAt:new Date().toISOString(),payloadText:"same",submittedPromptTurnId:"missing"});
  assert.equal(result,false);
  assert.equal(completions,0);
});

for(const resume of [false,true]) {
  test(`stable turn identity processJob carries the same anchor into waiting and artifact capture (resume=${resume})`,async()=>{
    const c=await loadContentScriptContext();
    const job={id:"stable-pipeline",status:"running",claimedAt:new Date().toISOString(),payloadText:"same request",
      ...(resume?{sentAt:new Date().toISOString(),submittedPromptTurnId:"own-prompt",submittedPromptTurnIndex:20}:{})};
    const own=logicalTurn("own-answer","assistant","CURRENT_FINAL_OK");
    let turns=resume?[logicalTurn("own-prompt","user","same request"),own]:[logicalTurn("older-prompt","user","same request")];
    const calls=[];let sends=0,captured=null;
    const composer={value:"",tagName:"TEXTAREA"};
    c.conversationTurns=()=>turns;c.directUserPromptNodes=()=>[];
    c.ensureExpectedChatGptPage=()=>true;c.isGenerating=()=>false;
    c.stopStaleGenerationIfNeeded=async()=>{};c.dismissArtifactPreviewIfNeeded=async()=>{};
    c.waitForComposer=async()=>composer;c.findComposer=()=>composer;
    c.preferencesAlreadyApplied=()=>true;c.applyJobPreferences=async()=>{};
    c.fillComposerText=async(node,text)=>{node.value=text;};c.uploadInputArtifacts=async()=>{};
    c.waitForReadySendButton=async()=>({});c.generatedImageBaselineKeys=()=>[];
    c.triggerSendButton=async()=>{sends++;composer.value="";turns=[logicalTurn("own-prompt","user","same request"),own];return {};};
    c.bridgeApi=async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
      return {job:{...job,status:url.endsWith("/complete")?"succeeded":"running"}};
    };
    c.waitForAssistantReply=async(_previous,options)=>{
      assert.equal(options.afterUserTurnId,"own-prompt");
      turns=[logicalTurn("own-prompt","user","same request"),own,logicalTurn("later-prompt","user","same request"),logicalTurn("later-answer","assistant","WRONG")];
      return "CURRENT_FINAL_OK";
    };
    c.collectDownloadArtifacts=async(scope,options)=>{captured=scope;assert.equal(options.includePageGallery,false);return {artifacts:[],artifactIds:[],errors:[]};};
    await c.processJob(job,{resume});
    assert.equal(sends,resume?0:1);
    assert.equal(captured,own);
    const sent=calls.find(x=>x.url.endsWith("/sent"));
    assert.equal(sent?.body.submittedPromptTurnId,resume?undefined:"own-prompt");
    assert.equal(calls.find(x=>x.url.endsWith("/complete"))?.body.replyText,"CURRENT_FINAL_OK");
  });
}

test("stable turn identity capture-only recovery uses its original same-text prompt and disables global gallery",async()=>{
  const c=await loadContentScriptContext(); const own=logicalTurn("own-answer","assistant","CURRENT_FINAL_OK");
  c.isGenerating=()=>false;c.syncJobStillActive=async()=>true;
  c.conversationTurns=()=>[logicalTurn("own-prompt","user","same"),own,logicalTurn("later-prompt","user","same"),logicalTurn("later-answer","assistant","WRONG")];
  c.hasUsableAssistantContent=()=>true;c.visibleReplyTextFromAssistant=node=>node.textContent;c.looksLikePossiblyStreamingReply=()=>false;
  c.completeAssistantReplyOnce=async(_job,node,text,options)=>{assert.equal(node,own);assert.equal(text,"CURRENT_FINAL_OK");assert.equal(options.includePageGallery,false);return true;};
  assert.equal(await c.captureExistingReply({id:"stable-recovery-own",sentAt:new Date().toISOString(),payloadText:"same",submittedPromptTurnId:"own-prompt"}),true);
});

test("stable turn identity baseline excludes old remounted prompts even when indices grow",async()=>{
  const c=await loadContentScriptContext();
  const turns=[logicalTurn("prior","assistant","history"),logicalTurn("old-prompt","user","same request")];
  assert.equal(c.latestUserPromptTurnInfo(["same request"],{turns,afterTurnIndex:0,initialTurnIds:["prior","old-prompt"]}),null);
});

test("stable turn identity rejects an empty identity on an explicitly modern container",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[logicalTurn("","user","same"),logicalTurn("a","assistant","WRONG")];
  assert.throws(()=>c.lastAssistantMessage({afterUserTurnId:"target"}),e=>e.errorCode==="reply_scope_ambiguous");
});

test("stable turn identity does not bind an unidentified answer or partially identified submission baseline",async()=>{
  const c=await loadContentScriptContext();
  const unidentified=fakeElement("section",{"data-message-author-role":"assistant"},[fakeText("UNPROVEN")]);
  const turns=[logicalTurn("own-prompt","user","same"),unidentified];
  c.conversationTurns=()=>turns;
  assert.equal(c.lastAssistantMessage({afterUserTurnId:"own-prompt"}),null);
  assert.throws(()=>c.submissionTurnBaseline(turns),e=>e.errorCode==="reply_scope_ambiguous");
});

test("stable turn identity ignores only duplicate nested wrappers of the same identity",async()=>{
  const c=await loadContentScriptContext();
  const outer=logicalTurn("one","user","prompt");
  const inner=logicalTurn("one",null);
  inner.parentElement={closest:()=>outer};
  const different=logicalTurn("two","assistant","answer");
  different.parentElement={closest:()=>outer};
  c.document.querySelectorAll=selector=>selector==='[data-turn-id-container]'?[outer,inner,different]:[];
  assert.deepEqual(Array.from(c.conversationTurns()),[outer,different]);
});

test("stable turn identity submission refuses two new same-text prompts instead of choosing the last",async()=>{
  const c=await loadContentScriptContext();
  const turns=[logicalTurn("new-one","user","same"),logicalTurn("new-two","user","same")];
  assert.throws(()=>c.latestUserPromptTurnInfo(["same"],{turns,initialTurnIds:[],afterTurnIndex:-1}),e=>e.errorCode==="reply_scope_ambiguous");
});

test("stable turn identity confirmation does not turn a cleared composer into proof of a new message",async()=>{
  const c=await loadContentScriptContext();let now=1000;
  c.Date=class extends Date {static now(){return now;}};
  c.conversationTurns=()=>[logicalTurn("old","user","same")];
  c.directUserPromptNodes=()=>[];c.isGenerating=()=>true;c.assertNoChatGptBlocker=()=>{};
  c.waitForAssistantActivity=async()=>{now+=500;return true;};
  await assert.rejects(c.waitForSubmittedPrompt({id:"confirm",payloadText:"same"},100,{composer:{tagName:"TEXTAREA",value:""},afterTurnIndex:0,initialTurnIds:["old"]}),e=>e.errorCode==="send_not_confirmed");
});

test("scope hardening keeps an empty stable baseline in identity-confirmation mode",async()=>{
  const c=await loadContentScriptContext();let now=1000;
  c.Date=class extends Date {static now(){return now;}};
  c.conversationTurns=()=>[];c.directUserPromptNodes=()=>[];
  c.isGenerating=()=>true;c.assertNoChatGptBlocker=()=>{};
  c.waitForAssistantActivity=async()=>{now+=500;return true;};
  await assert.rejects(c.waitForSubmittedPrompt({id:"empty-baseline",payloadText:"new"},100,
    {composer:{tagName:"TEXTAREA",value:""},afterTurnIndex:-1,initialTurnIds:[],afterUserMessageCount:0}),e=>e.errorCode==="send_not_confirmed");
});

test("scope hardening stops legacy index replies at the next user turn",async()=>{
  const c=await loadContentScriptContext();
  const user=text=>fakeElement("section",{},[fakeElement("div",{"data-message-author-role":"user"},[fakeText(text)])]);
  const answer=text=>fakeElement("section",{},[fakeElement("div",{"data-message-author-role":"assistant"},[fakeText(text)])]);
  const own=answer("OWN_REPLY"),other=answer("WRONG_OTHER");
  const turns=[user("own prompt"),own,user("next prompt"),other];c.conversationTurns=()=>turns;
  assert.deepEqual(Array.from(c.assistantTurnsAfterTurnIndex(0,turns)),[own]);
  assert.equal(c.lastAssistantMessage({afterUserTurnIndex:0,afterUserText:"own prompt",requireAfterUserText:true}),own);
});

for (const nextPrompt of ["next prompt", "own prompt"]) test(`scope hardening does not fall through to a later response when a legacy prompt has no answer (${nextPrompt})`,async()=>{
  const c=await loadContentScriptContext();let waits=0;
  const user=text=>fakeElement("section",{},[fakeElement("div",{"data-message-author-role":"user"},[fakeText(text)])]);
  const foreign=fakeElement("section",{},[fakeElement("div",{"data-message-author-role":"assistant"},[fakeText("WRONG_OTHER_REPLY")])]);
  c.conversationTurns=()=>[user("own prompt"),user(nextPrompt),foreign];
  c.assistantMessages=()=>[foreign];c.isGenerating=()=>false;c.effectiveStableTarget=()=>1;c.assertNoChatGptBlocker=()=>{};
  c.waitForAssistantActivity=async()=>{waits++;throw Object.assign(new Error("scope still unavailable"),{code:"TEST_END"});};
  await assert.rejects(c.waitForAssistantReply("previous",{afterUserTurnIndex:0,afterUserText:"own prompt"}),
    e=>nextPrompt==="own prompt"?e.errorCode==="reply_scope_ambiguous":e.code==="TEST_END");
  assert.equal(waits,nextPrompt==="own prompt"?0:1);
});

test("scope hardening confirms an actual new identity after an initially empty page",async()=>{
  const c=await loadContentScriptContext();let now=1000,visible=false,waits=0;
  c.Date=class extends Date {static now(){return now;}};
  c.conversationTurns=()=>visible?[logicalTurn("new-visible","user","new prompt")]:[];
  c.directUserPromptNodes=()=>[];c.isGenerating=()=>true;c.assertNoChatGptBlocker=()=>{};
  c.waitForAssistantActivity=async()=>{now+=20;visible=true;waits++;return true;};
  const result=await c.waitForSubmittedPrompt({id:"empty-then-visible",payloadText:"new prompt"},100,
    {composer:{tagName:"TEXTAREA",value:""},afterTurnIndex:-1,initialTurnIds:[],afterUserMessageCount:0});
  assert.equal(result.turnId,"new-visible");assert.equal(result.fallback,undefined);assert.equal(waits,1);
});

function legacyTurn(role,text) {
  return fakeElement("section",{},[fakeElement("div",{"data-message-author-role":role},[fakeText(text)])]);
}

test("legacy unique prompt ignores a stale index pointing at a different user's question",async()=>{
  const c=await loadContentScriptContext();
  const wrong=legacyTurn("assistant","WRONG"),right=legacyTurn("assistant","RIGHT");
  const turns=[legacyTurn("user","other question"),wrong,legacyTurn("user","actual question"),right];c.conversationTurns=()=>turns;
  assert.equal(c.lastAssistantMessage({afterUserTurnIndex:0,afterUserText:"actual question",requireAfterUserText:true}),right);
  assert.deepEqual(Array.from(c.assistantMessagesForReplyScope(0,["actual question"],turns)),[right]);
});

test("legacy unique prompt rejects duplicate matching questions even when an old index looks valid",async()=>{
  const c=await loadContentScriptContext();
  const turns=[legacyTurn("user","same question"),legacyTurn("assistant","FIRST"),legacyTurn("user","same question"),legacyTurn("assistant","LATER")];c.conversationTurns=()=>turns;
  for(const index of [undefined,0,9]) {
    assert.throws(()=>c.lastAssistantMessage({afterUserTurnIndex:index,afterUserText:"same question",requireAfterUserText:true}),e=>e.errorCode==="reply_scope_ambiguous");
    assert.throws(()=>c.assistantMessagesForReplyScope(index,["same question"],turns),e=>e.errorCode==="reply_scope_ambiguous");
  }
});

test("legacy unique prompt does not return indexed content when the requested question is absent",async()=>{
  const c=await loadContentScriptContext();const turns=[legacyTurn("user","other"),legacyTurn("assistant","WRONG")];c.conversationTurns=()=>turns;
  assert.equal(c.lastAssistantMessage({afterUserTurnIndex:0,afterUserText:"missing",requireAfterUserText:true}),null);
  assert.deepEqual(Array.from(c.assistantMessagesForReplyScope(0,["missing"],turns)),[]);
});

test("legacy full prompt rejects a different request sharing the first eighty characters",async()=>{
  const c=await loadContentScriptContext();const prefix="Common instruction. ".repeat(8);
  c.conversationTurns=()=>[legacyTurn("user",prefix+"task A"),legacyTurn("assistant","WRONG")];
  assert.equal(c.lastAssistantMessage({afterUserText:prefix+"task B",requireAfterUserText:true}),null);
});

test("legacy full prompt never treats a filename-only overlap as proof of the request",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[legacyTurn("user","Delete the file report.csv"),legacyTurn("assistant","WRONG")];
  assert.equal(c.lastAssistantMessage({afterUserTexts:["Summarize report.csv","report.csv"],requireAfterUserText:true}),null);
});

test("legacy full prompt refuses to claim uniqueness when earlier history is virtualized",async()=>{
  const c=await loadContentScriptContext();
  c.conversationTurns=()=>[logicalTurn("hidden-earlier",null),logicalTurn("visible-later","user","same question"),logicalTurn("visible-reply","assistant","WRONG")];
  assert.throws(()=>c.lastAssistantMessage({afterUserText:"same question",requireAfterUserText:true}),e=>e.errorCode==="reply_scope_ambiguous");
});

test("stable turn identity supports modern data-turn roles without legacy author-role attributes",async()=>{
  const c=await loadContentScriptContext();
  const user=fakeElement("section",{"data-turn-id":"modern-user","data-turn":"user"},[fakeText("same")]);
  const reply=fakeElement("section",{"data-turn-id":"modern-answer","data-turn":"assistant"},[fakeText("same")]);
  c.conversationTurns=()=>[user,reply];
  assert.equal(c.lastAssistantMessage({afterUserTurnId:"modern-user"}),reply);
  assert.equal(c.latestUserPromptTurnInfo(["same"],{turns:[user,reply],initialTurnIds:["modern-user"],afterTurnIndex:0}),null);
});

test("stable turn identity supports modern roles inside persistent identity wrappers",async()=>{
  const c=await loadContentScriptContext();
  const user=fakeElement("div",{"data-turn-id-container":"modern-user"},[fakeElement("section",{"data-turn":"user"},[fakeText("prompt")])]);
  const reply=fakeElement("div",{"data-turn-id-container":"modern-answer"},[fakeElement("section",{"data-turn":"assistant"},[fakeText("reply")])]);
  c.conversationTurns=()=>[user,reply];
  assert.equal(c.lastAssistantMessage({afterUserTurnId:"modern-user"}),reply);
});

test("pre-send preparation has a hard timeout", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.preSendTimeoutMs({}), 30_000);
  await assert.rejects(
    () => context.withPreSendTimeout(
      { id: "sync_pre_send_timeout", _bridgePreSendTimeoutMs: 1 },
      () => new Promise(() => {})
    ),
    (error) => error.errorCode === "pre_send_timeout" && /GPT \u9875\u9762\u51c6\u5907\u53d1\u9001\u8d85\u65f6/.test(error.message)
  );
});

test("reply waiting uses activity-aware idle expiry with an enlarged hard ceiling", async () => {
  const context = await loadContentScriptContext();
  const limits = context.responseWaitLimits();

  assert.equal(limits.idleTimeoutMs, 15 * 60_000);
  assert.equal(limits.hardTimeoutMs, 45 * 60_000);
  assert.equal(
    context.responseWaitExpired({
      startedAt: 0,
      lastActivityAt: 0,
      now: 20 * 60_000,
      pageStillGenerating: true
    }),
    false,
    "visible generation must keep the reply wait alive past the idle window"
  );
  assert.equal(
    context.responseWaitExpired({
      startedAt: 0,
      lastActivityAt: 10 * 60_000,
      now: 20 * 60_000,
      pageStillGenerating: false
    }),
    false,
    "recent reply progress must renew the idle window"
  );
  assert.equal(
    context.responseWaitExpired({
      startedAt: 0,
      lastActivityAt: 0,
      now: 15 * 60_000,
      pageStillGenerating: false
    }),
    true,
    "a genuinely idle page must eventually expire"
  );
  assert.equal(
    context.responseWaitExpired({
      startedAt: 0,
      lastActivityAt: 44 * 60_000,
      now: 45 * 60_000,
      pageStillGenerating: true
    }),
    true,
    "the hard ceiling must still stop a permanently stuck page"
  );
});

test("content script expires a claimed unsent job before another refresh cycle can block the queue", async () => {
  const context = await loadContentScriptContext();
  const claimedAt = new Date(Date.now() - 61_000).toISOString();
  context.document.querySelector = () => {
    throw new Error("expired unsent job must not touch the GPT composer");
  };
  context.bridgeApi = async (path) => {
    if (path === "/api/sync/jobs/sync_expired_unsent") {
      return {
        job: {
          id: "sync_expired_unsent",
          status: "running",
          claimedAt,
          sentAt: null
        }
      };
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_expired_unsent",
        status: "running",
        claimedAt,
        sentAt: null,
        payloadText: "must not stay at the head of the queue",
        _bridgePreSendTimeoutMs: 1
      }),
    (error) => {
      assert.equal(error.errorCode, "pre_send_expired");
      assert.equal(error.recoveryAction, "retry");
      return true;
    }
  );
});

test("content script preserves structured Bridge API errors", async () => {
  const context = await loadContentScriptContext();
  const calls = [];
  context.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/api/config")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { apiToken: "extension-session-token" };
        }
      };
    }
    if (!options.headers?.["X-Bridge-Token"]) {
      return {
        ok: false,
        status: 401,
        async text() {
          return JSON.stringify({
            error: "Bridge API token is required"
          });
        }
      };
    }
    return {
      ok: false,
      status: 409,
      async text() {
        return JSON.stringify({
          error: "GPT reply is still streaming or interrupted",
          code: "interim_chatgpt_reply"
        });
      }
    };
  };

  await assert.rejects(
    () => context.bridgeApi("/api/sync/jobs/sync_interim/complete", { method: "POST" }),
    (error) => {
      assert.equal(error.message, "GPT reply is still streaming or interrupted");
      assert.equal(error.errorCode, "interim_chatgpt_reply");
      assert.equal(error.status, 409);
      return true;
    }
  );
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/api\/sync\/jobs\/sync_interim\/complete$/);
  assert.match(calls[1].url, /\/api\/config$/);
  assert.equal(calls[2].options.headers["X-Bridge-Token"], "extension-session-token");
});

test("content script reads one full-page text surface instead of duplicating a long conversation", async () => {
  const context = await loadContentScriptContext();
  const reads = {
    bodyInnerText: 0,
    bodyTextContent: 0,
    documentInnerText: 0,
    documentTextContent: 0
  };

  context.document.body = {
    get innerText() {
      reads.bodyInnerText += 1;
      return "the complete long conversation";
    },
    get textContent() {
      reads.bodyTextContent += 1;
      return "duplicate body conversation";
    }
  };
  context.document.documentElement = {
    get innerText() {
      reads.documentInnerText += 1;
      return "duplicate document conversation";
    },
    get textContent() {
      reads.documentTextContent += 1;
      return "another duplicate document conversation";
    }
  };
  context.document.title = "Bound conversation";

  assert.equal(context.pageTextSnapshot(), "the complete long conversation");
  assert.deepEqual(reads, {
    bodyInnerText: 1,
    bodyTextContent: 0,
    documentInnerText: 0,
    documentTextContent: 0
  });
});

test("content script sends a lightweight heartbeat without scanning the page while a job is busy", async () => {
  const context = await loadContentScriptContext();
  let fullPageReads = 0;
  let heartbeatBody = null;

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat"
  };
  context.document.title = "Bound conversation";
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a very long generated answer";
    },
    get textContent() {
      fullPageReads += 1;
      return "a very long generated answer";
    }
  };
  context.document.documentElement = {
    get innerText() {
      fullPageReads += 1;
      return "a very long generated answer";
    },
    get textContent() {
      fullPageReads += 1;
      return "a very long generated answer";
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    assert.equal(path, "/api/extension/heartbeat");
    heartbeatBody = JSON.parse(options.body);
    return {};
  };

  await context.sendHeartbeat({ lightweight: true });

  assert.equal(fullPageReads, 0);
  assert.deepEqual(heartbeatBody.pageStatus, {
    state: "working",
    code: "bridge_busy",
    recoveryAction: "wait_for_bridge",
    message: "Bridge is processing the current GPT job."
  });
});

test("content script lightweight heartbeat reports active generation without reading conversation text", async () => {
  const context = await loadContentScriptContext();
  let fullPageReads = 0;
  let heartbeatBody = null;
  const stopButton = {
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{}];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat"
  };
  context.document.title = "Bound conversation";
  context.document.querySelectorAll = () => [stopButton];
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "streaming response text";
    },
    get textContent() {
      fullPageReads += 1;
      return "streaming response text";
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    assert.equal(path, "/api/extension/heartbeat");
    heartbeatBody = JSON.parse(options.body);
    return {};
  };

  await context.sendHeartbeat({ lightweight: true });

  assert.equal(fullPageReads, 0);
  assert.equal(heartbeatBody.pageStatus.state, "working");
  assert.equal(heartbeatBody.pageStatus.code, "active_generation");
  assert.equal(heartbeatBody.pageStatus.recoveryAction, "wait_for_generation");
});

test("content script does not scan the full conversation when the normal composer is ready", async () => {
  const context = await loadContentScriptContext();
  let fullPageReads = 0;
  const composer = {
    disabled: false,
    getClientRects() {
      return [{}];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    pathname: "/c/bound-chat"
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a very long completed conversation";
    },
    get textContent() {
      fullPageReads += 1;
      return "a very long completed conversation";
    }
  };

  const status = context.currentPageStatus();
  assert.equal(status.state, "ready");
  assert.equal(status.code, "ready");
  assert.equal(status.message, "GPT 页面已就绪。");
  assert.equal(fullPageReads, 0);
});

test("content script reuses one page text snapshot while classifying a missing composer", async () => {
  const context = await loadContentScriptContext();
  let fullPageReads = 0;

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    pathname: "/c/bound-chat"
  };
  context.document.title = "Bound conversation";
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a very long completed conversation without a visible composer";
    },
    get textContent() {
      fullPageReads += 1;
      return "duplicate long conversation";
    }
  };

  const status = context.currentPageStatus();

  assert.equal(status.state, "warning");
  assert.equal(status.code, "composer_missing");
  assert.equal(fullPageReads, 1);
});

test("composer waiting skips blocker rescans until the page changes", async () => {
  const context = await loadContentScriptContext();
  let composerVisible = false;
  let activityWaits = 0;
  let fullPageReads = 0;
  const composer = { tagName: "TEXTAREA", disabled: false };
  const activityWake = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      return false;
    }
    if (activityWaits === 2) {
      composerVisible = true;
      return true;
    }
    throw new Error("composer wait did not react to the page change");
  };

  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    observe() {}
  };
  context.sleep = activityWake;
  context.waitForAssistantActivity = activityWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a normal bound conversation";
    }
  };
  context.document.querySelector = (selector) =>
    selector === "#prompt-textarea" && composerVisible ? composer : null;
  context.document.querySelectorAll = () => [];

  assert.equal(await context.waitForComposer(2_000), composer);
  assert.equal(activityWaits, 2);
  assert.equal(fullPageReads, 2);
});

test("composer waiting keeps polling blockers when DOM observation is unavailable", async () => {
  const context = await loadContentScriptContext();
  let pageBlocked = false;
  let sleepCalls = 0;
  let fullPageReads = 0;

  context.sleep = async () => {
    sleepCalls += 1;
    pageBlocked = true;
  };
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return pageBlocked ? "Cloudflare: verify you are human" : "a normal bound conversation";
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];

  await assert.rejects(
    () => context.waitForComposer(2_000),
    (error) => error?.errorCode === "human_verification"
  );
  assert.equal(sleepCalls, 1);
  assert.equal(fullPageReads, 2);
});

test("send button waiting skips blocker rescans until the page changes", async () => {
  const context = await loadContentScriptContext();
  let sendButtonReady = false;
  let activityWaits = 0;
  let fullPageReads = 0;
  const sendButton = {
    get disabled() {
      return !sendButtonReady;
    },
    getAttribute() {
      return null;
    }
  };
  const activityWake = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      return false;
    }
    if (activityWaits === 2) {
      sendButtonReady = true;
      return true;
    }
    throw new Error("send button wait did not react to the page change");
  };

  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    observe() {}
  };
  context.sleep = activityWake;
  context.waitForAssistantActivity = activityWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a normal bound conversation";
    }
  };
  context.document.querySelector = (selector) =>
    selector === 'button[data-testid="send-button"]' ? sendButton : null;
  context.document.querySelectorAll = () => [];

  assert.equal(await context.waitForReadySendButton(2_000), sendButton);
  assert.equal(activityWaits, 2);
  assert.equal(fullPageReads, 2);
});

test("send button waiting keeps polling blockers when DOM observation is unavailable", async () => {
  const context = await loadContentScriptContext();
  let pageBlocked = false;
  let sleepCalls = 0;
  let fullPageReads = 0;
  const disabledSendButton = {
    disabled: true,
    getAttribute() {
      return null;
    }
  };

  context.sleep = async () => {
    sleepCalls += 1;
    pageBlocked = true;
  };
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return pageBlocked ? "Cloudflare: verify you are human" : "a normal bound conversation";
    }
  };
  context.document.querySelector = (selector) =>
    selector === 'button[data-testid="send-button"]' ? disabledSendButton : null;
  context.document.querySelectorAll = () => [];

  await assert.rejects(
    () => context.waitForReadySendButton(2_000),
    (error) => error?.errorCode === "human_verification"
  );
  assert.equal(sleepCalls, 1);
  assert.equal(fullPageReads, 2);
});

test("reply waiting does not rescan unchanged page text after idle wakeups", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Return one complete sentence.";
  const finalText = "The completed response is available.";
  let idleWakeups = 0;
  let fullPageReads = 0;
  const userTurn = fakeElement("section", { "data-testid": "conversation-turn-idle-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);
  const assistantTurn = fakeElement("section", { "data-testid": "conversation-turn-idle-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [fakeText(finalText)])
  ]);

  const idleWake = async () => {
    idleWakeups += 1;
    return false;
  };
  context.sleep = idleWake;
  context.waitForAssistantActivity = idleWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a long unchanged bound conversation";
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return idleWakeups >= 2 ? [userTurn, assistantTurn] : [];
    }
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.equal(reply, finalText);
  assert.ok(idleWakeups >= 2);
  assert.equal(fullPageReads, 1);
});

test("reply waiting rescans blockers immediately after a DOM change", async () => {
  const context = await loadContentScriptContext();
  let pageBlocked = false;
  let fullPageReads = 0;
  let activityWaits = 0;

  context.waitForAssistantActivity = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      pageBlocked = true;
      return true;
    }
    throw new Error("blocker rescan was skipped after the DOM changed");
  };
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return pageBlocked ? "Cloudflare: verify you are human" : "a normal bound conversation";
    }
  };
  context.document.querySelectorAll = () => [];

  await assert.rejects(
    () => context.waitForAssistantReply("old answer", { afterUserText: "current prompt" }),
    (error) => error?.errorCode === "human_verification"
  );
  assert.equal(activityWaits, 1);
  assert.equal(fullPageReads, 2);
});

test("send confirmation does not rescan unchanged page text after idle wakeups", async () => {
  const context = await loadContentScriptContext();
  const prompt = "confirm this submitted prompt";
  let idleWakeups = 0;
  let fullPageReads = 0;
  const oldAssistantTurn = fakeElement("section", { "data-testid": "conversation-turn-old-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [fakeText("older reply")])
  ]);
  const submittedUserTurn = fakeElement("section", { "data-testid": "conversation-turn-new-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);

  const idleConfirmationWake = async () => {
    idleWakeups += 1;
    return false;
  };
  context.sleep = idleConfirmationWake;
  context.waitForAssistantActivity = idleConfirmationWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a long unchanged bound conversation";
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return idleWakeups >= 2 ? [oldAssistantTurn, submittedUserTurn] : [oldAssistantTurn];
    }
    if (selector === '[data-message-author-role="user"]') {
      return idleWakeups >= 2 ? [submittedUserTurn] : [];
    }
    return [];
  };

  const submitted = await context.waitForSubmittedPrompt(
    { id: "sync_idle_confirmation", payloadText: prompt },
    2_000,
    { afterTurnIndex: 0 }
  );

  assert.equal(submitted.index, 1);
  assert.ok(idleWakeups >= 2);
  assert.equal(fullPageReads, 1);
});

test("send confirmation rescans blockers immediately after a DOM change", async () => {
  const context = await loadContentScriptContext();
  let pageBlocked = false;
  let activityWaits = 0;
  let fullPageReads = 0;
  const activityWake = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      pageBlocked = true;
      return true;
    }
    throw new Error("send blocker rescan was skipped after the DOM changed");
  };

  context.sleep = activityWake;
  context.waitForAssistantActivity = activityWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return pageBlocked ? "Cloudflare: verify you are human" : "a normal bound conversation";
    }
  };
  context.document.querySelectorAll = () => [];

  await assert.rejects(
    () => context.waitForSubmittedPrompt(
      { id: "sync_changed_confirmation", payloadText: "current prompt" },
      2_000,
      { afterTurnIndex: 0 }
    ),
    (error) => error?.errorCode === "human_verification"
  );
  assert.equal(activityWaits, 1);
  assert.equal(fullPageReads, 2);
});

for (const fails of [false, true]) {
  test(`slow preference preparation keeps heartbeat alive without concurrent actions: failure=${fails}`, async () => {
    const c = await loadContentScriptContext();
    c.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/c/bound-chat" };
    let releasePreparation, preparationStarted, releasePing;
    const started = new Promise(r => { preparationStarted = r; });
    const preparation = new Promise(r => { releasePreparation = r; });
    const ping = new Promise(r => { releasePing = r; });
    let heartbeats = 0, claims = 0, preferences = 0, recoveries = 0, opens = 0;
    c.sendHeartbeat = async () => {
      heartbeats++;
      if (heartbeats === 2) { await ping; if (fails) throw new Error("Bridge temporarily unavailable"); }
      return { controlsCurrentPage: true, preferences: { modelPreference: "latest", modePreference: "balanced" } };
    };
    c.maybeOpenProjectTabFromHeartbeat = async () => { opens++; };
    c.handleHeartbeatRecovery = async () => { recoveries++; return false; };
    c.isGenerating = () => false;
    c.applyHeartbeatPreferences = async () => { preferences++; preparationStarted(); await preparation; return true; };
    c.bridgeApi = async () => { claims++; return {}; };
    const first = c.poll();
    await started;
    const second = c.poll();
    const duplicate = c.poll();
    try {
      assert.equal(heartbeats, 2, "a pending preference operation must not suppress the next heartbeat");
      assert.equal(preferences, 1);
      assert.equal(recoveries, 1);
      assert.equal(opens, 1);
      assert.equal(claims, 0, "liveness must not claim a second task");
    } finally {
      releasePing();
      await Promise.allSettled([second, duplicate]);
      releasePreparation();
      await first;
    }
    await c.poll();
    assert.equal(heartbeats, 3, "heartbeat failure must release the single-flight guard");
    assert.equal(preferences, 2);
  });
}

test("content script allows only one polling cycle at a time", async () => {
  const context = await loadContentScriptContext();
  let heartbeatCalls = 0;
  let releaseHeartbeat;
  const heartbeatGate = new Promise((resolve) => {
    releaseHeartbeat = resolve;
  });

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat"
  };
  context.sendHeartbeat = async () => {
    heartbeatCalls += 1;
    await heartbeatGate;
    return {};
  };

  const first = context.poll();
  await Promise.resolve();
  const second = context.poll();
  await Promise.resolve();

  let assertionError = null;
  try {
    assert.equal(heartbeatCalls, 1);
  } catch (error) {
    assertionError = error;
  } finally {
    releaseHeartbeat();
    await Promise.all([first, second]);
  }
  if (assertionError) throw assertionError;
});

test("content script confirms a cleared composer when GPT is visibly generating", async () => {
  const context = await loadContentScriptContext();
  const composer = {
    tagName: "DIV",
    innerText: "",
    textContent: ""
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat"
  };
  context.document.querySelectorAll = (selector) =>
    selector === '[data-testid^="conversation-turn-"]' ? [{ textContent: "older assistant turn" }] : [];
  context.isGenerating = () => true;

  const submitted = await context.waitForSubmittedPrompt(
    {
      id: "sync_visible_generation",
      payloadText: "write the detailed first episode"
    },
    20,
    {
      composer,
      afterTurnIndex: 0
    }
  );

  assert.equal(submitted.index, 0);
  assert.equal(submitted.fallback, "composer_cleared");
});

test("content script never treats an arbitrary editable assistant surface as the composer", async () => {
  const context = await loadContentScriptContext();
  const assistantEditor = {
    tagName: "DIV",
    textContent: "a long assistant answer being edited",
    innerText: "a long assistant answer being edited"
  };

  context.document.querySelector = (selector) => {
    if (selector === '[contenteditable="true"]') {
      return assistantEditor;
    }
    return null;
  };

  assert.equal(context.findComposer(), null);
});

function selectorMatches(node, selector) {
  if (selector.includes(",")) return selector.split(",").some(part=>selectorMatches(node,part.trim()));
  const tag = String(node.tagName || "").toLowerCase();
  if (selector === tag) return true;
  const attr = (name) => node.getAttribute?.(name);
  const present = selector.match(/^\[([\w-]+)\]$/);
  if (present) return attr(present[1]) != null;
  if (selector === "#prompt-textarea") return attr("id") === "prompt-textarea";
  if (selector === "textarea") return tag === "textarea";
  if (["[data-turn-id-container]", "[title]", "[download]", "[data-filename]"].includes(selector)) return attr(selector.slice(1,-1)) !== null;
  if (selector === "button") return tag === "button";
  if (selector === "img") return tag === "img";
  if (selector === "tr") return tag === "tr";
  if (selector === "th,td") return tag === "th" || tag === "td";
  if (selector === "a[href]") return tag === "a" && Boolean(attr("href"));
  if (selector === "input[type=\"checkbox\"]") return tag === "input" && attr("type") === "checkbox";
  if (selector === "[data-message-author-role=\"assistant\"]") return attr("data-message-author-role") === "assistant";
  if (selector === "[data-message-author-role=\"user\"]") return attr("data-message-author-role") === "user";
  if (selector === '[data-turn="assistant"]') return attr("data-turn") === "assistant";
  if (selector === '[data-turn="user"]') return attr("data-turn") === "user";
  if (selector === "[data-testid^=\"conversation-turn-\"]") {
    return String(attr("data-testid") || "").startsWith("conversation-turn-");
  }
  return false;
}

function fakeElement(tagName, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    nodeName: tagName.toUpperCase(),
    className: attrs.className || "",
    childNodes: children,
    textContent: "",
    innerText: "",
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (current) => {
        if (!current || current.nodeType !== 1) return;
        if (selectorMatches(current, selector)) {
          found.push(current);
        }
        for (const child of current.childNodes || []) {
          walk(child);
        }
      };
      for (const child of this.childNodes || []) {
        walk(child);
      }
      return found;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    matches(selector) {
      return selectorMatches(this, selector);
    },
    closest(selector) {
      for (let current=this; current; current=current.parentElement) {
        if (selectorMatches(current,selector)) return current;
      }
      return null;
    }
  };
  for (const child of children) {
    if (child && typeof child === "object") {
      child.parentElement = node;
      child.parentNode = node;
    }
  }
  node.textContent = children.map((child) => child.textContent || "").join("");
  node.innerText = children.map((child) => child.innerText || child.textContent || "").join("");
  return node;
}

test("content script accepts short ChatGPT replies after the assistant text changes", async () => {
  const context = await loadContentScriptContext();

  assert.equal(
    context.hasUsableAssistantText("new reply", "old reply"),
    true
  );
  assert.equal(context.hasUsableAssistantText("old reply", "old reply"), false);
  assert.equal(context.hasUsableAssistantText("   ", "old reply"), false);
});

test("content script keeps waiting on a short unfinished opening fragment", async () => {
  const context = await loadContentScriptContext();
  const fragment = "下面是一套完整统一";

  assert.equal(context.looksLikePossiblyStreamingReply(fragment), true);
  assert.ok(
    context.assistantReplyStableTarget(fragment) >= 12,
    "an unfinished opening fragment must remain stable for at least 12 probes"
  );
});

test("content script treats an English sentence ending in a period as final", async () => {
  const context = await loadContentScriptContext();

  assert.equal(
    context.looksLikePossiblyStreamingReply("The requested analysis is complete."),
    false
  );
});

test("content script ignores empty ChatGPT wrapper headings", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.cleanChatGptReplyText("#### ChatGPT \u8bf4\uff1a"), "");
  assert.equal(context.hasUsableAssistantText("#### ChatGPT \u8bf4\uff1a", "old reply"), false);
});

test("content script accepts complete Chinese long-form replies containing status-like words", async () => {
  const context = await loadContentScriptContext();
  const reply = [
    "AI \u5de5\u4f5c\u6d41\u4ea7\u54c1\u7684\u4ef7\u503c\uff0c\u4e0d\u662f\u7b80\u5355\u628a GPT \u548c Codex \u653e\u5728\u540c\u4e00\u4e2a\u754c\u9762\u91cc\u3002",
    "\u771f\u6b63\u91cd\u8981\u7684\u662f\u4efb\u52a1\u6b63\u5728\u88ab\u5206\u914d\u5230\u6700\u5408\u9002\u7684\u6267\u884c\u8005\u624b\u91cc\uff0c\u7528\u6237\u4e0d\u9700\u8981\u5173\u5fc3\u80cc\u540e\u5206\u5de5\u3002",
    "\u5bf9\u4e8e\u521b\u610f\u3001\u56fe\u7247\u3001\u957f\u6587\u548c Office \u6587\u4ef6\uff0cGPT \u53ef\u4ee5\u7ed9\u51fa\u66f4\u81ea\u7136\u7684\u4ea7\u7269\uff1b\u5bf9\u4e8e\u4ee3\u7801\u3001\u6587\u4ef6\u843d\u5730\u548c\u9a8c\u8bc1\uff0cCodex \u5219\u8d1f\u8d23\u6536\u675f\u3002"
  ].join("\n\n");

  assert.equal(context.isInterimAssistantText(reply), false);
  assert.equal(context.hasUsableAssistantText(reply, "old reply"), true);
});

test("content script accepts a complete long-form reply containing file-analysis status phrases", async () => {
  const context = await loadContentScriptContext();
  const reply = [
    "最终架构说明已经完成。系统正在分析文件生命周期这一句，是对运行机制的客观描述，不是等待提示。",
    "Router 会把每个阶段的 requestId、payload 和状态持久化，再按依赖关系逐个执行；失败、取消与超时都不会自动推进。",
    "设计还明确区分了公共 Transport 协议与网页同步私有字段，调用方只消费统一状态、文本与真实产物路径。",
    "恢复时复用已经保存的请求内容，成功阶段不会重复提交，终态也不能被陈旧执行逆转。",
    "这是一份完整的最终答案，已经覆盖职责边界、状态恢复、错误策略和产物落地规则。"
  ].join("\n\n");
  assert.ok(reply.length > 220);

  assert.equal(context.isInterimAssistantText(reply), false);
  assert.equal(context.hasUsableAssistantText(reply, "old reply"), true);

  const incidentReport = [
    "The incident review is complete and all corrective actions have been verified.",
    "The connection lost event was caused by an expired upstream route, and the service recovered after the route table was refreshed.",
    "No Router stage was duplicated. Persisted request ids and terminal guards prevented a stale continuation from replaying completed work.",
    "Monitoring now distinguishes historical incident language from a live interruption banner, and the final report is ready for handoff.",
    "This is the complete final answer, including cause, impact, recovery, validation, and prevention work."
  ].join("\n\n");
  assert.ok(incidentReport.length > 220);
  assert.equal(context.isInterimAssistantText(incidentReport), false);
  assert.equal(context.hasUsableAssistantText(incidentReport, "old reply"), true);
});

test("content script parses ChatGPT thought duration from assistant chrome", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.parseThoughtDurationMs("Thought for 1m 14s\n\nfinal answer"), 74000);
  assert.equal(context.parseThoughtDurationMs("\u5df2\u601d\u8003 48 \u79d2\n\n\u6700\u7ec8\u56de\u7b54"), 48000);
  assert.equal(context.cleanChatGptReplyText("Thought for 1m 14s\n\nfinal answer"), "final answer");
});

test("content script uploads sync job input artifacts before sending to ChatGPT", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "codex-notes.txt",
    innerText: "codex-notes.txt",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_notes/raw");
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/plain" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("notes created by Codex", "utf8");
      }
    };
  };

  const uploaded = await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_notes",
        filename: "codex-notes.txt",
        contentType: "text/plain",
        downloadUrl: "/api/artifacts/artifact_notes/download"
      }
    ]
  });

  assert.equal(uploaded.length, 1);
  assert.equal(input.files[0].name, "codex-notes.txt");
  assert.equal(input.files[0].type, "text/plain");
  assert.deepEqual(changed, ["change"]);
});

test("content script never fetches download URLs as ChatGPT upload attachments", async () => {
  const context = await loadContentScriptContext();
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
    assert.doesNotMatch(String(url), /\/download$/);
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };

  await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        uploadUrl: "/api/artifacts/artifact_zip/download",
        downloadUrl: "/api/artifacts/artifact_zip/download"
      }
    ]
  });

  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
});

test("content script retries transient local artifact fetch failures before upload", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  let fetchAttempts = 0;
  context.fetch = async (url) => {
    fetchAttempts += 1;
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
    if (fetchAttempts === 1) {
      throw new TypeError("Failed to fetch");
    }
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };
  context.sleep = async () => {};

  const uploaded = await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        downloadUrl: "/api/artifacts/artifact_zip/download"
      }
    ]
  });

  assert.equal(fetchAttempts, 2);
  assert.equal(uploaded.length, 1);
  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
  assert.equal(input.files[0].type, "application/zip");
  assert.deepEqual(changed, ["change"]);
});

test("content script uses the internal upload URL instead of the user download URL for input artifacts", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  let fetchedUrl = "";
  context.fetch = async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };

  await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        downloadUrl: "/api/artifacts/artifact_zip/download",
        uploadUrl: "/api/artifacts/artifact_zip/raw"
      }
    ]
  });

  assert.equal(fetchedUrl, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
  assert.deepEqual(changed, ["change"]);
});

test("content script rejects an input artifact upload when ChatGPT shows no attachment", async () => {
  const context = await loadContentScriptContext();
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = () => [];
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });
  context.sleep = async () => {};

  await assert.rejects(
    () =>
      context.uploadInputArtifacts(
        {
          inputArtifacts: [
            {
              id: "artifact_image",
              filename: "github-repo-screenshot.png",
              contentType: "image/png",
              downloadUrl: "/api/artifacts/artifact_image/download"
            }
          ]
        },
        { attachmentTimeoutMs: 1 }
      ),
    /(?:ChatGPT attachment did not appear|GPT \u9644\u4ef6\u6ca1\u6709\u51fa\u73b0\u5728\u8f93\u5165\u6846)/
  );
});

test("content script accepts an image input artifact after a visible upload preview appears", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "IMG",
    textContent: "",
    getAttribute(name) {
      if (name === "alt") return "github-repo-screenshot.png";
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 80 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("img")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });
  context.sleep = async () => {};

  const uploaded = await context.uploadInputArtifacts(
    {
      inputArtifacts: [
        {
          id: "artifact_image",
          filename: "github-repo-screenshot.png",
          contentType: "image/png",
          downloadUrl: "/api/artifacts/artifact_image/download"
        }
      ]
    },
    { attachmentTimeoutMs: 1 }
  );

  assert.equal(uploaded.length, 1);
  assert.deepEqual(changed, ["change"]);
});

for(const scenario of ['avatar','one_preview_for_two','duplicate_preview','two_previews','named_other_file','named_duplicate','mixed_previews','same_name_missing','same_name_two']){
  test(`image upload evidence is scoped and counted: ${scenario}`,async()=>{
    const c=await loadContentScriptContext();
    const form={};const composer={closest:()=>form};
    const image=(src,label='',inside=true)=>({tagName:'IMG',textContent:'',getAttribute:n=>n==='src'?src:n==='alt'?label:null,parentElement:inside?form:null,closest:()=>null,getClientRects:()=>[{}]});
    c.findComposer=()=>composer;c.findFileInput=()=>null;
    const a=image('blob:first'),b=image('blob:second');
    const previews=scenario==='avatar'?[image('https://example.com/avatar.png','',false)]
      :scenario==='duplicate_preview'?[a,image('blob:first')]
      :scenario==='two_previews'?[a,b]
      :scenario==='named_duplicate'?[image('blob:first','a.png'),a]
      :scenario==='mixed_previews'?[image('blob:first','a.png'),b]
      :scenario==='same_name_missing'?[image('blob:first','a.png')]
      :scenario==='same_name_two'?[image('blob:first','a.png'),image('blob:second','a.png')]
      :scenario==='named_other_file'?[image('blob:first','a.png')]:[a];
    c.uploadPreviewElements=()=>previews;
    c.assertNoChatGptBlocker=()=>{};
    c.installAssistantActivityObserver=()=>false;
    let now=0;c.Date=class extends Date{static now(){return now;}};
    c.waitForAssistantActivity=async()=>{now+=10;return false;};
    const artifacts=[{filename:'a.png',contentType:'image/png'},{filename:'b.png',contentType:'image/png'}];
    if(scenario.startsWith('same_name'))artifacts[1].filename='a.png';
    if(['two_previews','mixed_previews','same_name_two'].includes(scenario))await c.waitForInputArtifactsVisible(artifacts,5);
    else await assert.rejects(c.waitForInputArtifactsVisible(artifacts,5),/附件没有出现/);
  });
}

test('attachment filename evidence rejects suffixes and prefix collisions',async()=>{
  const c=await loadContentScriptContext();
  const artifact={filename:'report.csv',contentType:'text/csv'};
  const preview=text=>({tagName:'DIV',textContent:text,getAttribute:()=>null});
  assert.equal(c.inputArtifactAppearsUploaded(artifact,[preview('old-report.csv')]),false);
  assert.equal(c.inputArtifactAppearsUploaded(artifact,[preview('report.csv.bak')]),false);
  assert.equal(c.inputArtifactAppearsUploaded(artifact,[preview('删除 report.csv')]),true);
});

test('attachment candidates exclude ancestors aggregating draft or historical filenames',async()=>{
  const c=await loadContentScriptContext();const composer={};
  const node=()=>({tagName:'DIV',textContent:'a.png b.png',getClientRects:()=>[{}],closest:()=>null});
  const draftParent={...node(),contains:x=>x===composer};
  const historyParent={...node(),querySelector:()=>({})};
  const preview=node();
  c.findComposer=()=>composer;c.document.querySelectorAll=()=>[draftParent,historyParent,preview];
  const candidates=c.uploadPreviewElements();
  assert.equal(candidates.length,1);assert.equal(candidates[0],preview);
});

test("attachment confirmation reuses one preview snapshot for every input artifact", async () => {
  const context = await loadContentScriptContext();
  let previewScans = 0;
  const preview = (filename) => ({
    tagName: "DIV",
    textContent: filename,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 40 }];
    },
    closest() {
      return null;
    }
  });
  const previews = [preview("chapter-outline.docx"), preview("cover-reference.png")];

  context.document.body = { innerText: "a normal bound conversation" };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "img,[data-testid],[aria-label],[title],a,button,div,span,p") {
      previewScans += 1;
      return previews;
    }
    return [];
  };

  await context.waitForInputArtifactsVisible([
    { id: "artifact_outline", filename: "chapter-outline.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { id: "artifact_cover", filename: "cover-reference.png", contentType: "image/png" }
  ], 1_000);

  assert.equal(previewScans, 1);
});

test("attachment preview scanning resolves the composer once for all candidates", async () => {
  const context = await loadContentScriptContext();
  let composerQueries = 0;
  const composer = {
    contains() {
      return false;
    }
  };
  const candidates = Array.from({ length: 4 }, (_, index) => ({
    tagName: "DIV",
    textContent: `attachment-${index}.txt`,
    getClientRects() {
      return [{ width: 120, height: 40 }];
    },
    closest() {
      return null;
    }
  }));

  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      composerQueries += 1;
      return composer;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) =>
    selector === "img,[data-testid],[aria-label],[title],a,button,div,span,p" ? candidates : [];

  assert.equal(context.uploadPreviewElements().length, candidates.length);
  assert.equal(composerQueries, 1);
});

test("attachment waiting skips preview and blocker rescans until the page changes", async () => {
  const context = await loadContentScriptContext();
  let previewVisible = false;
  let activityWaits = 0;
  let fullPageReads = 0;
  let previewScans = 0;
  const preview = {
    tagName: "DIV",
    textContent: "chapter-outline.docx",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 40 }];
    },
    closest() {
      return null;
    }
  };
  const activityWake = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      return false;
    }
    if (activityWaits === 2) {
      previewVisible = true;
      return true;
    }
    throw new Error("attachment wait did not react to the page change");
  };

  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    observe() {}
  };
  context.sleep = activityWake;
  context.waitForAssistantActivity = activityWake;
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "a normal bound conversation";
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "img,[data-testid],[aria-label],[title],a,button,div,span,p") {
      previewScans += 1;
      return previewVisible ? [preview] : [];
    }
    return [];
  };

  await context.waitForInputArtifactsVisible([
    { id: "artifact_outline", filename: "chapter-outline.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
  ], 2_000);

  assert.equal(activityWaits, 2);
  assert.equal(fullPageReads, 2);
  assert.equal(previewScans, 2);
});

test("attachment waiting keeps polling blockers when DOM observation is unavailable", async () => {
  const context = await loadContentScriptContext();
  let pageBlocked = false;
  let sleepCalls = 0;
  let fullPageReads = 0;
  let previewScans = 0;

  context.sleep = async () => {
    sleepCalls += 1;
    pageBlocked = true;
  };
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return pageBlocked ? "Cloudflare: verify you are human" : "a normal bound conversation";
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "img,[data-testid],[aria-label],[title],a,button,div,span,p") {
      previewScans += 1;
    }
    return [];
  };

  await assert.rejects(
    () => context.waitForInputArtifactsVisible([
      { id: "artifact_outline", filename: "chapter-outline.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }
    ], 2_000),
    (error) => error?.errorCode === "human_verification"
  );
  assert.equal(sleepCalls, 1);
  assert.equal(fullPageReads, 2);
  assert.equal(previewScans, 1);
});

test("content script classifies ChatGPT blocker pages before sending", async () => {
  const context = await loadContentScriptContext();
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE 闂傚倸鍊搁幊蹇涘礉濡ゅ懏锟?闂備礁鎼ˇ顐﹀礈濠靛锟?"
  };
  assert.equal(context.detectChatGptBlocker()?.code, "human_verification");

  context.document.body = {
    innerText: "This content is not available or could not be found."
  };
  assert.equal(context.detectChatGptBlocker()?.code, "conversation_unavailable");

  context.document.body = {
    innerText: "chatgpt.com 宸茶灞忚斀 姝ら〉闈㈠凡锟?Chrome 灞忚斀 ERR_BLOCKED_BY_CLIENT"
  };
  const clientBlocked = context.detectChatGptBlocker();
  assert.equal(clientBlocked?.code, "client_blocked");
  assert.equal(clientBlocked?.recoveryAction, "disable_client_blocker");

  const normalComposer = {
    tagName: "TEXTAREA",
    value: "",
    getClientRects() {
      return [{ width: 400, height: 80 }];
    }
  };
  context.document.body = {
    innerText:
      "鍘嗗彶娑堟伅锛歝hatgpt.com 宸茶灞忚斀 姝ら〉闈㈠凡锟?Chrome 灞忚斀 ERR_BLOCKED_BY_CLIENT銆傝鍏抽棴鎷︽埅 chatgpt.com 鐨勬墿灞曟垨鍔犲叆鐧藉悕鍗曞悗锛屽彧鍒锋柊缁戝畾浼氳瘽?"
  };
  context.document.querySelector = (selector) => {
    if (selector === "textarea" || selector === "[contenteditable='true']" || selector === "[contenteditable=\"true\"]") {
      return normalComposer;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "textarea, [contenteditable='true'], [contenteditable=\"true\"]") {
      return [normalComposer];
    }
    return [];
  };
  assert.equal(context.detectChatGptBlocker(), null);

  context.document.body = {
    innerText: "Something went wrong while generating the response. If this issue persists please contact us."
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);
  assert.equal(context.detectChatGptBlocker({ includeGenerationFailure: true })?.code, "generation_failed");

  context.document.body = {
    innerText: "Welcome back. Select an account to continue. Log in to another account. Create account."
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker()?.code, "account_selection");

  const composer = {
    tagName: "TEXTAREA",
    value: "",
    getClientRects() {
      return [{ width: 400, height: 80 }];
    }
  };
  context.document.body = {
    innerText: "Composer is visible. Welcome back copy should not block a ready page."
  };
  context.document.querySelector = (selector) => (selector === "#prompt-textarea" ? composer : null);
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);

  const accountDialog = {
    innerText: "Welcome back. Select an account to continue.",
    textContent: "Welcome back. Select an account to continue.",
    getClientRects() {
      return [{ width: 400, height: 280 }];
    }
  };
  context.document.querySelectorAll = (selector) =>
    selector.includes("[role='dialog']") || selector.includes('[role="dialog"]') ? [accountDialog] : [];
  assert.equal(context.detectChatGptBlocker()?.code, "account_selection");

  context.document.body = {
    innerText: "This content is not available or could not be found."
  };
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);

  context.document.querySelector = () => null;
  assert.equal(context.detectChatGptBlocker()?.code, "conversation_unavailable");

  context.document.body = {
    innerText: "This is a normal Steam desktop shortcut analysis, not an account-selection blocker."
  };
  assert.equal(context.detectChatGptBlocker(), null);
});

for (const failureText of ["Something went wrong while generating the response.", "消息流中的错误", "Error in message stream. Try again"]) test(`generation failure stays scoped to the current reply: ${failureText}`, async () => {
  const context = await loadContentScriptContext();
  const oldUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("闂佸搫鍞查崒娑樺簥??")]);
  const oldAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeText(failureText)
  ]);
  const currentUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("current prompt")]);
  const currentAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [fakeText("current answer")]);
  const turns = [
    fakeElement("section", { "data-testid": "conversation-turn-1" }, [oldUser]),
    fakeElement("section", { "data-testid": "conversation-turn-2" }, [oldAssistant]),
    fakeElement("section", { "data-testid": "conversation-turn-3" }, [currentUser]),
    fakeElement("section", { "data-testid": "conversation-turn-4" }, [currentAssistant])
  ];
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return turns;
    }
    return [];
  };
  context.document.body = {
    innerText: turns.map((turn) => turn.innerText).join("\n")
  };

  assert.equal(context.detectChatGptBlocker({ afterUserText: "current prompt" }), null);

  const failedUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("failed prompt")]);
  const failedAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeText(failureText)
  ]);
  const failedTurns = [
    fakeElement("section", { "data-testid": "conversation-turn-5" }, [failedUser]),
    fakeElement("section", { "data-testid": "conversation-turn-6" }, [failedAssistant])
  ];
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return failedTurns;
    }
    return [];
  };
  context.document.body = {
    innerText: failedTurns.map((turn) => turn.innerText).join("\n")
  };

  assert.equal(context.detectChatGptBlocker({ afterUserText: "failed prompt" })?.code, "generation_failed");
});

test("content script refuses to send a Bridge job from the ChatGPT start page", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/";
  context.document.body = {
    innerText: "Where should we begin? Ask anything."
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_wrong_page",
        payloadText: "ask GPT something"
      }),
    /start page|new chat|wrong page|\u65b0\u804a\u5929\u9996\u9875/i
  );
});

test("content script refuses to send when ChatGPT shows an account chooser over the composer", async () => {
  const context = await loadContentScriptContext();
  let clickedSend = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.document.body = {
    innerText: "Welcome back. zhe wang. Select an account to continue.",
    textContent: "Welcome back. zhe wang. Select an account to continue."
  };
  const accountDialog = {
    innerText: "Welcome back. zhe wang. Select an account to continue.",
    textContent: "Welcome back. zhe wang. Select an account to continue.",
    getClientRects() {
      return [{ width: 400, height: 280 }];
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector.includes("[role='dialog']") || selector.includes('[role="dialog"]')) return [accountDialog];
    return [];
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_account_blocker",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "Please analyze the file."
      }),
    /\u8d26\u53f7|account/i
  );
  assert.equal(clickedSend, false);
});

test("content script completes a visible reply even if an account chooser appears after sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "This is a Steam desktop shortcut icon." : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "What is this?",
    innerText: "What is this?",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/project/demo/c/abc";
  context.document.body = {
    get innerText() {
      return sent ? "Welcome back. zhe wang. Select an account to continue." : "";
    },
    get textContent() {
      return this.innerText;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.sleep = async () => {};
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  await context.processJob({
    id: "sync_visible_reply_with_account_prompt",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "What is this?"
  });

  assert.equal(sent, true, JSON.stringify({
    bridgeCalls: bridgeCalls.map((call) => call.path),
    composerValue: composer.value
  }));
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_visible_reply_with_account_prompt/sent",
      "/api/sync/jobs/sync_visible_reply_with_account_prompt/complete"
    ]
  );
  assert.equal(bridgeCalls.at(-1).body.replyText, "This is a Steam desktop shortcut icon.");
});

test("content script completes preference sync jobs without sending a prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let clickedSend = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.location.href = "https://chatgpt.com/project/demo/c/abc";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [sendButton] : []);
  context.sleep = async () => {};
  context.fetch = async (url, options = {}) => {
    bridgeCalls.push({
      path: new URL(url).pathname,
      body: options.body ? JSON.parse(options.body) : null
    });
    return {
      ok: true,
      json: async () => ({})
    };
  };

  await context.processJob({
    id: "sync_preferences",
    kind: "preference_sync",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "Bridge preference sync"
  });

  assert.equal(clickedSend, false);
  assert.equal(composer.value, "");
  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/sync/jobs/sync_preferences/complete"]);
  assert.equal(bridgeCalls[0].body.replyText, "GPT 偏好已同步");
});

test("content script refreshes a loading ChatGPT shell before sending", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 70_000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.location.reload = () => {
    reloaded = true;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.document.title = "Please wait";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];

  await context.processJob({
    id: "sync_loading_shell",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Please analyze the file."
  });

  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_loading_shell");
});

test("content script refreshes instead of sending when an input artifact never appears", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let clickedSend = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 70_000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const fileInput = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.location.reload = () => {
    reloaded = true;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'input[type="file"]') return fileInput;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });

  await context.processJob({
    id: "sync_missing_attachment",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Please analyze the image.",
    inputArtifacts: [
      {
        id: "artifact_image",
        filename: "github-repo-screenshot.png",
        contentType: "image/png",
        downloadUrl: "/api/artifacts/artifact_image/download"
      }
    ]
  });

  assert.equal(clickedSend, false);
  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_missing_attachment");
});

test("content script fails fast when ChatGPT shows a generation error", async () => {
  const context = await loadContentScriptContext();
  const prompt = "please inspect this file";
  const userTurn = fakeElement("section", { "data-testid": "conversation-turn-error-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);
  const assistantTurn = fakeElement("section", { "data-testid": "conversation-turn-error-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [
      fakeText("Something went wrong while generating the response. If this issue persists please contact us.")
    ])
  ]);
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return [userTurn, assistantTurn];
    }
    return [];
  };
  context.document.body = {
    innerText: "Something went wrong while generating the response. If this issue persists please contact us."
  };

  await assert.rejects(
    () => context.waitForAssistantReply("old answer", { afterUserText: prompt }),
    (error) => error?.errorCode === "generation_failed"
  );
});

test("content script does not rebuild full Markdown while GPT is still streaming", async () => {
  const context = await loadContentScriptContext();
  const assistantMessage = {
    textContent: "A long response is still streaming.",
    childNodes: [],
    matches() {
      return true;
    },
    querySelectorAll() {
      return [];
    }
  };
  let streaming = true;
  let fullReplyExtractions = 0;

  context.assistantTurnsAfterTurnIndex = () => [assistantMessage];
  context.isGenerating = () => streaming;
  context.extractAssistantReplyText = () => {
    fullReplyExtractions += 1;
    return "A long response is complete.";
  };
  context.hasUsableAssistantContent = () => true;
  context.visibleReplyTextFromAssistant = () => {
    fullReplyExtractions += 1;
    return "A long response is complete.";
  };
  context.uniqueGeneratedImageCount = () => 0;
  context.hasDownloadableArtifact = () => false;
  context.effectiveStableTarget = () => 1;
  context.shouldAcceptStableTextDuringGlobalGeneration = () => false;
  context.sleep = async () => {
    streaming = false;
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserTurnIndex: 0
  });

  assert.equal(reply, "A long response is complete.");
  assert.equal(
    fullReplyExtractions,
    2,
    "full reply extraction should run only after streaming has stopped"
  );
});

test("content script fails fast when ChatGPT shows the short generic generation error", async () => {
  const context = await loadContentScriptContext();
  const prompt = "create a downloadable docx";
  const userTurn = fakeElement("section", { "data-testid": "conversation-turn-short-error-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);
  const assistantTurn = fakeElement("section", { "data-testid": "conversation-turn-short-error-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [
      fakeText("Hmm...something seems to have gone wrong.")
    ])
  ]);
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      return [userTurn, assistantTurn];
    }
    return [];
  };
  context.document.body = {
    innerText: "Hmm...something seems to have gone wrong."
  };

  await assert.rejects(
    () => context.waitForAssistantReply("old answer", { afterUserText: prompt }),
    (error) => error?.errorCode === "generation_failed"
  );
});

test("content script does not treat the normal ChatGPT footer disclaimer as a generation error", async () => {
  const context = await loadContentScriptContext();
  context.document.body = {
    innerText: "ChatGPT 婵炴垶姊婚崰搴ゃ亹閺屻儲鍤勯柟瀛樺笧缁愭鏌ｅ鍡楃仸闁轰礁锕俊鎾磼濠垫劕娈查梺鍝勭Т閹诧繝鎮￠敓鐘崇厒鐎广儱鐗滃ú锝吳庨崶锝呭⒉濞寸厧鎳橀弫?",
    textContent: "ChatGPT 婵炴垶姊婚崰搴ゃ亹閺屻儲鍤勯柟瀛樺笧缁愭鏌ｅ鍡楃仸闁轰礁锕俊鎾磼濠垫劕娈查梺鍝勭Т閹诧繝鎮￠敓鐘崇厒鐎广儱鐗滃ú锝吳庨崶锝呭⒉濞寸厧鎳橀弫?"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };

  assert.equal(context.detectChatGptBlocker(), null);
});

test("content script maps Bridge mode and model preferences separately", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.modeLabelForPreference("balanced"), "中");
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.6-sol"), "极速 5.5");
  assert.equal(context.modeLabelForPreference("gpt-5.5"), null);
  assert.equal(context.modelLabelForPreference("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(context.modelLabelForPreference("gpt-5.5"), "GPT-5.5");
  assert.equal(context.modelLabelForPreference("o3"), "o3");
  assert.equal(context.modelLabelForPreference("gpt-4.5"), null);
  assert.equal(context.modelLabelForPreference("balanced"), null);
  assert.equal(context.modelLabelForPreference("unknown-model"), null);
});

test("content script keeps the actual mode set for every supported model", async () => {
  const context = await loadContentScriptContext();

  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.6-sol")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.5")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.4")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.3")), ["fast"]);
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.5"), "极速");
  assert.equal(context.modeLabelForPreference("pro", "gpt-5.5"), "Pro 深度模式");
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.6-sol"), "极速 5.5");
  assert.equal(context.modeLabelForPreference("pro", "gpt-5.6-sol"), "Pro");
  assert.deepEqual(Array.from(context.modelLabelsForPreference("gpt-5.5")), ["GPT-5.5", "5.5"]);
  assert.deepEqual(Array.from(context.modelLabelsForPreference("gpt-5.6-sol")), ["GPT-5.6 Sol", "5.6 Sol"]);
});

test("content script chooses the model menu instead of the mode menu", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const modeButton = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 80, height: 32 }];
    },
    click() {
      clicked.push("mode");
    }
  };
  const modelButton = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("model");
      menuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("option");
      modelButton.textContent = context.modelLabelForPreference("gpt-5.4");
      modelButton.innerText = context.modelLabelForPreference("gpt-5.4");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton, modelButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, modelButton, modelOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked, ["model", "option"]);
});

test("content script chooses a model from the combined ChatGPT mode menu", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      sharedButton.textContent = context.modelLabelForPreference("gpt-5.3");
      sharedButton.innerText = context.modelLabelForPreference("gpt-5.3");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, modelOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.3" }), true);
  assert.deepEqual(clicked, ["shared", "model-option"]);
});

test("content script opens ChatGPT preference menus with pointer events", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      clicked.push(event.type);
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("click");
    }
  };
  const modeOption = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`option:${event.type}`);
      return true;
    },
    click() {
      clicked.push("mode-option");
      sharedButton.textContent = context.modeLabelForPreference("advanced");
      sharedButton.innerText = context.modeLabelForPreference("advanced");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, modeOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "advanced" }), true);
  assert.ok(clicked.includes("pointerdown"));
  assert.ok(clicked.includes("mode-option"));
});

test("content script switches mode through ChatGPT combined model and mode control", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("combined");
      menuOpen = true;
    }
  };
  const fastOption = {
    tagName: "BUTTON",
    textContent: "极速",
    innerText: "极速",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("fast-option");
      combinedButton.textContent = "5.5 极速";
      combinedButton.innerText = "5.5 极速";
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [combinedButton, fastOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(
    await context.selectModePreference({ modePreference: "fast", modelPreference: "gpt-5.5" }),
    true
  );
  assert.deepEqual(clicked, ["combined", "fast-option"]);
});

test("content script prefers the composer combined control over the sidebar Pro account", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const accountButton = {
    tagName: "BUTTON",
    textContent: "wangzhe Pro",
    innerText: "wangzhe Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 180, height: 56 }];
    },
    click() {
      clicked.push("account");
    }
  };
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("combined");
      menuOpen = true;
    }
  };
  const highOption = {
    tagName: "BUTTON",
    textContent: "高",
    innerText: "高",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("high-option");
      combinedButton.textContent = "5.5高";
      combinedButton.innerText = "5.5高";
    }
  };
  const composerScope = {
    querySelectorAll(selector) {
      return selector === "button,[role='button']" ? [combinedButton] : [];
    }
  };
  const composer = {
    closest(selector) {
      return selector === '[data-testid*="composer"]' ? composerScope : null;
    },
    parentElement: null
  };

  context.document.querySelector = (selector) => selector === "#prompt-textarea" ? composer : null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [accountButton, combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [accountButton, combinedButton, highOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(
    await context.selectModePreference({ modePreference: "advanced", modelPreference: "gpt-5.5" }),
    true
  );
  assert.deepEqual(clicked, ["combined", "high-option"]);
  assert.equal(context.textContainsPreferenceLabel("极高", "高"), false);
});

test("content script chooses the actual menu item instead of a wrapper div", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      menuOpen = true;
      clicked.push("shared");
    }
  };
  const wrapperDiv = {
    tagName: "DIV",
    textContent: `${context.modeLabelForPreference("fast")} ${context.modeLabelForPreference("balanced")} ${context.modeLabelForPreference("advanced")} ${context.modeLabelForPreference("high")}`,
    innerText: `${context.modeLabelForPreference("fast")} ${context.modeLabelForPreference("balanced")} ${context.modeLabelForPreference("advanced")} ${context.modeLabelForPreference("high")}`,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 180, height: 220 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`wrapper:${event.type}`);
      return true;
    },
    click() {
      clicked.push("wrapper");
    }
  };
  const balancedOption = {
    tagName: "DIV",
    textContent: context.modeLabelForPreference("balanced"),
    innerText: context.modeLabelForPreference("balanced"),
    getAttribute(name) {
      return name === "role" ? "menuitem" : null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 160, height: 36 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`option:${event.type}`);
      return true;
    },
    click() {
      clicked.push("balanced-option");
      sharedButton.textContent = context.modeLabelForPreference("balanced");
      sharedButton.innerText = context.modeLabelForPreference("balanced");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, wrapperDiv, balancedOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.ok(clicked.includes("balanced-option"));
  assert.equal(clicked.includes("wrapper"), false);
});

test("content script verifies mode selection and retries when ChatGPT does not apply it immediately", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let optionClicks = 0;
  const targetLabel = context.modeLabelForPreference("balanced");
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const targetOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      optionClicks += 1;
      clicked.push(`option:${optionClicks}`);
      menuOpen = false;
      if (optionClicks >= 2) {
        modeButton.textContent = targetLabel;
        modeButton.innerText = targetLabel;
      }
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, targetOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.deepEqual(clicked.filter((entry) => entry.startsWith("option:")), ["option:1", "option:2"]);
});

test("content script selects the GPT-5.4 professional mode label from ChatGPT", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const targetLabel = "\u4e13\u4e1a";
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const professionalOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("professional-option");
      modeButton.textContent = targetLabel;
      modeButton.innerText = targetLabel;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, professionalOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "pro", modelPreference: "gpt-5.4" }), true);
  assert.ok(clicked.includes("professional-option"));
});

test("content script keeps preference polling responsive and reports preference freshness", async () => {
  const source = await readFile("chrome-extension/content-script.js", "utf8");

  assert.match(source, /const POLL_MS = 1500;/);
  assert.match(source, /function bridgeClientId\(\)/);
  assert.match(source, /updatedAt: preferences\.updatedAt \|\| null/);
});

test("content script uses a stable per-tab worker id so ChatGPT tabs do not overwrite each other", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  };

  const first = context.currentWorkerId();
  const second = context.currentWorkerId();

  assert.equal(first, second);
  assert.match(first, /v20260923-missing-recovery:runtime-missing:tab_/);
  assert.equal(storage.size, 1);
});

test("content script reloads the current ChatGPT page once after extension reload is requested", async () => {
  const context = await loadContentScriptContext();
  const runtimeMessages = [];
  const scheduled = [];
  const storage = new Map();
  let pageReloads = 0;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  };
  context.chrome = {
    runtime: {
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        callback({ok:true});
      }
    }
  };
  context.location = {
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      pageReloads += 1;
    }
  };
  context.setTimeout = (callback, ms) => {
    scheduled.push({ callback, ms });
    return scheduled.length;
  };

  assert.equal(context.maybeReloadExtensionFromHeartbeat({
    reloadExtension: true,
    expectedExtensionVersion: "v20260923-missing-recovery"
  }), true);
  assert.equal(context.maybeReloadExtensionFromHeartbeat({
    reloadExtension: true,
    expectedExtensionVersion: "v20260923-missing-recovery"
  }), true);

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:reloadExtension",
      expectedVersion: "v20260923-missing-recovery"
    }
  ]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 750);
  scheduled[0].callback();
  assert.equal(pageReloads, 1);
});

test("refresh guard does not reload a new extension to satisfy an older backend",async()=>{
  const c=await loadContentScriptContext();let reloads=0;
  c.chrome={runtime:{sendMessage(){reloads++;}}};
  c.sessionStorage={getItem:()=>null,setItem(){}};
  c.setTimeout=()=>{reloads++;};
  assert.equal(c.maybeReloadExtensionFromHeartbeat({reloadExtension:true,expectedExtensionVersion:"v20260920-brand-diagnostics"}),true);
  assert.equal(reloads,0);
});

test("refresh guard does not loop forever when reload keeps the same client and expected build",async()=>{
  const c=await loadContentScriptContext();const storage=new Map();let reloads=0,now=100000;
  c.Date=class extends Date{static now(){return now;}};
  c.chrome={runtime:{sendMessage(_payload,callback){reloads++;callback({ok:true});}}};c.setTimeout=()=>{};
  c.sessionStorage={getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)};
  const heartbeat={reloadExtension:true,expectedExtensionVersion:"v20990101-forward"};
  assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat),true);now+=120000;
  assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat),true);
  assert.equal(reloads,1);
});

for (const failure of ["throw", "promise_reject", "callback_error", "negative_ack", "no_response"]) {
  test(`reload recovery retries a failed ${failure} handoff without claiming work`, async () => {
    const c = await loadContentScriptContext();
    const storage = new Map();
    const scheduled = [];
    let now = 100000, calls = 0, pageReloads = 0;
    c.Date = class extends Date { static now() { return now; } };
    c.sessionStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
    c.location = { reload() { pageReloads++; } };
    c.setTimeout = (callback, ms) => { scheduled.push({callback, ms}); return scheduled.length; };
    c.chrome = { runtime: { sendMessage(_payload, callback) {
      calls++;
      if (calls > 1) { callback?.({ok:true}); return; }
      if (failure === "throw") throw new Error("runtime temporarily unavailable");
      if (failure === "promise_reject") return { then(_resolve, reject) { reject(new Error("channel closed")); } };
      if (failure === "callback_error") {
        c.chrome.runtime.lastError = {message:"channel closed"};
        callback?.(undefined);
        c.chrome.runtime.lastError = null;
      }
      if (failure === "negative_ack") callback?.({ok:false});
    } } };
    const heartbeat = {reloadExtension:true, expectedExtensionVersion:"v20990101-forward"};
    assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true, "mismatched workers must stay paused even on handoff failure");
    assert.equal(scheduled.length, 0, "no page refresh before a positive background acknowledgement");
    now += 1000;
    assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true);
    assert.equal(calls, 1, "failure retries must respect cooldown");
    now += 120000;
    assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true);
    assert.equal(calls, 2, "a recovered runtime must get another handoff attempt");
    assert.equal(scheduled.length, 1);
    scheduled[0].callback();
    assert.equal(pageReloads, 1);
    now += 120000;
    c.maybeReloadExtensionFromHeartbeat(heartbeat);
    assert.equal(calls, 2, "a confirmed reload must not loop on unchanged builds");
  });
}

test("reload recovery stays paused while the extension runtime is unavailable", async () => {
  const c = await loadContentScriptContext();
  c.chrome = {};
  assert.equal(c.maybeReloadExtensionFromHeartbeat({reloadExtension:true, expectedExtensionVersion:"v20990101-forward"}), true);
});

test("reload recovery ignores late acknowledgements from an expired handoff", async () => {
  const c = await loadContentScriptContext();
  const storage = new Map(), callbacks = [], scheduled = [];
  let now = 100000;
  c.Date = class extends Date { static now() { return now; } };
  c.sessionStorage = {getItem:key=>storage.get(key), setItem:(key,value)=>storage.set(key,value)};
  c.chrome = {runtime:{sendMessage(_payload, callback) { callbacks.push(callback); }}};
  c.location = {reload() {}};
  c.setTimeout = callback => scheduled.push(callback);
  const heartbeat = {reloadExtension:true, expectedExtensionVersion:"v20990101-forward"};
  c.maybeReloadExtensionFromHeartbeat(heartbeat);
  now += 120000;
  c.maybeReloadExtensionFromHeartbeat(heartbeat);
  callbacks[0]({ok:true});
  assert.equal(scheduled.length, 0);
  callbacks[1]({ok:true});
  callbacks[1]({ok:true});
  assert.equal(scheduled.length, 1, "only the current handoff may refresh once");
});

test("reload recovery retains cooldown and confirmed handoff when storage is unavailable", async () => {
  const c = await loadContentScriptContext();
  let now = 100000, calls = 0;
  c.Date = class extends Date { static now() { return now; } };
  c.sessionStorage = {getItem(){throw new Error("storage blocked");}, setItem(){throw new Error("storage blocked");}};
  c.chrome = {runtime:{sendMessage() { calls++; return Promise.resolve({ok:true}); }}};
  c.setTimeout = () => {};
  const heartbeat = {reloadExtension:true, expectedExtensionVersion:"v20990101-forward"};
  assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true);
  assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true);
  await Promise.resolve();
  now += 120000;
  assert.equal(c.maybeReloadExtensionFromHeartbeat(heartbeat), true);
  assert.equal(calls, 1);
});

test("content script retries when the ChatGPT preference menu is not ready yet", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let openAttempts = 0;
  const targetLabel = context.modeLabelForPreference("balanced");
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        openAttempts += 1;
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const targetOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen && openAttempts >= 2 ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("option");
      modeButton.textContent = targetLabel;
      modeButton.innerText = targetLabel;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, targetOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.equal(openAttempts >= 2, true);
  assert.ok(clicked.includes("option"));
});

test("content script dismisses an open preference menu when the target option is unavailable", async () => {
  const context = await loadContentScriptContext();
  let menuOpen = false;
  const escapeEvents = [];
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent() {
      menuOpen = true;
      return true;
    },
    click() {
      menuOpen = true;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton];
    return [];
  };
  context.document.dispatchEvent = (event) => {
    if (event.key === "Escape") {
      escapeEvents.push(event.type);
      menuOpen = false;
    }
    return true;
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  context.MouseEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  context.KeyboardEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), false);
  assert.equal(menuOpen, false);
  assert.deepEqual(escapeEvents.slice(-2), ["keydown", "keyup"]);
});

test("content script opens the ChatGPT model submenu before choosing a model", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let submenuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelSubmenu = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(event.type);
      submenuOpen = true;
    },
    click() {
      clicked.push("submenu");
      submenuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return submenuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      sharedButton.textContent = context.modelLabelForPreference("gpt-5.4");
      sharedButton.innerText = context.modelLabelForPreference("gpt-5.4");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [sharedButton, modelSubmenu, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked, ["shared", "mouseenter", "mousemove", "mousedown", "model-option"]);
});

test("content script accepts model selection when ChatGPT keeps the collapsed control mode-only", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let submenuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelSubmenu = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`submenu:${event.type}`);
      submenuOpen = true;
      return true;
    },
    click() {
      clicked.push("submenu");
      submenuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return submenuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      menuOpen = false;
      submenuOpen = false;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [sharedButton, modelSubmenu, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked.filter((entry) => entry === "model-option"), ["model-option"]);
});

test("content script does not choose retired GPT-4.5 model preferences", async () => {
  const context = await loadContentScriptContext();

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-4.5" }), false);
});

test("content script ignores old assistant model buttons when using composer preferences", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const oldTurn = {
    tagName: "SECTION",
    getAttribute(name) {
      return name === "data-testid" ? "conversation-turn-1" : null;
    }
  };
  const historicalModelButton = {
    tagName: "BUTTON",
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    parentElement: oldTurn,
    parentNode: oldTurn,
    getAttribute() {
      return null;
    },
    closest(selector) {
      return selector === '[data-testid^="conversation-turn-"]' ? oldTurn : null;
    },
    getClientRects() {
      return [{ width: 80, height: 30 }];
    },
    click() {
      clicked.push("historical");
    }
  };
  const composerForm = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [composerModeButton];
      return [];
    }
  };
  const composer = {
    closest(selector) {
      return selector === "form" ? composerForm : null;
    }
  };
  const composerModeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("composer-mode");
      menuOpen = true;
    }
  };
  const modelOption = {
    tagName: "BUTTON",
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      composerModeButton.textContent = context.modelLabelForPreference("gpt-5.3");
      composerModeButton.innerText = context.modelLabelForPreference("gpt-5.3");
    }
  };

  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [historicalModelButton, composerModeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [historicalModelButton, composerModeButton, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.3" }), true);
  assert.deepEqual(clicked, ["composer-mode", "model-option"]);
});

test("content script looks beyond the composer form for mode controls", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sendButton = {
    tagName: "BUTTON",
    textContent: "",
    innerText: "",
    getAttribute(name) {
      return name === "aria-label" ? "Send prompt" : null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [{ width: 32, height: 32 }];
    },
    click() {
      clicked.push("send");
    }
  };
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [{ width: 86, height: 32 }];
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const modeOption = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("balanced"),
    innerText: context.modeLabelForPreference("balanced"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 86, height: 32 }] : [];
    },
    click() {
      clicked.push("mode-option");
      modeButton.textContent = context.modeLabelForPreference("balanced");
      modeButton.innerText = context.modeLabelForPreference("balanced");
    }
  };
  const composerForm = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [sendButton];
      return [];
    }
  };
  const composerWrapper = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [sendButton, modeButton];
      return [];
    }
  };
  const composer = {
    closest(selector) {
      if (selector === "form") return composerForm;
      if (selector === '[data-testid*="composer"]') return composerWrapper;
      return null;
    }
  };

  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sendButton, modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, modeOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.deepEqual(clicked, ["mode", "mode-option"]);
});

test("content script treats ChatGPT fallback query parameters as the same bound conversation", async () => {
  const context = await loadContentScriptContext();
  let refreshed = false;
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat?mweb_fallback=1",
    replace() {
      refreshed = true;
    },
    reload() {
      refreshed = true;
    }
  };

  assert.equal(
    context.ensureExpectedChatGptPage({
      projectUrl: "https://chatgpt.com/c/bound-chat"
    }),
    true
  );
  assert.equal(refreshed, false);
});

test("content script extracts clean assistant text without ChatGPT chrome", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "ChatGPT \u8bf4\uff1a\u5df2\u601d\u8003 29sActual answer\n\u7f16\u8f91\n\u6765\u6e90",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.visibleReplyTextFromAssistant(message, "old answer"), "Actual answer");
});

test("content script preserves rendered markdown structure from assistant DOM", async () => {
  const context = await loadContentScriptContext();
  const table = fakeElement("table", {}, [
    fakeElement("tr", {}, [fakeElement("th", {}, [fakeText("Name")]), fakeElement("th", {}, [fakeText("Value")])]),
    fakeElement("tr", {}, [fakeElement("td", {}, [fakeText("Status")]), fakeElement("td", {}, [fakeText("OK")])])
  ]);
  const message = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeElement("h1", {}, [fakeText("Report")]),
    fakeElement("h2", {}, [fakeText("Checks")]),
    fakeElement("p", {}, [fakeText("Intro paragraph.")]),
    fakeElement("ul", {}, [fakeElement("li", {}, [fakeText("First bullet")])]),
    fakeElement("ol", {}, [fakeElement("li", {}, [fakeText("First step")])]),
    fakeElement("blockquote", {}, [fakeElement("p", {}, [fakeText("quoted line")])]),
    table,
    fakeElement("pre", {}, [fakeElement("code", { className: "language-js" }, [fakeText("console.log(\"ok\");")])])
  ]);

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.match(reply, /^# Report/m);
  assert.match(reply, /^## Checks/m);
  assert.match(reply, /^- First bullet/m);
  assert.match(reply, /^1\. First step/m);
  assert.match(reply, /^> quoted line/m);
  assert.match(reply, /\| Name \| Value \|/);
  assert.match(reply, /```js\nconsole\.log\("ok"\);\n```/);
});

test("content script returns raw single code block with line breaks", async () => {
  const context = await loadContentScriptContext();
  const code = "<!DOCTYPE html>\n<html>\n<head></head>\n<body>OK</body>\n</html>";
  const message = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeElement("pre", {}, [fakeElement("code", { className: "language-html" }, [fakeText(code)])])
  ]);

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.equal(reply, code);
  assert.equal(reply.split("\n").length, 5);
});

test("content script ignores disabled or hidden stop buttons when checking generation state", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: true,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    },
    {
      disabled: false,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), false);
});

test("content script reuses one stop-control scan per generation-state check", async () => {
  const context = await loadContentScriptContext();
  let queryCount = 0;
  context.document.querySelectorAll = () => {
    queryCount += 1;
    return [];
  };

  assert.equal(context.isGenerating(), false);
  assert.equal(queryCount, 3);
});

test("content script treats a visible enabled stop button as active generation", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: false,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), true);
});

test("content script stops a data-testid only generation button", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "data-testid") return "stop-button";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    },
    click() {
      clicked = true;
      this.disabled = true;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [];
    if (selector === '[data-testid*="stop"]') return [stopButton];
    return [];
  };
  context.sleep = async () => {};

  const stopped = await context.stopActiveGenerationIfPossible(5);

  assert.equal(stopped, true);
  assert.equal(clicked, true);
});

test("content script reports active generation in page status", async () => {
  const context = await loadContentScriptContext();
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    }
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stopButton] : []);

  const status = context.currentPageStatus();

  assert.equal(status.state, "working");
  assert.equal(status.code, "active_generation");
});

test("content script ignores visible non-stop generating labels", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: false,
      getAttribute() {
        return "Generating image";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), false);
});

test("content script ignores stopped thinking buttons when checking generation state", async () => {
  const context = await loadContentScriptContext();
  const stoppedThinkingButton = {
    disabled: false,
    getAttribute() {
      return null;
    },
    title: "",
    textContent: "宸插仠姝拷?",
    getClientRects() {
      return [{ width: 94, height: 24 }];
    }
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stoppedThinkingButton] : []);

  assert.equal(context.isGenerating(), false);
});

test("content script returns stable text replies even when a global stop button is stale", async () => {
  const context = await loadContentScriptContext();
  const prompt = "???????";
  let now = 0;
  let sleepCount = 0;
  const finalText = "???????????????????????????????";

  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };
  context.sleep = async () => {
    sleepCount += 1;
  };

  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: finalText,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: finalText,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    inputArtifactCount: 1
  });

  assert.equal(reply, finalText);
  assert.ok(sleepCount < 15);
});

test("content script reuses one artifact snapshot per completed-reply stability check", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Return one complete sentence.";
  const finalText = "This completed reply should be captured once per stability check.";
  let imageScans = 0;
  let downloadScans = 0;
  context.sleep = async () => {};

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: finalText,
    innerText: finalText,
    querySelectorAll(selector) {
      if (selector === "img") imageScans += 1;
      if (selector === "button") downloadScans += 1;
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: finalText,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") imageScans += 1;
      if (selector === "button") downloadScans += 1;
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    },
    closest() {
      return this;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.equal(reply, finalText);
  assert.equal(imageScans, 3);
  assert.equal(downloadScans, 3);
});

test("content script reuses one conversation-turn snapshot per completed-reply stability check", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Return one complete sentence.";
  const finalText = "This completed reply should reuse one turn snapshot per stability check.";
  let turnScans = 0;
  context.sleep = async () => {};

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: finalText,
    innerText: finalText,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: finalText,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    },
    closest() {
      return this;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      turnScans += 1;
      return [userTurn, assistantTurn];
    }
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.equal(reply, finalText);
  assert.equal(turnScans, 3);
});

test("content script does not repeat prompt matching while a scoped reply has not appeared", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Wait for the scoped assistant reply.";
  const finalText = "The scoped assistant reply is now complete.";
  let turnScans = 0;
  let userRoleChecks = 0;
  context.sleep = async () => {};

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') {
        userRoleChecks += 1;
        return {};
      }
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: finalText,
    innerText: finalText,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: finalText,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    },
    closest() {
      return this;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') {
      turnScans += 1;
      return turnScans === 1 ? [userTurn] : [userTurn, assistantTurn];
    }
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.equal(reply, finalText);
  assert.equal(turnScans, 4);
  assert.equal(userRoleChecks, 4);
});

test("content script keeps the global assistant fallback while turn wrappers are absent", async () => {
  const context = await loadContentScriptContext();
  const finalText = "The assistant reply is complete before turn wrappers appear.";
  let clockReads = 0;
  context.Date = class extends Date {
    static now() {
      clockReads += 1;
      return clockReads <= 4 ? (clockReads - 1) * 1000 : 2_000_000;
    }
  };
  context.sleep = async () => {};

  const assistantMessage = {
    textContent: finalText,
    innerText: finalText,
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: "Return the assistant reply."
  });

  assert.equal(reply, finalText);
});

test("content script filters unrelated turn text before checking prompt roles", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Find this exact current request.";
  let userRoleChecks = 0;

  const matchingUserTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') {
        userRoleChecks += 1;
        return {};
      }
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const unrelatedTurns = Array.from({ length: 20 }, (_, index) => ({
    textContent: `Unrelated historical turn ${index}.`,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') {
        userRoleChecks += 1;
        return null;
      }
      return selector === '[data-message-author-role="assistant"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  }));

  const result = context.latestUserPromptTurnInfo([prompt], {
    turns: [matchingUserTurn, ...unrelatedTurns]
  });

  assert.equal(result.index, 0);
  assert.equal(result.turn, matchingUserTurn);
  assert.equal(userRoleChecks, 1);
});

test("content script checks a missing after-user prompt only once per assistant lookup", async () => {
  const context = await loadContentScriptContext();
  let textReads = 0;
  const staleAssistantTurn = {
    get textContent() {
      textReads += 1;
      return "An older unrelated assistant reply.";
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };

  const result = context.lastAssistantMessage({
    afterUserText: "This prompt is not rendered yet.",
    requireAfterUserText: true,
    turns: [staleAssistantTurn]
  });

  assert.equal(result, null);
  assert.equal(textReads, 1);
});

test("content script settles image replies that remain stuck in generating state", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  let stopClicked = false;
  let generating = true;
  context.Date = class extends Date {
    static now() {
      now += 100000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };

  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=file_direct_10_01",
    src: "https://chatgpt.com/backend-api/estuary/content?id=file_direct_10_01",
    naturalWidth: 1024,
    naturalHeight: 1024,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 512 }];
    }
  };
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return generating ? [{ width: 24, height: 24 }] : [];
    },
    click() {
      stopClicked = true;
      generating = false;
    }
  };
  const assistantTurn = {
    textContent: "generated image visible",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };
  const userTurn = {
    textContent: "direct image prompt",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: "direct image prompt" });

  assert.equal(reply, "generated image visible");
  assert.equal(stopClicked, true);
});

test("content script does not expose interim processing text when an image is already visible", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=image-final",
    src: "https://chatgpt.com/backend-api/estuary/content?id=image-final",
    naturalWidth: 1024,
    naturalHeight: 1536,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 768 }];
    }
  };
  const message = {
    textContent:
      "ChatGPT \u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u8bf7\u6c42\uff0cBridge \u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d\u3002",
    innerText:
      "ChatGPT \u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u8bf7\u6c42\uff0cBridge \u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d\u3002",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.equal(reply, "\u5df2\u751f\u6210\u56fe\u7247\u3002");
});

test("content script refreshes the bound page once before sending a new unsent job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  const job = {
    id: "sync_pre_send_refresh",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "next task",
    _bridgeNeedsPreSendRefresh: true
  };
  let reloaded = false;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = () => {
    throw new Error("composer should not be touched before pre-send refresh");
  };
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (apiPath) => {
    bridgeCalls.push(apiPath);
    if (apiPath === "/api/sync/jobs/sync_pre_send_refresh/pre-send-refresh") {
      return {
        job: {
          ...job,
          _bridgePreSendRefresh: true,
          _bridgeRefreshAttempts: 1
        }
      };
    }
    throw new Error(`Unexpected bridge call: ${apiPath}`);
  };

  await context.processJob(job);

  assert.equal(reloaded, true);
  assert.deepEqual(bridgeCalls, ["/api/sync/jobs/sync_pre_send_refresh/pre-send-refresh"]);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_pre_send_refresh");
  assert.equal(stored.job._bridgePreSendRefresh, true);
});

test("content script stops stale generation before sending a new job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const actions = [];
  let generating = true;
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return generating ? [{ width: 24, height: 24 }] : [];
    },
    getBoundingClientRect() {
      return { left: 20, top: 10, width: 40, height: 20 };
    },
    click() {
      actions.push("stop");
      generating = false;
    }
  };
  const sendButton = {
    get disabled() {
      return generating;
    },
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return generating ? [] : [{ width: 24, height: 24 }];
    },
    click() {
      actions.push("send");
      sent = true;
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  let sent = false;
  const assistant = () => ({
    textContent: sent ? "new answer after stale generation stopped" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "next task",
    innerText: "next task",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return generating ? null : sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton, sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_after_stale",
    payloadText: "next task"
  });

  assert.deepEqual(actions, ["stop", "send"]);
  assert.equal(composer.value, "next task");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_after_stale/sent", "/api/sync/jobs/sync_after_stale/complete"]
  );
});

test("content script waits for the ChatGPT composer before sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  let sent = false;
  let composerQueries = 0;
  const assistant = () => ({
    textContent: sent ? "answer after composer appears" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "send after load",
    innerText: "send after load",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      composerQueries += 1;
      return composerQueries >= 3 ? composer : null;
    }
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_composer",
    payloadText: "send after load"
  });

  assert.equal(sent, true);
  assert.equal(composer.value, "send after load");
  assert.equal(composerQueries, 5);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_wait_composer/sent", "/api/sync/jobs/sync_wait_composer/complete"]
  );
});

test("content script sends with the ChatGPT composer submit button", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  let sent = false;
  const submitButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after composer submit" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "send with submit",
    innerText: "send with submit",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_submit",
    payloadText: "send with submit"
  });

  assert.equal(sent, true);
  assert.equal(composer.value, "send with submit");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_submit/sent", "/api/sync/jobs/sync_composer_submit/complete"]
  );
});

test("content script does not abandon a mutating send path behind a global timeout race", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      return name === "data-testid" ? "composer-submit-button" : null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userMessage = {
    textContent: "send without abandoned race",
    innerText: "send without abandoned race",
    getAttribute(name) {
      return name === "data-message-author-role" ? "user" : null;
    }
  };
  const assistant = () => ({
    textContent: sent ? "completed safely" : "old answer",
    innerText: sent ? "completed safely" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });

  context.sleep = async () => {};
  context.withPreSendTimeout = async () => {
    throw new Error("global pre-send timeout race must not wrap the mutating path");
  };
  context.triggerSendButton = async () => {
    sent = true;
    return { fallbackDomClick: true };
  };
  context.waitForAssistantReply = async () => "completed safely";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_without_abandoned_timeout",
    payloadText: "send without abandoned race"
  });

  assert.equal(sent, true, JSON.stringify({
    bridgeCalls: bridgeCalls.map((call) => call.path),
    composerValue: composer.value
  }));
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_without_abandoned_timeout/sent",
      "/api/sync/jobs/sync_without_abandoned_timeout/complete"
    ]
  );
});

test("content script uses a trusted browser click for the ChatGPT composer submit button", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    tagName: "BUTTON",
    disabled: false,
    textContent: "Send",
    innerText: "Send",
    getAttribute() {
      return null;
    },
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 40, width: 30, height: 30 };
    }
  };
  const assistant = () => ({
    textContent: sent ? "ok" : "old",
    innerText: sent ? "ok" : "old",
    getAttribute(name) {
      if (name === "data-message-author-role") return "assistant";
      return null;
    }
  });
  const userMessage = {
    textContent: "send trusted",
    innerText: "send trusted",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeCalls.push(payload);
        if (payload.type === "bridge:trustedClick") {
          sent = true;
          callback?.({ ok: true });
          return;
        }
        callback?.({ ok: true });
      }
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_trusted_submit",
    payloadText: "send trusted"
  });

  assert.equal(sent, true);
  assert.deepEqual(
    runtimeCalls.map((call) => call.type),
    ["bridge:trustedClick"]
  );
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_trusted_submit/sent", "/api/sync/jobs/sync_composer_trusted_submit/complete"]
  );
});

test("content script falls back quickly when the trusted send click never answers", async () => {
  const context = await loadContentScriptContext();
  let domClicks = 0;
  const submitButton = {
    tagName: "BUTTON",
    disabled: false,
    textContent: "Send",
    innerText: "Send",
    getAttribute() {
      return null;
    },
    click() {
      domClicks += 1;
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 40, width: 30, height: 30 };
    }
  };

  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage() {
        // Simulate a debugger-backed trusted click whose callback and promise never settle.
      }
    }
  };

  const attempt = await Promise.race([
    context.triggerSendButton(submitButton, {
      runtimeTimeoutMs: 5
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("trusted send click remained pending")), 50);
    })
  ]);

  assert.equal(domClicks, 1);
  assert.equal(attempt.usedTrustedClick, true);
  assert.equal(attempt.trustedClickOk, false);
  assert.equal(attempt.trustedClickError, "trusted click timed out");
  assert.equal(attempt.fallbackDomClick, true);
});

test("content script retries submit when trusted click leaves the draft in the composer", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    tagName: "BUTTON",
    disabled: false,
    textContent: "Send",
    innerText: "Send",
    getAttribute() {
      return null;
    },
    click() {
      sent = true;
      composer.value = "";
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 40, width: 30, height: 30 };
    }
  };
  const assistant = () => ({
    textContent: sent ? "ok" : "old",
    innerText: sent ? "ok" : "old",
    getAttribute(name) {
      if (name === "data-message-author-role") return "assistant";
      return null;
    }
  });
  const userMessage = {
    textContent: "send after retry",
    innerText: "send after retry",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeCalls.push(payload);
        callback?.({ ok: true });
      }
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_retry_submit",
    payloadText: "send after retry"
  });

  assert.equal(sent, true);
  assert.deepEqual(
    runtimeCalls.map((call) => call.type),
    ["bridge:trustedClick"]
  );
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_retry_submit/sent", "/api/sync/jobs/sync_composer_retry_submit/complete"]
  );
});

test("content script replaces stale contenteditable composer text before sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "DIV",
    textContent: "缂傚倷缍€閸涱垱鏆伴梺姹囧灮閸犳劙宕瑰璺虹闁冲搫顑嗭拷??10 閻庢鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    innerText: "缂傚倷缍€閸涱垱鏆伴梺姹囧灮閸犳劙宕瑰璺虹闁冲搫顑嗭拷??10 閻庢鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userMessage = {
    textContent: "new prompt",
    innerText: "new prompt",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: "new prompt",
    innerText: "new prompt",
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: sent ? "new answer" : "old answer",
    innerText: sent ? "new answer" : "old answer",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  // A real contenteditable element derives innerText from its text nodes.
  Object.defineProperty(composer, "innerText", {
    get() { return this.textContent; },
    set(value) { this.textContent = value; }
  });
  context.document.execCommand = (command, _showUi, value) => {
    if (command === "insertText") {
      composer.textContent += value;
      composer.innerText += value;
    }
    return true;
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_replace_stale_composer",
    payloadText: "new prompt"
  });

  assert.equal(sent, true);
  assert.equal(composer.textContent, "new prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_replace_stale_composer/sent", "/api/sync/jobs/sync_replace_stale_composer/complete"]
  );
});

test("content script bypasses debugger insertion for a long routed prompt", async () => {
  const context = await loadContentScriptContext();
  const runtimeMessages = [];
  let execCommands = 0;
  let focused = false;
  let composerText = "stale draft";
  const prompt = "long dependency context ".repeat(900);
  const composer = {
    tagName: "DIV",
    get textContent() {
      return composerText;
    },
    set textContent(value) {
      composerText = value;
    },
    get innerText() {
      return composerText;
    },
    set innerText(value) {
      composerText = value;
    },
    focus() {
      focused = true;
    },
    dispatchEvent() {}
  };

  context.document.execCommand = () => {
    execCommands += 1;
    return true;
  };
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        composerText = payload.text;
        callback?.({ ok: true });
      }
    }
  };

  await context.fillComposerText(composer, prompt);

  assert.equal(focused, true);
  assert.equal(execCommands, 0);
  assert.equal(composerText, prompt);
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), []);
});

test("content script avoids synchronous execCommand insertion for a medium staged prompt", async () => {
  const context = await loadContentScriptContext();
  const runtimeMessages = [];
  let execCommands = 0;
  let composerText = "stale draft";
  const prompt = "海".repeat(3345);
  const composer = {
    tagName: "DIV",
    get textContent() {
      return composerText;
    },
    set textContent(value) {
      composerText = value;
    },
    get innerText() {
      return composerText;
    },
    set innerText(value) {
      composerText = value;
    },
    focus() {},
    dispatchEvent() {}
  };

  context.document.execCommand = () => {
    execCommands += 1;
    return true;
  };
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        composerText = payload.text;
        callback?.({ ok: true });
      }
    }
  };

  await context.fillComposerText(composer, prompt);

  assert.equal(prompt.length, 3345);
  assert.equal(execCommands, 0);
  assert.equal(composerText, prompt);
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:trustedInsertText",
      text: prompt
    }
  ]);
});

test("content script clears a Bridge draft when a send fails before submit", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const inputEvents = [];
  const composer = {
    tagName: "TEXTAREA",
    value: "old draft",
    focus() {},
    dispatchEvent(event) {
      inputEvents.push(event);
    }
  };
  const disabledSendButton = {
    disabled: true,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return disabledSendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [disabledSendButton];
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === '[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async () => ({});

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_failed_before_submit",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "draft that should be cleared"
      }),
    /(?:ChatGPT send button not ready|GPT \u53d1\u9001\u6309\u94ae\u8fd8\u6ca1(?:\u6709)?\u51c6\u5907\u597d)/
  );

  assert.equal(composer.value, "");
  assert.ok(inputEvents.length >= 2);
});

test("content script refreshes and resumes when stale generation cannot be stopped", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  const actions = [];
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 16000;
      return now;
    }
  }
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    getBoundingClientRect() {
      return { left: 20, top: 10, width: 40, height: 20 };
    },
    click() {
      actions.push("stop");
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };
  context.bridgeApi = async () => {
    throw new Error("job should wait for reload instead of calling the bridge");
  };

  await context.processJob({
    id: "sync_stuck_generation",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "next task after stuck generation"
  });

  assert.deepEqual(actions, ["stop"]);
  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_stuck_generation");
});

test("content script refreshes an already sent job when ChatGPT reply times out", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 301000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  const userTurn = {
    textContent: "image prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn];
    return [];
  };
  context.bridgeApi = async () => {
    throw new Error("timed out sent job should wait for reload instead of failing");
  };

  await context.processJob(
    {
      id: "sync_sent_timeout",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "image prompt",
      sentAt: "2026-06-27T11:00:00.000Z",
      previousAssistantText: "old answer"
    },
    { resume: true }
  );

  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_sent_timeout");
  assert.equal(stored.job.sentAt, "2026-06-27T11:00:00.000Z");
  assert.equal(stored.job.previousAssistantText, "old answer");
});

test("content script downloads artifacts from the last assistant message", async () => {
  const context = await loadContentScriptContext();
  const anchor = {
    href: "blob:https://chatgpt.com/report",
    download: "report.txt",
    textContent: "Download report.txt",
    title: "",
    getAttribute(name) {
      if (name === "href") return this.href;
      if (name === "aria-label") return "";
      return null;
    }
  };
  const message = {
    querySelectorAll(selector) {
      return selector === "a[href]" ? [anchor] : [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "text/plain";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from("report from gpt", "utf8")
  });
  context.waitForInterpreterDownloadResources = async () => {
    throw new Error("visible download links must be captured before waiting for interpreter resources");
  };

  const result = await context.collectDownloadArtifacts(message);

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts[0].filename, "report.txt");
  assert.equal(result.artifacts[0].contentType, "text/plain");
  assert.equal(result.artifacts[0].base64Data, Buffer.from("report from gpt", "utf8").toString("base64"));
});

test("content script captures artifacts from ChatGPT file card download buttons", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const card = {
    textContent: "jokes.xlsx",
    querySelectorAll(selector) {
      return selector === "button" ? [button] : [];
    }
  };
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download jokes.xlsx";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    closest() {
      return card;
    },
    click() {
      clicked = true;
    }
  };
  const message = {
    textContent: "jokes.xlsx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "jokes.xlsx");
          assert.equal(payload.syncJobId, "sync_card");
          return { ok: true, watchId: "watch_1" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_1");
          return {
            ok: true,
            artifact: {
              id: "artifact_jokes",
              filename: "jokes.xlsx"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_card" });

  assert.equal(clicked, true);
  assert.equal(result.artifactIds.length, 1);
  assert.equal(result.artifactIds[0], "artifact_jokes");
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script does not use office preview images as downloadable file artifacts", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  let waitedMs = 0;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  const image = {
    currentSrc: "data:image/png;base64,preview-image",
    src: "data:image/png;base64,preview-image",
    naturalWidth: 512,
    naturalHeight: 300,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 300 }];
    }
  };
  const message = {
    textContent: "鐎规瓕灏欓弫鎾诲箣閹邦剙璁插☉鎾愁儓锟?Excel 闁哄倸娲ｅ▎銏ゆ晬濮濇笧idge-regression-table.xlsx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [image];
      return [];
    }
  };
  context.Date = FakeDate;
  context.sleep = async (delayMs) => {
    waitedMs += delayMs;
    now += delayMs;
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_xlsx_preview" });

  assert.equal(result.artifacts.length, 0);
  assert.equal(result.artifactIds.length, 0);
  assert.equal(result.errors.length, 0);
  assert.ok(waitedMs <= 750, `office preview waited ${waitedMs}ms without a download surface`);
});

test("content script recovers imported artifacts when extension context invalidates during file-card capture", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const card = {
    textContent: "bridge-regression-note-20260705.txt",
    querySelectorAll(selector) {
      return selector === "button" ? [button] : [];
    }
  };
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-regression-note-20260705.txt";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    closest() {
      return card;
    },
    click() {
      clicked = true;
    }
  };
  const message = {
    textContent: "bridge-regression-note-20260705.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-regression-note-20260705.txt");
          assert.equal(payload.syncJobId, "sync_recovered_txt");
          return { ok: true, watchId: "watch_recovered_txt" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          throw new Error("Extension context invalidated.");
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  context.fetch = async (url) => {
    assert.equal(String(url), "http://127.0.0.1:4317/api/artifacts?syncJobId=sync_recovered_txt");
    return {
      ok: true,
      json: async () => ({
        artifacts: [
          {
            id: "artifact_recovered_txt",
            filename: "bridge-regression-note-20260705.txt"
          }
        ]
      })
    };
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_recovered_txt" });

  assert.equal(clicked, true);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_recovered_txt"]);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script rebuilds generated text artifacts before clicking GPT behavior downloads", async () => {
  const context = await loadContentScriptContext();
  let trustedClicks = 0;
  const filename = "bridge-regression-note-20260705-v3.txt";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: `闂佽法鍠愰弸濠氬箯閻戣姤鏅搁柡鍌樺€栵拷?${filename}`,
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 40, top: 80, width: 260, height: 24 };
    },
    getClientRects() {
      return [{ width: 260, height: 24 }];
    },
    click() {}
  };
  const message = {
    textContent: [
      "Generated file:",
      `闂佽法鍠愰弸濠氬箯閻戣姤鏅搁柡鍌樺€栵拷?${filename}`,
      "```python",
      "from pathlib import Path",
      `path = Path(\"/mnt/data/${filename}\")`,
      "path.write_text(\"bridge txt capture ok 20260705 v3\", encoding=\"utf-8\")",
      "print(f\"Created: {path}\")",
      "```",
      `STDOUT/STDERR\nCreated: /mnt/data/${filename}`
    ].join("\n"),
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button, button];
      if (selector === "img") return [];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: "watch_text" };
        }
        if (payload.type === "bridge:trustedClick") {
          trustedClicks += 1;
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return { ok: false, error: `Timed out waiting for Chrome download ${filename}` };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_text_fallback" });

  assert.equal(trustedClicks, 0);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(result.artifacts[0].contentType, "text/plain; charset=utf-8");
  assert.equal(result.artifacts[0].base64Data, Buffer.from("bridge txt capture ok 20260705 v3", "utf8").toString("base64"));
});

test("content script uses a trusted browser click for ChatGPT behavior download buttons", async () => {
  const context = await loadContentScriptContext();
  let ordinaryClicked = false;
  const messages = [];
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download ZIP",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 50, width: 80, height: 20 };
    },
    getClientRects() {
      return [{ width: 80, height: 20 }];
    },
    click() {
      ordinaryClicked = true;
    }
  };
  const message = {
    textContent: "Download ZIP",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, null);
          return { ok: true, watchId: "watch_zip" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 140, y: 60 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_zip");
          return {
            ok: true,
            artifact: {
              id: "artifact_zip",
              filename: "multi-image-final-icons.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip" });

  assert.equal(ordinaryClicked, false);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script uses a trusted browser click for icon-only ChatGPT file card download buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const filename = "bridge-regression-table.xlsx";
  let ordinaryClicked = false;

  const card = {
    textContent: filename,
    parentElement: null,
    parentNode: null,
    querySelectorAll(selector) {
      if (selector === "button") return [downloadButton, expandButton];
      return [];
    }
  };
  const downloadButton = {
    className: "hover:text-token-text-secondary hover:bg-token-bg-tertiary rounded-full p-1",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    parentNode: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 80, width: 28, height: 28 };
    },
    getClientRects() {
      return [{ width: 28, height: 28 }];
    },
    scrollIntoView() {},
    click() {
      ordinaryClicked = true;
    }
  };
  const expandButton = {
    ...downloadButton,
    parentElement: card,
    parentNode: card,
    click() {}
  };
  const message = {
    textContent: filename,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [downloadButton, expandButton];
      if (selector === "img") return [];
      return [];
    }
  };
  card.parentElement = message;
  card.parentNode = message;

  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: "watch_icon_file_card" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 114, y: 94 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_icon_file_card");
          return {
            ok: true,
            artifact: { id: "artifact_icon_file_card", filename }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_icon_card" });

  assert.equal(ordinaryClicked, false);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_icon_file_card"]);
  assert.equal(result.errors.length, 0);
});

test("content script retries a file card with DOM click after trusted click download timeout", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const filename = "bridge-live-doc.docx";
  let ordinaryClicked = false;
  let watchCount = 0;

  const card = {
    textContent: filename,
    parentElement: null,
    parentNode: null,
    querySelectorAll(selector) {
      if (selector === "button") return [downloadButton];
      return [];
    }
  };
  const downloadButton = {
    className: "hover:text-token-text-secondary hover:bg-token-bg-tertiary rounded-full p-1",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    parentNode: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 80, width: 28, height: 28 };
    },
    getClientRects() {
      return [{ width: 28, height: 28 }];
    },
    scrollIntoView() {},
    click() {
      ordinaryClicked = true;
    }
  };
  const message = {
    textContent: filename,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [downloadButton];
      if (selector === "img") return [];
      return [];
    }
  };
  card.parentElement = message;
  card.parentNode = message;

  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          watchCount += 1;
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: `watch_doc_${watchCount}` };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 114, y: 94 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          if (payload.watchId === "watch_doc_1") {
            return {
              ok: false,
              error: `Timed out waiting for Chrome download ${filename}`
            };
          }
          assert.equal(payload.watchId, "watch_doc_2");
          return {
            ok: true,
            artifact: { id: "artifact_doc_retry", filename }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_doc_retry" });

  assert.equal(ordinaryClicked, true);
  assert.deepEqual(
    messages.map((message) => message.type),
    [
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch",
      "bridge:startDownloadWatch",
      "bridge:awaitDownloadWatch"
    ]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_doc_retry"]);
  assert.equal(result.errors.length, 0);
});

test("content script reveals interpreter download resources from download-labeled file buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filename = "bridge-live-doc-final.docx";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: `涓嬭浇 ${filename}`,
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 80, top: 120, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {}
  };
  const message = {
    textContent: `宸茬敓鎴愶細涓嬭浇 ${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      if (selector === "img") return [];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          resources.push({
            name:
              "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=" +
              encodeURIComponent(`/mnt/data/${filename}`)
          });
          return { ok: true };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, filename);
          return {
            ok: true,
            artifact: {
              id: "artifact_download_labeled_docx",
              filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_download_labeled_docx" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_download_labeled_docx"]);
  assert.equal(result.errors.length, 0);
});

test("content script imports ChatGPT interpreter download resources for filename-only buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filenames = ["direct-10-icons-v2-01.png", "direct-10-icons-v2-02.png"];
  const buttons = filenames.map((filename) => ({
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: filename,
    title: "",
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 120, height: 20 };
    },
    getClientRects() {
      return [{ width: 120, height: 20 }];
    },
    click() {
      resources.push({
        name: `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`
      });
    }
  }));
  const message = {
    textContent: `闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼幏宀婂晣锟??{filenames.join(" ")}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return buttons;
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.fetch = async () => {
    throw new Error("interpreter downloads should be delegated to the background download bridge");
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          return { ok: false };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.syncJobId, "sync_interpreter");
          assert.ok(filenames.includes(payload.filename));
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: `artifact_${payload.filename}`,
              filename: payload.filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_interpreter" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:trustedClick", "bridge:downloadUrl", "bridge:downloadUrl"]
  );
  assert.deepEqual(
    Array.from(result.artifactIds),
    filenames.map((filename) => `artifact_${filename}`)
  );
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script waits for delayed interpreter download resources after clicking file reference buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filename = "bridge-live-note-delayed.md";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: filename,
    title: "",
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 160, height: 20 };
    },
    getClientRects() {
      return [{ width: 160, height: 20 }];
    },
    click() {}
  };
  const message = {
    textContent: `Generated file: ${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          setTimeout(() => {
            resources.push({
              name: `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`
            });
          }, 400);
          return { ok: true };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, filename);
          return {
            ok: true,
            artifact: {
              id: "artifact_delayed_md",
              filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_delayed_md" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_delayed_md"]);
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script fetches interpreter resources from the page when background download is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-table.xlsx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
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
      arrayBuffer: async () => Buffer.from("xlsx bytes from page context", "utf8")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_page_fetch" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(
    result.artifacts[0].contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.equal(result.artifacts[0].base64Data, Buffer.from("xlsx bytes from page context", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl]);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script retries interpreter resources through the page context when isolated fetch is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-deck.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const listeners = new Map();

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.window = context;
  context.addEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };
  context.removeEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    listeners.set(
      type,
      handlers.filter((candidate) => candidate !== handler)
    );
  };
  context.postMessage = (message) => {
    for (const handler of listeners.get("message") || []) {
      handler({ source: context.window, data: message });
    }
  };
  context.document.createElement = () => ({
    textContent: "",
    remove() {}
  });
  context.document.documentElement = {
    appendChild(script) {
      vm.runInContext(script.textContent, context);
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
    if (fetchCalls.length === 1) {
      return {
        ok: false,
        status: 401,
        headers: {
          get() {
            return null;
          }
        },
        arrayBuffer: async () => Buffer.from("")
      };
    }
    return {
      ok: true,
      url: String(url),
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type"
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : null;
        }
      },
      arrayBuffer: async () => Buffer.from("pptx bytes from page context", "utf8")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_page_context_fetch" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(fetchCalls, [interpreterUrl, interpreterUrl]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(
    result.artifacts[0].contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  assert.equal(
    result.artifacts[0].base64Data,
    Buffer.from("pptx bytes from page context", "utf8").toString("base64")
  );
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script does not create visible Chrome downloads for interpreter resources after page fetch is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-deck-download.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const listeners = new Map();

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.window = context;
  context.addEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };
  context.removeEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    listeners.set(
      type,
      handlers.filter((candidate) => candidate !== handler)
    );
  };
  context.postMessage = (message) => {
    for (const handler of listeners.get("message") || []) {
      handler({ source: context.window, data: message });
    }
  };
  context.document.createElement = () => ({
    textContent: "",
    remove() {}
  });
  context.document.documentElement = {
    appendChild(script) {
      vm.runInContext(script.textContent, context);
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
    return {
      ok: false,
      status: 401,
      headers: {
        get() {
          return null;
        }
      },
      arrayBuffer: async () => Buffer.from("")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type !== "bridge:downloadUrl") {
          throw new Error(`Unexpected message type ${payload.type}`);
        }
        assert.equal(payload.quietOnly, true);
        return { ok: false, error: "GPT direct download failed with status 401" };
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_chrome_download_fallback" });

  assert.deepEqual(
    messages.map((message) => ({ type: message.type, quietOnly: message.quietOnly })),
    [{ type: "bridge:downloadUrl", quietOnly: true }]
  );
  assert.deepEqual(fetchCalls, [interpreterUrl, interpreterUrl]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, filename);
  assert.match(result.errors[0].error, /status 401/i);
});

test("content script ignores stale interpreter resources for preview-only presentation cards", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-preview-only-deck.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=old&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const previewButton = {
    className: "",
    disabled: false,
    textContent: "以全屏模式打开演示文稿",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "以全屏模式打开演示文稿" : null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 220, height: 40 };
    },
    getClientRects() {
      return [{ width: 220, height: 40 }];
    },
    click() {
      throw new Error("preview button should not be clicked as a download");
    }
  };
  const message = {
    textContent: `已生成演示文稿：${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [previewButton];
      return [];
    }
  };
  previewButton.parentElement = message;
  previewButton.parentNode = message;

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("preview-only presentation cards should not fetch interpreter resources");
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_preview_pptx" });

  assert.deepEqual(messages, []);
  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script never replaces an unavailable original xlsx with a lossy preview reconstruction", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-preview-only-table.xlsx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    assert.equal(String(url), interpreterUrl);
    return {
      ok: false,
      status: 401,
      headers: {
        get() {
          return null;
        }
      },
      arrayBuffer: async () => Buffer.from("")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const tableOutput = JSON.stringify({
    kind: "table",
    sheet: "Sheet1",
    address: "A1:B5",
    rows: 5,
    cols: 2,
    values: [
      ["id", "note"],
      [1, "Bridge trusted card row 1"],
      [2, "Bridge trusted card row 2"],
      [3, "Bridge trusted card row 3"],
      [4, "Bridge trusted card row 4"]
    ]
  });
  const message = {
    textContent: `Created the actual downloadable Excel file: ${filename}\n/mnt/data/${filename}\n${tableOutput}`,
    querySelectorAll(selector) {
      if (selector === "pre, code" || selector === "pre" || selector === "code") {
        return [{ textContent: tableOutput }];
      }
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_embedded_xlsx" });

  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 0);
  assert.ok(result.errors.some(error=>/401/.test(error.error)));
});

test("file-card download controls precede preview references for the same file",async()=>{
  const context=await loadContentScriptContext();
  const preview={getAttribute:()=>"下载 Excel 文件 report.xlsx",textContent:"report.xlsx"};
  const download={getAttribute:()=>"下载文件",textContent:""};
  context.isLikelyFileDownloadButton=()=>true;
  assert.equal(context.downloadButtonCandidates({querySelectorAll:()=>[preview,download]})[0],download);
});

test("file download focuses hover-only controls before issuing the trusted click",async()=>{
  const context=await loadContentScriptContext();let focused=false;
  context.canAskBackgroundForDownloads=()=>true;
  context.scrollElementIntoClickView=async()=>{};
  context.sleep=async()=>{};
  context.clickCoordinates=()=>({x:10,y:10});
  context.chromeRuntimeMessage=async()=>{assert.equal(focused,true);return{ok:true};};
  await context.triggerDownloadButton({focus:()=>{focused=true;},click(){assert.fail("Fallback must not hide an invalid trusted-click order");}});
});

test("native file download invokes the exact DOM control without debugger coordinate input",async()=>{
  const context=await loadContentScriptContext();let clicks=0;
  context.sleep=async()=>{};context.canAskBackgroundForDownloads=()=>true;
  context.scrollElementIntoClickView=async()=>{};
  context.clickCoordinates=()=>({x:10,y:20});
  context.chromeRuntimeMessage=async()=>({ok:true});
  await context.triggerDownloadButton({getAttribute:()=>"下载文件",focus(){},click(){clicks++;}});
  assert.equal(clicks,1);
});

test("content script ignores stale interpreter download resources when the current reply has no filenames", async () => {
  const context = await loadContentScriptContext();
  context.performance = {
    getEntriesByType(type) {
      if (type !== "resource") return [];
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=old&sandbox_path=%2Fmnt%2Fdata%2Fdirect-10-icons-v2-01.png"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`stale interpreter downloads should not be captured: ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: "Thought for 44s 缂傚倸鍊搁崐褰掓偋閻愮儤锟?",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [];
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message);

  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script does not wait for interpreter resources for a plain text reply", async () => {
  const context = await loadContentScriptContext();
  context.waitForInterpreterDownloadResources = async () => {
    throw new Error("plain text replies must not enter the five-second interpreter wait");
  };
  const message = {
    textContent: "This is a complete plain text reply.",
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message);

  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script scrolls ChatGPT behavior download buttons into view before trusted click", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  let scrolled = false;
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "婵炴垶鎸搁鎴﹀箯??multi-image-live-v3-icons.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return scrolled ? { left: 120, top: 80, width: 260, height: 26 } : { left: 120, top: 5275, width: 260, height: 26 };
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    },
    scrollIntoView() {
      scrolled = true;
    },
    click() {
      throw new Error("ordinary click should not be used when trusted click succeeds");
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?10 ??PNG闂佹寧绋戦懟顖炴嚐閻旂厧绠ラ柟鎯у暱閻﹀爼鎮楅悷鐗堟拱闁搞劍宀搁弫宥咁潩椤愩倗锟??multi-image-live-v3-icons.zip",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "multi-image-live-v3-icons.zip");
          return { ok: true, watchId: "watch_scrolled_zip" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.equal(scrolled, true);
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 250, y: 93 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_scrolled_zip",
              filename: "multi-image-live-v3-icons.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_scrolled_zip" });

  assert.equal(scrolled, true);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_scrolled_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script prefers zip filenames for ChatGPT behavior zip buttons", async () => {
  const context = await loadContentScriptContext();
  const button = {
    className: "behavior-btn",
    disabled: false,
    textContent: "濠电偞鍨堕幐鎼侇敄閸儲锟?ZIP",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 80, height: 20 }];
    }
  };
  const message = {
    textContent:
      "闂備礁鎼崐绋棵洪敐鍛瀻闁靛繈鍊曠粈宀勬煕濞戝崬娅欓柟??multi-image-zip-auto-01.png闂備線娼уΛ鏂库柦閻掆暔ti-image-zip-auto-02.png闂備焦瀵х粙鎴炵附閺冨倻绠旈柛娑卞枟婵粓鏌﹀Ο渚锟??/mnt/data/multi-image-zip-auto-icons.zip",
    querySelectorAll() {
      return [];
    }
  };

  assert.equal(context.expectedFilenameForButton(button, message), "multi-image-zip-auto-icons.zip");
});

test("content script does not treat files inside a captured zip as separate missing artifacts", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-capture-test.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {
      throw new Error("trusted click should capture the zip");
    }
  };
  const innerFileButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "readme.txt",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 24 }];
    },
    click() {
      throw new Error("inner zip file should not be clicked as a separate artifact");
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?bridge-capture-test.zip闂備焦瀵х粙鎴︽儗閸岀偛闂柣鎴ｅГ椤ュ牓鏌曡箛鏇炐㈤柣锕€鐖奸弫?readme.txt ??result.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton, innerFileButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-capture-test.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_zip",
              filename: "bridge-capture-test.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_bundle" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script reports one zip download failure without retrying the same button", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-capture-test.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const message = {
    textContent: "Generated bridge-capture-test.zip containing readme.txt and result.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-capture-test.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: false,
            error: "Timed out waiting for Chrome download bridge-capture-test.zip"
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_bundle_timeout" });

  assert.deepEqual(
    messages.filter((message) => message.type !== "bridge:api").map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, "bridge-capture-test.zip");
});

test("content script imports interpreter zip URLs before clicking zip buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-mini.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const message = {
    textContent: "Generated bridge-mini.zip with ok.txt inside.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fbridge-mini.zip"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-mini.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: false,
            error: "Timed out waiting for Chrome download bridge-mini.zip"
          };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "bridge-mini.zip");
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_zip",
              filename: "bridge-mini.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_interpreter_fallback" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script ignores interpreter resources for files listed inside a captured zip", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-mini.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("download button should not be clicked when zip resource URL is already available");
    }
  };
  const message = {
    textContent: "Generated bridge-mini.zip containing ok.txt. Download bridge-mini.zip.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fok.txt"
        },
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fbridge-mini.zip"
        },
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fok.txt"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "bridge-mini.zip");
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_zip",
              filename: "bridge-mini.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_with_contents" });

  assert.deepEqual(messages.map((message) => message.filename), ["bridge-mini.zip"]);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script captures existing interpreter zip resource without clicking download buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download quiet-artifact.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("download button should not be clicked when resource URL is already available");
    }
  };
  const message = {
    textContent: "Generated quiet-artifact.zip for download.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fquiet-artifact.zip"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "quiet-artifact.zip");
          assert.equal(payload.quietOnly, true);
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: "artifact_quiet_zip",
              filename: "quiet-artifact.zip"
            }
          };
        }
        return {
          ok: false,
          error: `${payload.type} should not be used for existing interpreter resources`
        };
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_quiet_zip" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_quiet_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script tries another same-file card button when the first zip button times out", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const card = {
    textContent: "bridge-mini-v6.zip",
    querySelectorAll(selector) {
      return selector === "button" ? [previewButton, downloadButton] : [];
    }
  };
  const previewButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "bridge-mini-v6.zip",
    title: "",
    parentElement: card,
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const downloadButton = {
    className: "",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-mini-v6.zip";
      return null;
    },
    getBoundingClientRect() {
      return { left: 210, top: 10, width: 24, height: 24 };
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      messages.push({ type: "ordinary-click-download" });
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣秗idge-mini-v6.zip",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [previewButton, downloadButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-mini-v6.zip");
          return { ok: true, watchId: `watch_${messages.filter((message) => message.type === "bridge:startDownloadWatch").length}` };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          const watchIndex = Number(String(payload.watchId).replace("watch_", ""));
          if (watchIndex === 1) {
            return {
              ok: false,
              error: "Timed out waiting for Chrome download bridge-mini-v6.zip"
            };
          }
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_v6_zip",
              filename: "bridge-mini-v6.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_second_button" });

  assert.deepEqual(
    messages.filter((message) => message.type !== "bridge:api").map((message) => message.type),
    [
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch",
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch"
    ]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_v6_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script scans the enclosing assistant turn for generated file cards", async () => {
  const context = await loadContentScriptContext();
  const section = {
    textContent: "閻庤鐡曠亸娆撳极閹捐绠ｉ柟鏉垮缁愭avorite-foods.pptx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹捐绠ｉ柟鏉垮缁愭avorite-foods.pptx",
    querySelectorAll() {
      return [];
    },
    closest(selector) {
      return selector === '[data-testid^="conversation-turn-"]' ? section : null;
    }
  };
  let clicked = false;
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    parentElement: section,
    parentNode: section,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clicked = true;
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "favorite-foods.pptx");
          return { ok: true, watchId: "watch_ppt" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_ppt",
              filename: "favorite-foods.pptx"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(context.assistantDownloadScope(message), {
    syncJobId: "sync_ppt"
  });

  assert.equal(clicked, true);
  assert.equal(result.artifactIds[0], "artifact_ppt");
});

test("content script falls back to capturing generated images from the assistant turn", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("fake png bytes", "utf8");
  const image = {
    currentSrc: "blob:https://chatgpt.com/generated-image",
    src: "blob:https://chatgpt.com/generated-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?codex-image-test.png",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.waitForInterpreterDownloadResources = async () => {
    throw new Error("visible generated images must be captured before waiting for interpreter resources");
  };

  const result = await context.collectDownloadArtifacts(message);

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, "codex-image-test.png");
  assert.equal(result.artifacts[0].contentType, "image/png");
  assert.equal(result.artifacts[0].base64Data, imageBytes.toString("base64"));
});

test("content script prefers generated images over stale file cards for image jobs", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("fresh image bytes", "utf8");
  const image = {
    currentSrc: "blob:https://chatgpt.com/fresh-image",
    src: "blob:https://chatgpt.com/fresh-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const staleButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download food-mini-v6.pptx";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      throw new Error("stale file button should not be clicked for an image job");
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?blue-circle-test.png  food-mini-v6.pptx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [staleButton];
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.chrome = {
    runtime: {
      async sendMessage() {
        throw new Error("download watch should not be used for a stale file button");
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, "blue-circle-test.png");
  assert.equal(result.artifacts[0].contentType, "image/png");
  assert.equal(result.artifactIds.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script detects image artifact requests without matching normal slide files", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.expectsImageArtifact({ payloadText: "Generate a PNG image." }), true);
  assert.equal(context.expectsImageArtifact({ payloadText: "generate an image" }), true);
  assert.equal(
    context.expectsImageArtifact({
      kind: "image_request",
      payloadText: "Restyle this reference in watercolor."
    }),
    true
  );
  assert.equal(
    context.requestedImageCount({
      kind: "image_request",
      payloadText: "Restyle this reference in watercolor."
    }),
    1
  );
  assert.equal(context.expectsImageArtifact({ payloadText: "闁荤姴娲ˉ鎾诲极閹捐绠ｉ柟閭︿簽锟??food-mini.pptx" }), false);
  assert.equal(context.requestedImageFilename({ payloadText: "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱娲﹂弳?blue-circle-priority-v3.png" }), "blue-circle-priority-v3.png");
  assert.equal(context.requestedImageFilename({ payloadText: "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱娲﹂弳?food-mini.pptx" }), null);
});

test("content script does not wait for an image when the prompt explicitly says not to generate a poster", async () => {
  const context = await loadContentScriptContext();
  const payloadText = [
    "\u6211\u60f3\u5199\u4e00\u672c\u5c0f\u8bf4\uff0c\u8bf7\u8bbe\u8ba1\u524d\u4e09\u96c6\u3002",
    "\u4e0d\u8981\u7ee7\u7eed\u5199\u7b2c\u4e00\u96c6\u6b63\u6587\uff0c\u4e5f\u4e0d\u5236\u4f5c\u6d77\u62a5\u3002"
  ].join("");

  assert.equal(context.hasImageOutputRequestSignal(payloadText), true);
  assert.equal(context.requestedImageCount({ payloadText }), 0);
  assert.equal(context.expectsImageArtifact({ kind: "image_request", payloadText }), false);
});

test("content script still captures one requested image when the prompt only forbids duplicates", async () => {
  const context = await loadContentScriptContext();
  const payloadText =
    "请生成且只生成1张正方形极简验收图片。不要生成多张，不要引用或重复本会话以前的图片。";

  assert.equal(context.hasNegativeArtifactSignal(payloadText), false);
  assert.equal(context.requestedImageCount({ kind: "image_request", payloadText }), 1);
  assert.equal(context.expectsImageArtifact({ kind: "image_request", payloadText }), true);
});

test("content script splits multiple requested image filenames", async () => {
  const context = await loadContentScriptContext();
  const text =
    "鐠囬鏁撻幋?multi-image-test-01.png閵嗕沟ulti-image-test-02.png閵嗕沟ulti-image-test-03.png閵嗕沟ulti-image-test-04.png";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
  assert.deepEqual(Array.from(context.requestedImageFilenames({ payloadText: text })), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
});

test("content script splits quoted multiple requested image filenames", async () => {
  const context = await loadContentScriptContext();
  const text =
    "鐠囬鏁撻幋?\"multi-image-test-01.png閵嗕沟ulti-image-test-02.png閵嗕沟ulti-image-test-03.png閵嗕沟ulti-image-test-04.png\"";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
});

test("content script does not attach ChatGPT thinking seconds to filenames", async () => {
  const context = await loadContentScriptContext();
  const text = "Thought for 25sbridge-live-sheet-20260708035451.xlsx";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "bridge-live-sheet-20260708035451.xlsx"
  ]);
});

test("content script assigns requested filenames to multiple generated images by index", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const images = [0, 1, 2].map((index) => ({
    currentSrc: `data:image/png;base64,image-${index}`,
    src: `data:image/png;base64,image-${index}`,
    naturalWidth: 512,
    naturalHeight: 512,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 256, height: 256 }];
    }
  }));
  const message = {
    textContent: "Generated images",
    querySelectorAll(selector) {
      if (selector === "img") return images;
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });

  const result = await context.collectDownloadArtifacts(message, {
    preferImages: true,
    requestedFilenames: ["multi-image-test-01.png", "multi-image-test-02.png", "multi-image-test-03.png"]
  });

  assert.deepEqual(
    Array.from(result.artifacts, (artifact) => artifact.filename),
    ["multi-image-test-01.png", "multi-image-test-02.png", "multi-image-test-03.png"]
  );
});

test("content script reports generated image download failures without masking the original error", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=broken-image",
    src: "https://chatgpt.com/backend-api/estuary/content?id=broken-image",
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const message = {
    textContent: "生成图片 fail-image-01.png",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async () => ({
    ok: false,
    status: 403,
    headers: {
      get() {
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from("")
  });

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, "fail-image-01.png");
  assert.match(result.errors[0].error, /Image download failed with status 403/);
});

test("content script captures generated image galleries with rail thumbnails", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, width = 1024, height = 768) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: width,
    naturalHeight: height,
    width: 72,
    height: 72,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const mainImage = makeImage("main", 1024, 1024);
  const thumbnails = Array.from({ length: 4 }, (_, index) => makeImage(`thumb-${index + 1}`, 1024, 1024));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage, ...thumbnails];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 5);
  assert.equal(new Set(fetched).size, 5);
});

test("content script captures only the requested current image instead of older gallery images", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const images = [
    makeImage("current-poster"),
    ...Array.from({ length: 6 }, (_, index) => makeImage(`older-poster-${index + 1}`))
  ];
  const message = {
    textContent: "已生成 1 张小说海报",
    querySelectorAll(selector) {
      if (selector === "img") return images;
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, {
    preferImages: true,
    expectedImageCount: 1
  });

  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(fetched, [
    "https://chatgpt.com/backend-api/estuary/content?id=current-poster"
  ]);
});

test("content script excludes images that existed before the current job from recovery galleries", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const currentImage = makeImage("current-job-image");
  const historicalImage = makeImage("historical-image");
  const historicalUrl = "https://chatgpt.com/backend-api/estuary/content?id=historical-image";
  const message = {
    textContent: "已生成当前任务图片",
    querySelectorAll(selector) {
      if (selector === "img") return [currentImage];
      return [];
    },
    contains(node) {
      return node === currentImage;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "img") return [currentImage, historicalImage];
    return [];
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, {
    preferImages: true,
    includePageGallery: true,
    excludeImageKeys: [historicalUrl]
  });

  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(fetched, [
    "https://chatgpt.com/backend-api/estuary/content?id=current-job-image"
  ]);
});

test("content script captures generated image galleries when rail thumbnails are small", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, naturalSize, displaySize) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: naturalSize,
    naturalHeight: naturalSize,
    width: displaySize,
    height: displaySize,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const mainImage = makeImage("main", 1024, 520);
  const thumbnails = Array.from({ length: 9 }, (_, index) => makeImage(`thumb-${index + 1}`, 96, 72));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage, ...thumbnails];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
});

test("content script captures generated image rail outside the assistant message", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, top = 120, left = 120, size = 72) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: size,
    height: size,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { top, bottom: top + size, left, right: left + size, width: size, height: size };
    },
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  });
  const mainImage = makeImage("main", 140, 120, 520);
  const railImages = Array.from({ length: 9 }, (_, index) =>
    makeImage(`rail-${index + 1}`, 150 + index * 44, 690, 40)
  );
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      return [];
    },
    getBoundingClientRect() {
      return { top: 100, bottom: 720, left: 80, right: 760, width: 680, height: 620 };
    },
    contains(node) {
      return node === mainImage;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "img") return [mainImage, ...railImages];
    return [];
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true, expectedImageCount: 10 });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
  assert.ok(fetched.some((url) => url.includes("rail-9")));
});

test("content script captures generated image galleries when rail thumbnails use background images", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const mainImage = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=main",
    src: "https://chatgpt.com/backend-api/estuary/content?id=main",
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const thumbnails = Array.from({ length: 9 }, (_, index) => ({
    tagName: "BUTTON",
    currentSrc: "",
    src: "",
    naturalWidth: 96,
    naturalHeight: 96,
    width: 52,
    height: 52,
    style: {
      backgroundImage: `url("https://chatgpt.com/backend-api/estuary/content?id=thumb-bg-${index + 1}")`
    },
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return `image ${index + 1}`;
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  }));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      if (selector.includes("background-image")) return thumbnails;
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
  assert.ok(fetched.some((url) => url.includes("thumb-bg-9")));
});

test("content script keeps generated image URLs with the same content id but different image index", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (index) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=batch-1&image=${index}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=batch-1&image=${index}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 72,
    height: 72,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [makeImage(1), makeImage(2), makeImage(3)];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 3);
  assert.equal(new Set(fetched).size, 3);
});

test("content script captures image galleries that require clicking thumbnail controls", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const urls = Array.from(
    { length: 4 },
    (_, index) => `https://chatgpt.com/backend-api/estuary/content?id=click-gallery-${index + 1}`
  );
  const mainImage = {
    currentSrc: urls[0],
    src: urls[0],
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.currentSrc;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const thumbs = urls.map((url, index) => ({
    tagName: "BUTTON",
    textContent: "",
    title: `Image ${index + 1}`,
    getAttribute(name) {
      if (name === "aria-label") return `Image ${index + 1}`;
      return null;
    },
    getClientRects() {
      return [{ width: 52, height: 52 }];
    },
    click() {
      mainImage.currentSrc = url;
      mainImage.src = url;
    }
  }));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      if (selector === "button" || selector === "button,[role='button']") return thumbs;
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };
  context.sleep = async () => {};

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 4);
  assert.deepEqual(fetched, urls);
});

test("content script waits for a single requested image before completing", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const imageBytes = Buffer.from("png", "utf8");
  let now = 0;
  let sent = false;
  let sleepCalls = 0;
  let imageVisible = false;
  class FakeDate extends Date {
    static now() {
      now += 100;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    src: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    naturalWidth: 1024,
    naturalHeight: 1536,
    width: 480,
    height: 720,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "Generated novel poster";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const userMessage = {
    textContent: "Generate a novel poster image.",
    innerText: "Generate a novel poster image.",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: userMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Crafted a novel poster.",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return imageVisible ? [image] : [];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.Date = FakeDate;
  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {
    if (sent) {
      sleepCalls += 1;
      if (sleepCalls >= 5) imageVisible = true;
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "image/png" : null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_single_image",
    kind: "image_request",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Generate a novel poster image."
  });

  const completeCall = bridgeCalls.find((call) => call.path.endsWith("/complete"));
  const completeBody = JSON.parse(completeCall.options.body);
  assert.equal(completeBody.artifacts.length, 1);
  assert.ok(sleepCalls >= 5);
});

test("content script requires image content for a stable single-image reply", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Generate a novel poster image.";
  let sleepCalls = 0;
  let imageVisible = false;
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    src: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    naturalWidth: 1024,
    naturalHeight: 1536,
    width: 480,
    height: 720,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "Generated novel poster";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Crafted a novel poster.",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return imageVisible ? [image] : [];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls >= 5) imageVisible = true;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantTurn];
    if (selector === "button" || selector === '[role="button"]' || selector === '[data-testid*="stop"]') return [];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    expectedImageCount: 1
  });

  assert.equal(reply, "Crafted a novel poster.");
  assert.equal(imageVisible, true);
  assert.ok(sleepCalls >= 5);
});

test("content script waits for the requested multi-image count before completing", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const imageBytes = Buffer.from("png", "utf8");
  let now = 0;
  let sent = false;
  let sleepCalls = 0;
  let visibleImageCount = 1;
  class FakeDate extends Date {
    static now() {
      now += 100;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const makeImage = (id) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}&sig=demo`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}&sig=demo`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 480,
    height: 480,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const images = [makeImage("img-1"), makeImage("img-2"), makeImage("img-3")];
  const userMessage = {
    textContent: "Generate 3 images, theme: AI workspace.",
    innerText: "Generate 3 images, theme: AI workspace.",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: userMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Thought for 10s",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return images.slice(0, visibleImageCount);
      return [];
    },
    closest() {
      return null;
    }
  };

  context.Date = FakeDate;
  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls >= 5) {
      visibleImageCount = 3;
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_multi_image_count",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Generate 3 images, theme: AI workspace."
  });

  const completeCall = bridgeCalls.find((call) => call.path.endsWith("/complete"));
  const completeBody = JSON.parse(completeCall.options.body);
  assert.equal(completeBody.artifacts.length, 3);
  assert.ok(sleepCalls >= 5);
});

test("content script names data URL images from the requested image filename", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "data:image/png;base64,abcdef",
    src: "data:image/png;base64,abcdef",
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    }
  };
  const message = {
    textContent: "ChatGPT 闂佹眹鍨婚崰鎰板垂濮橆厾顩查柛鈩冩礈椤忚京鈧鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    querySelectorAll() {
      return [];
    }
  };

  assert.equal(
    context.filenameFromImage(image, message, 0, {
      requestedFilename: "blue-circle-priority-v3.png"
    }),
    "blue-circle-priority-v3.png"
  );
});

test("content script selects an image-only reply after the matching user prompt", async () => {
  const context = await loadContentScriptContext();
  const oldImage = {
    currentSrc: "data:image/png;base64,old-ppt-preview",
    src: "data:image/png;base64,old-ppt-preview",
    naturalWidth: 800,
    naturalHeight: 450,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 400, height: 225 }];
    }
  };
  const freshImage = {
    currentSrc: "data:image/png;base64,fresh-blue-circle",
    src: "data:image/png;base64,fresh-blue-circle",
    naturalWidth: 800,
    naturalHeight: 800,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 400, height: 400 }];
    }
  };
  const oldAssistantMessage = { textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣籵od-mini-v5.pptx" };
  const oldAssistantTurn = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣籵od-mini-v5.pptx",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? oldAssistantMessage : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [oldImage];
      return [];
    }
  };
  const userTurn = {
    getAttribute(name) { return name === "data-turn-id" ? "image-user" : null; },
    textContent: "闂備浇宕垫慨鏉懨洪鈶哄骞樼拠鍙夌€梺鐟板綖缁鳖噣锟??blue-circle-filename-v4.png",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const imageReplyTurn = {
    getAttribute(name) { return name === "data-turn-id" ? "image-answer" : null; },
    textContent: "",
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [freshImage];
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [oldAssistantMessage];
    if (selector === '[data-testid^="conversation-turn-"]') return [oldAssistantTurn, userTurn, imageReplyTurn];
    return [];
  };

  assert.equal(context.lastAssistantMessage({ afterUserTurnId: "image-user", afterUserText: "blue-circle-filename-v4.png" }), imageReplyTurn);
});

test("content script anchors filename prompts to the user turn instead of the assistant reply", async () => {
  const context = await loadContentScriptContext();
  const prompt = "The filename imagegen.png is only an example; no file was generated.";
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: "The filename imagegen.png is only an example; no file was generated.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: assistantMessage.textContent,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };

  assert.equal(context.lastAssistantMessage({ afterUserText: prompt, requireAfterUserText: true }), assistantTurn);
});

test("content script does not fall back to stale assistant replies before the matching user prompt appears", async () => {
  const context = await loadContentScriptContext();
  const staleAssistantMessage = { textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?10 闁诲孩顔栭崰姘叏妞嬪簶鍋撳鐓庡伎锟??PNG闂備焦瀵х粙鎴︽嚐椤栨縿浜归柡灞诲劚缁€鍡涙煕閳╁喚娈旈柣鎺斿帶閳藉骞橀幇浣稿壍濠电偞娼欏ú顓㈠极瀹ュ拋娼伴柣搴㈠Оect-10-icons-v2-01.png" };
  const staleAssistantTurn = {
    textContent: staleAssistantMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? staleAssistantMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [staleAssistantMessage];
    if (selector === '[data-testid^="conversation-turn-"]') return [staleAssistantTurn];
    return [];
  };

  assert.equal(
    context.lastAssistantMessage({
      afterUserText: "闁汇埄鍨奸崰妤呭垂濠婂牊鍋ㄩ柣鏃傤焾閻忓洤鈽夐幘顖氫壕閻庢鍠氭繛鈧柣婵愬枤閹峰綊濡搁埡浣诡仭闂佹悶鍎辨晶鑺ユ櫠閺嶎厽鏅慨姗嗗亞椤忓崬鈽夐幙鍐х凹婵犫偓椤撱垹绾ч柕澶涚畱锟?AI 閻庤鎮堕崕鎵礊閺冨牊锟?",
      requireAfterUserText: true
    }),
    null
  );
});

test("content script ignores ChatGPT bootstrap page text when no assistant message exists", async () => {
  const context = await loadContentScriptContext();
  const bootstrapNode = {
    textContent:
      "window.__oai_logHTML?window.__oai_logHTML():window.__oai_SSR_HTML=window.__oai_SSR_HTML||Date.now();requestAnimationFrame((function(){window.__oai_logTTI?window.__oai_logTTI():window.__oai_SSR_TTI=window.__oai_SSR_TTI||Date.now()}))",
    getAttribute() {
      return "";
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === '[data-testid^="conversation-turn-"]') return [];
    if (selector === "article, main [role='presentation'], main div") return [bootstrapNode];
    return [];
  };

  assert.equal(context.lastAssistantText(), "");
});

test("content script treats an image-only assistant turn as a usable reply", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "blob:https://chatgpt.com/generated-image",
    src: "blob:https://chatgpt.com/generated-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const message = {
    textContent: "old answer",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), true);
  assert.equal(context.visibleReplyTextFromAssistant(message, "old answer"), message.textContent);
});

test("content script ignores interim image generation waiting text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Generating a more detailed image, please wait.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores Chinese image creation placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Generating image, please wait.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores final image tuning placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "\u6700\u540e\u5fae\u8c03\u4e00\u4e0b..",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores document reading placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "#### ChatGPT said:\n\nReading document",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores document skill lookup placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "#### ChatGPT said:\n\nLooking up document related skill instructions",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores generic file skill lookup placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const placeholders = [
    "#### ChatGPT says:\n\nLooking up PPT related skill instructions",
    "#### ChatGPT says:\n\nLooking up PDF related skill instructions",
    "#### ChatGPT says:\n\nLooking up Excel related skill instructions",
    "#### ChatGPT says:\n\nChecking file related skill instructions",
    "#### ChatGPT says:\n\nChecking ZIP file content",
    "#### ChatGPT says:\n\nLooking up document related skill instructions",
    "#### ChatGPT said:\n\nChecking file skills",
    "Pro thinking",
    "Connection interrupted. Waiting for the complete reply"
  ];

  for (const textContent of placeholders) {
    const message = {
      textContent,
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      }
    };

    assert.equal(context.hasUsableAssistantContent(message, "old answer"), false, textContent);
  }
});

test("content script ignores downloadable file generation promise text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const placeholders = [
    "\u6211\u6765\u751f\u6210\u8fd9\u4e2a DOCX \u6587\u4ef6\uff0c\u5e76\u76f4\u63a5\u7ed9\u4f60\u4e0b\u8f7d\u94fe\u63a5\u3002",
    "\u6211\u4f1a\u521b\u5efa\u4e00\u4e2a Excel \u6587\u4ef6\uff0c\u7a0d\u540e\u63d0\u4f9b\u4e0b\u8f7d\u3002",
    "I'll generate this PPTX file and provide a download link shortly."
  ];

  for (const textContent of placeholders) {
    const message = {
      textContent,
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      }
    };

    assert.equal(context.hasUsableAssistantContent(message, "old answer"), false, textContent);
  }
});

test("content script waits past document reading placeholder before returning final analysis", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What is this document?";
  let sleepCount = 0;
  let assistantText = "#### ChatGPT said:\n\nReading document";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      assistantText = "This is a compensation and performance review policy document.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /compensation and performance review policy document/);
  assert.doesNotMatch(reply, /reading the document/i);
});

test("content script waits past file generation promise until a downloadable card appears", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Generate a downloadable DOCX file.";
  let sleepCount = 0;
  let hasButton = false;
  let assistantText = "\u6211\u6765\u751f\u6210\u8fd9\u4e2a DOCX \u6587\u4ef6\uff0c\u5e76\u76f4\u63a5\u7ed9\u4f60\u4e0b\u8f7d\u94fe\u63a5\u3002";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      hasButton = true;
      assistantText = "\u5df2\u751f\u6210\uff1a\u4e0b\u8f7d bridge-file.docx";
    }
  };

  const downloadButton = {
    tagName: "BUTTON",
    textContent: "\u4e0b\u8f7d bridge-file.docx",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll(selector) {
      return hasButton && selector === "a,button,[role='button']" ? [downloadButton] : [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
      return hasButton && selector === "a,button,[role='button']" ? [downloadButton] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /bridge-file\.docx/);
  assert.ok(sleepCount >= 2);
});

test("content script waits past document skill lookup placeholder before returning final analysis", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What kind of document is this?";
  let sleepCount = 0;
  let assistantText = "#### ChatGPT says:\n\nLooking up document-related skill instructions";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      assistantText = "This is a Word document for a Double Eleven enrollment and renewal promotion plan.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /promotion plan/);
  assert.doesNotMatch(reply, /Looking up document-related skill instructions/);
});

test("content script waits longer for file analysis text that pauses mid sentence", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What is this?";
  let sleepCount = 0;
  let assistantText =
    "This is a Word document for a Double Eleven promotion plan. Overall, it is an internal campus enrollment and renewal plan that includes course package design, discount policies, and discussion";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 5) {
      assistantText =
        "This is a Word document for a Double Eleven promotion plan. Overall, it is an internal campus enrollment and renewal plan that includes course package design, discount policies, sales scripts, and on-site activity incentives.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    inputArtifactCount: 1
  });

  assert.match(reply, /promotion plan|activity/i);
  assert.doesNotMatch(reply, /old answer/i);
});

test("content script ignores ChatGPT image planning text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Planning for image generation\n\nI'll go for a 1:1 aspect ratio unless specified otherwise.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores sequential image planning text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent:
      "Planning sequential image generation in batches\n\nThe user asked for 10 images in 5 batches, with 2 images per batch.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script treats a matching download button as usable even when reply text repeats", async () => {
  const context = await loadContentScriptContext();
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "婵炴垶鎸搁鎴﹀箯??multi-image-live-v3-icons.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?10 ??PNG闂佹寧绋戦懟顖炴嚐閻旂厧绠ラ柟鎯у暱閻﹀爼鎮楅悷鐗堟拱闁搞劍宀搁弫宥咁潩椤愩倗锟??multi-image-live-v3-icons.zip",
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, message.textContent), true);
});

test("content script rejects stale unscoped artifact replies after composer-cleared send confirmation", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.sleep = async () => {};
  const staleDownloadButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-regression-small.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-regression-small.zip";
      return null;
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    }
  };
  const staleAssistantMessage = {
    textContent: "Generated:",
    innerText: "Generated:",
    querySelectorAll(selector) {
      if (selector === "button") return [staleDownloadButton];
      return [];
    },
    closest() {
      return null;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [staleAssistantMessage];
    if (selector === "button") return [];
    return [];
  };

  await assert.rejects(
    () =>
      context.waitForAssistantReply("Generated:", {
        requireFreshUnscopedReply: true
      }),
    /Timed out waiting for (?:ChatGPT|GPT) reply|\u7b49\u5f85 GPT \u56de\u590d\u8d85\u65f6/
  );
});

test("content script accepts repeated text when it belongs to the matching new assistant turn", async () => {
  const context = await loadContentScriptContext();
  const prompt = "repeat the same answer";
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.sleep = async () => {};
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: "same answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: assistantMessage.textContent,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };

  const reply = await context.waitForAssistantReply("same answer", { afterUserText: prompt });

  assert.equal(reply, "same answer");
});

test("content script matches Markdown list prompts after ChatGPT removes list markers", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  context.Date = class extends Date { static now() { now += 10000; return now; } };
  const payload = [
    "请只完成第 1 步：为玄幻穿越小说设计前十集的大纲。",
    "",
    "要求：",
    "- 只输出大纲、核心设定、主线、主要人物和每集概要。",
    "- 不要写第一章。",
    "- 不要生成海报。"
  ].join("\n");
  const renderedPrompt = payload.replace(/(^|\n)-\s+/g, "$1");
  const previousReply = "旧版大纲回复。";
  const latestReply = "新版完整大纲回复。";

  const userTurn = (text = renderedPrompt) => ({
    textContent: text,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  });
  const assistantTurn = (text) => {
    let turn = null;
    const message = {
      textContent: text,
      matches(selector) {
        return selector === '[data-message-author-role="assistant"]';
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return turn;
      }
    };
    turn = {
      textContent: text,
      querySelector(selector) {
        if (selector === '[data-message-author-role="assistant"]') return message;
        return null;
      },
      querySelectorAll() {
        return [];
      }
    };
    return { turn, message };
  };
  const oldAssistant = assistantTurn(previousReply);
  const newAssistant = assistantTurn(latestReply);
  const turns = [userTurn("An earlier unrelated request"), oldAssistant.turn, userTurn(), newAssistant.turn];

  context.sleep = async () => {};
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return turns;
    if (selector === '[data-message-author-role="assistant"]') {
      return [oldAssistant.message, newAssistant.message];
    }
    if (selector === "button" || selector === '[role="button"]' || selector === '[data-testid*="stop"]') {
      return [];
    }
    return [];
  };

  assert.equal(context.userPromptTurnExistsAny([payload]), true);
  assert.equal(context.latestUserPromptTurnInfo([payload]).index, 2);
  assert.equal(await context.waitForAssistantReply(previousReply, { afterUserText: payload }), latestReply);
});

test("content script does not confirm a send from an older duplicate prompt", async () => {
  const context = await loadContentScriptContext();
  const prompt = "基于上一阶段结果，只生成一张竖版中文小说海报。";
  const makeUserTurn = () => ({
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  });
  const oldAssistantTurn = {
    textContent: "旧海报",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const turns = [makeUserTurn(), oldAssistantTurn];
  let sleepCount = 0;
  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount === 1) {
      turns.push(makeUserTurn());
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return turns;
    if (selector === '[data-message-author-role="user"]') {
      return turns.filter((turn) => turn !== oldAssistantTurn);
    }
    return [];
  };

  const submitted = await context.waitForSubmittedPrompt(
    { kind: "image_request", payloadText: prompt },
    2_000,
    { afterTurnIndex: 1 }
  );

  assert.equal(sleepCount, 1);
  assert.equal(submitted.index, 2);
});

test("content script refuses an unanchored Canvas reply after ChatGPT reindexes away the confirmed user turn", async () => {
  const context = await loadContentScriptContext();
  const previousReply = "An older assistant answer.";
  const canvasReply = [
    "# 第七码头",
    "",
    "## 第三集：档案室里没有死者",
    "",
    "周叙从档案回溯中醒来，身份删除进度升到49%。",
    "",
    "以上只完成前三集设计，没有展开第一集正文，也没有生成海报。"
  ].join("\n");
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.sleep = async () => {};

  const assistantMessage = fakeElement(
    "div",
    { "data-message-author-role": "assistant" },
    [fakeElement("article", {}, [fakeText(canvasReply)])]
  );
  const canvasTurn = fakeElement(
    "section",
    { "data-testid": "conversation-turn-canvas-reindexed" },
    [assistantMessage]
  );
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [canvasTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button" || selector === '[role="button"]' || selector === '[data-testid*="stop"]') {
      return [];
    }
    return [];
  };

  await assert.rejects(context.waitForAssistantReply(previousReply, {
    afterUserTurnIndex: 7,
    afterUserText: "请设计小说的前三集。"
  }), /等待 GPT 回复超时/);
});

test("content script captures an image-only reply by prompt after the confirmed turn index is reindexed", async () => {
  const context = await loadContentScriptContext();
  const prompt = "只生成一张竖版中文小说海报。";
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 60_000;
      return now;
    }
  };
  context.sleep = async () => {};

  const image = {
    currentSrc: "blob:https://chatgpt.com/generated-poster",
    src: "blob:https://chatgpt.com/generated-poster",
    naturalWidth: 1024,
    naturalHeight: 1536,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 768 }];
    }
  };
  const userRole = { textContent: prompt };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userRole : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const imageTurn = {
    textContent: "",
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    },
    closest() {
      return null;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, imageTurn];
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (
      selector === "button" ||
      selector === '[role="button"]' ||
      selector === '[data-testid*="stop"]'
    ) {
      return [];
    }
    return [];
  };

  const reply = await context.waitForAssistantReply("older assistant reply", {
    afterUserTurnIndex: 7,
    afterUserText: prompt,
    expectedImageCount: 1
  });

  assert.equal(reply, "GPT generated an image.");
  assert.equal(
    context.lastAssistantMessage({
      afterUserTurnIndex: 7,
      afterUserText: prompt,
      requireAfterUserText: true
    }),
    imageTurn
  );
});

test("content script completes repeated file analysis replies using the confirmed turn identity", async () => {
  const context = await loadContentScriptContext();
  const repeatedReply = "The ZIP contains one file: `Codex-Setup-Tool.cmd`.";
  const hiddenPayload = "Internal Bridge attachment instruction that is not visible in the ChatGPT turn.";
  const visibleUserText = "Please inspect the attachment. Attachment: 1. Codex-Setup-Tool.zip";
  const bridgeCalls = [];
  let now = 0;

  context.Date = class extends Date {
    static now() {
      now += 5_000;
      return now;
    }
  };
  context.sleep = async () => {};

  const userTurn = {
    textContent: visibleUserText,
    getAttribute: name => name === "data-turn-id" ? "attachment-user" : null,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: repeatedReply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: repeatedReply,
    getAttribute: name => name === "data-turn-id" ? "attachment-answer" : null,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_repeated_zip",
      submittedPromptTurnId: "attachment-user",
      kind: "codex_file_analysis",
      payloadText: hiddenPayload,
      userText: "Ask GPT to analyze file: Codex-Setup-Tool.zip",
      previousAssistantText: repeatedReply,
      sentAt: "2026-07-02T20:10:03.000Z",
      inputArtifacts: [
        {
          filename: "Codex-Setup-Tool.zip",
          contentType: "application/zip",
          sizeBytes: 549
        }
      ]
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_repeated_zip/complete"]
  );
  assert.equal(JSON.parse(bridgeCalls[0].options.body).replyText, repeatedReply);
});

test("content script resumes a sent job without resending the prompt", async () => {
  const context = await loadContentScriptContext();
  const assistant = {
    textContent: "new answer after reload",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };
  const bridgeCalls = [];

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_resume",
      payloadText: "do not resend",
      previousAssistantText: "old answer",
      sentAt: "2026-06-24T17:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_resume/complete"]
  );
  const completedBody = JSON.parse(bridgeCalls[0].options.body);
  assert.equal(completedBody.replyText, "new answer after reload");
  assert.match(
    completedBody.workerId,
    /^codex-chatgpt-project-extension-v20260923-missing-recovery:runtime-missing:tab_/
  );
});

test("content script publishes a captured heartbeat after normal completion succeeds", async () => {
  const context = await loadContentScriptContext();
  const reply = "This is the complete final response with enough detail to prove that normal reply capture has finished successfully.";
  const assistant = {
    textContent: reply,
    innerText: reply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };
  let heartbeatBody = null;

  context.sleep = async () => {};
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    if (path === "/api/sync/jobs/sync_normal_capture_status/complete") {
      return {
        job: {
          id: "sync_normal_capture_status",
          status: "succeeded"
        }
      };
    }
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  await context.processJob(
    {
      id: "sync_normal_capture_status",
      payloadText: "return one final response",
      previousAssistantText: "old answer",
      sentAt: "2026-07-31T11:45:52.018Z"
    },
    { resume: true }
  );
  await context.sendHeartbeat({ lightweight: true });

  assert.equal(heartbeatBody.captureStatus.jobId, "sync_normal_capture_status");
  assert.equal(heartbeatBody.captureStatus.state, "captured");
  assert.equal(heartbeatBody.captureStatus.replyLength, reply.length);
  assert.equal(heartbeatBody.captureStatus.artifactCount, 0);
});

test("content script can capture an already-finished scoped reply while the original waiter is stuck", async () => {
  const context = await loadContentScriptContext();
  const prompt = "请只设计小说前三集，不要继续写正文。";
  const reply = "这是已经完整返回的前三集设计。第一集建立冲突，第二集扩大危机，第三集以强悬念收尾。";
  const userMessage = {
    textContent: prompt,
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: reply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: reply,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const bridgeCalls = [];

  context.sleep = async () => {};
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/sync/jobs/sync_stuck_waiter") {
      return { job: { id: "sync_stuck_waiter", status: "running" } };
    }
    return {};
  };

  assert.equal(
    await context.captureExistingReply({
      id: "sync_stuck_waiter",
      status: "running",
      payloadText: prompt,
      userText: prompt,
      previousAssistantText: "旧回复",
      sentAt: "2026-07-28T10:12:54.115Z",
      inputArtifacts: []
    }),
    true
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_stuck_waiter",
      "/api/sync/jobs/sync_stuck_waiter",
      "/api/sync/jobs/sync_stuck_waiter",
      "/api/sync/jobs/sync_stuck_waiter/complete"
    ]
  );
  assert.equal(JSON.parse(bridgeCalls.at(-1).options.body).replyText, reply);
});

test("content script does not report capture success when the server returns a failed completion job", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Return one complete project analysis.";
  const reply = [
    "The requested report has been fully prepared and the generation task is complete.",
    "It contains the final introduction, findings, recommendations, validation checklist, and closing summary.",
    "No additional analysis or generation is still running, and this is the final response."
  ].join(" ");
  const userMessage = {
    textContent: prompt,
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: reply,
    innerText: reply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: reply,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  let heartbeatBody = null;

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    if (path === "/api/sync/jobs/sync_failed_completion_status") {
      return {
        job: {
          id: "sync_failed_completion_status",
          status: "running"
        }
      };
    }
    if (path === "/api/sync/jobs/sync_failed_completion_status/complete") {
      return {
        job: {
          id: "sync_failed_completion_status",
          status: "failed",
          errorCode: "server_validation_failed",
          error: "The server rejected the captured result"
        }
      };
    }
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  const captured = await context.captureExistingReply({
    id: "sync_failed_completion_status",
    status: "running",
    payloadText: prompt,
    userText: prompt,
    previousAssistantText: "old answer",
    sentAt: "2026-07-31T12:00:00.000Z",
    inputArtifacts: []
  });
  await context.sendHeartbeat({ lightweight: true });

  assert.equal(captured, false);
  assert.equal(heartbeatBody.captureStatus.jobId, "sync_failed_completion_status");
  assert.equal(heartbeatBody.captureStatus.state, "completion_failed");
  assert.equal(heartbeatBody.captureStatus.errorCode, "server_validation_failed");
});

async function captureConcurrencyFixture() {
  const context = await loadContentScriptContext();
  const prompt = "Download the current Excel file.";
  const reply = "Download current.xlsx.";
  const job = { id: "sync_capture_concurrency", status: "running", sentAt: "2026-09-10T00:00:00Z",
    payloadText: prompt, userText: prompt, previousAssistantText: "old reply", inputArtifacts: [] };
  const userMessage = { textContent: prompt, querySelectorAll: () => [] };
  const assistantMessage = { textContent: reply, innerText: reply, querySelectorAll: () => [], closest: () => assistantTurn };
  const userTurn = { textContent: prompt, querySelector: (s) => s === '[data-message-author-role="user"]' ? userMessage : null, querySelectorAll: () => [] };
  const assistantTurn = { textContent: reply, querySelector: (s) => s === '[data-message-author-role="assistant"]' ? assistantMessage : null, querySelectorAll: () => [] };
  context.document.querySelectorAll = (s) => s === '[data-testid^="conversation-turn-"]'
    ? [userTurn, assistantTurn] : s === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
  // Browser download and HTTP boundaries are delayed; both production capture paths stay real.
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const effects = { downloads: 0, completions: 0, status: "running" };
  context.waitForAssistantReply = async () => reply;
  context.collectDownloadArtifacts = async () => {
    effects.downloads += 1;
    entered.resolve();
    await release.promise;
    return { artifacts: [], artifactIds: ["artifact_current"], errors: [] };
  };
  context.bridgeApi = async (url, options = {}) => {
    if (url === `/api/sync/jobs/${job.id}`) return { job: { id: job.id, status: effects.status } };
    if (url === `/api/sync/jobs/${job.id}/complete`) {
      assert.deepEqual(JSON.parse(options.body).artifactIds, ["artifact_current"]);
      effects.completions += 1;
      effects.status = "succeeded";
      return { job: { id: job.id, status: effects.status } };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { context, job, entered, release, effects };
}

for (const firstPath of ["normal waiter", "recovery"]) {
  test(`content script shares one download and completion when ${firstPath} overlaps recovery`, async () => {
    const { context, job, entered, release, effects } = await captureConcurrencyFixture();
    const first = firstPath === "normal waiter" ? context.processJob(job) : context.captureExistingReply(job);
    await entered.promise;
    const second = context.captureExistingReply(job);
    await new Promise(setImmediate);
    release.resolve();
    await Promise.all([first, second]);
    assert.equal(effects.downloads, 1, "one browser download per job, including heartbeat recovery");
    assert.equal(effects.completions, 1, "the shared capture must submit one terminal result");
    assert.equal(effects.status, "succeeded");
  });
}

test("content script keeps the capture shared until the completion request settles", async () => {
  const { context, job, release, effects } = await captureConcurrencyFixture();
  const completionEntered = Promise.withResolvers();
  const completionRelease = Promise.withResolvers();
  const api = context.bridgeApi;
  context.bridgeApi = async (url, options) => {
    if (url.endsWith("/complete")) {
      completionEntered.resolve();
      await completionRelease.promise;
    }
    return api(url, options);
  };
  release.resolve();
  const first = context.processJob(job);
  await completionEntered.promise;
  const second = context.captureExistingReply(job);
  await new Promise(setImmediate);
  completionRelease.resolve();
  await Promise.all([first, second]);
  assert.equal(effects.downloads, 1);
  assert.equal(effects.completions, 1);
});

test("content script releases a failed shared capture so the same job can recover", async () => {
  const { context, job, release, effects } = await captureConcurrencyFixture();
  const download = context.collectDownloadArtifacts;
  context.collectDownloadArtifacts = async () => { throw new Error("download interrupted"); };
  await assert.rejects(context.processJob(job), /download interrupted/);
  assert.equal(effects.completions, 0);
  context.collectDownloadArtifacts = download;
  release.resolve();
  assert.equal(await context.captureExistingReply(job), true);
  assert.equal(effects.downloads, 1);
  assert.equal(effects.completions, 1);
});

test("content script does not complete a job cancelled during a shared capture", async () => {
  const { context, job, entered, release, effects } = await captureConcurrencyFixture();
  const first = context.processJob(job);
  await entered.promise;
  const second = context.captureExistingReply(job);
  await new Promise(setImmediate);
  effects.status = "failed";
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(effects.downloads, 1);
  assert.equal(effects.completions, 0);
  assert.equal(effects.status, "failed");
});

test("content script does not let a late recovery probe overwrite a captured terminal status", async () => {
  const context = await loadContentScriptContext();
  const job = {
    id: "sync_late_recovery_probe",
    status: "running",
    sentAt: "2026-07-31T12:07:18.682Z"
  };
  let heartbeatBody = null;

  context.document.querySelectorAll = () => [];
  context.recordCompletionCaptureStatus(
    job,
    {
      job: {
        id: job.id,
        status: "succeeded"
      }
    },
    {
      replyLength: 17,
      artifactCount: 0
    }
  );
  context.bridgeApi = async (path, options = {}) => {
    if (path === `/api/sync/jobs/${job.id}`) {
      return {
        job: {
          id: job.id,
          status: "succeeded"
        }
      };
    }
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  assert.equal(await context.captureExistingReply(job), true);
  await context.sendHeartbeat({ lightweight: true });

  assert.equal(heartbeatBody.captureStatus.jobId, job.id);
  assert.equal(heartbeatBody.captureStatus.state, "captured");
  assert.equal(heartbeatBody.captureStatus.replyLength, 17);
});

test("content script preserves captured status when the job finishes during recovery collection", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Return the final sentence.";
  const reply = "CAPTURE-RACE-OK.";
  const job = {
    id: "sync_finishes_during_recovery_collection",
    status: "running",
    payloadText: prompt,
    userText: prompt,
    previousAssistantText: "old answer",
    sentAt: "2026-07-31T12:17:50.948Z",
    inputArtifacts: []
  };
  const userMessage = {
    textContent: prompt,
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: reply,
    innerText: reply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: reply,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  let jobReads = 0;
  let heartbeatBody = null;

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    if (path === `/api/sync/jobs/${job.id}`) {
      jobReads += 1;
      if (jobReads === 1) {
        return { job: { id: job.id, status: "running" } };
      }
      context.recordCompletionCaptureStatus(
        job,
        { job: { id: job.id, status: "succeeded" } },
        { replyLength: reply.length, artifactCount: 0 }
      );
      return { job: { id: job.id, status: "succeeded" } };
    }
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  assert.equal(await context.captureExistingReply(job), true);
  await context.sendHeartbeat({ lightweight: true });

  assert.equal(jobReads, 2);
  assert.equal(heartbeatBody.captureStatus.jobId, job.id);
  assert.equal(heartbeatBody.captureStatus.state, "captured");
  assert.equal(heartbeatBody.captureStatus.replyLength, reply.length);
});

test("content script captures a finished image reply even when its short caption has no punctuation", async () => {
  const context = await loadContentScriptContext();
  const prompt = "请生成一张竖版小说海报。";
  const reply = "图片已生成";
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=file_finished_poster",
    src: "https://chatgpt.com/backend-api/estuary/content?id=file_finished_poster",
    naturalWidth: 1024,
    naturalHeight: 1536,
    getAttribute(name) {
      if (name === "src") return this.src;
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 768 }];
    }
  };
  const userMessage = {
    textContent: prompt,
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: reply,
    innerText: reply,
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: reply,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    }
  };
  const bridgeCalls = [];

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.collectDownloadArtifacts = async () => ({
    artifacts: [{ filename: "poster.png", mimeType: "image/png", base64: "aW1hZ2U=" }],
    artifactIds: [],
    errors: []
  });
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/sync/jobs/sync_finished_image") {
      return { job: { id: "sync_finished_image", status: "running" } };
    }
    return {};
  };

  assert.equal(
    await context.captureExistingReply({
      id: "sync_finished_image",
      status: "running",
      kind: "image_request",
      payloadText: prompt,
      userText: prompt,
      previousAssistantText: "",
      sentAt: "2026-07-29T10:00:10.591Z",
      inputArtifacts: []
    }),
    true
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_finished_image",
      "/api/sync/jobs/sync_finished_image",
      "/api/sync/jobs/sync_finished_image",
      "/api/sync/jobs/sync_finished_image/complete"
    ]
  );
  const completion = JSON.parse(bridgeCalls.at(-1).options.body);
  assert.equal(completion.replyText, reply);
  assert.equal(completion.artifacts.length, 1);
});

test("content script does not complete a sent job after Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const assistant = {
    textContent: "answer that arrived after manual stop",
    innerText: "answer that arrived after manual stop",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming a cancelled job");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/sync/jobs/sync_cancelled_after_sent") {
      return {
        job: {
          id: "sync_cancelled_after_sent",
          status: "failed",
          errorCode: "manual_cancelled"
        }
      };
    }
    throw new Error(`cancelled sent job should not call ${path}`);
  };

  await context.processJob(
    {
      id: "sync_cancelled_after_sent",
      status: "running",
      payloadText: "do not complete after cancellation",
      previousAssistantText: "old answer",
      sentAt: "2026-07-07T00:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_cancelled_after_sent"]
  );
});

test("content script releases a sent job while waiting when Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let statusChecks = 0;
  let now = 0;
  let reloaded = false;

  context.Date = class extends Date {
    static now() {
      now += 100_000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloaded = true;
    },
    replace(url) {
      throw new Error(`cancelled waiting job should not navigate to ${url}`);
    }
  };
  context.sleep = async () => {};
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/sync/jobs/sync_cancelled_while_waiting") {
      statusChecks += 1;
      return {
        job: {
          id: "sync_cancelled_while_waiting",
          status: statusChecks <= 2 ? "running" : "failed",
          errorCode: statusChecks <= 2 ? null : "manual_cancelled"
        }
      };
    }
    throw new Error(`cancelled waiting job should not call ${path}`);
  };

  await context.processJob(
    {
      id: "sync_cancelled_while_waiting",
      status: "running",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "wait until cancelled",
      previousAssistantText: "old answer",
      sentAt: "2026-07-07T00:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(bridgeCalls, [
    "/api/sync/jobs/sync_cancelled_while_waiting",
    "/api/sync/jobs/sync_cancelled_while_waiting",
    "/api/sync/jobs/sync_cancelled_while_waiting"
  ]);
  assert.equal(reloaded, false);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script skips artifact capture when a filename is only an example", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const reply = "The filename imagegen.png is only an example; no file was generated.";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "imagegen.png",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 24 }];
    },
    click() {
      throw new Error("example filename should not be clicked");
    }
  };
  const assistant = {
    textContent: reply,
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`example filename should not trigger Chrome downloads: ${payload.type}`);
      }
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_example_filename",
      payloadText: "Do not generate files. The filename imagegen.png is only an example.",
      previousAssistantText: "old answer",
      sentAt: "2026-06-25T14:00:00.000Z"
    },
    { resume: true }
  );

  const complete = JSON.parse(bridgeCalls[0].options.body);
  assert.equal(complete.replyText, reply);
  assert.deepEqual(complete.artifacts, []);
  assert.deepEqual(complete.artifactIds, []);
  assert.deepEqual(complete.artifactErrors, []);
});

test("content script skips artifact capture for local file analysis replies that mention filenames", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const reply = "闁哄鏅滈悷銉ф閸洖鐐婇柟顖嗗懏缍岀紓浣插亾闁惧繗顫夐悾??GitHub 婵炲濮甸幐鍝ヨ姳鏉堛劊浜滈柣銏犳啞濡椼劑鏌曢崱妤€鈧鈧潧鐬奸幉鐗堟媴缁嬭儻顔夐柣鐔哥懁閻掞箓寮搁崘鈺冾浄閻犱礁婀辩粣妗滸ENTS.md闂侀潧妫旈梼娣揂DME.md闂侀潧妫旈崹顣嘽kage.json??;"
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "AGENTS.md",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 24 }];
    },
    click() {
      throw new Error("analysis-only filename should not be clicked");
    }
  };
  const assistant = {
    textContent: reply,
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`analysis-only reply should not trigger Chrome downloads: ${payload.type}`);
      }
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_local_image_analysis",
      kind: "codex_file_analysis",
      payloadText: [
        "闁荤姴娲ら崲鏌ュ垂鎼淬劌鍑犻柟閭﹀幖閻忓鈽夐幘绛规缂佸崬鐖奸幆鍐礋椤掍胶鈧喖霉閻樹警鍟囬柟??",
        "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱绻掔粣姊榠thub-repo-screenshot.png",
        "闂佸搫鍊稿ú锝呪枎閵忋垻灏甸悹鍥皺閳ь剛鍏橀弫宥咁潰閿曞穬ge/png",
        "",
        "Please analyze the attached image."
      ].join("\n"),
      inputArtifacts: [
        {
          filename: "github-repo-screenshot.png",
          contentType: "image/png"
        }
      ],
      previousAssistantText: "old answer",
      sentAt: "2026-06-25T14:00:00.000Z"
    },
    { resume: true }
  );

  const complete = JSON.parse(bridgeCalls[0].options.body);
  assert.equal(complete.replyText, reply);
  assert.deepEqual(complete.artifacts, []);
  assert.deepEqual(complete.artifactIds, []);
  assert.deepEqual(complete.artifactErrors, []);
});

test("content script sends a fresh job directly when the project page is ready", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let reloaded = false;
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userNode = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelectorAll() {
      return [];
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after direct send" : "old answer",
    innerText: sent ? "answer after direct send" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userTurn = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userNode;
      return null;
    }
  };
  const assistantTurn = {
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    }
  };

  context.sleep = async () => {};
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userNode] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    if (selector === "button") return [sendButton];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_refresh_first",
          payloadText: "fresh prompt"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(reloaded, false);
  assert.equal(sent, true);
  assert.equal(composer.value, "fresh prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/claim",
      "/api/sync/jobs/sync_refresh_first/sent",
      "/api/sync/jobs/sync_refresh_first/complete"
    ]
  );
});

test("content script sends a claimed unsent job when pre-send refresh was already persisted", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let reloaded = false;
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after persisted refresh" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer after persisted refresh",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.sleep = async () => {};
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistant()] : [];
    if (selector === "button") return [sendButton];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo"
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_refresh_persisted",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "fresh prompt",
          _bridgePreSendRefresh: true,
          _bridgeRefreshAttempts: 1
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(reloaded, false);
  assert.equal(sent, true);
  assert.equal(composer.value, "fresh prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/claim",
      "/api/sync/jobs/sync_refresh_persisted/sent",
      "/api/sync/jobs/sync_refresh_persisted/complete"
    ]
  );
});

test("content script reports a persisted pre-send job failure instead of swallowing it", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  const job = {
    id: "sync_persisted_pre_send_failure",
    status: "running",
    claimedAt: new Date(Date.now() - 61_000).toISOString(),
    sentAt: null,
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "release the queue",
    _bridgePreSendRefresh: true,
    _bridgeRefreshAttempts: 2
  };
  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({ job })
  );
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.sendHeartbeat = async () => ({
    controlsCurrentPage: true,
    projectUrl: "https://chatgpt.com/c/demo"
  });
  context.processJob = async () => {
    const error = new Error("GPT task was claimed but never submitted");
    error.errorCode = "pre_send_expired";
    error.recoveryAction = "retry";
    throw error;
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({
      path,
      body: options.body ? JSON.parse(options.body) : null
    });
    if (path === `/api/sync/jobs/${job.id}`) {
      return { job };
    }
    if (path === `/api/sync/jobs/${job.id}/fail`) {
      return { job: { ...job, status: "failed" } };
    }
    throw new Error(`Unexpected bridge call: ${path}`);
  };

  await context.poll();

  const failCall = bridgeCalls.find((call) => call.path === `/api/sync/jobs/${job.id}/fail`);
  assert.ok(failCall);
  assert.equal(failCall.body.errorCode, "pre_send_expired");
  assert.equal(failCall.body.recoveryAction, "retry");
  assert.match(
    failCall.body.workerId,
    /^codex-chatgpt-project-extension-v20260923-missing-recovery:runtime-missing:tab_/
  );
});

test("content script discards a persisted pre-send job after Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let sent = false;
  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_cancelled_before_reload",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "do not send",
        _bridgePreSendRefresh: true,
        _bridgeRefreshAttempts: 1
      }
    })
  );
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };

  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [sendButton] : []);
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo"
      };
    }
    if (path === "/api/sync/jobs/sync_cancelled_before_reload") {
      return {
        job: {
          id: "sync_cancelled_before_reload",
          status: "failed",
          errorCode: "manual_cancelled"
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return { job: null };
    }
    throw new Error(`cancelled persisted job should not be sent: ${path}`);
  };

  await context.poll();

  assert.equal(sent, false);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/sync_cancelled_before_reload",
      "/api/sync/jobs/claim"
    ]
  );
});

test("content script does not mark a job sent until ChatGPT shows the user prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {}
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === '[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await assert.rejects(
    () => context.processJob({
      id: "sync_unconfirmed_send",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "bridge-live-ok"
    }),
    /(?:ChatGPT did not show the submitted prompt|GPT \u70b9\u51fb\u53d1\u9001\u540e\u6ca1\u6709\u663e\u793a\u5df2\u63d0\u4ea4\u7684\u63d0\u793a)/
  );
  assert.deepEqual(bridgeCalls.map((call) => call.path), []);
});

test("content script does not mark a job sent when ChatGPT clears the composer without showing the user prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  let logicalNow = 0;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
      composer.value = "";
    }
  };
  const assistantNode = {
    textContent: "fresh answer",
    innerText: "fresh answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.Date = class extends Date {
    static now() {
      logicalNow += 500;
      return logicalNow;
    }
  };
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantNode] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_prompt_bubble_delayed",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "bridge-live-ok"
      }),
    /(?:ChatGPT did not show the submitted prompt|GPT \u70b9\u51fb\u53d1\u9001\u540e\u6ca1\u6709\u663e\u793a\u5df2\u63d0\u4ea4\u7684\u63d0\u793a)/
  );

  assert.ok(logicalNow >= 4_000, "the full logical send-confirmation window must elapse");
  assert.deepEqual(bridgeCalls.map((call) => call.path), []);
});

test("content script includes send confirmation diagnostics in failure payloads", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/c/demo";
  const composer = {
    tagName: "TEXTAREA",
    value: "bridge-live-ok"
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  const error = context.sendConfirmationError(
    {
      id: "sync_unconfirmed_send",
      payloadText: "bridge-live-ok"
    },
    {
      composer,
      sendButton,
      sendAttempt: {
        hadPoint: true,
        usedTrustedClick: true,
        trustedClickOk: true
      }
    }
  );
  const payload = context.bridgeFailurePayload(error);

  assert.equal(payload.errorCode, "send_not_confirmed");
  assert.equal(payload.recoveryAction, "manual_send_or_refresh");
  assert.equal(payload.failureDetails.reason, "send_not_confirmed");
  assert.equal(payload.failureDetails.composerStillContainsDraft, true);
  assert.equal(payload.failureDetails.sendButton.label, "Send message");
  assert.equal(payload.failureDetails.sendAttempt.trustedClickOk, true);
});

test("content script includes send button diagnostics when the submit control is not ready", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/c/demo";
  const composer = {
    tagName: "TEXTAREA",
    value: "continue image generation"
  };
  const stopButton = {
    disabled: false,
    textContent: "Stop generating",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };

  const error = context.sendButtonNotReadyError(
    {
      id: "sync_send_not_ready",
      payloadText: "continue image generation"
    },
    { composer }
  );
  const payload = context.bridgeFailurePayload(error);

  assert.equal(payload.errorCode, "send_button_not_ready");
  assert.equal(payload.recoveryAction, "wait_or_refresh_bound_page");
  assert.equal(payload.failureDetails.reason, "send_button_not_ready");
  assert.equal(payload.failureDetails.composerContainsDraft, true);
  assert.equal(payload.failureDetails.visibleButtons[0].label, "Stop generating Stop generating");
});

test("content script wraps the Chinese send-button timeout with structured diagnostics", async () => {
  const context = await loadContentScriptContext();
  const prompt = "continue image generation";
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const stopButton = {
    disabled: false,
    textContent: "Stop generating",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {};
  context.syncJobStillActive = async () => true;
  context.ensureExpectedChatGptPage = () => true;
  context.stopStaleGenerationIfNeeded = async () => {};
  context.dismissArtifactPreviewIfNeeded = async () => {};
  context.waitForComposer = async () => composer;
  context.waitForReadySendButton = async () => {
    throw new Error("GPT \u53d1\u9001\u6309\u94ae\u8fd8\u6ca1\u6709\u51c6\u5907\u597d\u3002");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };

  await assert.rejects(
    () => context.processJob({
      id: "sync_chinese_send_not_ready",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: prompt
    }),
    (error) => {
      assert.equal(error.errorCode, "send_button_not_ready");
      assert.equal(error.recoveryAction, "wait_or_refresh_bound_page");
      assert.equal(error.details.reason, "send_button_not_ready");
      assert.equal(error.details.composerContainsDraft, true);
      return true;
    }
  );
});

test("content script skips per-message preference sync when heartbeat already applied it", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  let modelSyncCalls = 0;
  let modeSyncCalls = 0;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userNode = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelectorAll() {
      return [];
    }
  };
  const assistantNode = {
    textContent: "fresh answer",
    innerText: "fresh answer",
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode];
      return [];
    },
    closest() {
      return null;
    }
  };
  const userTurn = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userNode;
      return null;
    }
  };
  const assistantTurn = {
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantNode;
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {};
  context.setPreferenceStatus(
    {
      modePreference: "advanced",
      modelPreference: "gpt-5.6-sol",
      updatedAt: "2026-06-30T13:47:33.475Z"
    },
    {
      state: "applied",
      modeSynced: true,
      modelSynced: true
    }
  );
  context.selectModelPreference = async () => {
    modelSyncCalls += 1;
    throw new Error("model sync should be skipped");
  };
  context.selectModePreference = async () => {
    modeSyncCalls += 1;
    throw new Error("mode sync should be skipped");
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userNode] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantNode] : [];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_skip_redundant_preferences",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "fresh prompt",
    modePreference: "advanced",
    modelPreference: "gpt-5.6-sol"
  });

  assert.equal(modelSyncCalls, 0);
  assert.equal(modeSyncCalls, 0);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_skip_redundant_preferences/sent",
      "/api/sync/jobs/sync_skip_redundant_preferences/complete"
    ]
  );
});

test("content script sends an extension heartbeat before claiming work", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
  assert.equal(JSON.parse(bridgeCalls[0].options.body).href, "https://chatgpt.com/c/demo");
});

test("content script asks the background to open another bound GPT conversation without replacing this tab", async () => {
  const context = await loadContentScriptContext();
  const runtimeMessages = [];
  const navigations = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/current-page",
    replace(url) {
      navigations.push(url);
    }
  };
  context.document.title = "Current page";
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        callback({ ok: true, opened: true, tabId: 77 });
      }
    }
  };
  context.bridgeApi = async (requestPath) => {
    if (requestPath === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/current-page",
        openTarget: {
          action: "open_project_tab",
          jobId: "sync_waiting_page",
          projectUrl: "https://chatgpt.com/c/waiting-page"
        }
      };
    }
    if (requestPath === "/api/sync/jobs/claim") {
      return { job: null, resume: false };
    }
    throw new Error(`Unexpected Bridge call: ${requestPath}`);
  };

  await context.poll();

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:openProjectTab",
      jobId: "sync_waiting_page",
      projectUrl: "https://chatgpt.com/c/waiting-page"
    }
  ]);
  assert.deepEqual(navigations, []);
});

test("content script claims work when heartbeat confirms control without preferences", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo",
        preferences: null,
        recovery: null
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script does not claim work while ChatGPT is actively generating", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stopButton] : []);
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo",
        preferences: null,
        recovery: null,
        heartbeat: {
          pageStatus: {
            state: "working",
            code: "active_generation"
          }
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat"]
  );
});

test("content script applies heartbeat preferences without claiming a chat job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let selectedModeJob = null;
  let selectedModelJob = null;

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {};
  context.selectModePreference = async (job) => {
    selectedModeJob = job;
    return true;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/project/demo",
          modePreference: "high",
          modelPreference: "gpt-5.6-sol",
          updatedAt: "2026-06-28T00:00:00.000Z"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/extension/heartbeat"]);
  assert.equal(selectedModeJob.modePreference, "high");
  assert.equal(selectedModelJob.modelPreference, "gpt-5.6-sol");
});

test("content script applies linked model preferences before mode preferences", async () => {
  const context = await loadContentScriptContext();
  const order = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModelPreference = async (job) => {
    order.push(`model:${job.modelPreference}`);
    return true;
  };
  context.selectModePreference = async (job) => {
    order.push(`mode:${job.modePreference}`);
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.deepEqual(order, ["model:gpt-5.6-sol", "mode:high"]);
});

test("content script coerces unsupported GPT-5.3 modes before syncing preferences", async () => {
  const context = await loadContentScriptContext();
  let selectedModeJob = null;
  let selectedModelJob = null;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "balanced",
    modelPreference: "gpt-5.3",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };
  context.selectModePreference = async (job) => {
    selectedModeJob = job;
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.equal(selectedModelJob.modelPreference, "gpt-5.3");
  assert.equal(selectedModelJob.modePreference, "fast");
  assert.equal(selectedModeJob.modePreference, "fast");
});

test("content script skips mode selection for model-only ChatGPT preferences", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let selectedModelJob = null;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "balanced",
    modelPreference: "o3",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.equal(modeAttempts, 0);
  assert.equal(selectedModelJob.modelPreference, "o3");
  assert.equal(selectedModelJob.modePreference, null);
});

test("content script retries heartbeat preferences after the preference timestamp changes", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };
  const changedPreferences = {
    ...preferences,
    updatedAt: "2026-06-28T00:00:01.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return false;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(changedPreferences), false);
  assert.equal(modeAttempts, 0);
  assert.equal(modelAttempts, 2);
});

test("content script reports heartbeat preference selection failures", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => true;
  context.selectModelPreference = async () => false;
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  await context.sendHeartbeat();

  assert.deepEqual(bridgeCalls[0].body.preferenceStatus, {
    state: "failed",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z",
    modeSynced: false,
    modelSynced: false,
    error: "mode and model preferences were not applied"
  });
});

test("content script reports the controls seen during a failed mode selection", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    title: "",
    getAttribute(name) {
      if (name === "role") return "button";
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {}
  };
  const composerScope = {
    querySelectorAll(selector) {
      return selector === "button,[role='button']" ? [combinedButton] : [];
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {},
    closest(selector) {
      return selector === '[data-testid*="composer"]' ? composerScope : null;
    },
    parentElement: null
  };

  context.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/project/demo/c/abc" };
  context.document.title = "Demo chat";
  context.document.body = { innerText: "", textContent: "" };
  context.document.querySelector = (selector) => selector === "#prompt-textarea" ? composer : null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [combinedButton];
    return [];
  };
  context.sleep = async () => {};
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences({
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "advanced",
    modelPreference: "gpt-5.5",
    updatedAt: "2026-07-12T00:00:00.000Z"
  }), false);
  await context.sendHeartbeat();

  const diagnostic = bridgeCalls[0].body.preferenceStatus.diagnostics;
  assert.equal(diagnostic.kind, "mode");
  assert.deepEqual(diagnostic.labels, ["高", "高级"]);
  assert.equal(diagnostic.currentControl.text, "5.5 Pro");
  assert.deepEqual(diagnostic.visibleOptions.map((item) => item.text), ["5.5 Pro"]);
});

test("content script does not repeatedly retry the same failed heartbeat preferences", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(modeAttempts, 0);
  assert.equal(modelAttempts, 1);
});

test("content script does not retry the same failed heartbeat preferences on a timer", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  context.Date = FakeDate;
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  now = 60001;
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(modeAttempts, 0);
  assert.equal(modelAttempts, 1);
});

test("content script clears a failed heartbeat preference when the page already shows the target labels", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {},
    closest() {
      return null;
    }
  };
  let modelButtonLabel = "Wrong model";
  const modeButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 88, height: 32 }];
    }
  };
  const modelButton = {
    get textContent() {
      return modelButtonLabel;
    },
    get innerText() {
      return modelButtonLabel;
    },
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 88, height: 32 }];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton, modelButton];
    return [];
  };
  context.selectModePreference = async () => false;
  context.selectModelPreference = async () => false;
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  modelButtonLabel = context.modelLabelForPreference("gpt-5.6-sol");
  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  await context.sendHeartbeat();

  assert.deepEqual(bridgeCalls.at(-1).body.preferenceStatus, {
    state: "applied",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z",
    modeSynced: true,
    modelSynced: true
  });
});

test("content script reapplies the same heartbeat preferences after the visible controls drift", async () => {
  const context = await loadContentScriptContext();
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-07-28T00:00:00.000Z"
  };
  let modeLabel = context.modeLabelForPreference("high");
  let modelLabel = context.modelLabelForPreference("gpt-5.6-sol");
  let modeAttempts = 0;
  let modelAttempts = 0;
  const visibleControl = (getText) => ({
    get textContent() {
      return getText();
    },
    get innerText() {
      return getText();
    },
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 88, height: 32 }];
    }
  });
  const modeButton = visibleControl(() => modeLabel);
  const modelButton = visibleControl(() => modelLabel);

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = { innerText: "", textContent: "" };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) =>
    selector === "button,[role='button']" ? [modeButton, modelButton] : [];
  context.selectModePreference = async () => {
    modeAttempts += 1;
    modeLabel = context.modeLabelForPreference("high");
    return true;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    modelLabel = context.modelLabelForPreference("gpt-5.6-sol");
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  modeLabel = "wrong mode";
  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.equal(modeAttempts, 1);
  assert.equal(modelAttempts, 1);
});

test("content script requests extension reload before claiming work when heartbeat is stale", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeMessages = [];
  const sessionValues = new Map();

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.sessionStorage = {
    getItem(key) {
      return sessionValues.get(key) || null;
    },
    setItem(key, value) {
      sessionValues.set(key, value);
    }
  };
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        callback?.({ ok: true });
        return undefined;
      }
    }
  };
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/extension/heartbeat") {
      return {
        reloadExtension: true,
        expectedExtensionVersion: "v20990101-forward"
      };
    }
    throw new Error(`unexpected call ${path}`);
  };

  await context.poll();
  await context.poll();

  assert.deepEqual(bridgeCalls, ["/api/extension/heartbeat", "/api/extension/heartbeat"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:reloadExtension",
      expectedVersion: "v20990101-forward"
    }
  ]);
});

test("content script continues to claim chat work when preference sync is blocked by ChatGPT state", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/project/demo",
          modePreference: "advanced",
          modelPreference: "gpt-5.3",
          updatedAt: "2026-06-28T00:00:00.000Z"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script reports structured blocker failures to Bridge", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        },
        recovery: null
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_human_verification",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "Please analyze the file."
        }
      };
    }
    return {};
  };

  await context.poll();

  const failCall = bridgeCalls.find((call) => call.path === "/api/sync/jobs/sync_human_verification/fail");
  assert.ok(failCall);
  assert.equal(failCall.body.errorCode, "human_verification");
  assert.equal(failCall.body.recoveryAction, "manual_verification");
  assert.match(failCall.body.error, /human verification|\u771f\u4eba\u9a8c\u8bc1/i);
});

test("content script leaves an interim completion running for the next resume poll", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return { controlsCurrentPage: true };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_interim_reply",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "Write a long outline"
        }
      };
    }
    return {};
  };
  context.processJob = async () => {
    const error = new Error("GPT reply is still streaming or interrupted");
    error.status = 409;
    error.errorCode = "interim_chatgpt_reply";
    throw error;
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script reports current ChatGPT page status in heartbeat", async () => {
  const context = await loadContentScriptContext();
  let heartbeatBody = null;
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    return {};
  };

  await context.sendHeartbeat();

  assert.equal(heartbeatBody.pageStatus.state, "blocked");
  assert.equal(heartbeatBody.pageStatus.code, "human_verification");
  assert.equal(heartbeatBody.pageStatus.recoveryAction, "manual_verification");
  assert.match(heartbeatBody.pageStatus.message, /human verification|\u771f\u4eba\u9a8c\u8bc1/i);
});

test("content script does not claim work when heartbeat cannot confirm the bound page", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      throw new Error("bridge unavailable");
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat"]
  );
});

test("content script ignores heartbeat recovery on non-bound ChatGPT pages", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let replacedUrl = null;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/other-chat",
    replace(url) {
      replacedUrl = url;
    },
    reload() {
      throw new Error("wrong ChatGPT page should navigate instead of reload");
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "navigate",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_recover_navigate",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "fresh prompt"
          }
        }
      };
    }
    throw new Error("recovery should happen before claim");
  };

  await context.poll();

  assert.equal(replacedUrl, null);
  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/extension/heartbeat"]);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script ignores navigation-only heartbeat recovery on non-bound ChatGPT pages", async () => {
  const context = await loadContentScriptContext();
  const navigations = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/other-chat",
    replace(url) {
      navigations.push(url);
      this.href = url;
    }
  };

  const recovered = await context.handleHeartbeatRecovery({
    action: "navigate",
    reason: "ChatGPT page is not on the bound conversation",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: null
  });

  assert.equal(recovered, false);
  assert.deepEqual(navigations, []);
});

test("content script does not recover a claimed job from a non-bound ChatGPT page", async () => {
  const context = await loadContentScriptContext();
  let replacedUrl = null;
  const storage = new Map();
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/",
    replace(url) {
      replacedUrl = url;
      this.href = url;
    }
  };
  const workerId = context.currentWorkerId();

  const recovered = await context.handleHeartbeatRecovery({
    action: "reload",
    reason: "Claimed job was never sent",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: {
      id: "sync_stale_unsent",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      workerId,
      payloadText: "continue image generation"
    }
  });

  assert.equal(recovered, false);
  assert.equal(replacedUrl, null);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script sends a stored pre-refresh job before applying another heartbeat recovery", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after stored job" : "",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "pre refresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer after stored job",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_stored_refresh",
        projectUrl: "https://chatgpt.com/c/bound-chat",
        payloadText: "pre refresh prompt"
      }
    })
  );
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    replace() {
      throw new Error("stored pre-refresh job should send instead of navigating again");
    },
    reload() {
      throw new Error("stored pre-refresh job should send instead of reloading again");
    }
  };
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistant()] : [];
    if (selector === "button") return [sendButton];
    if (selector === '[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "reload",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_stale_again",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "stale prompt",
            sentAt: "2026-06-28T04:00:00.000Z"
          },
          resendIfPromptMissing: true
        }
      };
    }
    if (path === "/api/sync/jobs/sync_stored_refresh") {
      return {
        job: {
          id: "sync_stored_refresh",
          status: "running",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          payloadText: "pre refresh prompt"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(sent, true);
  assert.equal(composer.value, "pre refresh prompt");
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
  const stateReads = bridgeCalls.filter(call => call.path === "/api/sync/jobs/sync_stored_refresh");
  assert.ok(stateReads.length > 0);
  assert.ok(stateReads.every(call => !call.options?.method || call.options.method === "GET"));
  assert.deepEqual(
    bridgeCalls.map((call) => call.path).filter(path => path !== "/api/sync/jobs/sync_stored_refresh"),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/sync_stored_refresh/sent",
      "/api/sync/jobs/sync_stored_refresh/complete"
    ]
  );
});

test("content script can interrupt a busy wait with heartbeat recovery", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let reloaded = false;
  let fullPageReads = 0;
  let firstSleepStarted;
  const firstSleep = new Promise((resolve) => {
    firstSleepStarted = resolve;
  });
  let heartbeatCount = 0;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloaded = true;
    },
    replace(url) {
      throw new Error(`same-page recovery should reload instead of navigating to ${url}`);
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.document.body = {
    get innerText() {
      fullPageReads += 1;
      return "bound conversation";
    }
  };
  context.sleep = async () => {
    firstSleepStarted();
    return new Promise(() => {});
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return {
          preferences: {
            projectUrl: "https://chatgpt.com/c/bound-chat"
          }
        };
      }
      return {
        recovery: {
          action: "reload",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_busy_recover",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "busy prompt",
            sentAt: "2026-06-28T04:00:00.000Z"
          },
          resendIfPromptMissing: true
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_busy_original",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          payloadText: "original prompt",
          _bridgeRefreshAttempts: 1
        },
        resume: false
      };
    }
    return {};
  };

  context.poll();
  await firstSleep;
  const readsBeforeBusyHeartbeat = fullPageReads;
  await context.poll();

  assert.equal(reloaded, true);
  assert.equal(fullPageReads, readsBeforeBusyHeartbeat);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim", "/api/extension/heartbeat"]
  );
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_busy_recover");
  assert.equal(stored.job._bridgeResendIfPromptMissing, false);
});

test("content script stops active generation when Bridge cancels the running GPT job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let stopped = false;
  const stopButton = {
    disabled: false,
    textContent: "鍋滄鐢熸垚",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "鍋滄鐢熸垚" : null;
    },
    getClientRects() {
      return stopped ? [] : [{ width: 10, height: 10 }];
    },
    click() {
      stopped = true;
    }
  };

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      throw new Error("cancel recovery should stop generation instead of reloading");
    },
    replace(url) {
      throw new Error(`cancel recovery should not navigate to ${url}`);
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => selector === "button" ? [stopButton] : [];
  context.sleep = async () => {};
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "stop_generation",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_cancel_stop_page",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "cancel me"
          }
        }
      };
    }
    throw new Error(`cancel recovery should not call ${path}`);
  };

  await context.poll();

  assert.equal(stopped, true);
  assert.deepEqual(bridgeCalls, ["/api/extension/heartbeat"]);
});

test("content script throttles duplicate heartbeat recovery for the same job", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloads = 0;

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloads += 1;
    }
  };

  const recovery = {
    action: "reload",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: {
      id: "sync_recovery_once",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "retry once",
      sentAt: "2026-06-28T04:00:00.000Z"
    },
    resendIfPromptMissing: true
  };

  assert.equal(await context.handleHeartbeatRecovery(recovery), true);
  assert.equal(await context.handleHeartbeatRecovery(recovery), false);
  assert.equal(reloads, 1);
});

test("content script ignores stale heartbeat recovery owned by a previous page worker", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloads = 0;

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloads += 1;
    }
  };

  const recovered = await context.handleHeartbeatRecovery({
    action: "reload",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "previous-page-worker",
    job: {
      id: "sync_previous_worker_recovery",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      workerId: "previous-page-worker",
      payloadText: "send after the refreshed page takes over"
    }
  });

  assert.equal(recovered, false);
  assert.equal(reloads, 0);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script ignores recovery issued to a previous worker after the job owner changed", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloads = 0;

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  const currentWorker = context.currentWorkerId();
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloads += 1;
    }
  };

  const recovered = await context.handleHeartbeatRecovery({
    action: "reload",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    workerId: "previous-page-worker",
    job: {
      id: "sync_reassigned_after_recovery",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      workerId: currentWorker,
      _bridgeRecoveryWorkerId: "previous-page-worker",
      payloadText: "must not inherit an old reload"
    }
  });

  assert.equal(recovered, false);
  assert.equal(reloads, 0);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script resumes a sent job without resending it even when a legacy recovery flag is present", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: "answer already generated",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "prompt that is missing from the page",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer already generated",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === "button") return [sendButton];
    if (selector === '[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_resend_missing_prompt",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "prompt that is missing from the page",
      sentAt: "2026-06-28T04:00:00.000Z",
      previousAssistantText: "old answer",
      _bridgeResendIfPromptMissing: true
    },
    { resume: true }
  );

  assert.equal(sent, false);
  assert.equal(composer.value, "");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_resend_missing_prompt/complete"]
  );
});

test("content script navigates back to the project chat before pre-send refresh from a preview URL", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let replacedUrl = null;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_preview_refresh",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "fresh prompt"
      },
      createdAt: "2026-06-28T00:00:00.000Z"
    })
  );
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/backend-api/estuary/content?id=file_preview",
    replace(url) {
      replacedUrl = url;
    },
    reload() {
      throw new Error("preview URLs should navigate back to the project URL instead of reloading");
    }
  };
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (path) => {
    if (path === "/api/sync/jobs/sync_preview_refresh") {
      return {
        job: {
          id: "sync_preview_refresh",
          status: "running",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "fresh prompt"
        }
      };
    }
    if (path !== "/api/extension/heartbeat") {
      throw new Error(`preview pre-send recovery should not claim new work: ${path}`);
    }
    return {};
  };

  await context.poll();

  assert.equal(replacedUrl, "https://chatgpt.com/c/demo");
  assert.ok(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
});

test("artifact preview detection combines URL title and composer state", async () => {
  const context = await loadContentScriptContext();
  const composer = { tagName: "TEXTAREA" };
  const closeButton = {
    textContent: "",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "Close settings" : null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  context.location = {
    href: "https://chatgpt.com/c/report-pdf",
    hostname: "chatgpt.com",
    pathname: "/c/report-pdf"
  };
  context.document.title = "report.pdf";
  context.document.querySelector = (selector) =>
    selector === "#prompt-textarea" ? composer : null;
  context.document.querySelectorAll = (selector) =>
    selector === "button" ? [closeButton] : [];
  assert.equal(context.isArtifactPreviewPage(), false);

  context.location = {
    href: "https://chatgpt.com/backend-api/estuary/content?id=file_preview",
    hostname: "chatgpt.com",
    pathname: "/backend-api/estuary/content"
  };
  context.document.title = "File preview";
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  assert.equal(context.isArtifactPreviewPage(), true);
});

test("artifact preview close matching ignores ordinary labels containing x", async () => {
  const context = await loadContentScriptContext();
  const button = (label) => ({
    textContent: "",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? label : null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  });
  const expandButton = button("Expand image");
  const closeButton = button("Close preview");
  const chineseCloseButton = button("关闭预览");
  const exactXButton = button("×");

  context.document.querySelectorAll = (selector) =>
    selector === "button" ? [expandButton, closeButton] : [];
  assert.equal(context.findArtifactPreviewCloseButton(), closeButton);

  context.document.querySelectorAll = (selector) =>
    selector === "button" ? [expandButton, exactXButton] : [];
  assert.equal(context.findArtifactPreviewCloseButton(), exactXButton);

  context.document.querySelectorAll = (selector) =>
    selector === "button" ? [expandButton, chineseCloseButton] : [];
  assert.equal(context.findArtifactPreviewCloseButton(), chineseCloseButton);
});

test("artifact preview without a close button refreshes before the composer wait", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloads = 0;
  let composerWaits = 0;

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloads += 1;
    }
  };
  context.document.title = "generated-report.pdf";
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.stopStaleGenerationIfNeeded = async () => {};
  context.waitForComposer = async () => {
    composerWaits += 1;
    throw new Error("the 60-second composer wait must not start from a stuck preview");
  };

  await context.processJob({
    id: "sync_preview_without_close",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "fresh prompt"
  });

  assert.equal(reloads, 1);
  assert.equal(composerWaits, 0);
  assert.ok(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
});

test("artifact preview dismissal waits until the preview actually closes", async () => {
  const context = await loadContentScriptContext();
  let previewOpen = true;
  let closeClicks = 0;
  let activityWaits = 0;
  const closeButton = {
    textContent: "",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "Close" : null;
    },
    getClientRects() {
      return previewOpen ? [{ width: 24, height: 24 }] : [];
    },
    click() {
      closeClicks += 1;
    }
  };
  const composer = { tagName: "TEXTAREA" };
  const activityWake = async () => {
    activityWaits += 1;
    if (activityWaits === 1) {
      return false;
    }
    if (activityWaits === 2) {
      previewOpen = false;
      return true;
    }
    throw new Error("preview dismissal did not stop after the preview closed");
  };

  context.document.title = "generated-cover.png";
  context.document.documentElement = { nodeName: "HTML" };
  context.MutationObserver = class {
    observe() {}
  };
  context.sleep = activityWake;
  context.waitForAssistantActivity = activityWake;
  context.document.querySelector = (selector) =>
    selector === "#prompt-textarea" && !previewOpen ? composer : null;
  context.document.querySelectorAll = (selector) =>
    selector === "button" && previewOpen ? [closeButton] : [];

  await context.dismissArtifactPreviewIfNeeded(2_000);

  assert.equal(closeClicks, 1);
  assert.equal(activityWaits, 2);
  assert.equal(previewOpen, false);
});

test("content script closes a ChatGPT artifact preview before sending a job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let previewOpen = true;
  let sent = false;
  const closeButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Close";
      return null;
    },
    getClientRects() {
      return previewOpen ? [{ width: 24, height: 24 }] : [];
    },
    click() {
      previewOpen = false;
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return previewOpen ? [] : [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after preview closed" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.title = "direct-10-icons-v2-01.png";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return previewOpen ? null : composer;
    if (selector === 'button[data-testid="send-button"]') return previewOpen ? null : sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === "button") return previewOpen ? [closeButton] : [sendButton];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_close_preview",
    payloadText: "fresh prompt"
  });

  assert.equal(previewOpen, false);
  assert.equal(composer.value, "fresh prompt");
  assert.equal(sent, true);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_close_preview/sent", "/api/sync/jobs/sync_close_preview/complete"]
  );
});
