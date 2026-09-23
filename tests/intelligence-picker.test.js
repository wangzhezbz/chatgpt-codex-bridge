import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { normalizeChatGptPreferences } from "../src/preference-compat.js";

// DOM boundary fixture based on the September 9 live composer. Inactive panels
// still have client rects; the slider thumb is aria-hidden, its menuitem owns keys.
async function fixture({ triggerLabel = "中", pointerRequired = false, stuckModel = false, stuckSlider = false, max = 4, labels = ["极速", "中", "高", "极高", "Pro"] } = {}) {
  const state = { open: false, advanced: false, selected: "最新", value: 1, clicks: [], keys: [] };
  const el = (attrs = {}, text = "") => ({
    textContent: text, innerText: text, tagName: "DIV",
    getAttribute: (name) => attrs[name] ?? null,
    getClientRects: () => [{ width: 200, height: 32 }],
    closest: () => null, focus() {}, click() {}, dispatchEvent() {}
  });
  const trigger = el({ "aria-haspopup": "menu" }, triggerLabel);
  trigger.tagName = "BUTTON";
  const open = () => { state.open = !state.open; state.advanced = false; state.clicks.push("trigger"); };
  trigger.click = () => { if (!pointerRequired) open(); };
  trigger.dispatchEvent = event => { if (pointerRequired && event.type === "pointerdown") open(); };
  const toggle = el({ "aria-label": "选择模型", role: "menuitem" }, "中");
  toggle.click = () => { state.advanced = true; state.clicks.push("toggle"); };
  const slider = el({ role: "slider", "aria-hidden": "true" });
  slider.getAttribute = name => ({ "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(state.value), "aria-hidden": "true" })[name] ?? null;
  const announcement = el();
  Object.defineProperty(announcement, "textContent", { get: () => `${labels[state.value]}，第 ${state.value + 1} 项，共 ${max + 1} 项。` });
  const control = el({ role: "menuitem", "aria-label": "能力", "aria-describedby": "effort-announcement effort-help" });
  control.dispatchEvent = event => {
    if (event.type !== "keydown") return;
    state.keys.push(event.key);
    if (!stuckSlider) state.value = Math.max(0, Math.min(max, state.value + (event.key === "ArrowRight" ? 1 : -1)));
  };
  const radios = ["最新", "GPT-5.6 Sol", "GPT-5.5"].map(label => {
    const radio = el({ role: "menuitemradio" }, label);
    radio.getAttribute = name => name === "aria-checked" ? String(state.selected === label) : name === "role" ? "menuitemradio" : null;
    radio.closest = selector => selector.includes("inert") && !state.advanced ? {} : null;
    radio.click = () => {
      assert.equal(state.advanced, true, "hidden model panel must not be clicked");
      state.clicks.push(label);
      if (!stuckModel) state.selected = label;
    };
    return radio;
  });
  const picker = el();
  picker.querySelectorAll = selector => selector.includes("menuitemradio") ? radios : selector.includes("menuitem") ? [toggle, control] : [];
  picker.querySelector = selector => selector.includes("slider") ? slider : selector.includes("选择模型") || selector.includes("Select model") ? toggle : selector.includes("能力") || selector.includes("Capability") ? control : null;
  const scope = { querySelectorAll: () => [trigger] };
  const composer = { closest: () => scope, parentElement: null };
  const listeners = new Map();
  const document = {
    addEventListener: (type, callback) => listeners.set(type, callback),
    querySelector: selector => selector === "#prompt-textarea" ? composer : selector.includes("composer-intelligence-picker-content") && state.open ? picker : null,
    querySelectorAll: selector => selector.includes("button") ? [trigger] : [],
    getElementById: id => id === "effort-announcement" ? announcement : null,
    dispatchEvent: event => { if (event.key === "Escape") state.open = false; }
  };
  const context = { console, document, location: {hostname:"example.com",href:"https://example.com/"}, URL,
    InputEvent: class {}, PointerEvent: class {constructor(type,args){this.type=type;Object.assign(this,args);}}, KeyboardEvent: class {constructor(type, args){this.type=type;Object.assign(this,args);}},
    setInterval(){}, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(await readFile("chrome-extension/bridge-config.js", "utf8"), context);
  vm.runInContext(await readFile("chrome-extension/content-script.js", "utf8"), context);
  context.sleep = async () => {};
  return { state, context, trigger, picker, radios, listeners };
}

test("latest survives normalization without being aliased to Astra", () => {
  assert.deepEqual(normalizeChatGptPreferences({modelPreference:"latest",modePreference:"pro"}), {modelPreference:"latest",modePreference:"pro"});
});

test("Radix composer trigger opens on pointerdown, not synthetic click", async () => {
  const {context,state} = await fixture({pointerRequired:true});
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"high"}),true);
  assert.equal(state.value,3);
});

test("current Chinese Instant label is 即时 and remains a valid closed trigger", async () => {
  const {context,state} = await fixture({pointerRequired:true,triggerLabel:"即时",labels:["即时","中","高","极高","Pro"]});
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"fast"}),true);
  assert.equal(state.value,0);
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"balanced"}),true);
});

test("September picker opens the model view and verifies the checked radio", async () => {
  const {context,state} = await fixture();
  assert.equal(await context.selectModelPreference({modelPreference:"gpt-5.6-sol"}), true);
  assert.equal(state.selected,"GPT-5.6 Sol");
  assert.ok(state.clicks.indexOf("toggle") < state.clicks.indexOf("GPT-5.6 Sol"));
  assert.equal(state.open,false);
});

test("September picker rejects a model click that did not change the selection", async () => {
  const {context,state} = await fixture({stuckModel:true});
  assert.equal(await context.selectModelPreference({modelPreference:"gpt-5.6-sol"}), false);
  assert.equal(state.selected,"最新");
});

test("September picker drives the keyboard owner and reads back slider value", async () => {
  const {context,state} = await fixture();
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"high"}), true);
  assert.equal(state.value,3);
  assert.deepEqual(state.keys,["ArrowRight","ArrowRight"]);
  assert.equal(state.open,false);
});

test("September picker does not claim success for a stuck slider", async () => {
  const {context,state} = await fixture({stuckSlider:true});
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"high"}), false);
  assert.equal(state.value,1);
  assert.ok(state.keys.length <= 2);
});

test("September picker rejects a requested tier absent from this account", async () => {
  const {context,state} = await fixture({max:2});
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"pro"}), false);
  assert.deepEqual(state.keys,[]);
});

test("September picker rejects numeric tiers with an unexpected semantic label", async () => {
  const {context} = await fixture({labels:["极速","中","高","Other tier","Pro"]});
  assert.equal(await context.selectModePreference({modelPreference:"latest",modePreference:"high"}), false);
});

test("explicit Astra cannot silently select latest", async () => {
  const {context,state} = await fixture();
  assert.equal(await context.selectModelPreference({modelPreference:"gpt-6-astra"}), false);
  assert.equal(state.selected,"最新");
});

test("legacy candidate search excludes inert advanced panels even with client rects", async () => {
  const {context,radios} = await fixture();
  context.document.querySelectorAll = () => radios;
  assert.equal(context.bestMenuCandidate(["GPT-5.6 Sol"]),null);
});

test("successful September heartbeat does not reopen the picker every poll", async () => {
  const {context,state} = await fixture();
  context.location = {hostname:"chatgpt.com",href:"https://chatgpt.com/c/fixture"};
  context.assertNoChatGptBlocker = () => {};
  context.waitForComposer = async () => ({});
  const prefs = {projectUrl:context.location.href,modelPreference:"latest",modePreference:"balanced",updatedAt:"2026-09-09"};
  assert.equal(await context.applyHeartbeatPreferences(prefs),true);
  const clicks = state.clicks.length;
  assert.equal(await context.applyHeartbeatPreferences(prefs),true);
  assert.equal(state.clicks.length,clicks);
});

test("send preflight refuses unsupported modern model instead of sending on latest", async () => {
  const {context} = await fixture();
  await assert.rejects(() => context.applyJobPreferences({modelPreference:"gpt-5.3",modePreference:"fast"}),
    error => error.errorCode === "preference_not_applied");
});

test("send preflight rechecks model after a previously successful heartbeat", async () => {
  const {context,state} = await fixture();
  await context.selectModelPreference({modelPreference:"gpt-5.6-sol"});
  state.selected = "最新";
  await context.applyJobPreferences({modelPreference:"gpt-5.6-sol",modePreference:"high"});
  assert.equal(state.selected,"GPT-5.6 Sol");
  assert.equal(state.value,3);
});

test("failed heartbeat model selection must leave the current effort unchanged", async () => {
  const {context,state} = await fixture();
  context.location = {hostname:"chatgpt.com",href:"https://chatgpt.com/c/fixture"};
  context.assertNoChatGptBlocker = () => {};
  context.waitForComposer = async () => ({});
  const ok = await context.applyHeartbeatPreferences({projectUrl:context.location.href,modelPreference:"gpt-5.4",modePreference:"high",updatedAt:"new-request"});
  assert.equal(ok,false);
  assert.equal(state.selected,"最新");
  assert.equal(state.value,1);
});

test("model verification reopens a popup that closes asynchronously before radio commit", async () => {
  const {context,state,radios} = await fixture();
  let pending = false;
  radios[1].click = () => {pending=true;};
  context.sleep = async () => { if(pending){pending=false;state.open=false;state.selected="GPT-5.6 Sol";} };
  assert.equal(await context.selectModelPreference({modelPreference:"gpt-5.6-sol"}),true);
  assert.equal(state.clicks.filter(x=>x==="trigger").length,2);
});

test("trusted manual picker interaction invalidates cached success without restoring old preferences", async () => {
  const {context,state,trigger,listeners} = await fixture();
  context.location = {hostname:"chatgpt.com",href:"https://chatgpt.com/c/fixture"};
  context.assertNoChatGptBlocker=()=>{};
  context.waitForComposer=async()=>({});
  const prefs={projectUrl:context.location.href,modelPreference:"latest",modePreference:"balanced",updatedAt:"original"};
  await context.applyHeartbeatPreferences(prefs);
  assert.equal(typeof listeners.get("pointerdown"),"function");
  listeners.get("pointerdown")({isTrusted:true,target:trigger});
  state.selected="GPT-5.5"; state.value=3;
  const count=state.clicks.length;
  assert.equal(await context.applyHeartbeatPreferences(prefs),false);
  assert.equal(context.preferencesAlreadyApplied(prefs),false);
  assert.equal(state.clicks.length,count);
  assert.equal(state.selected,"GPT-5.5");
  assert.equal(await context.applyHeartbeatPreferences({...prefs,updatedAt:"explicit-resync"}),true);
  assert.equal(state.selected,"最新");
});

test("capability evidence is included in real heartbeat payload only for its page", async () => {
  const {context}=await fixture();
  context.location={hostname:"chatgpt.com",href:"https://chatgpt.com/c/fixture"};
  context.assertNoChatGptBlocker=()=>{};
  context.waitForComposer=async()=>({});
  await context.applyHeartbeatPreferences({projectUrl:context.location.href,modelPreference:"latest",modePreference:"balanced",updatedAt:"observed"});
  const payloads=[];
  context.currentPageStatus=()=>({state:"ready"});
  context.bridgeApi=async(_path,options)=>{payloads.push(JSON.parse(options.body));};
  await context.sendHeartbeat();
  assert.deepEqual(payloads[0].preferenceStatus.availableModels,["latest","gpt-5.6-sol","gpt-5.5"]);
  assert.equal(payloads[0].preferenceStatus.pageUrl,context.location.href);
  context.location.href="https://chatgpt.com/c/other";
  await context.sendHeartbeat();
  assert.equal(payloads[1].preferenceStatus,null);
});

test("effort selection must not silently switch away from the requested model", async () => {
  const {context,state,picker}=await fixture();
  const owner=picker.querySelector('[aria-label="能力"]');
  const original=owner.dispatchEvent;
  owner.dispatchEvent=event=>{original(event);if(event.type==="keydown")state.selected="最新";};
  await assert.rejects(()=>context.applyJobPreferences({modelPreference:"gpt-5.6-sol",modePreference:"high"}),error=>error.errorCode==="preference_not_applied");
});

test("failed preference sync job uses failure endpoint, never successful completion or artifact errors", async () => {
  const {context}=await fixture();
  context.ensureExpectedChatGptPage=()=>true;
  context.waitForComposer=async()=>({});
  const calls=[];
  context.bridgeApi=async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});};
  await context.processJobAndReportFailure({id:"preferences-test",kind:"preference_sync",modelPreference:"gpt-5.4",modePreference:"high"});
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,"/api/sync/jobs/preferences-test/fail");
  assert.equal(calls[0].body.errorCode,"preference_not_applied");
  assert.equal(calls[0].body.artifactErrors,undefined);
});

test("successful send revalidation clears manual unverified status only for matching preferences", async () => {
  const {context,state,trigger,listeners}=await fixture();
  context.location={hostname:"chatgpt.com",href:"https://chatgpt.com/c/fixture"};
  context.assertNoChatGptBlocker=()=>{};context.waitForComposer=async()=>({});
  const prefs={projectUrl:context.location.href,modelPreference:"latest",modePreference:"balanced",updatedAt:"desired"};
  await context.applyHeartbeatPreferences(prefs);
  listeners.get("pointerdown")({isTrusted:true,target:trigger});state.selected="GPT-5.5";
  await context.applyJobPreferences(prefs);
  assert.equal(context.preferencesAlreadyApplied(prefs),true);
});

async function evidenceFixture() {
  const {context}=await fixture();
  let callback, now=0, sleeps=0, disconnected=0;
  const timers=new Map();
  context.document.documentElement={};
  context.Date=class extends Date {static now(){return now;}};
  context.MutationObserver=class {
    constructor(cb){callback=cb;}
    observe(){}
    disconnect(){disconnected++;}
  };
  context.setTimeout=(cb)=>{timers.set(1,cb);return 1;};
  context.clearTimeout=id=>timers.delete(id);
  context.sleep=async()=>{sleeps++;now+=100;};
  return {context,timers,mutate:()=>callback?.(),advance:ms=>{now+=ms;},stats:()=>({sleeps,disconnected})};
}

test("preference evidence resolves on DOM mutation without timer polling and releases resources",async()=>{
  const h=await evidenceFixture();let node=null;
  const pending=h.context.waitForPreferenceEvidence(()=>node);
  node={checked:true};h.mutate();
  assert.equal(await pending,node);
  assert.equal(h.stats().sleeps,0);
  assert.equal(h.stats().disconnected,1);
  assert.equal(h.timers.size,0);
});

test("preference evidence rejects evidence arriving after the wall-clock deadline",async()=>{
  const h=await evidenceFixture();let ready=false;
  const pending=h.context.waitForPreferenceEvidence(()=>ready);
  h.advance(60000);ready=true;h.mutate();
  assert.equal(await pending,null);
  assert.equal(h.stats().disconnected,1);
  assert.equal(h.timers.size,0);
});

test("preference evidence timeout disconnects its observer",async()=>{
  const h=await evidenceFixture();
  const pending=h.context.waitForPreferenceEvidence(()=>false);
  assert.equal(h.timers.size,1);
  h.advance(1000);h.timers.get(1)();
  assert.equal(await pending,null);
  assert.equal(h.stats().disconnected,1);
  assert.equal(h.timers.size,0);
});

test("preference evidence predicate errors release observers and timers",async()=>{
  const h=await evidenceFixture();let broken=false;
  const pending=h.context.waitForPreferenceEvidence(()=>{if(broken)throw new Error('read failed');return false;});
  broken=true;h.mutate();
  await assert.rejects(pending,/read failed/);
  assert.equal(h.stats().disconnected,1);
  assert.equal(h.timers.size,0);
});

test("preference evidence fallback stops after a delayed timer instead of spending ten delayed ticks",async()=>{
  const h=await evidenceFixture();delete h.context.MutationObserver;
  let sleeps=0;
  h.context.sleep=async()=>{sleeps++;h.advance(60000);};
  assert.equal(await h.context.waitForPreferenceEvidence(()=>false),null);
  assert.equal(sleeps,1);
});

test("full preference revalidation handles asynchronous menu changes without polling sleeps",async()=>{
  const {context,state,trigger,radios}=await fixture({pointerRequired:true});
  const observers=new Set();
  const notify=()=>{for(const cb of [...observers])cb();};
  context.document.documentElement={};
  context.MutationObserver=class{constructor(cb){this.cb=cb;}observe(){observers.add(this.cb);}disconnect(){observers.delete(this.cb);}};
  const dispatch=trigger.dispatchEvent;
  trigger.dispatchEvent=event=>queueMicrotask(()=>{dispatch(event);notify();});
  const close=context.document.dispatchEvent;
  context.document.dispatchEvent=event=>queueMicrotask(()=>{close(event);notify();});
  const option=radios[2],activate=option.click;
  option.click=()=>queueMicrotask(()=>{activate();state.open=false;notify();});
  context.sleep=async()=>{throw new Error('unexpected preference polling sleep');};
  await context.applyJobPreferences({modelPreference:'gpt-5.5',modePreference:'balanced'});
  assert.equal(state.selected,'GPT-5.5');
  assert.equal(state.value,1);
  assert.equal(state.clicks.filter(x=>x==='GPT-5.5').length,1);
  assert.equal(observers.size,0);
});
