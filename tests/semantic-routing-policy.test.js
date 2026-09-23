import assert from "node:assert/strict";
import test from "node:test";

import { decideRoomRoute } from "../src/room-routing-policy.js";

const boundWorkspace = {
  chatgptProjectUrl: "https://chatgpt.com/c/semantic-router",
  targetRepo: "F:/game_code/semantic-router"
};

test("semantic router uses the current Codex model proposal instead of legacy keyword classification", () => {
  const route = decideRoomRoute({
    text: "Analyze this code for concurrency bugs",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "codex_only",
      confidence: 0.94,
      reason: "The task requires local code inspection."
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.equal(route.decisionSource, "semantic_proposal");
  assert.equal(route.policyVersion, "semantic-router-v1");
  assert.equal(route.confidence, 0.94);
  assert.match(route.codexPromptText, /concurrency bugs/);
});

test("semantic router preserves model-proposed GPT stages without combining them", () => {
  const route = decideRoomRoute({
    text: "先设计故事大纲，再写第一章",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.97,
      reason: "This is a staged creative-writing request.",
      stages: [
        {
          id: "outline",
          title: "设计故事大纲",
          actor: "gpt",
          payloadText: "只设计故事大纲，不要写第一章。"
        },
        {
          id: "chapter",
          title: "写第一章",
          actor: "gpt",
          dependsOn: "outline",
          instruction: "使用大纲结果写第一章。"
        }
      ]
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.decisionSource, "semantic_proposal");
  assert.equal(route.sequentialPlan.stages.length, 2);
  assert.equal(route.sequentialPlan.stages[0].id, "outline");
  assert.equal(route.sequentialPlan.stages[1].dependsOn, "outline");
  assert.equal(route.gptPayloadText, "只设计故事大纲，不要写第一章。");
  assert.doesNotMatch(route.gptPayloadText, /使用大纲结果写第一章/);
});

test("semantic router collapses an existing-result revision into one incremental GPT request", () => {
  const text =
    "不要展示那句过程说明，其他内容不变，再扩写到适合录屏占满一页；不要重新生成海报。";
  const route = decideRoomRoute({
    text,
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.98,
      reason: "This is a substantial rewrite of an already completed result.",
      workType: "existing_result_revision",
      gptRequestKind: "user_request",
      stages: [
        {
          id: "outline",
          title: "重新设计前三集",
          actor: "gpt",
          payloadText: "重新设计小说前三集。"
        },
        {
          id: "chapter",
          title: "重新写第一集",
          actor: "gpt",
          dependsOn: "outline",
          instruction: "重新写第一集。"
        },
        {
          id: "poster",
          title: "重新生成海报",
          actor: "gpt",
          dependsOn: "chapter",
          instruction: "重新生成海报。"
        }
      ]
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.gptPayloadText, text);
  assert.equal(route.sequentialPlan, undefined);
  assert.equal(route.routingProposal.workType, "existing_result_revision");
  assert.deepEqual(route.routingProposal.stages, []);
  assert.equal(route.policy.stages.length, 1);
  assert.equal(route.policy.stages[0].actor, "gpt");
  assert.doesNotMatch(JSON.stringify(route.policy.stages), /前三集|第一集|海报/);
});

test("semantic router lets explicit no-GPT wording override a GPT proposal", () => {
  const route = decideRoomRoute({
    text: "不要交给 GPT，让 Codex 自己完成",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.99,
      reason: "Creative request"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.equal(route.decisionSource, "explicit_user_override");
  assert.equal(route.confidence, 1);
});

test("semantic router keeps an unbound request in Codex even when the model proposes GPT", () => {
  const route = decideRoomRoute({
    text: "写一篇产品发布文案",
    workspace: {
      chatgptProjectUrl: null,
      targetRepo: "F:/game_code/semantic-router"
    },
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.99,
      reason: "Long-form copywriting"
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.equal(route.decisionSource, "scope_guard");
  assert.equal(route.confidence, 1);
});

test("semantic router conservatively keeps low-confidence proposals in Codex", () => {
  const route = decideRoomRoute({
    text: "帮我优化一下这个东西",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    semanticRouterMinConfidence: 0.7,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.42,
      reason: "The request is ambiguous."
    }
  });

  assert.equal(route.kind, "codex_only");
  assert.equal(route.decisionSource, "semantic_low_confidence");
  assert.equal(route.needsClarification, true);
  assert.equal(route.confidence, 0.42);
});

test("semantic routing remains disabled by default for backward compatibility", () => {
  const route = decideRoomRoute({
    text: "写一篇产品发布文案",
    workspace: boundWorkspace,
    routingProposal: {
      version: "1",
      routeKind: "codex_only",
      confidence: 0.99,
      reason: "A deliberately conflicting proposal"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.decisionSource, undefined);
});

test("semantic router rejects actor plans that contradict the proposed route", () => {
  assert.throws(
    () =>
      decideRoomRoute({
        text: "处理这个任务",
        workspace: boundWorkspace,
        semanticRouterEnabled: true,
        routingProposal: {
          version: "1",
          routeKind: "gpt_only",
          confidence: 0.9,
          stages: [
            {
              id: "local-edit",
              title: "修改本地项目",
              actor: "codex"
            }
          ]
        }
      }),
    /gpt_only.*Codex stages/
  );
});

test("semantic router requires both executors when a gpt_then_codex proposal includes stages", () => {
  assert.throws(
    () =>
      decideRoomRoute({
        text: "先分析再实现",
        workspace: boundWorkspace,
        semanticRouterEnabled: true,
        routingProposal: {
          version: "1",
          routeKind: "gpt_then_codex",
          confidence: 0.9,
          stages: [
            {
              id: "implement",
              title: "修改本地项目",
              actor: "codex"
            }
          ]
        }
      }),
    /gpt_then_codex.*both GPT and Codex/
  );
});

test("semantic router uses the model-proposed GPT request kind", () => {
  const route = decideRoomRoute({
    text: "给这个故事制作一张海报",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.96,
      gptRequestKind: "image_request",
      stages: [
        {
          id: "poster",
          title: "制作海报",
          actor: "gpt",
          payloadText: "根据故事设定制作海报。"
        }
      ]
    }
  });

  assert.equal(route.syncKind, "image_request");
});

test("semantic router removes an image stage that the user explicitly rejected", () => {
  const text =
    "请设计小说前3集并写出第一集详细正文。本阶段不要生成海报。";
  const route = decideRoomRoute({
    text,
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_only",
      confidence: 0.99,
      gptRequestKind: "user_request",
      stages: [
        {
          id: "story",
          title: "小说策划与第一集正文",
          actor: "gpt",
          payloadText: text,
          instruction: "完成小说策划和正文，不要生成海报。"
        },
        {
          id: "poster",
          title: "小说海报",
          actor: "gpt",
          dependsOn: "story",
          instruction: "根据上一阶段的设定生成小说海报。"
        }
      ]
    }
  });

  assert.deepEqual(
    route.sequentialPlan.stages.map((stage) => stage.id),
    ["story"]
  );
  assert.equal(route.syncKind, "user_request");
  assert.equal(route.routingProposal.stages.length, 1);
  assert.equal(route.routingProposal.stages[0].id, "story");
});

test("semantic router keeps a pure creative chain in GPT when a proposal wrongly assigns poster generation to Codex", () => {
  const route = decideRoomRoute({
    text: "我想写一本小说，你帮我设计小说的前3集，还有第一集详细的内容，再给我一张海报",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_then_codex",
      confidence: 0.99,
      reason: "Incorrectly planned local image generation.",
      workType: "creative_writing_and_image_generation",
      gptRequestKind: "user_request",
      stages: [
        {
          id: "outline",
          title: "设计小说前三集",
          actor: "gpt",
          payloadText: "只设计小说前三集。"
        },
        {
          id: "episode1",
          title: "撰写第一集",
          actor: "gpt",
          dependsOn: "outline",
          instruction: "承接前三集设计，撰写第一集。"
        },
        {
          id: "poster_direction",
          title: "设计海报视觉",
          actor: "gpt",
          dependsOn: "episode1",
          instruction: "设计海报提示词。"
        },
        {
          id: "poster_generation",
          title: "生成海报",
          actor: "codex",
          dependsOn: "poster_direction",
          instruction: "调用本地图像工具生成最终海报。"
        }
      ]
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.decisionSource, "semantic_capability_guard");
  assert.equal(route.syncKind, "chat_message");
  assert.deepEqual(
    route.sequentialPlan.stages.map((stage) => stage.id),
    ["outline", "chapter", "poster"]
  );
  assert.doesNotMatch(route.gptPayloadText, /Codex|本地项目目录|交接内容/);
});

test("semantic router gives an explicit GPT instruction priority over a Codex proposal", () => {
  const route = decideRoomRoute({
    text: "请明确交给 GPT 写这段文案",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "codex_only",
      confidence: 0.9,
      reason: "Incorrect model proposal"
    }
  });

  assert.equal(route.kind, "gpt_only");
  assert.equal(route.decisionSource, "explicit_user_override");
  assert.equal(route.confidence, 1);
});

test("semantic gpt_then_codex stages keep the local-execution guard in the submitted GPT payload", () => {
  const route = decideRoomRoute({
    text: "先设计登录页，再在项目里实现",
    workspace: boundWorkspace,
    semanticRouterEnabled: true,
    routingProposal: {
      version: "1",
      routeKind: "gpt_then_codex",
      confidence: 0.95,
      stages: [
        {
          id: "design",
          title: "设计登录页",
          actor: "gpt",
          payloadText: "设计登录页的交互和视觉方案。"
        },
        {
          id: "implement",
          title: "实现登录页",
          actor: "codex",
          dependsOn: "design",
          instruction: "把设计方案实现到本地项目。"
        }
      ]
    }
  });

  assert.match(route.sequentialPlan.stages[0].payloadText, /不要声称已经修改/);
  assert.equal(route.sequentialPlan.stages[0].payloadText, route.gptPayloadText);
});
