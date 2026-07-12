import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import { createHttpServer } from "../src/http-server.js";

async function tempStore(prefix) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function withServer(options, fn) {
  const server = createHttpServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function loadContentScriptContext() {
  const bridgeConfigSource = await readFile("chrome-extension/bridge-config.js", "utf8");
  const source = await readFile("chrome-extension/content-script.js", "utf8");
  const storage = new Map();
  const context = {
    console,
    document: {
      body: { innerText: "", textContent: "" },
      title: "",
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    fetch() {
      throw new Error("fetch should not be called by this test");
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
    sessionStorage: {
      getItem(key) {
        return storage.get(key) || null;
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      }
    },
    setInterval() {},
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(bridgeConfigSource, context);
  vm.runInContext(source, context);
  context.__storage = storage;
  return context;
}

function fakeGeneratedImage(src = "blob:https://chatgpt.com/generated-image") {
  return {
    tagName: "IMG",
    src,
    naturalWidth: 1024,
    naturalHeight: 1536,
    disabled: false,
    getAttribute(name) {
      return name === "src" ? src : null;
    },
    getClientRects() {
      return [{ width: 512, height: 768 }];
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 512, bottom: 768, width: 512, height: 768 };
    }
  };
}

test("image replies do not expose interim processing text once an image artifact exists", async () => {
  const context = await loadContentScriptContext();
  const image = fakeGeneratedImage();
  const message = {
    textContent: "ChatGPT is still processing this request. Bridge has not received the final usable reply.",
    innerText: "ChatGPT is still processing this request. Bridge has not received the final usable reply.",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };

  assert.equal(context.visibleReplyTextFromAssistant(message, "old answer"), "已生成图片。");
});

test("image replies are not complete while ChatGPT still shows processing text", async () => {
  const context = await loadContentScriptContext();
  const image = fakeGeneratedImage();
  const message = {
    textContent: "Generating a more detailed image, please wait.",
    innerText: "Generating a more detailed image, please wait.",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script refreshes the bound ChatGPT page before touching the composer for a new job", async () => {
  const context = await loadContentScriptContext();
  const calls = [];
  let reloaded = false;
  const job = {
    id: "sync_refresh_before_send",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Second task",
    _bridgeNeedsPreSendRefresh: true
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = () => {
    throw new Error("composer should not be touched before refresh");
  };
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (apiPath) => {
    calls.push(apiPath);
    if (apiPath === "/api/sync/jobs/sync_refresh_before_send/pre-send-refresh") {
      return {
        job: {
          ...job,
          _bridgePreSendRefresh: true,
          _bridgeRefreshAttempts: 1,
          _bridgeNeedsPreSendRefresh: false
        }
      };
    }
    throw new Error(`unexpected bridge call: ${apiPath}`);
  };

  await context.processJob(job);

  assert.equal(reloaded, true);
  assert.deepEqual(calls, ["/api/sync/jobs/sync_refresh_before_send/pre-send-refresh"]);
});

test("sync claim blocks old extension versions after fatal capture fixes", async () => {
  const storeRoot = await tempStore("bridge-fatal-version-store-");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        targetRepo: await tempStore("bridge-fatal-version-project-")
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate one image.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo",
        workerId: "codex-chatgpt-project-extension-v20260705-submit-retry:test"
      })
    });
    const claimed = await claimResponse.json();

    assert.equal(claimed.job, null);
    assert.match(claimed.error, /reload/i);
  });
});

test("content script does not treat interrupted ChatGPT text as a final answer", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Connection interrupted. Waiting for the complete reply.",
    innerText: "Connection interrupted. Waiting for the complete reply.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return this;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("sync completion rejects interrupted ChatGPT text as still streaming", async () => {
  const storeRoot = await tempStore("bridge-fatal-interrupt-store-");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        targetRepo: await tempStore("bridge-fatal-interrupt-project-")
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please analyze this file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:test"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Connection interrupted. Waiting for the complete reply.",
        thoughtDurationMs: 500
      })
    });
    const completed = await completeResponse.json();

    assert.equal(completeResponse.status, 409);
    assert.equal(completed.code, "interim_chatgpt_reply");
  });
});

test("sync completion saves captured image artifacts into the bound project and returns exact paths", async () => {
  const storeRoot = await tempStore("bridge-fatal-store-");
  const projectRoot = await tempStore("bridge-fatal-project-");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        targetRepo: projectRoot
      })
    });

    const createdResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Continue step 2 and generate one novel poster.",
        to: ["gpt"]
      })
    });
    const created = await createdResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:test"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "ChatGPT is still processing this request. Bridge has not received the final usable reply.",
        artifacts: [
          {
            filename: "novel-poster.png",
            contentType: "image/png",
            originalUrl: "blob:https://chatgpt.com/poster",
            base64Data: Buffer.from("poster bytes").toString("base64")
          }
        ],
        thoughtDurationMs: 1200
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.metadata.sourceMessageId, created.message.id);
    assert.equal(completed.roomMessage.text, "已捕获 1 张图片");
    assert.doesNotMatch(completed.roomMessage.text, /still processing|final usable reply/i);
    assert.equal(completed.roomMessage.metadata.projectArtifacts.length, 1);
    assert.equal(completed.job.projectArtifacts.length, 1);
    assert.match(completed.job.projectArtifacts[0].relativePath, /chatgpt-artifacts[\\/]novel-poster\.png$/);
    assert.equal(await readFile(completed.job.projectArtifacts[0].savedPath, "utf8"), "poster bytes");
  });
});

test("multi-step image batch saves every visible image artifact into the bound project", async () => {
  const storeRoot = await tempStore("bridge-fatal-batch-store-");
  const projectRoot = await tempStore("bridge-fatal-batch-project-");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        targetRepo: projectRoot
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate 2 images for a fantasy novel poster.",
        to: ["gpt"]
      })
    });

    const firstClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:test"
      })
    });
    const firstClaim = await firstClaimResponse.json();

    await fetch(`${baseUrl}/api/sync/jobs/${firstClaim.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated the first image.",
        artifacts: [
          {
            filename: "poster-1.png",
            contentType: "image/png",
            originalUrl: "blob:https://chatgpt.com/poster-1",
            base64Data: Buffer.from("poster one").toString("base64")
          }
        ],
        thoughtDurationMs: 1000
      })
    });

    const secondClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:test"
      })
    });
    const secondClaim = await secondClaimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${secondClaim.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated the second image.",
        artifacts: [
          {
            filename: "poster-2.png",
            contentType: "image/png",
            originalUrl: "blob:https://chatgpt.com/poster-2",
            base64Data: Buffer.from("poster two").toString("base64")
          }
        ],
        thoughtDurationMs: 1000
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.text, "已捕获 2 张图片");
    assert.equal(completed.roomMessage.metadata.artifactIds.length, 2);
    assert.equal(completed.roomMessage.metadata.projectArtifacts.length, 2);
    assert.deepEqual(
      completed.roomMessage.metadata.projectArtifacts.map((item) => item.filename),
      ["poster-1.png", "poster-2.png"]
    );
  });
});
