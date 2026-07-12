import assert from "node:assert/strict";
import test from "node:test";

import { decideRoomRoute } from "../src/room-routing-policy.js";

test("auto route keeps local execution work in Codex", () => {
  const route = decideRoomRoute({
    text: "检查这个项目的登录模块，直接修复并运行测试",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.deepEqual(route.targets, ["codex"]);
  assert.equal(route.syncKind, null);
  assert.match(route.codexPromptText, /登录模块/);
  assert.match(route.reason, /本地/);
});

test("auto route sends creative generation work to GPT only", () => {
  const route = decideRoomRoute({
    text: "帮我生成 3 张未来感 AI 工作台图片，风格都不一样",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "image_request");
  assert.equal(route.gptPayloadText, "帮我生成 3 张未来感 AI 工作台图片，风格都不一样");
  assert.equal(route.codexPromptText, null);
});

test("auto route does not infer an image request from an explicit no-image constraint", () => {
  const route = decideRoomRoute({
    text: "开始吧。请让 GPT 只回复一句验证结果，不要生成文件、图片，也不要继续其他任务。",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "chat_message");
});

test("auto route splits multi-step creative requests and only sends the first stage to GPT", () => {
  const route = decideRoomRoute({
    text: "我要写一篇玄幻穿越小说，你来协助我。先帮我设计前十集的大纲，再帮我写第一章内容，最后帮我生成一张小说海报。",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/codexbridge-test/novel"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.syncKind, "chat_message");
  assert.equal(route.sequentialPlan.id, "sequential_creative_chain");
  assert.equal(route.sequentialPlan.stages.length, 3);
  assert.match(route.gptPayloadText, /请只完成第 1 步/);
  assert.match(route.gptPayloadText, /前十集的大纲/);
  assert.match(route.gptPayloadText, /不要写第一章/);
  assert.match(route.gptPayloadText, /不要生成海报/);
  assert.doesNotMatch(route.gptPayloadText, /最后帮我生成/);
});

test("auto route sends design-first implementation work through GPT then Codex", () => {
  const route = decideRoomRoute({
    text: "先让 GPT 设计登录页交互和文案，再让 Codex 按方案实现到项目里",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_then_codex");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "user_request");
  assert.match(route.gptPayloadText, /设计登录页/);
  assert.match(route.gptPayloadText, /Codex/);
  assert.match(route.gptPayloadText, /Codex 会默认使用你的结论和产物/);
  assert.match(route.reason, /先 GPT/);
});

test("auto route exposes an explicit GPT then Codex responsibility policy", () => {
  const route = decideRoomRoute({
    text: "分析这个截图，然后按它把登录页改到项目里",
    attachmentCount: 1,
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.policy.id, "gpt_then_codex");
  assert.equal(route.policy.primaryActor, "gpt_then_codex");
  assert.equal(route.policy.codexUsesGptResult, true);
  assert.equal(route.policy.codexMayReanalyzeGptWork, false);
  assert.deepEqual(
    route.policy.stages.map((stage) => stage.actor),
    ["gpt", "codex"]
  );
  assert.match(route.policy.summary, /GPT/);
  assert.match(route.policy.summary, /Codex/);
});

test("auto route policy separates GPT-only generation from Codex-only local execution", () => {
  const gptRoute = decideRoomRoute({
    text: "帮我生成一张未来感 AI 工作台图片",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });
  const codexRoute = decideRoomRoute({
    text: "检查这个项目并运行测试",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(gptRoute.policy.id, "gpt_only");
  assert.equal(gptRoute.policy.primaryActor, "gpt");
  assert.equal(gptRoute.policy.codexUsesGptResult, true);
  assert.deepEqual(gptRoute.policy.stages.map((stage) => stage.actor), ["gpt"]);

  assert.equal(codexRoute.policy.id, "codex_only");
  assert.equal(codexRoute.policy.primaryActor, "codex");
  assert.equal(codexRoute.policy.codexUsesGptResult, false);
  assert.deepEqual(codexRoute.policy.stages.map((stage) => stage.actor), ["codex"]);
});

test("auto route sends attachment analysis to GPT", () => {
  const route = decideRoomRoute({
    text: "分析一下这张图片，告诉我它是什么",
    attachmentCount: 1,
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "chat_message");
  assert.match(route.reason, /附件|分析|GPT/);
  assert.equal(route.codexPromptText, null);
});

test("auto route sends direct Codex attachments to GPT unless the user overrides it", () => {
  const route = decideRoomRoute({
    text: "看看这张图是什么，用中文回答",
    attachmentCount: 1,
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.policy.codexUsesGptResult, true);
  assert.equal(route.policy.codexMayReanalyzeGptWork, false);

  const override = decideRoomRoute({
    text: "这张图不用 GPT，你自己直接看",
    attachmentCount: 1,
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(override.kind, "codex_only");
  assert.deepEqual(override.targets, ["codex"]);
});

test("explicit GPT request overrides simple local-file wording", () => {
  const route = decideRoomRoute({
    text: "发给 GPT 生成一个 b.txt，里面写一句文案",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.deepEqual(route.targets, ["gpt"]);
});

test("auto route sends attachment analysis plus local implementation through GPT then Codex", () => {
  const route = decideRoomRoute({
    text: "分析这个截图，然后按它把登录页改到项目里",
    attachmentCount: 1,
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_then_codex");
  assert.deepEqual(route.targets, ["gpt"]);
  assert.equal(route.syncKind, "user_request");
  assert.match(route.gptPayloadText, /不要声称已经修改/);
});

test("auto route keeps local disk cleanup in Codex", () => {
  const route = decideRoomRoute({
    text: "帮我看看 C 盘有什么可以删的，先告诉我",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.deepEqual(route.targets, ["codex"]);
  assert.equal(route.syncKind, null);
  assert.match(route.codexPromptText, /C 盘/);
});

test("auto route sends long writing and office generation to GPT", () => {
  const articleRoute = decideRoomRoute({
    text: "帮我写一篇完整长文，主题是 ChatGPT 和 Codex 协同",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });
  const deckRoute = decideRoomRoute({
    text: "生成一个 PPT，里面放几个你爱吃的美食",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(articleRoute.kind, "gpt_only");
  assert.equal(deckRoute.kind, "gpt_only");
  assert.equal(articleRoute.codexPromptText, null);
  assert.equal(deckRoute.codexPromptText, null);
});

test("auto route splits sequential creative chains and only sends the first GPT stage", () => {
  const route = decideRoomRoute({
    text: "我要写一篇玄幻穿越小说，你来协助我。先帮我设计前十集的大纲，再帮我写第一章内容，最后帮我生成一张小说海报。",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.syncKind, "chat_message");
  assert.equal(route.sequentialPlan?.stages.length, 3);
  assert.equal(route.sequentialPlan.currentStageIndex, 0);
  assert.match(route.gptPayloadText, /第 1 步/);
  assert.match(route.gptPayloadText, /前十集的大纲/);
  assert.match(route.gptPayloadText, /不要写第一章/);
  assert.match(route.gptPayloadText, /不要生成海报/);
  assert.doesNotMatch(route.gptPayloadText, /再帮我写第一章内容/);
  assert.doesNotMatch(route.gptPayloadText, /最后帮我生成一张小说海报/);
});

test("auto route keeps simple local file creation in Codex", () => {
  const route = decideRoomRoute({
    text: "创建一个 b.txt 文件，里面写一句我想对你说的话",
    workspace: {
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.deepEqual(route.targets, ["codex"]);
  assert.match(route.codexPromptText, /b\.txt/);
});

test("auto route avoids GPT when no ChatGPT project is bound", () => {
  const route = decideRoomRoute({
    text: "帮我写一篇产品说明",
    workspace: {
      chatgptProjectUrl: null,
      targetRepo: "F:/game_code/demo"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.deepEqual(route.targets, ["codex"]);
  assert.match(route.reason, /未绑定/);
});
