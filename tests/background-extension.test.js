import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function loadBackgroundContext(overrides = {}) {
  const listeners = [];
  const tabUpdateListeners = [];
  const downloadCreatedListeners = [];
  const downloadChangedListeners = [];
  const calls = [];
  const chrome = {
    runtime: {
      lastError: null,
      reload() {
        calls.push({ method: "runtime.reload" });
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    },
    downloads: {
      download(downloadOptions, callback) {
        calls.push({ method: "downloads.download", downloadOptions });
        callback?.(overrides.downloadId || 77);
      },
      search(query, callback) {
        calls.push({ method: "downloads.search", query });
        callback?.(overrides.downloadSearchItems || []);
      },
      erase(query, callback) {
        calls.push({ method: "downloads.erase", query });
        callback?.([]);
      },
      cancel(downloadId, callback) {
        calls.push({ method: "downloads.cancel", downloadId });
        callback?.();
      },
      onCreated: {
        addListener(listener) {
          downloadCreatedListeners.push(listener);
        }
      },
      onChanged: {
        addListener(listener) {
          downloadChangedListeners.push(listener);
        }
      }
    },
    tabs: {
      update(tabId, updateProperties, callback) {
        calls.push({ method: "tabs.update", tabId, updateProperties });
        callback?.({ id: tabId, ...updateProperties });
      },
      onUpdated: {
        addListener(listener) {
          tabUpdateListeners.push(listener);
        }
      }
    },
    debugger: {
      attach(target, version, callback) {
        calls.push({ method: "attach", target, version });
        callback();
      },
      sendCommand(target, method, params, callback) {
        calls.push({ method: "sendCommand", target, command: method, params });
        callback();
      },
      detach(target, callback) {
        calls.push({ method: "detach", target });
        callback();
      }
    },
    ...overrides.chrome
  };
  const context = {
    chrome,
    clearTimeout,
    console,
    fetch: overrides.fetch || function fetch() {
      throw new Error("fetch should not be called by these unit tests");
    },
    btoa(value) {
      return Buffer.from(value, "binary").toString("base64");
    },
    URL,
    setTimeout
  };
  vm.createContext(context);
  vm.runInContext(await readFile("chrome-extension/bridge-config.js", "utf8"), context);
  vm.runInContext(await readFile("chrome-extension/background.js", "utf8"), context);
  return { calls, context, downloadChangedListeners, downloadCreatedListeners, listeners, tabUpdateListeners };
}

function sendRuntimeMessage(listener, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

test("background trustedClick dispatches a real browser click through debugger", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  const response = await sendRuntimeMessage(
    listeners[0],
    { type: "bridge:trustedClick", x: 140, y: 60 },
    { tab: { id: 123 } }
  );

  assert.equal(response.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { method: "tabs.update", tabId: 123, updateProperties: { active: true } },
    { method: "attach", target: { tabId: 123 }, version: "1.3" },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 140, y: 60, button: "none", buttons: 0 }
    },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 140, y: 60, button: "left", buttons: 1, clickCount: 1 }
    },
    {
      method: "sendCommand",
      target: { tabId: 123 },
      command: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", x: 140, y: 60, button: "left", buttons: 0, clickCount: 1 }
    },
    { method: "detach", target: { tabId: 123 } }
  ]);
});

test("background trustedClick returns an error without a sender tab", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  const response = await sendRuntimeMessage(listeners[0], { type: "bridge:trustedClick", x: 1, y: 2 }, {});

  assert.equal(response.ok, false);
  assert.match(response.error, /No sender tab/);
  assert.deepEqual(calls, []);
});

test("background reloads the extension when Bridge requests a version refresh", async () => {
  const { calls, listeners } = await loadBackgroundContext();

  let response = null;
  const keepAlive = listeners[0]({ type: "bridge:reloadExtension" }, {}, (value) => {
    response = value;
  });

  assert.equal(keepAlive, false);
  assert.equal(response.ok, true);
  assert.deepEqual(calls, [{ method: "runtime.reload" }]);
});

test("background imports ChatGPT estuary content URL for an active download watch", async () => {
  const fetchCalls = [];
  const { listeners, tabUpdateListeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url: String(url), options });
      if (String(url).startsWith("https://chatgpt.com/backend-api/estuary/content")) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "application/zip" : null;
            }
          },
          arrayBuffer: async () => Buffer.from("zip bytes from chatgpt", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        assert.equal(body.syncJobId, "sync_zip");
        assert.equal(body.filename, "multi-image-live-v3-icons.zip");
        assert.equal(body.contentType, "application/zip");
        assert.equal(body.base64Data, Buffer.from("zip bytes from chatgpt", "utf8").toString("base64"));
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_remote_zip",
              filename: "multi-image-live-v3-icons.zip"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        syncJobId: "sync_zip",
        expectedFilename: "multi-image-live-v3-icons.zip",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  tabUpdateListeners[0](
    321,
    {
      url: "https://chatgpt.com/backend-api/estuary/content?id=file_123&fn=multi-image-live-v3-icons.zip&cd=attachment"
    },
    { id: 321 }
  );

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_remote_zip");
  assert.deepEqual(
    fetchCalls.map((call) => call.url),
    [
      "https://chatgpt.com/backend-api/estuary/content?id=file_123&fn=multi-image-live-v3-icons.zip&cd=attachment",
      "http://127.0.0.1:4317/api/downloads/import"
    ]
  );
});

test("background imports ChatGPT interpreter download URL for an active download watch", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-e2e-note.md";
  const fetchCalls = [];
  const importedBodies = [];
  const { listeners, tabUpdateListeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type" ? "text/markdown; charset=utf-8" : null;
            }
          },
          arrayBuffer: async () => Buffer.from("# Bridge note\n\n- captured", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_interpreter_md",
              filename: "bridge-e2e-note.md"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        syncJobId: "sync_md",
        expectedFilename: "bridge-e2e-note.md",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  tabUpdateListeners[0](321, { url: interpreterUrl }, { id: 321 });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_interpreter_md");
  assert.equal(importedBodies[0].syncJobId, "sync_md");
  assert.equal(importedBodies[0].filename, "bridge-e2e-note.md");
  assert.equal(importedBodies[0].contentType, "text/markdown; charset=utf-8");
  assert.equal(importedBodies[0].base64Data, Buffer.from("# Bridge note\n\n- captured", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl, "http://127.0.0.1:4317/api/downloads/import"]);
});

test("background erases visible Chrome download history after importing a watched file", async () => {
  const importedBodies = [];
  const { calls, downloadCreatedListeners, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_visible_pdf",
              filename: "visible.pdf"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        bridgeOrigin: "http://127.0.0.1:4317",
        syncJobId: "sync_visible_pdf",
        expectedFilename: "visible.pdf",
        timeoutMs: 10000
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });
  const resultPromise = sendRuntimeMessage(listeners[0], { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId }, {});

  downloadCreatedListeners[0]({
    id: 404,
    state: "complete",
    filename: "C:\\Users\\Administrator\\Downloads\\visible.pdf",
    finalUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_pdf&fn=visible.pdf",
    url: "https://chatgpt.com/backend-api/estuary/content?id=file_pdf&fn=visible.pdf",
    mime: "application/pdf"
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_visible_pdf");
  assert.equal(importedBodies[0].localPath, "C:\\Users\\Administrator\\Downloads\\visible.pdf");
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls.filter((call) => call.method === "downloads.erase"))),
    [{ method: "downloads.erase", query: { id: 404 } }]
  );
});

test("background imports ChatGPT interpreter URLs directly before opening a browser download", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fdirect-quiet.xlsx";
  const importedBodies = [];
  const fetchCalls = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: true,
          url: String(url),
          headers: {
            get(name) {
              return name.toLowerCase() === "content-type"
                ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                : null;
            }
          },
          arrayBuffer: async () => Buffer.from("xlsx bytes from chatgpt", "utf8")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_quiet_xlsx",
              filename: "direct-quiet.xlsx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_quiet",
      url: interpreterUrl,
      filename: "direct-quiet.xlsx",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_quiet_xlsx");
  assert.equal(importedBodies[0].syncJobId, "sync_quiet");
  assert.equal(importedBodies[0].filename, "direct-quiet.xlsx");
  assert.equal(importedBodies[0].contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(importedBodies[0].base64Data, Buffer.from("xlsx bytes from chatgpt", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl, "http://127.0.0.1:4317/api/downloads/import"]);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background quiet URL capture does not open a browser download after direct fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fquiet-fail.zip";
  const fetchCalls = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 403,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_quiet_fail",
      url: interpreterUrl,
      filename: "quiet-fail.zip",
      quietOnly: true,
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /direct download failed|status 403/i);
  assert.deepEqual(fetchCalls, [interpreterUrl]);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background quiet URL capture uses page-context fetch after direct fetch is unauthorized", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-live-deck.pptx";
  const importedBodies = [];
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_direct_page_context_pptx",
              filename: "bridge-live-deck.pptx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          assert.deepEqual(JSON.parse(JSON.stringify(details.target)), { tabId: 321 });
          assert.equal(details.world, "MAIN");
          assert.deepEqual(JSON.parse(JSON.stringify(details.args)), [interpreterUrl]);
          callback?.([
            {
              result: {
                ok: true,
                url: interpreterUrl,
                contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                contentDisposition: "attachment; filename=\"bridge-live-deck.pptx\"",
                base64Data: Buffer.from("pptx from direct page context", "utf8").toString("base64")
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_direct_page_context_pptx",
      url: interpreterUrl,
      filename: "bridge-live-deck.pptx",
      quietOnly: true,
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_direct_page_context_pptx");
  assert.deepEqual(
    calls.map((call) => call.method).filter((method) => method !== "downloads.search"),
    ["scripting.executeScript"]
  );
  assert.equal(importedBodies[0].syncJobId, "sync_direct_page_context_pptx");
  assert.equal(importedBodies[0].filename, "bridge-live-deck.pptx");
  assert.equal(
    importedBodies[0].base64Data,
    Buffer.from("pptx from direct page context", "utf8").toString("base64")
  );
});

test("background URL capture does not create a visible Chrome download when GPT URL fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fdirect-10-icons-v2-01.png";
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          callback?.([
            {
              result: {
                ok: false,
                error: "GPT page download failed with status 401"
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_interpreter",
      url: interpreterUrl,
      filename: "direct-10-icons-v2-01.png",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background URL capture fails quietly when page-context fetch also fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-live-deck.pptx";
  const { calls, listeners } = await loadBackgroundContext({
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
    chrome: {
      scripting: {
        executeScript(details, callback) {
          calls.push({ method: "scripting.executeScript", details });
          assert.deepEqual(JSON.parse(JSON.stringify(details.target)), { tabId: 321 });
          assert.equal(details.world, "MAIN");
          assert.deepEqual(JSON.parse(JSON.stringify(details.args)), [interpreterUrl]);
          callback?.([
            {
              result: {
                ok: false,
                error: "GPT page download failed with status 401"
              }
            }
          ]);
        }
      }
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_interrupted_pptx",
      url: interpreterUrl,
      filename: "bridge-live-deck.pptx",
      timeoutMs: 10000
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.deepEqual(
    calls.map((call) => call.method).filter((method) => method !== "downloads.search"),
    ["scripting.executeScript"]
  );
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
});

test("background URL capture ignores Chrome download history when GPT URL fetch fails", async () => {
  const interpreterUrl =
    "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-table.xlsx";
  const { calls, listeners } = await loadBackgroundContext({
    downloadSearchItems: [
      {
        id: 101,
        filename: "C:\\Users\\Administrator\\Downloads\\bridge-table.xlsx",
        finalUrl: interpreterUrl,
        url: interpreterUrl,
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        state: "complete"
      }
    ],
    fetch: async (url, options = {}) => {
      if (String(url) === interpreterUrl) {
        return {
          ok: false,
          status: 401,
          headers: { get() { return null; } },
          arrayBuffer: async () => Buffer.from("")
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    {
      type: "bridge:downloadUrl",
      bridgeOrigin: "http://127.0.0.1:4317",
      syncJobId: "sync_table",
      url: interpreterUrl,
      filename: "bridge-table.xlsx",
      timeoutMs: 20
    },
    { tab: { id: 321 } }
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /status 401/i);
  assert.equal(calls.some((call) => call.method === "downloads.download"), false);
  assert.equal(calls.some((call) => call.method === "downloads.search"), false);
});

test("background recovers a button-triggered download by filename when the watch event is missed", async () => {
  const importedBodies = [];
  const { calls, listeners } = await loadBackgroundContext({
    downloadSearchItems: [
      {
        id: 202,
        filename: "C:\\Users\\Administrator\\Downloads\\bridge-live-doc-retry2-20260708043012.docx",
        finalUrl: "",
        url: "",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        state: "complete"
      }
    ],
    fetch: async (url, options = {}) => {
      if (String(url) === "http://127.0.0.1:4317/api/downloads/import") {
        const body = JSON.parse(options.body);
        importedBodies.push(body);
        return {
          ok: true,
          json: async () => ({
            artifact: {
              id: "artifact_recovered_docx",
              filename: "bridge-live-doc-retry2-20260708043012.docx"
            }
          })
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    }
  });

  const startResponse = await new Promise((resolve) => {
    const keepAlive = listeners[0](
      {
        type: "bridge:startDownloadWatch",
        bridgeOrigin: "http://127.0.0.1:4317",
        syncJobId: "sync_docx_button",
        expectedFilename: "bridge-live-doc-retry2-20260708043012.docx",
        timeoutMs: 1
      },
      { tab: { id: 321 } },
      resolve
    );
    assert.equal(keepAlive, false);
  });

  const result = await sendRuntimeMessage(
    listeners[0],
    { type: "bridge:awaitDownloadWatch", watchId: startResponse.watchId },
    {}
  );

  assert.equal(result.ok, true);
  assert.equal(result.artifact.id, "artifact_recovered_docx");
  assert.equal(calls.some((call) => call.method === "downloads.search" && !("id" in call.query)), true);
  assert.equal(importedBodies[0].syncJobId, "sync_docx_button");
  assert.equal(importedBodies[0].localPath, "C:\\Users\\Administrator\\Downloads\\bridge-live-doc-retry2-20260708043012.docx");
  assert.equal(importedBodies[0].filename, "bridge-live-doc-retry2-20260708043012.docx");
});
