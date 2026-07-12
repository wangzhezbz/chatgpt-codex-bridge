import assert from "node:assert/strict";
import test from "node:test";

import { decideRoomRoute } from "../src/room-routing-policy.js";

const boundWorkspace = {
  chatgptProjectUrl: "https://chatgpt.com/project/demo",
  targetRepo: "F:/game_code/demo"
};

test("explicit Codex override keeps attachment work in Codex", () => {
  const route = decideRoomRoute({
    text: "这张截图让 Codex 直接看，不要交给 GPT。",
    attachmentCount: 1,
    workspace: boundWorkspace
  });

  assert.equal(route.kind, "codex_only");
  assert.deepEqual(route.targets, ["codex"]);
  assert.equal(route.syncKind, null);
  assert.match(route.codexPromptText, /Codex/);
});

test("explicit GPT then Codex sequence remains a handoff", () => {
  const route = decideRoomRoute({
    text: "先让 GPT 分析这张截图，然后让 Codex 直接按结论改到项目里。",
    attachmentCount: 1,
    workspace: boundWorkspace
  });

  assert.equal(route.kind, "gpt_then_codex");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "user_request");
  assert.match(route.gptPayloadText, /Codex/);
});
