import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendRoomMessage,
  claimNextCodexTask,
  clearRoomMessages,
  completeCodexTask,
  createCodexTask,
  hideRoomMessage,
  listCodexTasks,
  listRoomMessages
} from "../src/room-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-room-"));
}

test("room messages keep the three-party sender and target", async () => {
  const storeRoot = await tempStore();

  const message = await appendRoomMessage(storeRoot, {
    conversationId: "conv_1",
    from: "user",
    to: ["gpt", "codex"],
    text: "请先分析，再执行。"
  });

  assert.equal(message.from, "user");
  assert.deepEqual(message.to, ["gpt", "codex"]);

  const messages = await listRoomMessages(storeRoot, {
    conversationId: "conv_1"
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "请先分析，再执行。");
});

test("codex tasks are explicitly bound to the current Codex thread", async () => {
  const storeRoot = await tempStore();
  const task = await createCodexTask(storeRoot, {
    conversationId: "conv_1",
    sourceMessageId: "msg_1",
    currentThreadId: "thread_current",
    targetRepo: "F:/game_code/demo",
    promptText: "Create b.txt."
  });

  assert.equal(task.status, "pending");
  assert.equal(task.currentThreadId, "thread_current");

  const claimed = await claimNextCodexTask(storeRoot, {
    currentThreadId: "thread_current"
  });
  assert.equal(claimed.id, task.id);
  assert.equal(claimed.status, "running");

  const completed = await completeCodexTask(storeRoot, claimed.id, {
    resultText: "Created b.txt."
  });
  assert.equal(completed.status, "succeeded");

  const tasks = await listCodexTasks(storeRoot, {
    conversationId: "conv_1"
  });
  assert.equal(tasks[0].resultText, "Created b.txt.");
});

test("room messages can be hidden without deleting the message log", async () => {
  const storeRoot = await tempStore();
  const first = await appendRoomMessage(storeRoot, {
    conversationId: "conv_1",
    from: "user",
    to: ["gpt"],
    text: "keep"
  });
  const second = await appendRoomMessage(storeRoot, {
    conversationId: "conv_1",
    from: "gpt",
    to: ["user"],
    text: "hide me"
  });

  const hidden = await hideRoomMessage(storeRoot, second.id);
  assert.equal(hidden.messageId, second.id);

  assert.deepEqual((await listRoomMessages(storeRoot, { conversationId: "conv_1" })).map((message) => message.id), [
    first.id
  ]);
  assert.deepEqual(
    (await listRoomMessages(storeRoot, { conversationId: "conv_1", includeHidden: true })).map((message) => message.id),
    [first.id, second.id]
  );
});

test("room conversation clear hides only the current conversation", async () => {
  const storeRoot = await tempStore();
  await appendRoomMessage(storeRoot, {
    conversationId: "conv_1",
    from: "user",
    to: ["gpt"],
    text: "old"
  });
  const other = await appendRoomMessage(storeRoot, {
    conversationId: "conv_2",
    from: "user",
    to: ["gpt"],
    text: "other"
  });

  const cleared = await clearRoomMessages(storeRoot, { conversationId: "conv_1" });
  assert.equal(cleared.conversationId, "conv_1");
  assert.ok(cleared.clearedAt);

  assert.equal((await listRoomMessages(storeRoot, { conversationId: "conv_1" })).length, 0);
  assert.deepEqual((await listRoomMessages(storeRoot, { conversationId: "conv_2" })).map((message) => message.id), [
    other.id
  ]);
  assert.equal((await listRoomMessages(storeRoot, { conversationId: "conv_1", includeHidden: true })).length, 1);
});
