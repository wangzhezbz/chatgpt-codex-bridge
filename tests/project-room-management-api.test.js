import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-project-room-api-"));
}

async function withServer(fn) {
  const server = createHttpServer({ storeRoot: await tempStore() });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonFetch(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  if (!response.ok) {
    assert.fail(await response.text());
  }
  return response.json();
}

test("project and room management APIs soft-delete records without removing files", async () => {
  await withServer(async (baseUrl) => {
    const first = await jsonFetch(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "first",
        chatgptProjectUrl: "https://chatgpt.com/c/first",
        targetRepo: "F:/game_code/first"
      })
    });
    const second = await jsonFetch(baseUrl, "/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "second",
        chatgptProjectUrl: "https://chatgpt.com/c/second",
        targetRepo: "F:/game_code/second"
      })
    });
    await jsonFetch(baseUrl, `/api/projects/${encodeURIComponent(second.project.id)}/select`, {
      method: "POST",
      body: JSON.stringify({})
    });

    const deletedProject = await jsonFetch(baseUrl, `/api/projects/${encodeURIComponent(second.project.id)}`, {
      method: "DELETE"
    });
    assert.equal(deletedProject.deletedProject.id, second.project.id);
    assert.equal(deletedProject.activeProjectId, first.project.id);
    assert.deepEqual((await jsonFetch(baseUrl, "/api/projects")).projects.map((project) => project.id), [
      first.project.id
    ]);

    await jsonFetch(baseUrl, `/api/projects/${encodeURIComponent(first.project.id)}/select`, {
      method: "POST",
      body: JSON.stringify({})
    });
    const firstMessage = await jsonFetch(baseUrl, "/api/room/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "first message",
        to: ["gpt"]
      })
    });
    await jsonFetch(baseUrl, "/api/room/messages", {
      method: "POST",
      body: JSON.stringify({
        text: "second message",
        to: ["gpt"]
      })
    });

    await jsonFetch(baseUrl, `/api/room/messages/${encodeURIComponent(firstMessage.message.id)}`, {
      method: "DELETE"
    });
    assert.deepEqual((await jsonFetch(baseUrl, "/api/room/messages")).messages.map((message) => message.text), [
      "second message"
    ]);

    await jsonFetch(baseUrl, "/api/room/messages", { method: "DELETE" });
    assert.equal((await jsonFetch(baseUrl, "/api/room/messages")).messages.length, 0);
  });
});
