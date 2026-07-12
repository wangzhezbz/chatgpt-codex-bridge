import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createChatTurn,
  getWorkspaceBinding,
  importChatGptReply,
  listChatMessages,
  updateWorkspaceBinding
} from "../src/conversation-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-conversation-"));
}

test("workspace binding persists the ChatGPT project URL and local target repo", async () => {
  const storeRoot = await tempStore();

  const binding = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/g/g-project-demo/project",
    targetRepo: "F:/game_code/demo"
  });

  assert.equal(binding.chatgptProjectUrl, "https://chatgpt.com/g/g-project-demo/project");
  assert.equal(binding.targetRepo, "F:/game_code/demo");

  const saved = await getWorkspaceBinding(storeRoot);
  assert.equal(saved.chatgptProjectUrl, binding.chatgptProjectUrl);
  assert.equal(saved.targetRepo, binding.targetRepo);
  assert.match(saved.conversationId, /^conv_\d{8}T\d{6}_/);
});

test("workspace binding normalizes retired ChatGPT model preferences on read", async () => {
  const storeRoot = await tempStore();

  await writeFile(
    path.join(storeRoot, "workspace.json"),
    `${JSON.stringify({
      chatgptProjectUrl: "https://chatgpt.com/project/demo",
      targetRepo: "F:/game_code/demo",
      modePreference: "balanced",
      modelPreference: "gpt-4.5",
      updatedAt: "2026-06-28T00:00:00.000Z"
    })}\n`,
    "utf8"
  );

  const saved = await getWorkspaceBinding(storeRoot);
  assert.equal(saved.modePreference, "balanced");
  assert.equal(saved.modelPreference, null);
});

test("workspace binding keeps preference timestamp separate from metadata updates", async () => {
  const storeRoot = await tempStore();

  const first = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol"
  });
  assert.ok(first.preferenceUpdatedAt);

  const second = await updateWorkspaceBinding(storeRoot, {
    projectId: "project-demo"
  });

  assert.equal(second.modePreference, "high");
  assert.equal(second.modelPreference, "gpt-5.6-sol");
  assert.equal(second.preferenceUpdatedAt, first.preferenceUpdatedAt);
});

test("changing the project binding starts a clean visible conversation", async () => {
  const storeRoot = await tempStore();
  const first = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/one",
    targetRepo: "F:/game_code/one"
  });

  await createChatTurn(storeRoot, {
    text: "First project message"
  });
  assert.equal((await listChatMessages(storeRoot)).length, 1);

  const second = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/two",
    targetRepo: "F:/game_code/two"
  });

  assert.notEqual(second.conversationId, first.conversationId);
  assert.deepEqual(await listChatMessages(storeRoot), []);

  await createChatTurn(storeRoot, {
    text: "Second project message"
  });
  const messages = await listChatMessages(storeRoot);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "Second project message");
});

test("createChatTurn with a bound project queues ChatGPT sync before Codex runs", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo"
  });

  const turn = await createChatTurn(storeRoot, {
    text: "让 ChatGPT 规划一下登录模块该怎么修。"
  });

  assert.equal(turn.user.role, "user");
  assert.equal(turn.assistant, null);
  assert.equal(turn.task, null);
  assert.equal(turn.syncJob.kind, "user_request");
  assert.equal(turn.syncJob.status, "pending");
  assert.match(turn.syncJob.payloadText, /登录模块/);
  assert.doesNotMatch(turn.syncJob.payloadText, /给 Codex 的具体任务/);
  assert.doesNotMatch(turn.syncJob.payloadText, /验收方式/);

  const messages = await listChatMessages(storeRoot);
  assert.deepEqual(messages.map((message) => message.kind), ["message"]);
});

test("createChatTurn treats a greeting as normal chat instead of a Codex handoff", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo"
  });

  const turn = await createChatTurn(storeRoot, {
    text: "你好"
  });

  assert.equal(turn.assistant, null);
  assert.equal(turn.task, null);
  assert.equal(turn.syncJob.kind, "chat_message");
  assert.doesNotMatch(turn.syncJob.payloadText, /给 Codex 的具体任务/);
  assert.doesNotMatch(turn.syncJob.payloadText, /验收方式/);
  assert.match(turn.syncJob.payloadText, /自然、简短地回应/);
});

test("createChatTurn warns ChatGPT not to claim local files are generated", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo"
  });

  const turn = await createChatTurn(storeRoot, {
    text: "帮我生成一个 b.txt 文件"
  });

  assert.equal(turn.syncJob.kind, "user_request");
  assert.match(turn.syncJob.payloadText, /不要声称已经创建、生成、下载或修改了本地文件/);
  assert.match(turn.syncJob.payloadText, /Codex/);
});

test("createChatTurn sends image generation requests to ChatGPT without project handoff framing", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo"
  });
  const text = "\u8bf7\u751f\u56fe\uff1a10 \u5f20\u4e0d\u540c\u989c\u8272\u7684\u5706\u5f62\u56fe\u6807";

  const turn = await createChatTurn(storeRoot, { text });

  assert.equal(turn.syncJob.kind, "image_request");
  assert.equal(turn.syncJob.payloadText, text);
  assert.doesNotMatch(turn.syncJob.payloadText, /Codex/);
  assert.doesNotMatch(turn.syncJob.payloadText, /targetRepo|F:\/game_code/);
});

test("createChatTurn without a bound project falls back to a Codex task", async () => {
  const storeRoot = await tempStore();

  const turn = await createChatTurn(storeRoot, {
    text: "直接检查项目。"
  });

  assert.equal(turn.assistant.kind, "codex_task");
  assert.equal(turn.syncJob, null);
  assert.equal(turn.task.status, "queued");
});

test("importChatGptReply can turn a pasted ChatGPT answer into a Codex task", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    targetRepo: "F:/game_code/demo"
  });

  const imported = await importChatGptReply(storeRoot, {
    text: "计划：先检查登录路由，再补一个失败测试，最后修复。",
    createTask: true
  });

  assert.equal(imported.message.role, "chatgpt");
  assert.equal(imported.task.title, "GPT 规划执行");
  assert.equal(imported.task.targetRepo, "F:/game_code/demo");
  assert.equal(imported.task.status, "queued");
});
