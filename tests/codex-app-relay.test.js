import assert from "node:assert/strict";
import test from "node:test";

import { buildRoomCodexPrompt, relayCodexTaskToThread } from "../src/codex-app-relay.js";

test("buildRoomCodexPrompt tells the current thread how to complete the room task", () => {
  const prompt = buildRoomCodexPrompt(
    {
      id: "roomcodex_1",
      targetRepo: "F:/game_code/test",
      promptText: "# 用户消息\n\n你好"
    },
    {
      bridgeBaseUrl: "http://127.0.0.1:4317"
    }
  );

  assert.match(prompt, /roomcodex_1/);
  assert.match(prompt, /F:\/game_code\/test/);
  assert.match(prompt, /你好/);
  assert.match(prompt, /api\/current-codex\/roomcodex_1\/complete/);
  assert.match(prompt, /api\/current-codex\/roomcodex_1\/fail/);
});

test("relayCodexTaskToThread sends a turn/start request to the app server", async () => {
  const sent = [];

  class FakeWebSocket {
    static instances = [];

    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      FakeWebSocket.instances.push(this);
      queueMicrotask(() => this.listeners.get("open")?.({}));
    }

    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }

    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      if (message.method === "initialize") {
        queueMicrotask(() =>
          this.listeners.get("message")?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { userAgent: "fake" }
            })
          })
        );
      }
      if (message.method === "thread/resume") {
        queueMicrotask(() =>
          this.listeners.get("message")?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { thread: { id: message.params.threadId } }
            })
          })
        );
      }
      if (message.method === "turn/start") {
        queueMicrotask(() =>
          this.listeners.get("message")?.({
            data: JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { turnId: "turn_1" }
            })
          })
        );
      }
    }

    close() {}
  }

  const result = await relayCodexTaskToThread(
    {
      id: "roomcodex_1",
      currentThreadId: "thread_current",
      targetRepo: "F:/game_code/test",
      promptText: "你好"
    },
    {
      appServerUrl: "ws://127.0.0.1:43219",
      bridgeBaseUrl: "http://127.0.0.1:4317",
      WebSocketImpl: FakeWebSocket
    }
  );

  assert.equal(result.status, "sent");
  assert.equal(FakeWebSocket.instances[0].url, "ws://127.0.0.1:43219");
  assert.deepEqual(
    sent.map((message) => message.method),
    ["initialize", "thread/resume", "turn/start"]
  );
  assert.equal(sent[1].params.threadId, "thread_current");
  assert.equal(sent[1].params.excludeTurns, true);
  assert.equal(sent[2].params.threadId, "thread_current");
  assert.equal(sent[2].params.input[0].type, "text");
  assert.match(sent[2].params.input[0].text, /api\/current-codex\/roomcodex_1\/complete/);
});
