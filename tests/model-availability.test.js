import assert from "node:assert/strict";
import test from "node:test";
import { applyModelAvailability } from "../public/model-availability.js";

const workspace = {chatgptProjectUrl:"https://chatgpt.com/c/a"};
function setup() {
  return {value:"gpt-5.4",options:["latest","gpt-5.6-sol","gpt-5.4","o3"].map(value=>({value,textContent:value,disabled:false,hidden:false}))};
}
const evidence = {connected:true,projectMatches:true,heartbeat:{href:workspace.chatgptProjectUrl,preferenceStatus:{pageUrl:workspace.chatgptProjectUrl,availableModels:["latest","gpt-5.6-sol"]}}};

test("unavailable current model remains visibly unavailable instead of silently switching",()=>{
  const select=setup();
  applyModelAvailability(select,evidence,workspace);
  assert.equal(select.value,"gpt-5.4");
  assert.equal(select.options[2].disabled,true);
  assert.equal(select.options[2].hidden,false);
  assert.match(select.options[2].textContent,/不可用/);
  assert.equal(select.options[3].hidden,true);
  assert.equal(select.options[0].disabled,false);
});
test("another project or a disconnected page cannot filter this projects models",()=>{
  for(const ext of [{...evidence,connected:false},{...evidence,projectMatches:false}]){
    const select=setup();applyModelAvailability(select,ext,workspace);
    assert.ok(select.options.every(option=>!option.hidden&&!option.disabled));
  }
  const select=setup();applyModelAvailability(select,evidence,{chatgptProjectUrl:"https://chatgpt.com/c/b"});
  assert.ok(select.options.every(option=>!option.disabled));
});
test("model availability resets when leaving a project with narrower capabilities",()=>{
  const select=setup();applyModelAvailability(select,evidence,workspace);
  applyModelAvailability(select,null,workspace);
  assert.equal(select.options[2].textContent,"gpt-5.4");
  assert.ok(select.options.every(option=>!option.hidden&&!option.disabled));
});
