import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

async function loadContentScriptContext() {
  const bridgeConfigSource = await readFile("chrome-extension/bridge-config.js", "utf8");
  const source = await readFile("chrome-extension/content-script.js", "utf8");
  const context = {
    console,
    document: {
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      }
    },
    fetch() {
      throw new Error("fetch should not be called by these unit tests");
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
    setInterval() {},
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(bridgeConfigSource, context);
  vm.runInContext(source, context);
  return context;
}

function fakeText(value) {
  return {
    nodeType: 3,
    textContent: value,
    innerText: value
  };
}

test("pre-send preparation has a hard timeout", async () => {
  const context = await loadContentScriptContext();

  await assert.rejects(
    () => context.withPreSendTimeout(
      { id: "sync_pre_send_timeout", _bridgePreSendTimeoutMs: 1 },
      () => new Promise(() => {})
    ),
    (error) => error.errorCode === "pre_send_timeout" && /GPT \u9875\u9762\u51c6\u5907\u53d1\u9001\u8d85\u65f6/.test(error.message)
  );
});

test("content script preserves structured Bridge API errors", async () => {
  const context = await loadContentScriptContext();
  context.fetch = async () => ({
    ok: false,
    status: 409,
    async text() {
      return JSON.stringify({
        error: "GPT reply is still streaming or interrupted",
        code: "interim_chatgpt_reply"
      });
    }
  });

  await assert.rejects(
    () => context.bridgeApi("/api/sync/jobs/sync_interim/complete", { method: "POST" }),
    (error) => {
      assert.equal(error.message, "GPT reply is still streaming or interrupted");
      assert.equal(error.errorCode, "interim_chatgpt_reply");
      assert.equal(error.status, 409);
      return true;
    }
  );
});

function selectorMatches(node, selector) {
  const tag = String(node.tagName || "").toLowerCase();
  const attr = (name) => node.getAttribute?.(name);
  if (selector === "button") return tag === "button";
  if (selector === "img") return tag === "img";
  if (selector === "tr") return tag === "tr";
  if (selector === "th,td") return tag === "th" || tag === "td";
  if (selector === "a[href]") return tag === "a" && Boolean(attr("href"));
  if (selector === "input[type=\"checkbox\"]") return tag === "input" && attr("type") === "checkbox";
  if (selector === "[data-message-author-role=\"assistant\"]") return attr("data-message-author-role") === "assistant";
  if (selector === "[data-message-author-role=\"user\"]") return attr("data-message-author-role") === "user";
  if (selector === "section[data-testid^=\"conversation-turn-\"]") {
    return tag === "section" && String(attr("data-testid") || "").startsWith("conversation-turn-");
  }
  return false;
}

function fakeElement(tagName, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    nodeName: tagName.toUpperCase(),
    className: attrs.className || "",
    childNodes: children,
    textContent: "",
    innerText: "",
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (current) => {
        if (!current || current.nodeType !== 1) return;
        if (selectorMatches(current, selector)) {
          found.push(current);
        }
        for (const child of current.childNodes || []) {
          walk(child);
        }
      };
      for (const child of this.childNodes || []) {
        walk(child);
      }
      return found;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
    matches(selector) {
      return selectorMatches(this, selector);
    },
    closest() {
      return null;
    }
  };
  for (const child of children) {
    if (child && typeof child === "object") {
      child.parentElement = node;
      child.parentNode = node;
    }
  }
  node.textContent = children.map((child) => child.textContent || "").join("");
  node.innerText = children.map((child) => child.innerText || child.textContent || "").join("");
  return node;
}

test("content script accepts short ChatGPT replies after the assistant text changes", async () => {
  const context = await loadContentScriptContext();

  assert.equal(
    context.hasUsableAssistantText("new reply", "old reply"),
    true
  );
  assert.equal(context.hasUsableAssistantText("old reply", "old reply"), false);
  assert.equal(context.hasUsableAssistantText("   ", "old reply"), false);
});

test("content script ignores empty ChatGPT wrapper headings", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.cleanChatGptReplyText("#### ChatGPT \u8bf4\uff1a"), "");
  assert.equal(context.hasUsableAssistantText("#### ChatGPT \u8bf4\uff1a", "old reply"), false);
});

test("content script accepts complete Chinese long-form replies containing status-like words", async () => {
  const context = await loadContentScriptContext();
  const reply = [
    "AI \u5de5\u4f5c\u6d41\u4ea7\u54c1\u7684\u4ef7\u503c\uff0c\u4e0d\u662f\u7b80\u5355\u628a GPT \u548c Codex \u653e\u5728\u540c\u4e00\u4e2a\u754c\u9762\u91cc\u3002",
    "\u771f\u6b63\u91cd\u8981\u7684\u662f\u4efb\u52a1\u6b63\u5728\u88ab\u5206\u914d\u5230\u6700\u5408\u9002\u7684\u6267\u884c\u8005\u624b\u91cc\uff0c\u7528\u6237\u4e0d\u9700\u8981\u5173\u5fc3\u80cc\u540e\u5206\u5de5\u3002",
    "\u5bf9\u4e8e\u521b\u610f\u3001\u56fe\u7247\u3001\u957f\u6587\u548c Office \u6587\u4ef6\uff0cGPT \u53ef\u4ee5\u7ed9\u51fa\u66f4\u81ea\u7136\u7684\u4ea7\u7269\uff1b\u5bf9\u4e8e\u4ee3\u7801\u3001\u6587\u4ef6\u843d\u5730\u548c\u9a8c\u8bc1\uff0cCodex \u5219\u8d1f\u8d23\u6536\u675f\u3002"
  ].join("\n\n");

  assert.equal(context.isInterimAssistantText(reply), false);
  assert.equal(context.hasUsableAssistantText(reply, "old reply"), true);
});

test("content script accepts a complete long-form reply containing file-analysis status phrases", async () => {
  const context = await loadContentScriptContext();
  const reply = [
    "最终架构说明已经完成。系统正在分析文件生命周期这一句，是对运行机制的客观描述，不是等待提示。",
    "Router 会把每个阶段的 requestId、payload 和状态持久化，再按依赖关系逐个执行；失败、取消与超时都不会自动推进。",
    "设计还明确区分了公共 Transport 协议与网页同步私有字段，调用方只消费统一状态、文本与真实产物路径。",
    "恢复时复用已经保存的请求内容，成功阶段不会重复提交，终态也不能被陈旧执行逆转。",
    "这是一份完整的最终答案，已经覆盖职责边界、状态恢复、错误策略和产物落地规则。"
  ].join("\n\n");
  assert.ok(reply.length > 220);

  assert.equal(context.isInterimAssistantText(reply), false);
  assert.equal(context.hasUsableAssistantText(reply, "old reply"), true);

  const incidentReport = [
    "The incident review is complete and all corrective actions have been verified.",
    "The connection lost event was caused by an expired upstream route, and the service recovered after the route table was refreshed.",
    "No Router stage was duplicated. Persisted request ids and terminal guards prevented a stale continuation from replaying completed work.",
    "Monitoring now distinguishes historical incident language from a live interruption banner, and the final report is ready for handoff.",
    "This is the complete final answer, including cause, impact, recovery, validation, and prevention work."
  ].join("\n\n");
  assert.ok(incidentReport.length > 220);
  assert.equal(context.isInterimAssistantText(incidentReport), false);
  assert.equal(context.hasUsableAssistantText(incidentReport, "old reply"), true);
});

test("content script parses ChatGPT thought duration from assistant chrome", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.parseThoughtDurationMs("Thought for 1m 14s\n\nfinal answer"), 74000);
  assert.equal(context.parseThoughtDurationMs("\u5df2\u601d\u8003 48 \u79d2\n\n\u6700\u7ec8\u56de\u7b54"), 48000);
  assert.equal(context.cleanChatGptReplyText("Thought for 1m 14s\n\nfinal answer"), "final answer");
});

test("content script uploads sync job input artifacts before sending to ChatGPT", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "codex-notes.txt",
    innerText: "codex-notes.txt",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_notes/raw");
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "text/plain" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("notes created by Codex", "utf8");
      }
    };
  };

  const uploaded = await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_notes",
        filename: "codex-notes.txt",
        contentType: "text/plain",
        downloadUrl: "/api/artifacts/artifact_notes/download"
      }
    ]
  });

  assert.equal(uploaded.length, 1);
  assert.equal(input.files[0].name, "codex-notes.txt");
  assert.equal(input.files[0].type, "text/plain");
  assert.deepEqual(changed, ["change"]);
});

test("content script never fetches download URLs as ChatGPT upload attachments", async () => {
  const context = await loadContentScriptContext();
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async (url) => {
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
    assert.doesNotMatch(String(url), /\/download$/);
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };

  await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        uploadUrl: "/api/artifacts/artifact_zip/download",
        downloadUrl: "/api/artifacts/artifact_zip/download"
      }
    ]
  });

  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
});

test("content script retries transient local artifact fetch failures before upload", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  let fetchAttempts = 0;
  context.fetch = async (url) => {
    fetchAttempts += 1;
    assert.equal(url, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
    if (fetchAttempts === 1) {
      throw new TypeError("Failed to fetch");
    }
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };
  context.sleep = async () => {};

  const uploaded = await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        downloadUrl: "/api/artifacts/artifact_zip/download"
      }
    ]
  });

  assert.equal(fetchAttempts, 2);
  assert.equal(uploaded.length, 1);
  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
  assert.equal(input.files[0].type, "application/zip");
  assert.deepEqual(changed, ["change"]);
});

test("content script uses the internal upload URL instead of the user download URL for input artifacts", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "DIV",
    textContent: "Codex-Setup-Tool.zip",
    innerText: "Codex-Setup-Tool.zip",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("[data-testid]") || selector.includes("div")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  let fetchedUrl = "";
  context.fetch = async (url) => {
    fetchedUrl = url;
    return {
      ok: true,
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type" ? "application/zip" : null;
        }
      },
      async arrayBuffer() {
        return Buffer.from("zip bytes", "utf8");
      }
    };
  };

  await context.uploadInputArtifacts({
    inputArtifacts: [
      {
        id: "artifact_zip",
        filename: "Codex-Setup-Tool.zip",
        contentType: "application/zip",
        downloadUrl: "/api/artifacts/artifact_zip/download",
        uploadUrl: "/api/artifacts/artifact_zip/raw"
      }
    ]
  });

  assert.equal(fetchedUrl, "http://127.0.0.1:4317/api/artifacts/artifact_zip/raw");
  assert.equal(input.files[0].name, "Codex-Setup-Tool.zip");
  assert.deepEqual(changed, ["change"]);
});

test("content script rejects an input artifact upload when ChatGPT shows no attachment", async () => {
  const context = await loadContentScriptContext();
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = () => [];
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });
  context.sleep = async () => {};

  await assert.rejects(
    () =>
      context.uploadInputArtifacts(
        {
          inputArtifacts: [
            {
              id: "artifact_image",
              filename: "github-repo-screenshot.png",
              contentType: "image/png",
              downloadUrl: "/api/artifacts/artifact_image/download"
            }
          ]
        },
        { attachmentTimeoutMs: 1 }
      ),
    /(?:ChatGPT attachment did not appear|GPT \u9644\u4ef6\u6ca1\u6709\u51fa\u73b0\u5728\u8f93\u5165\u6846)/
  );
});

test("content script accepts an image input artifact after a visible upload preview appears", async () => {
  const context = await loadContentScriptContext();
  const changed = [];
  const input = {
    tagName: "INPUT",
    files: [],
    dispatchEvent(event) {
      changed.push(event.type);
    }
  };
  const preview = {
    tagName: "IMG",
    textContent: "",
    getAttribute(name) {
      if (name === "alt") return "github-repo-screenshot.png";
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 80 }];
    },
    closest() {
      return null;
    }
  };

  context.document.querySelector = (selector) => (selector === 'input[type="file"]' ? input : null);
  context.document.querySelectorAll = (selector) => {
    if (selector.includes("img")) return [preview];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });
  context.sleep = async () => {};

  const uploaded = await context.uploadInputArtifacts(
    {
      inputArtifacts: [
        {
          id: "artifact_image",
          filename: "github-repo-screenshot.png",
          contentType: "image/png",
          downloadUrl: "/api/artifacts/artifact_image/download"
        }
      ]
    },
    { attachmentTimeoutMs: 1 }
  );

  assert.equal(uploaded.length, 1);
  assert.deepEqual(changed, ["change"]);
});

test("content script classifies ChatGPT blocker pages before sending", async () => {
  const context = await loadContentScriptContext();
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE 闂傚倸鍊搁幊蹇涘礉濡ゅ懏锟?闂備礁鎼ˇ顐﹀礈濠靛锟?"
  };
  assert.equal(context.detectChatGptBlocker()?.code, "human_verification");

  context.document.body = {
    innerText: "This content is not available or could not be found."
  };
  assert.equal(context.detectChatGptBlocker()?.code, "conversation_unavailable");

  context.document.body = {
    innerText: "chatgpt.com 宸茶灞忚斀 姝ら〉闈㈠凡锟?Chrome 灞忚斀 ERR_BLOCKED_BY_CLIENT"
  };
  const clientBlocked = context.detectChatGptBlocker();
  assert.equal(clientBlocked?.code, "client_blocked");
  assert.equal(clientBlocked?.recoveryAction, "disable_client_blocker");

  const normalComposer = {
    tagName: "TEXTAREA",
    value: "",
    getClientRects() {
      return [{ width: 400, height: 80 }];
    }
  };
  context.document.body = {
    innerText:
      "鍘嗗彶娑堟伅锛歝hatgpt.com 宸茶灞忚斀 姝ら〉闈㈠凡锟?Chrome 灞忚斀 ERR_BLOCKED_BY_CLIENT銆傝鍏抽棴鎷︽埅 chatgpt.com 鐨勬墿灞曟垨鍔犲叆鐧藉悕鍗曞悗锛屽彧鍒锋柊缁戝畾浼氳瘽?"
  };
  context.document.querySelector = (selector) => {
    if (selector === "textarea" || selector === "[contenteditable='true']" || selector === "[contenteditable=\"true\"]") {
      return normalComposer;
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "textarea, [contenteditable='true'], [contenteditable=\"true\"]") {
      return [normalComposer];
    }
    return [];
  };
  assert.equal(context.detectChatGptBlocker(), null);

  context.document.body = {
    innerText: "Something went wrong while generating the response. If this issue persists please contact us."
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);
  assert.equal(context.detectChatGptBlocker({ includeGenerationFailure: true })?.code, "generation_failed");

  context.document.body = {
    innerText: "Welcome back. Select an account to continue. Log in to another account. Create account."
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker()?.code, "account_selection");

  const composer = {
    tagName: "TEXTAREA",
    value: "",
    getClientRects() {
      return [{ width: 400, height: 80 }];
    }
  };
  context.document.body = {
    innerText: "Composer is visible. Welcome back copy should not block a ready page."
  };
  context.document.querySelector = (selector) => (selector === "#prompt-textarea" ? composer : null);
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);

  const accountDialog = {
    innerText: "Welcome back. Select an account to continue.",
    textContent: "Welcome back. Select an account to continue.",
    getClientRects() {
      return [{ width: 400, height: 280 }];
    }
  };
  context.document.querySelectorAll = (selector) =>
    selector.includes("[role='dialog']") || selector.includes('[role="dialog"]') ? [accountDialog] : [];
  assert.equal(context.detectChatGptBlocker()?.code, "account_selection");

  context.document.body = {
    innerText: "This content is not available or could not be found."
  };
  context.document.querySelectorAll = () => [];
  assert.equal(context.detectChatGptBlocker(), null);

  context.document.querySelector = () => null;
  assert.equal(context.detectChatGptBlocker()?.code, "conversation_unavailable");

  context.document.body = {
    innerText: "This is a normal Steam desktop shortcut analysis, not an account-selection blocker."
  };
  assert.equal(context.detectChatGptBlocker(), null);
});

test("content script only treats generation failures as blockers for the current reply", async () => {
  const context = await loadContentScriptContext();
  const oldUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("闂佸搫鍞查崒娑樺簥??")]);
  const oldAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeText("Something went wrong while generating the response.")
  ]);
  const currentUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("current prompt")]);
  const currentAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [fakeText("current answer")]);
  const turns = [
    fakeElement("section", { "data-testid": "conversation-turn-1" }, [oldUser]),
    fakeElement("section", { "data-testid": "conversation-turn-2" }, [oldAssistant]),
    fakeElement("section", { "data-testid": "conversation-turn-3" }, [currentUser]),
    fakeElement("section", { "data-testid": "conversation-turn-4" }, [currentAssistant])
  ];
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') {
      return turns;
    }
    return [];
  };
  context.document.body = {
    innerText: turns.map((turn) => turn.innerText).join("\n")
  };

  assert.equal(context.detectChatGptBlocker({ afterUserText: "current prompt" }), null);

  const failedUser = fakeElement("div", { "data-message-author-role": "user" }, [fakeText("failed prompt")]);
  const failedAssistant = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeText("Something went wrong while generating the response.")
  ]);
  const failedTurns = [
    fakeElement("section", { "data-testid": "conversation-turn-5" }, [failedUser]),
    fakeElement("section", { "data-testid": "conversation-turn-6" }, [failedAssistant])
  ];
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') {
      return failedTurns;
    }
    return [];
  };
  context.document.body = {
    innerText: failedTurns.map((turn) => turn.innerText).join("\n")
  };

  assert.equal(context.detectChatGptBlocker({ afterUserText: "failed prompt" })?.code, "generation_failed");
});

test("content script refuses to send a Bridge job from the ChatGPT start page", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/";
  context.document.body = {
    innerText: "Where should we begin? Ask anything."
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_wrong_page",
        payloadText: "ask GPT something"
      }),
    /start page|new chat|wrong page|\u65b0\u804a\u5929\u9996\u9875/i
  );
});

test("content script refuses to send when ChatGPT shows an account chooser over the composer", async () => {
  const context = await loadContentScriptContext();
  let clickedSend = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.document.body = {
    innerText: "Welcome back. zhe wang. Select an account to continue.",
    textContent: "Welcome back. zhe wang. Select an account to continue."
  };
  const accountDialog = {
    innerText: "Welcome back. zhe wang. Select an account to continue.",
    textContent: "Welcome back. zhe wang. Select an account to continue.",
    getClientRects() {
      return [{ width: 400, height: 280 }];
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector.includes("[role='dialog']") || selector.includes('[role="dialog"]')) return [accountDialog];
    return [];
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_account_blocker",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "Please analyze the file."
      }),
    /\u8d26\u53f7|account/i
  );
  assert.equal(clickedSend, false);
});

test("content script completes a visible reply even if an account chooser appears after sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "This is a Steam desktop shortcut icon." : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "What is this?",
    innerText: "What is this?",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/project/demo/c/abc";
  context.document.body = {
    get innerText() {
      return sent ? "Welcome back. zhe wang. Select an account to continue." : "";
    },
    get textContent() {
      return this.innerText;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.sleep = async () => {};
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  await context.processJob({
    id: "sync_visible_reply_with_account_prompt",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "What is this?"
  });

  assert.equal(sent, true);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_visible_reply_with_account_prompt/sent",
      "/api/sync/jobs/sync_visible_reply_with_account_prompt/complete"
    ]
  );
  assert.equal(bridgeCalls.at(-1).body.replyText, "This is a Steam desktop shortcut icon.");
});

test("content script completes preference sync jobs without sending a prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let clickedSend = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.location.href = "https://chatgpt.com/project/demo/c/abc";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [sendButton] : []);
  context.sleep = async () => {};
  context.fetch = async (url, options = {}) => {
    bridgeCalls.push({
      path: new URL(url).pathname,
      body: options.body ? JSON.parse(options.body) : null
    });
    return {
      ok: true,
      json: async () => ({})
    };
  };

  await context.processJob({
    id: "sync_preferences",
    kind: "preference_sync",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "Bridge preference sync"
  });

  assert.equal(clickedSend, false);
  assert.equal(composer.value, "");
  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/sync/jobs/sync_preferences/complete"]);
  assert.equal(bridgeCalls[0].body.replyText, "GPT 偏好已同步");
});

test("content script refreshes a loading ChatGPT shell before sending", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 70_000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.location.reload = () => {
    reloaded = true;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.document.title = "Please wait";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];

  await context.processJob({
    id: "sync_loading_shell",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Please analyze the file."
  });

  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_loading_shell");
});

test("content script refreshes instead of sending when an input artifact never appears", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let clickedSend = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 70_000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const fileInput = {
    tagName: "INPUT",
    files: [],
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clickedSend = true;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.location.reload = () => {
    reloaded = true;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'input[type="file"]') return fileInput;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    return [];
  };
  context.Event = class {
    constructor(type, options = {}) {
      this.type = type;
      this.bubbles = Boolean(options.bubbles);
    }
  };
  context.File = class {
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type || "";
      this.size = parts.reduce((total, part) => total + (part.byteLength || part.size || 0), 0);
    }
  };
  context.DataTransfer = class {
    constructor() {
      const files = [];
      this.items = {
        add(file) {
          files.push(file);
        }
      };
      Object.defineProperty(this, "files", {
        get() {
          return files;
        }
      });
    }
  };
  context.fetch = async () => ({
    ok: true,
    headers: {
      get() {
        return "image/png";
      }
    },
    async arrayBuffer() {
      return Buffer.from("png", "utf8");
    }
  });

  await context.processJob({
    id: "sync_missing_attachment",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Please analyze the image.",
    inputArtifacts: [
      {
        id: "artifact_image",
        filename: "github-repo-screenshot.png",
        contentType: "image/png",
        downloadUrl: "/api/artifacts/artifact_image/download"
      }
    ]
  });

  assert.equal(clickedSend, false);
  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_missing_attachment");
});

test("content script fails fast when ChatGPT shows a generation error", async () => {
  const context = await loadContentScriptContext();
  const prompt = "please inspect this file";
  const userTurn = fakeElement("section", { "data-testid": "conversation-turn-error-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);
  const assistantTurn = fakeElement("section", { "data-testid": "conversation-turn-error-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [
      fakeText("Something went wrong while generating the response. If this issue persists please contact us.")
    ])
  ]);
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') {
      return [userTurn, assistantTurn];
    }
    return [];
  };
  context.document.body = {
    innerText: "Something went wrong while generating the response. If this issue persists please contact us."
  };

  await assert.rejects(
    () => context.waitForAssistantReply("old answer", { afterUserText: prompt }),
    (error) => error?.errorCode === "generation_failed"
  );
});

test("content script fails fast when ChatGPT shows the short generic generation error", async () => {
  const context = await loadContentScriptContext();
  const prompt = "create a downloadable docx";
  const userTurn = fakeElement("section", { "data-testid": "conversation-turn-short-error-user" }, [
    fakeElement("div", { "data-message-author-role": "user" }, [fakeText(prompt)])
  ]);
  const assistantTurn = fakeElement("section", { "data-testid": "conversation-turn-short-error-assistant" }, [
    fakeElement("div", { "data-message-author-role": "assistant" }, [
      fakeText("Hmm...something seems to have gone wrong.")
    ])
  ]);
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') {
      return [userTurn, assistantTurn];
    }
    return [];
  };
  context.document.body = {
    innerText: "Hmm...something seems to have gone wrong."
  };

  await assert.rejects(
    () => context.waitForAssistantReply("old answer", { afterUserText: prompt }),
    (error) => error?.errorCode === "generation_failed"
  );
});

test("content script does not treat the normal ChatGPT footer disclaimer as a generation error", async () => {
  const context = await loadContentScriptContext();
  context.document.body = {
    innerText: "ChatGPT 婵炴垶姊婚崰搴ゃ亹閺屻儲鍤勯柟瀛樺笧缁愭鏌ｅ鍡楃仸闁轰礁锕俊鎾磼濠垫劕娈查梺鍝勭Т閹诧繝鎮￠敓鐘崇厒鐎广儱鐗滃ú锝吳庨崶锝呭⒉濞寸厧鎳橀弫?",
    textContent: "ChatGPT 婵炴垶姊婚崰搴ゃ亹閺屻儲鍤勯柟瀛樺笧缁愭鏌ｅ鍡楃仸闁轰礁锕俊鎾磼濠垫劕娈查梺鍝勭Т閹诧繝鎮￠敓鐘崇厒鐎广儱鐗滃ú锝吳庨崶锝呭⒉濞寸厧鎳橀弫?"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };

  assert.equal(context.detectChatGptBlocker(), null);
});

test("content script maps Bridge mode and model preferences separately", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.modeLabelForPreference("balanced"), "中");
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.6-sol"), "极速 5.5");
  assert.equal(context.modeLabelForPreference("gpt-5.5"), null);
  assert.equal(context.modelLabelForPreference("gpt-5.6-sol"), "GPT-5.6 Sol");
  assert.equal(context.modelLabelForPreference("gpt-5.5"), "GPT-5.5");
  assert.equal(context.modelLabelForPreference("o3"), "o3");
  assert.equal(context.modelLabelForPreference("gpt-4.5"), null);
  assert.equal(context.modelLabelForPreference("balanced"), null);
  assert.equal(context.modelLabelForPreference("unknown-model"), null);
});

test("content script keeps the actual mode set for every supported model", async () => {
  const context = await loadContentScriptContext();

  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.6-sol")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.5")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.4")), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(Array.from(context.modePreferencesForModel("gpt-5.3")), ["fast"]);
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.5"), "极速");
  assert.equal(context.modeLabelForPreference("pro", "gpt-5.5"), "Pro 深度模式");
  assert.equal(context.modeLabelForPreference("fast", "gpt-5.6-sol"), "极速 5.5");
  assert.equal(context.modeLabelForPreference("pro", "gpt-5.6-sol"), "Pro");
  assert.deepEqual(Array.from(context.modelLabelsForPreference("gpt-5.5")), ["GPT-5.5", "5.5"]);
  assert.deepEqual(Array.from(context.modelLabelsForPreference("gpt-5.6-sol")), ["GPT-5.6 Sol", "5.6 Sol"]);
});

test("content script chooses the model menu instead of the mode menu", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const modeButton = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 80, height: 32 }];
    },
    click() {
      clicked.push("mode");
    }
  };
  const modelButton = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("model");
      menuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("option");
      modelButton.textContent = context.modelLabelForPreference("gpt-5.4");
      modelButton.innerText = context.modelLabelForPreference("gpt-5.4");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton, modelButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, modelButton, modelOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked, ["model", "option"]);
});

test("content script chooses a model from the combined ChatGPT mode menu", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      sharedButton.textContent = context.modelLabelForPreference("gpt-5.3");
      sharedButton.innerText = context.modelLabelForPreference("gpt-5.3");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, modelOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.3" }), true);
  assert.deepEqual(clicked, ["shared", "model-option"]);
});

test("content script opens ChatGPT preference menus with pointer events", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      clicked.push(event.type);
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("click");
    }
  };
  const modeOption = {
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`option:${event.type}`);
      return true;
    },
    click() {
      clicked.push("mode-option");
      sharedButton.textContent = context.modeLabelForPreference("advanced");
      sharedButton.innerText = context.modeLabelForPreference("advanced");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, modeOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "advanced" }), true);
  assert.ok(clicked.includes("pointerdown"));
  assert.ok(clicked.includes("mode-option"));
});

test("content script switches mode through ChatGPT combined model and mode control", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("combined");
      menuOpen = true;
    }
  };
  const fastOption = {
    tagName: "BUTTON",
    textContent: "极速",
    innerText: "极速",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("fast-option");
      combinedButton.textContent = "5.5 极速";
      combinedButton.innerText = "5.5 极速";
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [combinedButton, fastOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(
    await context.selectModePreference({ modePreference: "fast", modelPreference: "gpt-5.5" }),
    true
  );
  assert.deepEqual(clicked, ["combined", "fast-option"]);
});

test("content script prefers the composer combined control over the sidebar Pro account", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const accountButton = {
    tagName: "BUTTON",
    textContent: "wangzhe Pro",
    innerText: "wangzhe Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 180, height: 56 }];
    },
    click() {
      clicked.push("account");
    }
  };
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("combined");
      menuOpen = true;
    }
  };
  const highOption = {
    tagName: "BUTTON",
    textContent: "高",
    innerText: "高",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("high-option");
      combinedButton.textContent = "5.5高";
      combinedButton.innerText = "5.5高";
    }
  };
  const composerScope = {
    querySelectorAll(selector) {
      return selector === "button,[role='button']" ? [combinedButton] : [];
    }
  };
  const composer = {
    closest(selector) {
      return selector === '[data-testid*="composer"]' ? composerScope : null;
    },
    parentElement: null
  };

  context.document.querySelector = (selector) => selector === "#prompt-textarea" ? composer : null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [accountButton, combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [accountButton, combinedButton, highOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(
    await context.selectModePreference({ modePreference: "advanced", modelPreference: "gpt-5.5" }),
    true
  );
  assert.deepEqual(clicked, ["combined", "high-option"]);
  assert.equal(context.textContainsPreferenceLabel("极高", "高"), false);
});

test("content script chooses the actual menu item instead of a wrapper div", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sharedButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      menuOpen = true;
      clicked.push("shared");
    }
  };
  const wrapperDiv = {
    tagName: "DIV",
    textContent: `${context.modeLabelForPreference("fast")} ${context.modeLabelForPreference("balanced")} ${context.modeLabelForPreference("advanced")} ${context.modeLabelForPreference("high")}`,
    innerText: `${context.modeLabelForPreference("fast")} ${context.modeLabelForPreference("balanced")} ${context.modeLabelForPreference("advanced")} ${context.modeLabelForPreference("high")}`,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 180, height: 220 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`wrapper:${event.type}`);
      return true;
    },
    click() {
      clicked.push("wrapper");
    }
  };
  const balancedOption = {
    tagName: "DIV",
    textContent: context.modeLabelForPreference("balanced"),
    innerText: context.modeLabelForPreference("balanced"),
    getAttribute(name) {
      return name === "role" ? "menuitem" : null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 160, height: 36 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`option:${event.type}`);
      return true;
    },
    click() {
      clicked.push("balanced-option");
      sharedButton.textContent = context.modeLabelForPreference("balanced");
      sharedButton.innerText = context.modeLabelForPreference("balanced");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [sharedButton, wrapperDiv, balancedOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.ok(clicked.includes("balanced-option"));
  assert.equal(clicked.includes("wrapper"), false);
});

test("content script verifies mode selection and retries when ChatGPT does not apply it immediately", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let optionClicks = 0;
  const targetLabel = context.modeLabelForPreference("balanced");
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const targetOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      optionClicks += 1;
      clicked.push(`option:${optionClicks}`);
      menuOpen = false;
      if (optionClicks >= 2) {
        modeButton.textContent = targetLabel;
        modeButton.innerText = targetLabel;
      }
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, targetOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.deepEqual(clicked.filter((entry) => entry.startsWith("option:")), ["option:1", "option:2"]);
});

test("content script selects the GPT-5.4 professional mode label from ChatGPT", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const targetLabel = "\u4e13\u4e1a";
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const professionalOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("professional-option");
      modeButton.textContent = targetLabel;
      modeButton.innerText = targetLabel;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, professionalOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "pro", modelPreference: "gpt-5.4" }), true);
  assert.ok(clicked.includes("professional-option"));
});

test("content script keeps preference polling responsive and reports preference freshness", async () => {
  const source = await readFile("chrome-extension/content-script.js", "utf8");

  assert.match(source, /const POLL_MS = 1500;/);
  assert.match(source, /function bridgeClientId\(\)/);
  assert.match(source, /updatedAt: preferences\.updatedAt \|\| null/);
});

test("content script uses a stable per-tab worker id so ChatGPT tabs do not overwrite each other", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  };

  const first = context.currentWorkerId();
  const second = context.currentWorkerId();

  assert.equal(first, second);
  assert.match(first, /v20260712-preference-verify:runtime-missing:tab_/);
  assert.equal(storage.size, 1);
});

test("content script reloads the current ChatGPT page once after extension reload is requested", async () => {
  const context = await loadContentScriptContext();
  const runtimeMessages = [];
  const scheduled = [];
  const storage = new Map();
  let pageReloads = 0;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    }
  };
  context.chrome = {
    runtime: {
      sendMessage(payload) {
        runtimeMessages.push(payload);
      }
    }
  };
  context.location = {
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      pageReloads += 1;
    }
  };
  context.setTimeout = (callback, ms) => {
    scheduled.push({ callback, ms });
    return scheduled.length;
  };

  assert.equal(context.maybeReloadExtensionFromHeartbeat({
    reloadExtension: true,
    expectedExtensionVersion: "v20260712-preference-verify"
  }), true);
  assert.equal(context.maybeReloadExtensionFromHeartbeat({
    reloadExtension: true,
    expectedExtensionVersion: "v20260712-preference-verify"
  }), true);

  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:reloadExtension",
      expectedVersion: "v20260712-preference-verify"
    }
  ]);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 750);
  scheduled[0].callback();
  assert.equal(pageReloads, 1);
});

test("content script retries when the ChatGPT preference menu is not ready yet", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let openAttempts = 0;
  const targetLabel = context.modeLabelForPreference("balanced");
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        openAttempts += 1;
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const targetOption = {
    tagName: "BUTTON",
    textContent: targetLabel,
    innerText: targetLabel,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen && openAttempts >= 2 ? [{ width: 120, height: 36 }] : [];
    },
    dispatchEvent() {
      return true;
    },
    click() {
      clicked.push("option");
      modeButton.textContent = targetLabel;
      modeButton.innerText = targetLabel;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, targetOption];
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.equal(openAttempts >= 2, true);
  assert.ok(clicked.includes("option"));
});

test("content script dismisses an open preference menu when the target option is unavailable", async () => {
  const context = await loadContentScriptContext();
  let menuOpen = false;
  const escapeEvents = [];
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent() {
      menuOpen = true;
      return true;
    },
    click() {
      menuOpen = true;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton];
    return [];
  };
  context.document.dispatchEvent = (event) => {
    if (event.key === "Escape") {
      escapeEvents.push(event.type);
      menuOpen = false;
    }
    return true;
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  context.MouseEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };
  context.KeyboardEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      Object.assign(this, init);
    }
  };

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), false);
  assert.equal(menuOpen, false);
  assert.deepEqual(escapeEvents.slice(-2), ["keydown", "keyup"]);
});

test("content script opens the ChatGPT model submenu before choosing a model", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let submenuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelSubmenu = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(event.type);
      submenuOpen = true;
    },
    click() {
      clicked.push("submenu");
      submenuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return submenuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      sharedButton.textContent = context.modelLabelForPreference("gpt-5.4");
      sharedButton.innerText = context.modelLabelForPreference("gpt-5.4");
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [sharedButton, modelSubmenu, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked, ["shared", "mouseenter", "mousemove", "mousedown", "model-option"]);
});

test("content script accepts model selection when ChatGPT keeps the collapsed control mode-only", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  let submenuOpen = false;
  const sharedButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    dispatchEvent(event) {
      if (event.type === "pointerdown") {
        menuOpen = true;
      }
      return true;
    },
    click() {
      clicked.push("shared");
      menuOpen = true;
    }
  };
  const modelSubmenu = {
    textContent: context.modelLabelForPreference("gpt-5.5"),
    innerText: context.modelLabelForPreference("gpt-5.5"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    dispatchEvent(event) {
      clicked.push(`submenu:${event.type}`);
      submenuOpen = true;
      return true;
    },
    click() {
      clicked.push("submenu");
      submenuOpen = true;
    }
  };
  const modelOption = {
    textContent: context.modelLabelForPreference("gpt-5.4"),
    innerText: context.modelLabelForPreference("gpt-5.4"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return submenuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      menuOpen = false;
      submenuOpen = false;
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sharedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [sharedButton, modelSubmenu, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};
  context.PointerEvent = class {
    constructor(type) {
      this.type = type;
    }
  };
  context.MouseEvent = class {
    constructor(type) {
      this.type = type;
    }
  };

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.4" }), true);
  assert.deepEqual(clicked.filter((entry) => entry === "model-option"), ["model-option"]);
});

test("content script does not choose retired GPT-4.5 model preferences", async () => {
  const context = await loadContentScriptContext();

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-4.5" }), false);
});

test("content script ignores old assistant model buttons when using composer preferences", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const oldTurn = {
    tagName: "SECTION",
    getAttribute(name) {
      return name === "data-testid" ? "conversation-turn-1" : null;
    }
  };
  const historicalModelButton = {
    tagName: "BUTTON",
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    parentElement: oldTurn,
    parentNode: oldTurn,
    getAttribute() {
      return null;
    },
    closest(selector) {
      return selector === 'section[data-testid^="conversation-turn-"]' ? oldTurn : null;
    },
    getClientRects() {
      return [{ width: 80, height: 30 }];
    },
    click() {
      clicked.push("historical");
    }
  };
  const composerForm = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [composerModeButton];
      return [];
    }
  };
  const composer = {
    closest(selector) {
      return selector === "form" ? composerForm : null;
    }
  };
  const composerModeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {
      clicked.push("composer-mode");
      menuOpen = true;
    }
  };
  const modelOption = {
    tagName: "BUTTON",
    textContent: context.modelLabelForPreference("gpt-5.3"),
    innerText: context.modelLabelForPreference("gpt-5.3"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 100, height: 32 }] : [];
    },
    click() {
      clicked.push("model-option");
      composerModeButton.textContent = context.modelLabelForPreference("gpt-5.3");
      composerModeButton.innerText = context.modelLabelForPreference("gpt-5.3");
    }
  };

  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [historicalModelButton, composerModeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") {
      return [historicalModelButton, composerModeButton, modelOption];
    }
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModelPreference({ modelPreference: "gpt-5.3" }), true);
  assert.deepEqual(clicked, ["composer-mode", "model-option"]);
});

test("content script looks beyond the composer form for mode controls", async () => {
  const context = await loadContentScriptContext();
  const clicked = [];
  let menuOpen = false;
  const sendButton = {
    tagName: "BUTTON",
    textContent: "",
    innerText: "",
    getAttribute(name) {
      return name === "aria-label" ? "Send prompt" : null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [{ width: 32, height: 32 }];
    },
    click() {
      clicked.push("send");
    }
  };
  const modeButton = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("advanced"),
    innerText: context.modeLabelForPreference("advanced"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return [{ width: 86, height: 32 }];
    },
    click() {
      clicked.push("mode");
      menuOpen = true;
    }
  };
  const modeOption = {
    tagName: "BUTTON",
    textContent: context.modeLabelForPreference("balanced"),
    innerText: context.modeLabelForPreference("balanced"),
    getAttribute() {
      return null;
    },
    closest() {
      return null;
    },
    getClientRects() {
      return menuOpen ? [{ width: 86, height: 32 }] : [];
    },
    click() {
      clicked.push("mode-option");
      modeButton.textContent = context.modeLabelForPreference("balanced");
      modeButton.innerText = context.modeLabelForPreference("balanced");
    }
  };
  const composerForm = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [sendButton];
      return [];
    }
  };
  const composerWrapper = {
    querySelectorAll(selector) {
      if (selector === "button,[role='button']") return [sendButton, modeButton];
      return [];
    }
  };
  const composer = {
    closest(selector) {
      if (selector === "form") return composerForm;
      if (selector === '[data-testid*="composer"]') return composerWrapper;
      return null;
    }
  };

  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [sendButton, modeButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [modeButton, modeOption];
    return [];
  };
  context.sleep = async () => {};

  assert.equal(await context.selectModePreference({ modePreference: "balanced" }), true);
  assert.deepEqual(clicked, ["mode", "mode-option"]);
});

test("content script treats ChatGPT fallback query parameters as the same bound conversation", async () => {
  const context = await loadContentScriptContext();
  let refreshed = false;
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat?mweb_fallback=1",
    replace() {
      refreshed = true;
    },
    reload() {
      refreshed = true;
    }
  };

  assert.equal(
    context.ensureExpectedChatGptPage({
      projectUrl: "https://chatgpt.com/c/bound-chat"
    }),
    true
  );
  assert.equal(refreshed, false);
});

test("content script extracts clean assistant text without ChatGPT chrome", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "ChatGPT \u8bf4\uff1a\u5df2\u601d\u8003 29sActual answer\n\u7f16\u8f91\n\u6765\u6e90",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.visibleReplyTextFromAssistant(message, "old answer"), "Actual answer");
});

test("content script preserves rendered markdown structure from assistant DOM", async () => {
  const context = await loadContentScriptContext();
  const table = fakeElement("table", {}, [
    fakeElement("tr", {}, [fakeElement("th", {}, [fakeText("Name")]), fakeElement("th", {}, [fakeText("Value")])]),
    fakeElement("tr", {}, [fakeElement("td", {}, [fakeText("Status")]), fakeElement("td", {}, [fakeText("OK")])])
  ]);
  const message = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeElement("h1", {}, [fakeText("Report")]),
    fakeElement("h2", {}, [fakeText("Checks")]),
    fakeElement("p", {}, [fakeText("Intro paragraph.")]),
    fakeElement("ul", {}, [fakeElement("li", {}, [fakeText("First bullet")])]),
    fakeElement("ol", {}, [fakeElement("li", {}, [fakeText("First step")])]),
    fakeElement("blockquote", {}, [fakeElement("p", {}, [fakeText("quoted line")])]),
    table,
    fakeElement("pre", {}, [fakeElement("code", { className: "language-js" }, [fakeText("console.log(\"ok\");")])])
  ]);

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.match(reply, /^# Report/m);
  assert.match(reply, /^## Checks/m);
  assert.match(reply, /^- First bullet/m);
  assert.match(reply, /^1\. First step/m);
  assert.match(reply, /^> quoted line/m);
  assert.match(reply, /\| Name \| Value \|/);
  assert.match(reply, /```js\nconsole\.log\("ok"\);\n```/);
});

test("content script returns raw single code block with line breaks", async () => {
  const context = await loadContentScriptContext();
  const code = "<!DOCTYPE html>\n<html>\n<head></head>\n<body>OK</body>\n</html>";
  const message = fakeElement("div", { "data-message-author-role": "assistant" }, [
    fakeElement("pre", {}, [fakeElement("code", { className: "language-html" }, [fakeText(code)])])
  ]);

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.equal(reply, code);
  assert.equal(reply.split("\n").length, 5);
});

test("content script ignores disabled or hidden stop buttons when checking generation state", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: true,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    },
    {
      disabled: false,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), false);
});

test("content script treats a visible enabled stop button as active generation", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: false,
      getAttribute() {
        return "Stop generating";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), true);
});

test("content script stops a data-testid only generation button", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "data-testid") return "stop-button";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    },
    click() {
      clicked = true;
      this.disabled = true;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [];
    if (selector === '[data-testid*="stop"]') return [stopButton];
    return [];
  };
  context.sleep = async () => {};

  const stopped = await context.stopActiveGenerationIfPossible(5);

  assert.equal(stopped, true);
  assert.equal(clicked, true);
});

test("content script reports active generation in page status", async () => {
  const context = await loadContentScriptContext();
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    }
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stopButton] : []);

  const status = context.currentPageStatus();

  assert.equal(status.state, "working");
  assert.equal(status.code, "active_generation");
});

test("content script ignores visible non-stop generating labels", async () => {
  const context = await loadContentScriptContext();
  const buttons = [
    {
      disabled: false,
      getAttribute() {
        return "Generating image";
      },
      title: "",
      textContent: "",
      getClientRects() {
        return [{ width: 20, height: 20 }];
      }
    }
  ];
  context.document.querySelectorAll = (selector) => (selector === "button" ? buttons : []);

  assert.equal(context.isGenerating(), false);
});

test("content script ignores stopped thinking buttons when checking generation state", async () => {
  const context = await loadContentScriptContext();
  const stoppedThinkingButton = {
    disabled: false,
    getAttribute() {
      return null;
    },
    title: "",
    textContent: "宸插仠姝拷?",
    getClientRects() {
      return [{ width: 94, height: 24 }];
    }
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stoppedThinkingButton] : []);

  assert.equal(context.isGenerating(), false);
});

test("content script returns stable text replies even when a global stop button is stale", async () => {
  const context = await loadContentScriptContext();
  const prompt = "???????";
  let now = 0;
  let sleepCount = 0;
  const finalText = "???????????????????????????????";

  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };
  context.sleep = async () => {
    sleepCount += 1;
  };

  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: finalText,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: finalText,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    inputArtifactCount: 1
  });

  assert.equal(reply, finalText);
  assert.ok(sleepCount < 15);
});

test("content script settles image replies that remain stuck in generating state", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  let stopClicked = false;
  let generating = true;
  context.Date = class extends Date {
    static now() {
      now += 100000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };

  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=file_direct_10_01",
    src: "https://chatgpt.com/backend-api/estuary/content?id=file_direct_10_01",
    naturalWidth: 1024,
    naturalHeight: 1024,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 512 }];
    }
  };
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return generating ? [{ width: 24, height: 24 }] : [];
    },
    click() {
      stopClicked = true;
      generating = false;
    }
  };
  const assistantTurn = {
    textContent: "generated image visible",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return {};
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };
  const userTurn = {
    textContent: "direct image prompt",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: "direct image prompt" });

  assert.equal(reply, "generated image visible");
  assert.equal(stopClicked, true);
});

test("content script does not expose interim processing text when an image is already visible", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=image-final",
    src: "https://chatgpt.com/backend-api/estuary/content?id=image-final",
    naturalWidth: 1024,
    naturalHeight: 1536,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 768 }];
    }
  };
  const message = {
    textContent:
      "ChatGPT \u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u8bf7\u6c42\uff0cBridge \u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d\u3002",
    innerText:
      "ChatGPT \u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u8bf7\u6c42\uff0cBridge \u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d\u3002",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      if (selector === "button") return [];
      return [];
    },
    closest() {
      return this;
    }
  };

  const reply = context.visibleReplyTextFromAssistant(message, "old answer");

  assert.equal(reply, "\u5df2\u751f\u6210\u56fe\u7247\u3002");
});

test("content script refreshes the bound page once before sending a new unsent job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  const job = {
    id: "sync_pre_send_refresh",
    projectUrl: "https://chatgpt.com/project/demo/c/abc",
    payloadText: "next task",
    _bridgeNeedsPreSendRefresh: true
  };
  let reloaded = false;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = () => {
    throw new Error("composer should not be touched before pre-send refresh");
  };
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (apiPath) => {
    bridgeCalls.push(apiPath);
    if (apiPath === "/api/sync/jobs/sync_pre_send_refresh/pre-send-refresh") {
      return {
        job: {
          ...job,
          _bridgePreSendRefresh: true,
          _bridgeRefreshAttempts: 1
        }
      };
    }
    throw new Error(`Unexpected bridge call: ${apiPath}`);
  };

  await context.processJob(job);

  assert.equal(reloaded, true);
  assert.deepEqual(bridgeCalls, ["/api/sync/jobs/sync_pre_send_refresh/pre-send-refresh"]);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_pre_send_refresh");
  assert.equal(stored.job._bridgePreSendRefresh, true);
});

test("content script stops stale generation before sending a new job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const actions = [];
  let generating = true;
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return generating ? [{ width: 24, height: 24 }] : [];
    },
    getBoundingClientRect() {
      return { left: 20, top: 10, width: 40, height: 20 };
    },
    click() {
      actions.push("stop");
      generating = false;
    }
  };
  const sendButton = {
    get disabled() {
      return generating;
    },
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return generating ? [] : [{ width: 24, height: 24 }];
    },
    click() {
      actions.push("send");
      sent = true;
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  let sent = false;
  const assistant = () => ({
    textContent: sent ? "new answer after stale generation stopped" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "next task",
    innerText: "next task",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return generating ? null : sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton, sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_after_stale",
    payloadText: "next task"
  });

  assert.deepEqual(actions, ["stop", "send"]);
  assert.equal(composer.value, "next task");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_after_stale/sent", "/api/sync/jobs/sync_after_stale/complete"]
  );
});

test("content script waits for the ChatGPT composer before sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  let sent = false;
  let composerQueries = 0;
  const assistant = () => ({
    textContent: sent ? "answer after composer appears" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "send after load",
    innerText: "send after load",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      composerQueries += 1;
      return composerQueries >= 3 ? composer : null;
    }
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_composer",
    payloadText: "send after load"
  });

  assert.equal(sent, true);
  assert.equal(composer.value, "send after load");
  assert.equal(composerQueries, 3);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_wait_composer/sent", "/api/sync/jobs/sync_wait_composer/complete"]
  );
});

test("content script sends with the ChatGPT composer submit button", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  let sent = false;
  const submitButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after composer submit" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "send with submit",
    innerText: "send with submit",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_submit",
    payloadText: "send with submit"
  });

  assert.equal(sent, true);
  assert.equal(composer.value, "send with submit");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_submit/sent", "/api/sync/jobs/sync_composer_submit/complete"]
  );
});

test("content script uses a trusted browser click for the ChatGPT composer submit button", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    tagName: "BUTTON",
    disabled: false,
    textContent: "Send",
    innerText: "Send",
    getAttribute() {
      return null;
    },
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 40, width: 30, height: 30 };
    }
  };
  const assistant = () => ({
    textContent: sent ? "ok" : "old",
    innerText: sent ? "ok" : "old",
    getAttribute(name) {
      if (name === "data-message-author-role") return "assistant";
      return null;
    }
  });
  const userMessage = {
    textContent: "send trusted",
    innerText: "send trusted",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeCalls.push(payload);
        if (payload.type === "bridge:trustedClick") {
          sent = true;
          callback?.({ ok: true });
          return;
        }
        callback?.({ ok: true });
      }
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_trusted_submit",
    payloadText: "send trusted"
  });

  assert.equal(sent, true);
  assert.deepEqual(
    runtimeCalls.map((call) => call.type),
    ["bridge:trustedClick"]
  );
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_trusted_submit/sent", "/api/sync/jobs/sync_composer_trusted_submit/complete"]
  );
});

test("content script retries submit when trusted click leaves the draft in the composer", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    tagName: "BUTTON",
    disabled: false,
    textContent: "Send",
    innerText: "Send",
    getAttribute() {
      return null;
    },
    click() {
      sent = true;
      composer.value = "";
    },
    scrollIntoView() {},
    getBoundingClientRect() {
      return { left: 20, top: 40, width: 30, height: 30 };
    }
  };
  const assistant = () => ({
    textContent: sent ? "ok" : "old",
    innerText: sent ? "ok" : "old",
    getAttribute(name) {
      if (name === "data-message-author-role") return "assistant";
      return null;
    }
  });
  const userMessage = {
    textContent: "send after retry",
    innerText: "send after retry",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeCalls.push(payload);
        callback?.({ ok: true });
      }
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_composer_retry_submit",
    payloadText: "send after retry"
  });

  assert.equal(sent, true);
  assert.deepEqual(
    runtimeCalls.map((call) => call.type),
    ["bridge:trustedClick"]
  );
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_composer_retry_submit/sent", "/api/sync/jobs/sync_composer_retry_submit/complete"]
  );
});

test("content script replaces stale contenteditable composer text before sending", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "DIV",
    textContent: "缂傚倷缍€閸涱垱鏆伴梺姹囧灮閸犳劙宕瑰璺虹闁冲搫顑嗭拷??10 閻庢鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    innerText: "缂傚倷缍€閸涱垱鏆伴梺姹囧灮閸犳劙宕瑰璺虹闁冲搫顑嗭拷??10 閻庢鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    focus() {},
    dispatchEvent() {}
  };
  const submitButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userMessage = {
    textContent: "new prompt",
    innerText: "new prompt",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: "new prompt",
    innerText: "new prompt",
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: sent ? "new answer" : "old answer",
    innerText: sent ? "new answer" : "old answer",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.execCommand = (command, _showUi, value) => {
    if (command === "insertText") {
      composer.textContent += value;
      composer.innerText += value;
    }
    return true;
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return submitButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [submitButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_replace_stale_composer",
    payloadText: "new prompt"
  });

  assert.equal(sent, true);
  assert.equal(composer.textContent, "new prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_replace_stale_composer/sent", "/api/sync/jobs/sync_replace_stale_composer/complete"]
  );
});

test("content script clears a Bridge draft when a send fails before submit", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const inputEvents = [];
  const composer = {
    tagName: "TEXTAREA",
    value: "old draft",
    focus() {},
    dispatchEvent(event) {
      inputEvents.push(event);
    }
  };
  const disabledSendButton = {
    disabled: true,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return disabledSendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [disabledSendButton];
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async () => ({});

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_failed_before_submit",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "draft that should be cleared"
      }),
    /(?:ChatGPT send button not ready|GPT \u53d1\u9001\u6309\u94ae\u8fd8\u6ca1(?:\u6709)?\u51c6\u5907\u597d)/
  );

  assert.equal(composer.value, "");
  assert.ok(inputEvents.length >= 2);
});

test("content script refreshes and resumes when stale generation cannot be stopped", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  const actions = [];
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 16000;
      return now;
    }
  }
  const stopButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    getBoundingClientRect() {
      return { left: 20, top: 10, width: 40, height: 20 };
    },
    click() {
      actions.push("stop");
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };
  context.bridgeApi = async () => {
    throw new Error("job should wait for reload instead of calling the bridge");
  };

  await context.processJob({
    id: "sync_stuck_generation",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "next task after stuck generation"
  });

  assert.deepEqual(actions, ["stop"]);
  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_stuck_generation");
});

test("content script refreshes an already sent job when ChatGPT reply times out", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloaded = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 301000;
      return now;
    }
  }

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  const userTurn = {
    textContent: "image prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn];
    return [];
  };
  context.bridgeApi = async () => {
    throw new Error("timed out sent job should wait for reload instead of failing");
  };

  await context.processJob(
    {
      id: "sync_sent_timeout",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "image prompt",
      sentAt: "2026-06-27T11:00:00.000Z",
      previousAssistantText: "old answer"
    },
    { resume: true }
  );

  assert.equal(reloaded, true);
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_sent_timeout");
  assert.equal(stored.job.sentAt, "2026-06-27T11:00:00.000Z");
  assert.equal(stored.job.previousAssistantText, "old answer");
});

test("content script downloads artifacts from the last assistant message", async () => {
  const context = await loadContentScriptContext();
  const anchor = {
    href: "blob:https://chatgpt.com/report",
    download: "report.txt",
    textContent: "Download report.txt",
    title: "",
    getAttribute(name) {
      if (name === "href") return this.href;
      if (name === "aria-label") return "";
      return null;
    }
  };
  const message = {
    querySelectorAll(selector) {
      return selector === "a[href]" ? [anchor] : [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "text/plain";
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from("report from gpt", "utf8")
  });

  const result = await context.collectDownloadArtifacts(message);

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts[0].filename, "report.txt");
  assert.equal(result.artifacts[0].contentType, "text/plain");
  assert.equal(result.artifacts[0].base64Data, Buffer.from("report from gpt", "utf8").toString("base64"));
});

test("content script captures artifacts from ChatGPT file card download buttons", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const card = {
    textContent: "jokes.xlsx",
    querySelectorAll(selector) {
      return selector === "button" ? [button] : [];
    }
  };
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download jokes.xlsx";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    closest() {
      return card;
    },
    click() {
      clicked = true;
    }
  };
  const message = {
    textContent: "jokes.xlsx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "jokes.xlsx");
          assert.equal(payload.syncJobId, "sync_card");
          return { ok: true, watchId: "watch_1" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_1");
          return {
            ok: true,
            artifact: {
              id: "artifact_jokes",
              filename: "jokes.xlsx"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_card" });

  assert.equal(clicked, true);
  assert.equal(result.artifactIds.length, 1);
  assert.equal(result.artifactIds[0], "artifact_jokes");
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script does not use office preview images as downloadable file artifacts", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "data:image/png;base64,preview-image",
    src: "data:image/png;base64,preview-image",
    naturalWidth: 512,
    naturalHeight: 300,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 300 }];
    }
  };
  const message = {
    textContent: "鐎规瓕灏欓弫鎾诲箣閹邦剙璁插☉鎾愁儓锟?Excel 闁哄倸娲ｅ▎銏ゆ晬濮濇笧idge-regression-table.xlsx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [image];
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_xlsx_preview" });

  assert.equal(result.artifacts.length, 0);
  assert.equal(result.artifactIds.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script recovers imported artifacts when extension context invalidates during file-card capture", async () => {
  const context = await loadContentScriptContext();
  let clicked = false;
  const card = {
    textContent: "bridge-regression-note-20260705.txt",
    querySelectorAll(selector) {
      return selector === "button" ? [button] : [];
    }
  };
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-regression-note-20260705.txt";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    closest() {
      return card;
    },
    click() {
      clicked = true;
    }
  };
  const message = {
    textContent: "bridge-regression-note-20260705.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-regression-note-20260705.txt");
          assert.equal(payload.syncJobId, "sync_recovered_txt");
          return { ok: true, watchId: "watch_recovered_txt" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          throw new Error("Extension context invalidated.");
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  context.fetch = async (url) => {
    assert.equal(String(url), "http://127.0.0.1:4317/api/artifacts?syncJobId=sync_recovered_txt");
    return {
      ok: true,
      json: async () => ({
        artifacts: [
          {
            id: "artifact_recovered_txt",
            filename: "bridge-regression-note-20260705.txt"
          }
        ]
      })
    };
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_recovered_txt" });

  assert.equal(clicked, true);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_recovered_txt"]);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script rebuilds generated text artifacts before clicking GPT behavior downloads", async () => {
  const context = await loadContentScriptContext();
  let trustedClicks = 0;
  const filename = "bridge-regression-note-20260705-v3.txt";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: `闂佽法鍠愰弸濠氬箯閻戣姤鏅搁柡鍌樺€栵拷?${filename}`,
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 40, top: 80, width: 260, height: 24 };
    },
    getClientRects() {
      return [{ width: 260, height: 24 }];
    },
    click() {}
  };
  const message = {
    textContent: [
      "Generated file:",
      `闂佽法鍠愰弸濠氬箯閻戣姤鏅搁柡鍌樺€栵拷?${filename}`,
      "```python",
      "from pathlib import Path",
      `path = Path(\"/mnt/data/${filename}\")`,
      "path.write_text(\"bridge txt capture ok 20260705 v3\", encoding=\"utf-8\")",
      "print(f\"Created: {path}\")",
      "```",
      `STDOUT/STDERR\nCreated: /mnt/data/${filename}`
    ].join("\n"),
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button, button];
      if (selector === "img") return [];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: "watch_text" };
        }
        if (payload.type === "bridge:trustedClick") {
          trustedClicks += 1;
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return { ok: false, error: `Timed out waiting for Chrome download ${filename}` };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_text_fallback" });

  assert.equal(trustedClicks, 0);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.errors.length, 0);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(result.artifacts[0].contentType, "text/plain; charset=utf-8");
  assert.equal(result.artifacts[0].base64Data, Buffer.from("bridge txt capture ok 20260705 v3", "utf8").toString("base64"));
});

test("content script uses a trusted browser click for ChatGPT behavior download buttons", async () => {
  const context = await loadContentScriptContext();
  let ordinaryClicked = false;
  const messages = [];
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download ZIP",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 50, width: 80, height: 20 };
    },
    getClientRects() {
      return [{ width: 80, height: 20 }];
    },
    click() {
      ordinaryClicked = true;
    }
  };
  const message = {
    textContent: "Download ZIP",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, null);
          return { ok: true, watchId: "watch_zip" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 140, y: 60 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_zip");
          return {
            ok: true,
            artifact: {
              id: "artifact_zip",
              filename: "multi-image-final-icons.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip" });

  assert.equal(ordinaryClicked, false);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script uses a trusted browser click for icon-only ChatGPT file card download buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const filename = "bridge-regression-table.xlsx";
  let ordinaryClicked = false;

  const card = {
    textContent: filename,
    parentElement: null,
    parentNode: null,
    querySelectorAll(selector) {
      if (selector === "button") return [downloadButton, expandButton];
      return [];
    }
  };
  const downloadButton = {
    className: "hover:text-token-text-secondary hover:bg-token-bg-tertiary rounded-full p-1",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    parentNode: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 80, width: 28, height: 28 };
    },
    getClientRects() {
      return [{ width: 28, height: 28 }];
    },
    scrollIntoView() {},
    click() {
      ordinaryClicked = true;
    }
  };
  const expandButton = {
    ...downloadButton,
    parentElement: card,
    parentNode: card,
    click() {}
  };
  const message = {
    textContent: filename,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [downloadButton, expandButton];
      if (selector === "img") return [];
      return [];
    }
  };
  card.parentElement = message;
  card.parentNode = message;

  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: "watch_icon_file_card" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 114, y: 94 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          assert.equal(payload.watchId, "watch_icon_file_card");
          return {
            ok: true,
            artifact: { id: "artifact_icon_file_card", filename }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_icon_card" });

  assert.equal(ordinaryClicked, false);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_icon_file_card"]);
  assert.equal(result.errors.length, 0);
});

test("content script retries a file card with DOM click after trusted click download timeout", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const filename = "bridge-live-doc.docx";
  let ordinaryClicked = false;
  let watchCount = 0;

  const card = {
    textContent: filename,
    parentElement: null,
    parentNode: null,
    querySelectorAll(selector) {
      if (selector === "button") return [downloadButton];
      return [];
    }
  };
  const downloadButton = {
    className: "hover:text-token-text-secondary hover:bg-token-bg-tertiary rounded-full p-1",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    parentNode: card,
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 100, top: 80, width: 28, height: 28 };
    },
    getClientRects() {
      return [{ width: 28, height: 28 }];
    },
    scrollIntoView() {},
    click() {
      ordinaryClicked = true;
    }
  };
  const message = {
    textContent: filename,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [downloadButton];
      if (selector === "img") return [];
      return [];
    }
  };
  card.parentElement = message;
  card.parentNode = message;

  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          watchCount += 1;
          assert.equal(payload.expectedFilename, filename);
          return { ok: true, watchId: `watch_doc_${watchCount}` };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 114, y: 94 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          if (payload.watchId === "watch_doc_1") {
            return {
              ok: false,
              error: `Timed out waiting for Chrome download ${filename}`
            };
          }
          assert.equal(payload.watchId, "watch_doc_2");
          return {
            ok: true,
            artifact: { id: "artifact_doc_retry", filename }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_doc_retry" });

  assert.equal(ordinaryClicked, true);
  assert.deepEqual(
    messages.map((message) => message.type),
    [
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch",
      "bridge:startDownloadWatch",
      "bridge:awaitDownloadWatch"
    ]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_doc_retry"]);
  assert.equal(result.errors.length, 0);
});

test("content script reveals interpreter download resources from download-labeled file buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filename = "bridge-live-doc-final.docx";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: `涓嬭浇 ${filename}`,
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 80, top: 120, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {}
  };
  const message = {
    textContent: `宸茬敓鎴愶細涓嬭浇 ${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      if (selector === "img") return [];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          resources.push({
            name:
              "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=" +
              encodeURIComponent(`/mnt/data/${filename}`)
          });
          return { ok: true };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, filename);
          return {
            ok: true,
            artifact: {
              id: "artifact_download_labeled_docx",
              filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_download_labeled_docx" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_download_labeled_docx"]);
  assert.equal(result.errors.length, 0);
});

test("content script imports ChatGPT interpreter download resources for filename-only buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filenames = ["direct-10-icons-v2-01.png", "direct-10-icons-v2-02.png"];
  const buttons = filenames.map((filename) => ({
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: filename,
    title: "",
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 120, height: 20 };
    },
    getClientRects() {
      return [{ width: 120, height: 20 }];
    },
    click() {
      resources.push({
        name: `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`
      });
    }
  }));
  const message = {
    textContent: `闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼幏宀婂晣锟??{filenames.join(" ")}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return buttons;
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.fetch = async () => {
    throw new Error("interpreter downloads should be delegated to the background download bridge");
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          return { ok: false };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.syncJobId, "sync_interpreter");
          assert.ok(filenames.includes(payload.filename));
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: `artifact_${payload.filename}`,
              filename: payload.filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_interpreter" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:trustedClick", "bridge:downloadUrl", "bridge:downloadUrl"]
  );
  assert.deepEqual(
    Array.from(result.artifactIds),
    filenames.map((filename) => `artifact_${filename}`)
  );
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script waits for delayed interpreter download resources after clicking file reference buttons", async () => {
  const context = await loadContentScriptContext();
  const resources = [];
  const messages = [];
  const filename = "bridge-live-note-delayed.md";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: filename,
    title: "",
    getAttribute() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 160, height: 20 };
    },
    getClientRects() {
      return [{ width: 160, height: 20 }];
    },
    click() {}
  };
  const message = {
    textContent: `Generated file: ${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? resources : [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:trustedClick") {
          setTimeout(() => {
            resources.push({
              name: `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`
            });
          }, 400);
          return { ok: true };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, filename);
          return {
            ok: true,
            artifact: {
              id: "artifact_delayed_md",
              filename
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_delayed_md" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:trustedClick", "bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_delayed_md"]);
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script fetches interpreter resources from the page when background download is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-table.xlsx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
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
      arrayBuffer: async () => Buffer.from("xlsx bytes from page context", "utf8")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_page_fetch" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(
    result.artifacts[0].contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.equal(result.artifacts[0].base64Data, Buffer.from("xlsx bytes from page context", "utf8").toString("base64"));
  assert.deepEqual(fetchCalls, [interpreterUrl]);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script retries interpreter resources through the page context when isolated fetch is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-deck.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const listeners = new Map();

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.window = context;
  context.addEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };
  context.removeEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    listeners.set(
      type,
      handlers.filter((candidate) => candidate !== handler)
    );
  };
  context.postMessage = (message) => {
    for (const handler of listeners.get("message") || []) {
      handler({ source: context.window, data: message });
    }
  };
  context.document.createElement = () => ({
    textContent: "",
    remove() {}
  });
  context.document.documentElement = {
    appendChild(script) {
      vm.runInContext(script.textContent, context);
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
    if (fetchCalls.length === 1) {
      return {
        ok: false,
        status: 401,
        headers: {
          get() {
            return null;
          }
        },
        arrayBuffer: async () => Buffer.from("")
      };
    }
    return {
      ok: true,
      url: String(url),
      headers: {
        get(name) {
          return name.toLowerCase() === "content-type"
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : null;
        }
      },
      arrayBuffer: async () => Buffer.from("pptx bytes from page context", "utf8")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_page_context_fetch" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(fetchCalls, [interpreterUrl, interpreterUrl]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(
    result.artifacts[0].contentType,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
  assert.equal(
    result.artifacts[0].base64Data,
    Buffer.from("pptx bytes from page context", "utf8").toString("base64")
  );
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script does not create visible Chrome downloads for interpreter resources after page fetch is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-regression-deck-download.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const listeners = new Map();

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.window = context;
  context.addEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  };
  context.removeEventListener = (type, handler) => {
    const handlers = listeners.get(type) || [];
    listeners.set(
      type,
      handlers.filter((candidate) => candidate !== handler)
    );
  };
  context.postMessage = (message) => {
    for (const handler of listeners.get("message") || []) {
      handler({ source: context.window, data: message });
    }
  };
  context.document.createElement = () => ({
    textContent: "",
    remove() {}
  });
  context.document.documentElement = {
    appendChild(script) {
      vm.runInContext(script.textContent, context);
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    assert.equal(String(url), interpreterUrl);
    return {
      ok: false,
      status: 401,
      headers: {
        get() {
          return null;
        }
      },
      arrayBuffer: async () => Buffer.from("")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type !== "bridge:downloadUrl") {
          throw new Error(`Unexpected message type ${payload.type}`);
        }
        assert.equal(payload.quietOnly, true);
        return { ok: false, error: "GPT direct download failed with status 401" };
      }
    }
  };
  const message = {
    textContent: `Created the file ${filename}`,
    querySelectorAll() {
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_chrome_download_fallback" });

  assert.deepEqual(
    messages.map((message) => ({ type: message.type, quietOnly: message.quietOnly })),
    [{ type: "bridge:downloadUrl", quietOnly: true }]
  );
  assert.deepEqual(fetchCalls, [interpreterUrl, interpreterUrl]);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, filename);
  assert.match(result.errors[0].error, /status 401/i);
});

test("content script ignores stale interpreter resources for preview-only presentation cards", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-preview-only-deck.pptx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=old&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  const messages = [];
  const fetchCalls = [];
  const previewButton = {
    className: "",
    disabled: false,
    textContent: "以全屏模式打开演示文稿",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "以全屏模式打开演示文稿" : null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 20, width: 220, height: 40 };
    },
    getClientRects() {
      return [{ width: 220, height: 40 }];
    },
    click() {
      throw new Error("preview button should not be clicked as a download");
    }
  };
  const message = {
    textContent: `已生成演示文稿：${filename}`,
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [previewButton];
      return [];
    }
  };
  previewButton.parentElement = message;
  previewButton.parentNode = message;

  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    fetchCalls.push(String(url));
    throw new Error("preview-only presentation cards should not fetch interpreter resources");
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_preview_pptx" });

  assert.deepEqual(messages, []);
  assert.deepEqual(fetchCalls, []);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script rebuilds xlsx artifact from embedded spreadsheet output when interpreter download is unauthorized", async () => {
  const context = await loadContentScriptContext();
  const filename = "bridge-preview-only-table.xlsx";
  const interpreterUrl =
    `https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2F${filename}`;
  context.performance = {
    getEntriesByType(type) {
      return type === "resource" ? [{ name: interpreterUrl }] : [];
    }
  };
  context.fetch = async (url) => {
    assert.equal(String(url), interpreterUrl);
    return {
      ok: false,
      status: 401,
      headers: {
        get() {
          return null;
        }
      },
      arrayBuffer: async () => Buffer.from("")
    };
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:downloadUrl") {
          return { ok: false, error: "ChatGPT direct download failed with status 401" };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const tableOutput = JSON.stringify({
    kind: "table",
    sheet: "Sheet1",
    address: "A1:B5",
    rows: 5,
    cols: 2,
    values: [
      ["id", "note"],
      [1, "Bridge trusted card row 1"],
      [2, "Bridge trusted card row 2"],
      [3, "Bridge trusted card row 3"],
      [4, "Bridge trusted card row 4"]
    ]
  });
  const message = {
    textContent: `Created the actual downloadable Excel file: ${filename}\n/mnt/data/${filename}\n${tableOutput}`,
    querySelectorAll(selector) {
      if (selector === "pre, code" || selector === "pre" || selector === "code") {
        return [{ textContent: tableOutput }];
      }
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_embedded_xlsx" });

  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, filename);
  assert.equal(
    result.artifacts[0].contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  assert.ok(Buffer.from(result.artifacts[0].base64Data, "base64").subarray(0, 2).equals(Buffer.from("PK")));
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script ignores stale interpreter download resources when the current reply has no filenames", async () => {
  const context = await loadContentScriptContext();
  context.performance = {
    getEntriesByType(type) {
      if (type !== "resource") return [];
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/test/interpreter/download?message_id=old&sandbox_path=%2Fmnt%2Fdata%2Fdirect-10-icons-v2-01.png"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`stale interpreter downloads should not be captured: ${payload.type}`);
      }
    }
  };
  const message = {
    textContent: "Thought for 44s 缂傚倸鍊搁崐褰掓偋閻愮儤锟?",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [];
      return [];
    }
  };

  const result = await context.collectDownloadArtifacts(message);

  assert.deepEqual(Array.from(result.artifacts), []);
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.deepEqual(Array.from(result.errors), []);
});

test("content script scrolls ChatGPT behavior download buttons into view before trusted click", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  let scrolled = false;
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "婵炴垶鎸搁鎴﹀箯??multi-image-live-v3-icons.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return scrolled ? { left: 120, top: 80, width: 260, height: 26 } : { left: 120, top: 5275, width: 260, height: 26 };
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    },
    scrollIntoView() {
      scrolled = true;
    },
    click() {
      throw new Error("ordinary click should not be used when trusted click succeeds");
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?10 ??PNG闂佹寧绋戦懟顖炴嚐閻旂厧绠ラ柟鎯у暱閻﹀爼鎮楅悷鐗堟拱闁搞劍宀搁弫宥咁潩椤愩倗锟??multi-image-live-v3-icons.zip",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  context.sleep = async () => {};
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "multi-image-live-v3-icons.zip");
          return { ok: true, watchId: "watch_scrolled_zip" };
        }
        if (payload.type === "bridge:trustedClick") {
          assert.equal(scrolled, true);
          assert.deepEqual({ x: payload.x, y: payload.y }, { x: 250, y: 93 });
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_scrolled_zip",
              filename: "multi-image-live-v3-icons.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_scrolled_zip" });

  assert.equal(scrolled, true);
  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_scrolled_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script prefers zip filenames for ChatGPT behavior zip buttons", async () => {
  const context = await loadContentScriptContext();
  const button = {
    className: "behavior-btn",
    disabled: false,
    textContent: "濠电偞鍨堕幐鎼侇敄閸儲锟?ZIP",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 80, height: 20 }];
    }
  };
  const message = {
    textContent:
      "闂備礁鎼崐绋棵洪敐鍛瀻闁靛繈鍊曠粈宀勬煕濞戝崬娅欓柟??multi-image-zip-auto-01.png闂備線娼уΛ鏂库柦閻掆暔ti-image-zip-auto-02.png闂備焦瀵х粙鎴炵附閺冨倻绠旈柛娑卞枟婵粓鏌﹀Ο渚锟??/mnt/data/multi-image-zip-auto-icons.zip",
    querySelectorAll() {
      return [];
    }
  };

  assert.equal(context.expectedFilenameForButton(button, message), "multi-image-zip-auto-icons.zip");
});

test("content script does not treat files inside a captured zip as separate missing artifacts", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-capture-test.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {
      throw new Error("trusted click should capture the zip");
    }
  };
  const innerFileButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "readme.txt",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 24 }];
    },
    click() {
      throw new Error("inner zip file should not be clicked as a separate artifact");
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?bridge-capture-test.zip闂備焦瀵х粙鎴︽儗閸岀偛闂柣鎴ｅГ椤ュ牓鏌曡箛鏇炐㈤柣锕€鐖奸弫?readme.txt ??result.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton, innerFileButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-capture-test.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_zip",
              filename: "bridge-capture-test.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_bundle" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script reports one zip download failure without retrying the same button", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-capture-test.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 220, height: 24 };
    },
    getClientRects() {
      return [{ width: 220, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const message = {
    textContent: "Generated bridge-capture-test.zip containing readme.txt and result.txt",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-capture-test.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: false,
            error: "Timed out waiting for Chrome download bridge-capture-test.zip"
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_bundle_timeout" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:startDownloadWatch", "bridge:trustedClick", "bridge:awaitDownloadWatch"]
  );
  assert.deepEqual(Array.from(result.artifactIds), []);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, "bridge-capture-test.zip");
});

test("content script imports interpreter zip URLs before clicking zip buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-mini.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const message = {
    textContent: "Generated bridge-mini.zip with ok.txt inside.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fbridge-mini.zip"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-mini.zip");
          return { ok: true, watchId: "watch_zip_bundle" };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: false,
            error: "Timed out waiting for Chrome download bridge-mini.zip"
          };
        }
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "bridge-mini.zip");
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_zip",
              filename: "bridge-mini.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_interpreter_fallback" });

  assert.deepEqual(
    messages.map((message) => message.type),
    ["bridge:downloadUrl"]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script ignores interpreter resources for files listed inside a captured zip", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-mini.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("download button should not be clicked when zip resource URL is already available");
    }
  };
  const message = {
    textContent: "Generated bridge-mini.zip containing ok.txt. Download bridge-mini.zip.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fok.txt"
        },
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fbridge-mini.zip"
        },
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fok.txt"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "bridge-mini.zip");
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_zip",
              filename: "bridge-mini.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_with_contents" });

  assert.deepEqual(messages.map((message) => message.filename), ["bridge-mini.zip"]);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script captures existing interpreter zip resource without clicking download buttons", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const zipButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download quiet-artifact.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("download button should not be clicked when resource URL is already available");
    }
  };
  const message = {
    textContent: "Generated quiet-artifact.zip for download.",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [zipButton];
      return [];
    }
  };
  context.performance = {
    getEntriesByType(type) {
      assert.equal(type, "resource");
      return [
        {
          name: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=abc&sandbox_path=%2Fmnt%2Fdata%2Fquiet-artifact.zip"
        }
      ];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:downloadUrl") {
          assert.equal(payload.filename, "quiet-artifact.zip");
          assert.equal(payload.quietOnly, true);
          assert.match(payload.url, /\/interpreter\/download/);
          return {
            ok: true,
            artifact: {
              id: "artifact_quiet_zip",
              filename: "quiet-artifact.zip"
            }
          };
        }
        return {
          ok: false,
          error: `${payload.type} should not be used for existing interpreter resources`
        };
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_quiet_zip" });

  assert.deepEqual(messages.map((message) => message.type), ["bridge:downloadUrl"]);
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_quiet_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script tries another same-file card button when the first zip button times out", async () => {
  const context = await loadContentScriptContext();
  const messages = [];
  const card = {
    textContent: "bridge-mini-v6.zip",
    querySelectorAll(selector) {
      return selector === "button" ? [previewButton, downloadButton] : [];
    }
  };
  const previewButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "bridge-mini-v6.zip",
    title: "",
    parentElement: card,
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { left: 10, top: 10, width: 180, height: 24 };
    },
    getClientRects() {
      return [{ width: 180, height: 24 }];
    },
    click() {
      throw new Error("trusted click should be used for zip buttons");
    }
  };
  const downloadButton = {
    className: "",
    disabled: false,
    textContent: "",
    title: "",
    parentElement: card,
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-mini-v6.zip";
      return null;
    },
    getBoundingClientRect() {
      return { left: 210, top: 10, width: 24, height: 24 };
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      messages.push({ type: "ordinary-click-download" });
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣秗idge-mini-v6.zip",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [previewButton, downloadButton];
      return [];
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        messages.push(payload);
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "bridge-mini-v6.zip");
          return { ok: true, watchId: `watch_${messages.filter((message) => message.type === "bridge:startDownloadWatch").length}` };
        }
        if (payload.type === "bridge:trustedClick") {
          return { ok: true };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          const watchIndex = Number(String(payload.watchId).replace("watch_", ""));
          if (watchIndex === 1) {
            return {
              ok: false,
              error: "Timed out waiting for Chrome download bridge-mini-v6.zip"
            };
          }
          return {
            ok: true,
            artifact: {
              id: "artifact_bridge_mini_v6_zip",
              filename: "bridge-mini-v6.zip"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { syncJobId: "sync_zip_second_button" });

  assert.deepEqual(
    messages.map((message) => message.type),
    [
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch",
      "bridge:startDownloadWatch",
      "bridge:trustedClick",
      "bridge:awaitDownloadWatch"
    ]
  );
  assert.deepEqual(Array.from(result.artifactIds), ["artifact_bridge_mini_v6_zip"]);
  assert.equal(result.errors.length, 0);
});

test("content script scans the enclosing assistant turn for generated file cards", async () => {
  const context = await loadContentScriptContext();
  const section = {
    textContent: "閻庤鐡曠亸娆撳极閹捐绠ｉ柟鏉垮缁愭avorite-foods.pptx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [button];
      return [];
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹捐绠ｉ柟鏉垮缁愭avorite-foods.pptx",
    querySelectorAll() {
      return [];
    },
    closest(selector) {
      return selector === 'section[data-testid^="conversation-turn-"]' ? section : null;
    }
  };
  let clicked = false;
  const button = {
    disabled: false,
    textContent: "",
    title: "",
    parentElement: section,
    parentNode: section,
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      clicked = true;
    }
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        if (payload.type === "bridge:startDownloadWatch") {
          assert.equal(payload.expectedFilename, "favorite-foods.pptx");
          return { ok: true, watchId: "watch_ppt" };
        }
        if (payload.type === "bridge:awaitDownloadWatch") {
          return {
            ok: true,
            artifact: {
              id: "artifact_ppt",
              filename: "favorite-foods.pptx"
            }
          };
        }
        throw new Error(`Unexpected message type ${payload.type}`);
      }
    }
  };

  const result = await context.collectDownloadArtifacts(context.assistantDownloadScope(message), {
    syncJobId: "sync_ppt"
  });

  assert.equal(clicked, true);
  assert.equal(result.artifactIds[0], "artifact_ppt");
});

test("content script falls back to capturing generated images from the assistant turn", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("fake png bytes", "utf8");
  const image = {
    currentSrc: "blob:https://chatgpt.com/generated-image",
    src: "blob:https://chatgpt.com/generated-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const message = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?codex-image-test.png",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [];
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });

  const result = await context.collectDownloadArtifacts(message);

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, "codex-image-test.png");
  assert.equal(result.artifacts[0].contentType, "image/png");
  assert.equal(result.artifacts[0].base64Data, imageBytes.toString("base64"));
});

test("content script prefers generated images over stale file cards for image jobs", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("fresh image bytes", "utf8");
  const image = {
    currentSrc: "blob:https://chatgpt.com/fresh-image",
    src: "blob:https://chatgpt.com/fresh-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const staleButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download food-mini-v6.pptx";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      throw new Error("stale file button should not be clicked for an image job");
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?blue-circle-test.png  food-mini-v6.pptx",
    querySelectorAll(selector) {
      if (selector === "a[href]") return [];
      if (selector === "button") return [staleButton];
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.chrome = {
    runtime: {
      async sendMessage() {
        throw new Error("download watch should not be used for a stale file button");
      }
    }
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].filename, "blue-circle-test.png");
  assert.equal(result.artifacts[0].contentType, "image/png");
  assert.equal(result.artifactIds.length, 0);
  assert.equal(result.errors.length, 0);
});

test("content script detects image artifact requests without matching normal slide files", async () => {
  const context = await loadContentScriptContext();

  assert.equal(context.expectsImageArtifact({ payloadText: "Generate a PNG image." }), true);
  assert.equal(context.expectsImageArtifact({ payloadText: "generate an image" }), true);
  assert.equal(
    context.expectsImageArtifact({
      kind: "image_request",
      payloadText: "Restyle this reference in watercolor."
    }),
    true
  );
  assert.equal(
    context.requestedImageCount({
      kind: "image_request",
      payloadText: "Restyle this reference in watercolor."
    }),
    1
  );
  assert.equal(context.expectsImageArtifact({ payloadText: "闁荤姴娲ˉ鎾诲极閹捐绠ｉ柟閭︿簽锟??food-mini.pptx" }), false);
  assert.equal(context.requestedImageFilename({ payloadText: "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱娲﹂弳?blue-circle-priority-v3.png" }), "blue-circle-priority-v3.png");
  assert.equal(context.requestedImageFilename({ payloadText: "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱娲﹂弳?food-mini.pptx" }), null);
});

test("content script splits multiple requested image filenames", async () => {
  const context = await loadContentScriptContext();
  const text =
    "鐠囬鏁撻幋?multi-image-test-01.png閵嗕沟ulti-image-test-02.png閵嗕沟ulti-image-test-03.png閵嗕沟ulti-image-test-04.png";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
  assert.deepEqual(Array.from(context.requestedImageFilenames({ payloadText: text })), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
});

test("content script splits quoted multiple requested image filenames", async () => {
  const context = await loadContentScriptContext();
  const text =
    "鐠囬鏁撻幋?\"multi-image-test-01.png閵嗕沟ulti-image-test-02.png閵嗕沟ulti-image-test-03.png閵嗕沟ulti-image-test-04.png\"";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "multi-image-test-01.png",
    "multi-image-test-02.png",
    "multi-image-test-03.png",
    "multi-image-test-04.png"
  ]);
});

test("content script does not attach ChatGPT thinking seconds to filenames", async () => {
  const context = await loadContentScriptContext();
  const text = "Thought for 25sbridge-live-sheet-20260708035451.xlsx";

  assert.deepEqual(Array.from(context.filenamesFromText(text)), [
    "bridge-live-sheet-20260708035451.xlsx"
  ]);
});

test("content script assigns requested filenames to multiple generated images by index", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const images = [0, 1, 2].map((index) => ({
    currentSrc: `data:image/png;base64,image-${index}`,
    src: `data:image/png;base64,image-${index}`,
    naturalWidth: 512,
    naturalHeight: 512,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 256, height: 256 }];
    }
  }));
  const message = {
    textContent: "Generated images",
    querySelectorAll(selector) {
      if (selector === "img") return images;
      return [];
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });

  const result = await context.collectDownloadArtifacts(message, {
    preferImages: true,
    requestedFilenames: ["multi-image-test-01.png", "multi-image-test-02.png", "multi-image-test-03.png"]
  });

  assert.deepEqual(
    Array.from(result.artifacts, (artifact) => artifact.filename),
    ["multi-image-test-01.png", "multi-image-test-02.png", "multi-image-test-03.png"]
  );
});

test("content script reports generated image download failures without masking the original error", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=broken-image",
    src: "https://chatgpt.com/backend-api/estuary/content?id=broken-image",
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const message = {
    textContent: "生成图片 fail-image-01.png",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    }
  };
  context.fetch = async () => ({
    ok: false,
    status: 403,
    headers: {
      get() {
        return null;
      }
    },
    arrayBuffer: async () => Buffer.from("")
  });

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].filename, "fail-image-01.png");
  assert.match(result.errors[0].error, /Image download failed with status 403/);
});

test("content script captures generated image galleries with rail thumbnails", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, width = 1024, height = 768) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: width,
    naturalHeight: height,
    width: 72,
    height: 72,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const mainImage = makeImage("main", 1024, 1024);
  const thumbnails = Array.from({ length: 4 }, (_, index) => makeImage(`thumb-${index + 1}`, 1024, 1024));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage, ...thumbnails];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 5);
  assert.equal(new Set(fetched).size, 5);
});

test("content script captures generated image galleries when rail thumbnails are small", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, naturalSize, displaySize) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: naturalSize,
    naturalHeight: naturalSize,
    width: displaySize,
    height: displaySize,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const mainImage = makeImage("main", 1024, 520);
  const thumbnails = Array.from({ length: 9 }, (_, index) => makeImage(`thumb-${index + 1}`, 96, 72));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage, ...thumbnails];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
});

test("content script captures generated image rail outside the assistant message", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (id, top = 120, left = 120, size = 72) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: size,
    height: size,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getBoundingClientRect() {
      return { top, bottom: top + size, left, right: left + size, width: size, height: size };
    },
    getClientRects() {
      return [this.getBoundingClientRect()];
    }
  });
  const mainImage = makeImage("main", 140, 120, 520);
  const railImages = Array.from({ length: 9 }, (_, index) =>
    makeImage(`rail-${index + 1}`, 150 + index * 44, 690, 40)
  );
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      return [];
    },
    getBoundingClientRect() {
      return { top: 100, bottom: 720, left: 80, right: 760, width: 680, height: 620 };
    },
    contains(node) {
      return node === mainImage;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "img") return [mainImage, ...railImages];
    return [];
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true, expectedImageCount: 10 });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
  assert.ok(fetched.some((url) => url.includes("rail-9")));
});

test("content script captures generated image galleries when rail thumbnails use background images", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const mainImage = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=main",
    src: "https://chatgpt.com/backend-api/estuary/content?id=main",
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const thumbnails = Array.from({ length: 9 }, (_, index) => ({
    tagName: "BUTTON",
    currentSrc: "",
    src: "",
    naturalWidth: 96,
    naturalHeight: 96,
    width: 52,
    height: 52,
    style: {
      backgroundImage: `url("https://chatgpt.com/backend-api/estuary/content?id=thumb-bg-${index + 1}")`
    },
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return `image ${index + 1}`;
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  }));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      if (selector.includes("background-image")) return thumbnails;
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 10);
  assert.equal(new Set(fetched).size, 10);
  assert.ok(fetched.some((url) => url.includes("thumb-bg-9")));
});

test("content script keeps generated image URLs with the same content id but different image index", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const makeImage = (index) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=batch-1&image=${index}`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=batch-1&image=${index}`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 72,
    height: 72,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [makeImage(1), makeImage(2), makeImage(3)];
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 3);
  assert.equal(new Set(fetched).size, 3);
});

test("content script captures image galleries that require clicking thumbnail controls", async () => {
  const context = await loadContentScriptContext();
  const imageBytes = Buffer.from("png", "utf8");
  const urls = Array.from(
    { length: 4 },
    (_, index) => `https://chatgpt.com/backend-api/estuary/content?id=click-gallery-${index + 1}`
  );
  const mainImage = {
    currentSrc: urls[0],
    src: urls[0],
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 520,
    height: 520,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.currentSrc;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const thumbs = urls.map((url, index) => ({
    tagName: "BUTTON",
    textContent: "",
    title: `Image ${index + 1}`,
    getAttribute(name) {
      if (name === "aria-label") return `Image ${index + 1}`;
      return null;
    },
    getClientRects() {
      return [{ width: 52, height: 52 }];
    },
    click() {
      mainImage.currentSrc = url;
      mainImage.src = url;
    }
  }));
  const message = {
    textContent: "Thought for 1m 14s",
    querySelectorAll(selector) {
      if (selector === "img") return [mainImage];
      if (selector === "button" || selector === "button,[role='button']") return thumbs;
      return [];
    }
  };
  const fetched = [];
  context.fetch = async (url) => {
    fetched.push(String(url));
    return {
      ok: true,
      url,
      headers: {
        get(name) {
          if (name.toLowerCase() === "content-type") return "image/png";
          return null;
        }
      },
      arrayBuffer: async () => imageBytes
    };
  };
  context.sleep = async () => {};

  const result = await context.collectDownloadArtifacts(message, { preferImages: true });

  assert.equal(result.artifacts.length, 4);
  assert.deepEqual(fetched, urls);
});

test("content script waits for a single requested image before completing", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const imageBytes = Buffer.from("png", "utf8");
  let now = 0;
  let sent = false;
  let sleepCalls = 0;
  let imageVisible = false;
  class FakeDate extends Date {
    static now() {
      now += 100;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    src: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    naturalWidth: 1024,
    naturalHeight: 1536,
    width: 480,
    height: 720,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "Generated novel poster";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const userMessage = {
    textContent: "Generate a novel poster image.",
    innerText: "Generate a novel poster image.",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: userMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Crafted a novel poster.",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return imageVisible ? [image] : [];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.Date = FakeDate;
  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {
    if (sent) {
      sleepCalls += 1;
      if (sleepCalls >= 5) imageVisible = true;
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        return name.toLowerCase() === "content-type" ? "image/png" : null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_single_image",
    kind: "image_request",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Generate a novel poster image."
  });

  const completeCall = bridgeCalls.find((call) => call.path.endsWith("/complete"));
  const completeBody = JSON.parse(completeCall.options.body);
  assert.equal(completeBody.artifacts.length, 1);
  assert.ok(sleepCalls >= 5);
});

test("content script requires image content for a stable single-image reply", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Generate a novel poster image.";
  let sleepCalls = 0;
  let imageVisible = false;
  const image = {
    currentSrc: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    src: "https://chatgpt.com/backend-api/estuary/content?id=poster&sig=demo",
    naturalWidth: 1024,
    naturalHeight: 1536,
    width: 480,
    height: 720,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "Generated novel poster";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Crafted a novel poster.",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return imageVisible ? [image] : [];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls >= 5) imageVisible = true;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantTurn];
    if (selector === "button" || selector === '[role="button"]' || selector === '[data-testid*="stop"]') return [];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    expectedImageCount: 1
  });

  assert.equal(reply, "Crafted a novel poster.");
  assert.equal(imageVisible, true);
  assert.ok(sleepCalls >= 5);
});

test("content script waits for the requested multi-image count before completing", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const imageBytes = Buffer.from("png", "utf8");
  let now = 0;
  let sent = false;
  let sleepCalls = 0;
  let visibleImageCount = 1;
  class FakeDate extends Date {
    static now() {
      now += 100;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "data-testid") return "composer-submit-button";
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const makeImage = (id) => ({
    currentSrc: `https://chatgpt.com/backend-api/estuary/content?id=${id}&sig=demo`,
    src: `https://chatgpt.com/backend-api/estuary/content?id=${id}&sig=demo`,
    naturalWidth: 1024,
    naturalHeight: 1024,
    width: 480,
    height: 480,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: this.width, height: this.height }];
    }
  });
  const images = [makeImage("img-1"), makeImage("img-2"), makeImage("img-3")];
  const userMessage = {
    textContent: "Generate 3 images, theme: AI workspace.",
    innerText: "Generate 3 images, theme: AI workspace.",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };
  const userTurn = {
    textContent: userMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? userMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "Thought for 10s",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? this : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return images.slice(0, visibleImageCount);
      return [];
    },
    closest() {
      return null;
    }
  };

  context.Date = FakeDate;
  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {
    sleepCalls += 1;
    if (sleepCalls >= 5) {
      visibleImageCount = 3;
    }
  };
  context.fetch = async (url) => ({
    ok: true,
    url,
    headers: {
      get(name) {
        if (name.toLowerCase() === "content-type") return "image/png";
        return null;
      }
    },
    arrayBuffer: async () => imageBytes
  });
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="composer-submit-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantTurn] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_wait_multi_image_count",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "Generate 3 images, theme: AI workspace."
  });

  const completeCall = bridgeCalls.find((call) => call.path.endsWith("/complete"));
  const completeBody = JSON.parse(completeCall.options.body);
  assert.equal(completeBody.artifacts.length, 3);
  assert.ok(sleepCalls >= 5);
});

test("content script names data URL images from the requested image filename", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "data:image/png;base64,abcdef",
    src: "data:image/png;base64,abcdef",
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    }
  };
  const message = {
    textContent: "ChatGPT 闂佹眹鍨婚崰鎰板垂濮橆厾顩查柛鈩冩礈椤忚京鈧鍠氭慨鏉懨瑰鈧幃褔宕堕柨瀣伓?",
    querySelectorAll() {
      return [];
    }
  };

  assert.equal(
    context.filenameFromImage(image, message, 0, {
      requestedFilename: "blue-circle-priority-v3.png"
    }),
    "blue-circle-priority-v3.png"
  );
});

test("content script selects an image-only reply after the matching user prompt", async () => {
  const context = await loadContentScriptContext();
  const oldImage = {
    currentSrc: "data:image/png;base64,old-ppt-preview",
    src: "data:image/png;base64,old-ppt-preview",
    naturalWidth: 800,
    naturalHeight: 450,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 400, height: 225 }];
    }
  };
  const freshImage = {
    currentSrc: "data:image/png;base64,fresh-blue-circle",
    src: "data:image/png;base64,fresh-blue-circle",
    naturalWidth: 800,
    naturalHeight: 800,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 400, height: 400 }];
    }
  };
  const oldAssistantMessage = { textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣籵od-mini-v5.pptx" };
  const oldAssistantTurn = {
    textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙缁狅綁鏌熼弶鍨暢缂佹劖顣籵od-mini-v5.pptx",
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? oldAssistantMessage : null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [oldImage];
      return [];
    }
  };
  const userTurn = {
    textContent: "闂備浇宕垫慨鏉懨洪鈶哄骞樼拠鍙夌€梺鐟板綖缁鳖噣锟??blue-circle-filename-v4.png",
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const imageReplyTurn = {
    textContent: "",
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      if (selector === "img") return [freshImage];
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [oldAssistantMessage];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [oldAssistantTurn, userTurn, imageReplyTurn];
    return [];
  };

  assert.equal(context.lastAssistantMessage({ afterUserText: "blue-circle-filename-v4.png" }), imageReplyTurn);
});

test("content script anchors filename prompts to the user turn instead of the assistant reply", async () => {
  const context = await loadContentScriptContext();
  const prompt = "The filename imagegen.png is only an example; no file was generated.";
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: "The filename imagegen.png is only an example; no file was generated.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: assistantMessage.textContent,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };

  assert.equal(context.lastAssistantMessage({ afterUserText: prompt, requireAfterUserText: true }), assistantTurn);
});

test("content script does not fall back to stale assistant replies before the matching user prompt appears", async () => {
  const context = await loadContentScriptContext();
  const staleAssistantMessage = { textContent: "闁诲氦顫夐悺鏇犱焊濞嗘挸鏋侀柟鎹愵嚙锟?10 闁诲孩顔栭崰姘叏妞嬪簶鍋撳鐓庡伎锟??PNG闂備焦瀵х粙鎴︽嚐椤栨縿浜归柡灞诲劚缁€鍡涙煕閳╁喚娈旈柣鎺斿帶閳藉骞橀幇浣稿壍濠电偞娼欏ú顓㈠极瀹ュ拋娼伴柣搴㈠Оect-10-icons-v2-01.png" };
  const staleAssistantTurn = {
    textContent: staleAssistantMessage.textContent,
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? staleAssistantMessage : null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [staleAssistantMessage];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [staleAssistantTurn];
    return [];
  };

  assert.equal(
    context.lastAssistantMessage({
      afterUserText: "闁汇埄鍨奸崰妤呭垂濠婂牊鍋ㄩ柣鏃傤焾閻忓洤鈽夐幘顖氫壕閻庢鍠氭繛鈧柣婵愬枤閹峰綊濡搁埡浣诡仭闂佹悶鍎辨晶鑺ユ櫠閺嶎厽鏅慨姗嗗亞椤忓崬鈽夐幙鍐х凹婵犫偓椤撱垹绾ч柕澶涚畱锟?AI 閻庤鎮堕崕鎵礊閺冨牊锟?",
      requireAfterUserText: true
    }),
    null
  );
});

test("content script ignores ChatGPT bootstrap page text when no assistant message exists", async () => {
  const context = await loadContentScriptContext();
  const bootstrapNode = {
    textContent:
      "window.__oai_logHTML?window.__oai_logHTML():window.__oai_SSR_HTML=window.__oai_SSR_HTML||Date.now();requestAnimationFrame((function(){window.__oai_logTTI?window.__oai_logTTI():window.__oai_SSR_TTI=window.__oai_SSR_TTI||Date.now()}))",
    getAttribute() {
      return "";
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [];
    if (selector === "article, main [role='presentation'], main div") return [bootstrapNode];
    return [];
  };

  assert.equal(context.lastAssistantText(), "");
});

test("content script treats an image-only assistant turn as a usable reply", async () => {
  const context = await loadContentScriptContext();
  const image = {
    currentSrc: "blob:https://chatgpt.com/generated-image",
    src: "blob:https://chatgpt.com/generated-image",
    naturalWidth: 1024,
    naturalHeight: 768,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "src") return this.src;
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 512, height: 384 }];
    }
  };
  const message = {
    textContent: "old answer",
    querySelectorAll(selector) {
      if (selector === "img") return [image];
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), true);
  assert.equal(context.visibleReplyTextFromAssistant(message, "old answer"), message.textContent);
});

test("content script ignores interim image generation waiting text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Generating a more detailed image, please wait.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores Chinese image creation placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Generating image, please wait.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores final image tuning placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "\u6700\u540e\u5fae\u8c03\u4e00\u4e0b..",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores document reading placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "#### ChatGPT said:\n\nReading document",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores document skill lookup placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "#### ChatGPT said:\n\nLooking up document related skill instructions",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores generic file skill lookup placeholder text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const placeholders = [
    "#### ChatGPT says:\n\nLooking up PPT related skill instructions",
    "#### ChatGPT says:\n\nLooking up PDF related skill instructions",
    "#### ChatGPT says:\n\nLooking up Excel related skill instructions",
    "#### ChatGPT says:\n\nChecking file related skill instructions",
    "#### ChatGPT says:\n\nChecking ZIP file content",
    "#### ChatGPT says:\n\nLooking up document related skill instructions",
    "#### ChatGPT said:\n\nChecking file skills",
    "Pro thinking",
    "Connection interrupted. Waiting for the complete reply"
  ];

  for (const textContent of placeholders) {
    const message = {
      textContent,
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      }
    };

    assert.equal(context.hasUsableAssistantContent(message, "old answer"), false, textContent);
  }
});

test("content script ignores downloadable file generation promise text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const placeholders = [
    "\u6211\u6765\u751f\u6210\u8fd9\u4e2a DOCX \u6587\u4ef6\uff0c\u5e76\u76f4\u63a5\u7ed9\u4f60\u4e0b\u8f7d\u94fe\u63a5\u3002",
    "\u6211\u4f1a\u521b\u5efa\u4e00\u4e2a Excel \u6587\u4ef6\uff0c\u7a0d\u540e\u63d0\u4f9b\u4e0b\u8f7d\u3002",
    "I'll generate this PPTX file and provide a download link shortly."
  ];

  for (const textContent of placeholders) {
    const message = {
      textContent,
      querySelectorAll() {
        return [];
      },
      closest() {
        return null;
      }
    };

    assert.equal(context.hasUsableAssistantContent(message, "old answer"), false, textContent);
  }
});

test("content script waits past document reading placeholder before returning final analysis", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What is this document?";
  let sleepCount = 0;
  let assistantText = "#### ChatGPT said:\n\nReading document";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      assistantText = "This is a compensation and performance review policy document.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /compensation and performance review policy document/);
  assert.doesNotMatch(reply, /reading the document/i);
});

test("content script waits past file generation promise until a downloadable card appears", async () => {
  const context = await loadContentScriptContext();
  const prompt = "Generate a downloadable DOCX file.";
  let sleepCount = 0;
  let hasButton = false;
  let assistantText = "\u6211\u6765\u751f\u6210\u8fd9\u4e2a DOCX \u6587\u4ef6\uff0c\u5e76\u76f4\u63a5\u7ed9\u4f60\u4e0b\u8f7d\u94fe\u63a5\u3002";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      hasButton = true;
      assistantText = "\u5df2\u751f\u6210\uff1a\u4e0b\u8f7d bridge-file.docx";
    }
  };

  const downloadButton = {
    tagName: "BUTTON",
    textContent: "\u4e0b\u8f7d bridge-file.docx",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 160, height: 32 }];
    }
  };
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll(selector) {
      return hasButton && selector === "a,button,[role='button']" ? [downloadButton] : [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
      return hasButton && selector === "a,button,[role='button']" ? [downloadButton] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /bridge-file\.docx/);
  assert.ok(sleepCount >= 2);
});

test("content script waits past document skill lookup placeholder before returning final analysis", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What kind of document is this?";
  let sleepCount = 0;
  let assistantText = "#### ChatGPT says:\n\nLooking up document-related skill instructions";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 2) {
      assistantText = "This is a Word document for a Double Eleven enrollment and renewal promotion plan.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", { afterUserText: prompt });

  assert.match(reply, /promotion plan/);
  assert.doesNotMatch(reply, /Looking up document-related skill instructions/);
});

test("content script waits longer for file analysis text that pauses mid sentence", async () => {
  const context = await loadContentScriptContext();
  const prompt = "What is this?";
  let sleepCount = 0;
  let assistantText =
    "This is a Word document for a Double Eleven promotion plan. Overall, it is an internal campus enrollment and renewal plan that includes course package design, discount policies, and discussion";

  context.sleep = async () => {
    sleepCount += 1;
    if (sleepCount >= 5) {
      assistantText =
        "This is a Word document for a Double Eleven promotion plan. Overall, it is an internal campus enrollment and renewal plan that includes course package design, discount policies, sales scripts, and on-site activity incentives.";
    }
  };

  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      return selector === '[data-message-author-role="user"]' ? {} : null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    get textContent() {
      return assistantText;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    get textContent() {
      return assistantText;
    },
    querySelector(selector) {
      return selector === '[data-message-author-role="assistant"]' ? assistantMessage : null;
    },
    querySelectorAll(selector) {
      return selector === '[data-message-author-role="assistant"]' ? [assistantMessage] : [];
    }
  };

  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    return [];
  };

  const reply = await context.waitForAssistantReply("old answer", {
    afterUserText: prompt,
    inputArtifactCount: 1
  });

  assert.match(reply, /promotion plan|activity/i);
  assert.doesNotMatch(reply, /old answer/i);
});

test("content script ignores ChatGPT image planning text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent: "Planning for image generation\n\nI'll go for a 1:1 aspect ratio unless specified otherwise.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script ignores sequential image planning text without artifacts", async () => {
  const context = await loadContentScriptContext();
  const message = {
    textContent:
      "Planning sequential image generation in batches\n\nThe user asked for 10 images in 5 batches, with 2 images per batch.",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, "old answer"), false);
});

test("content script treats a matching download button as usable even when reply text repeats", async () => {
  const context = await loadContentScriptContext();
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "婵炴垶鎸搁鎴﹀箯??multi-image-live-v3-icons.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "";
      return null;
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    }
  };
  const message = {
    textContent: "閻庤鐡曠亸娆撳极閹剧粯锟?10 ??PNG闂佹寧绋戦懟顖炴嚐閻旂厧绠ラ柟鎯у暱閻﹀爼鎮楅悷鐗堟拱闁搞劍宀搁弫宥咁潩椤愩倗锟??multi-image-live-v3-icons.zip",
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  assert.equal(context.hasUsableAssistantContent(message, message.textContent), true);
});

test("content script rejects stale unscoped artifact replies after composer-cleared send confirmation", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 10_000;
      return now;
    }
  };
  context.sleep = async () => {};
  const staleDownloadButton = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "Download bridge-regression-small.zip",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Download bridge-regression-small.zip";
      return null;
    },
    getClientRects() {
      return [{ width: 260, height: 26 }];
    }
  };
  const staleAssistantMessage = {
    textContent: "Generated:",
    innerText: "Generated:",
    querySelectorAll(selector) {
      if (selector === "button") return [staleDownloadButton];
      return [];
    },
    closest() {
      return null;
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [staleAssistantMessage];
    if (selector === "button") return [];
    return [];
  };

  await assert.rejects(
    () =>
      context.waitForAssistantReply("Generated:", {
        requireFreshUnscopedReply: true
      }),
    /Timed out waiting for (?:ChatGPT|GPT) reply|\u7b49\u5f85 GPT \u56de\u590d\u8d85\u65f6/
  );
});

test("content script accepts repeated text when it belongs to the matching new assistant turn", async () => {
  const context = await loadContentScriptContext();
  const prompt = "repeat the same answer";
  let now = 0;
  context.Date = class extends Date {
    static now() {
      now += 50_000;
      return now;
    }
  };
  context.sleep = async () => {};
  const userTurn = {
    textContent: prompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: "same answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: assistantMessage.textContent,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };

  const reply = await context.waitForAssistantReply("same answer", { afterUserText: prompt });

  assert.equal(reply, "same answer");
});

test("content script matches Markdown list prompts after ChatGPT removes list markers", async () => {
  const context = await loadContentScriptContext();
  const payload = [
    "请只完成第 1 步：为玄幻穿越小说设计前十集的大纲。",
    "",
    "要求：",
    "- 只输出大纲、核心设定、主线、主要人物和每集概要。",
    "- 不要写第一章。",
    "- 不要生成海报。"
  ].join("\n");
  const renderedPrompt = payload.replace(/(^|\n)-\s+/g, "$1");
  const previousReply = "旧版大纲回复。";
  const latestReply = "新版完整大纲回复。";

  const userTurn = () => ({
    textContent: renderedPrompt,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  });
  const assistantTurn = (text) => {
    let turn = null;
    const message = {
      textContent: text,
      matches(selector) {
        return selector === '[data-message-author-role="assistant"]';
      },
      querySelectorAll() {
        return [];
      },
      closest() {
        return turn;
      }
    };
    turn = {
      textContent: text,
      querySelector(selector) {
        if (selector === '[data-message-author-role="assistant"]') return message;
        return null;
      },
      querySelectorAll() {
        return [];
      }
    };
    return { turn, message };
  };
  const oldAssistant = assistantTurn(previousReply);
  const newAssistant = assistantTurn(latestReply);
  const turns = [userTurn(), oldAssistant.turn, userTurn(), newAssistant.turn];

  context.sleep = async () => {};
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return turns;
    if (selector === '[data-message-author-role="assistant"]') {
      return [oldAssistant.message, newAssistant.message];
    }
    if (selector === "button" || selector === '[role="button"]' || selector === '[data-testid*="stop"]') {
      return [];
    }
    return [];
  };

  assert.equal(context.userPromptTurnExistsAny([payload]), true);
  assert.equal(context.latestUserPromptTurnInfo([payload]).index, 2);
  assert.equal(await context.waitForAssistantReply(previousReply, { afterUserText: payload }), latestReply);
});

test("content script completes repeated file analysis replies by matching attachment prompt candidates", async () => {
  const context = await loadContentScriptContext();
  const repeatedReply = "The ZIP contains one file: `Codex-Setup-Tool.cmd`.";
  const hiddenPayload = "Internal Bridge attachment instruction that is not visible in the ChatGPT turn.";
  const visibleUserText = "Please inspect the attachment. Attachment: 1. Codex-Setup-Tool.zip";
  const bridgeCalls = [];
  let now = 0;

  context.Date = class extends Date {
    static now() {
      now += 5_000;
      return now;
    }
  };
  context.sleep = async () => {};

  const userTurn = {
    textContent: visibleUserText,
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantMessage = {
    textContent: repeatedReply,
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  };
  const assistantTurn = {
    textContent: repeatedReply,
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantMessage;
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    if (selector === '[data-message-author-role="assistant"]') return [assistantMessage];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_repeated_zip",
      kind: "codex_file_analysis",
      payloadText: hiddenPayload,
      userText: "Ask GPT to analyze file: Codex-Setup-Tool.zip",
      previousAssistantText: repeatedReply,
      sentAt: "2026-07-02T20:10:03.000Z",
      inputArtifacts: [
        {
          filename: "Codex-Setup-Tool.zip",
          contentType: "application/zip",
          sizeBytes: 549
        }
      ]
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_repeated_zip/complete"]
  );
  assert.equal(JSON.parse(bridgeCalls[0].options.body).replyText, repeatedReply);
});

test("content script resumes a sent job without resending the prompt", async () => {
  const context = await loadContentScriptContext();
  const assistant = {
    textContent: "new answer after reload",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };
  const bridgeCalls = [];

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_resume",
      payloadText: "do not resend",
      previousAssistantText: "old answer",
      sentAt: "2026-06-24T17:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_resume/complete"]
  );
  assert.equal(JSON.parse(bridgeCalls[0].options.body).replyText, "new answer after reload");
});

test("content script does not complete a sent job after Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const assistant = {
    textContent: "answer that arrived after manual stop",
    innerText: "answer that arrived after manual stop",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming a cancelled job");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/sync/jobs/sync_cancelled_after_sent") {
      return {
        job: {
          id: "sync_cancelled_after_sent",
          status: "failed",
          errorCode: "manual_cancelled"
        }
      };
    }
    throw new Error(`cancelled sent job should not call ${path}`);
  };

  await context.processJob(
    {
      id: "sync_cancelled_after_sent",
      status: "running",
      payloadText: "do not complete after cancellation",
      previousAssistantText: "old answer",
      sentAt: "2026-07-07T00:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_cancelled_after_sent"]
  );
});

test("content script releases a sent job while waiting when Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let statusChecks = 0;
  let now = 0;
  let reloaded = false;

  context.Date = class extends Date {
    static now() {
      now += 100_000;
      return now;
    }
  };
  context.setTimeout = (callback) => {
    callback();
    return 0;
  };
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloaded = true;
    },
    replace(url) {
      throw new Error(`cancelled waiting job should not navigate to ${url}`);
    }
  };
  context.sleep = async () => {};
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/sync/jobs/sync_cancelled_while_waiting") {
      statusChecks += 1;
      return {
        job: {
          id: "sync_cancelled_while_waiting",
          status: statusChecks <= 2 ? "running" : "failed",
          errorCode: statusChecks <= 2 ? null : "manual_cancelled"
        }
      };
    }
    throw new Error(`cancelled waiting job should not call ${path}`);
  };

  await context.processJob(
    {
      id: "sync_cancelled_while_waiting",
      status: "running",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "wait until cancelled",
      previousAssistantText: "old answer",
      sentAt: "2026-07-07T00:00:00.000Z"
    },
    { resume: true }
  );

  assert.deepEqual(bridgeCalls, [
    "/api/sync/jobs/sync_cancelled_while_waiting",
    "/api/sync/jobs/sync_cancelled_while_waiting",
    "/api/sync/jobs/sync_cancelled_while_waiting"
  ]);
  assert.equal(reloaded, false);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script skips artifact capture when a filename is only an example", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const reply = "The filename imagegen.png is only an example; no file was generated.";
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "imagegen.png",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 24 }];
    },
    click() {
      throw new Error("example filename should not be clicked");
    }
  };
  const assistant = {
    textContent: reply,
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`example filename should not trigger Chrome downloads: ${payload.type}`);
      }
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_example_filename",
      payloadText: "Do not generate files. The filename imagegen.png is only an example.",
      previousAssistantText: "old answer",
      sentAt: "2026-06-25T14:00:00.000Z"
    },
    { resume: true }
  );

  const complete = JSON.parse(bridgeCalls[0].options.body);
  assert.equal(complete.replyText, reply);
  assert.deepEqual(complete.artifacts, []);
  assert.deepEqual(complete.artifactIds, []);
  assert.deepEqual(complete.artifactErrors, []);
});

test("content script skips artifact capture for local file analysis replies that mention filenames", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const reply = "闁哄鏅滈悷銉ф閸洖鐐婇柟顖嗗懏缍岀紓浣插亾闁惧繗顫夐悾??GitHub 婵炲濮甸幐鍝ヨ姳鏉堛劊浜滈柣銏犳啞濡椼劑鏌曢崱妤€鈧鈧潧鐬奸幉鐗堟媴缁嬭儻顔夐柣鐔哥懁閻掞箓寮搁崘鈺冾浄閻犱礁婀辩粣妗滸ENTS.md闂侀潧妫旈梼娣揂DME.md闂侀潧妫旈崹顣嘽kage.json??;"
  const button = {
    className: "behavior-btn entity-underline",
    disabled: false,
    textContent: "AGENTS.md",
    title: "",
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 120, height: 24 }];
    },
    click() {
      throw new Error("analysis-only filename should not be clicked");
    }
  };
  const assistant = {
    textContent: reply,
    querySelectorAll(selector) {
      if (selector === "button") return [button];
      return [];
    },
    closest() {
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.querySelector = () => {
    throw new Error("composer should not be used while resuming");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant];
    if (selector === "button") return [];
    return [];
  };
  context.chrome = {
    runtime: {
      async sendMessage(payload) {
        throw new Error(`analysis-only reply should not trigger Chrome downloads: ${payload.type}`);
      }
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_local_image_analysis",
      kind: "codex_file_analysis",
      payloadText: [
        "闁荤姴娲ら崲鏌ュ垂鎼淬劌鍑犻柟閭﹀幖閻忓鈽夐幘绛规缂佸崬鐖奸幆鍐礋椤掍胶鈧喖霉閻樹警鍟囬柟??",
        "闂佸搫鍊稿ú锝呪枎閵忋倕瑙︾€广儱绻掔粣姊榠thub-repo-screenshot.png",
        "闂佸搫鍊稿ú锝呪枎閵忋垻灏甸悹鍥皺閳ь剛鍏橀弫宥咁潰閿曞穬ge/png",
        "",
        "Please analyze the attached image."
      ].join("\n"),
      inputArtifacts: [
        {
          filename: "github-repo-screenshot.png",
          contentType: "image/png"
        }
      ],
      previousAssistantText: "old answer",
      sentAt: "2026-06-25T14:00:00.000Z"
    },
    { resume: true }
  );

  const complete = JSON.parse(bridgeCalls[0].options.body);
  assert.equal(complete.replyText, reply);
  assert.deepEqual(complete.artifacts, []);
  assert.deepEqual(complete.artifactIds, []);
  assert.deepEqual(complete.artifactErrors, []);
});

test("content script sends a fresh job directly when the project page is ready", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let reloaded = false;
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userNode = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelectorAll() {
      return [];
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after direct send" : "old answer",
    innerText: sent ? "answer after direct send" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userTurn = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userNode;
      return null;
    }
  };
  const assistantTurn = {
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    }
  };

  context.sleep = async () => {};
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userNode] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    if (selector === "button") return [sendButton];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_refresh_first",
          payloadText: "fresh prompt"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(reloaded, false);
  assert.equal(sent, true);
  assert.equal(composer.value, "fresh prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/claim",
      "/api/sync/jobs/sync_refresh_first/sent",
      "/api/sync/jobs/sync_refresh_first/complete"
    ]
  );
});

test("content script sends a claimed unsent job when pre-send refresh was already persisted", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let reloaded = false;
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after persisted refresh" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer after persisted refresh",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.sleep = async () => {};
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo",
    reload() {
      reloaded = true;
    }
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistant()] : [];
    if (selector === "button") return [sendButton];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo"
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_refresh_persisted",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "fresh prompt",
          _bridgePreSendRefresh: true,
          _bridgeRefreshAttempts: 1
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(reloaded, false);
  assert.equal(sent, true);
  assert.equal(composer.value, "fresh prompt");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/claim",
      "/api/sync/jobs/sync_refresh_persisted/sent",
      "/api/sync/jobs/sync_refresh_persisted/complete"
    ]
  );
});

test("content script discards a persisted pre-send job after Bridge marks it cancelled", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let sent = false;
  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_cancelled_before_reload",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "do not send",
        _bridgePreSendRefresh: true,
        _bridgeRefreshAttempts: 1
      }
    })
  );
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };

  context.sleep = async () => {};
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [sendButton] : []);
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo"
      };
    }
    if (path === "/api/sync/jobs/sync_cancelled_before_reload") {
      return {
        job: {
          id: "sync_cancelled_before_reload",
          status: "failed",
          errorCode: "manual_cancelled"
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return { job: null };
    }
    throw new Error(`cancelled persisted job should not be sent: ${path}`);
  };

  await context.poll();

  assert.equal(sent, false);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/sync_cancelled_before_reload",
      "/api/sync/jobs/claim"
    ]
  );
});

test("content script does not mark a job sent until ChatGPT shows the user prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {}
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await assert.rejects(
    () => context.processJob({
      id: "sync_unconfirmed_send",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "bridge-live-ok"
    }),
    /(?:ChatGPT did not show the submitted prompt|GPT \u70b9\u51fb\u53d1\u9001\u540e\u6ca1\u6709\u663e\u793a\u5df2\u63d0\u4ea4\u7684\u63d0\u793a)/
  );
  assert.deepEqual(bridgeCalls.map((call) => call.path), []);
});

test("content script does not mark a job sent when ChatGPT clears the composer without showing the user prompt", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
      composer.value = "";
    }
  };
  const assistantNode = {
    textContent: "fresh answer",
    innerText: "fresh answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantNode] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await assert.rejects(
    () =>
      context.processJob({
        id: "sync_prompt_bubble_delayed",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "bridge-live-ok"
      }),
    /(?:ChatGPT did not show the submitted prompt|GPT \u70b9\u51fb\u53d1\u9001\u540e\u6ca1\u6709\u663e\u793a\u5df2\u63d0\u4ea4\u7684\u63d0\u793a)/
  );

  assert.deepEqual(bridgeCalls.map((call) => call.path), []);
});

test("content script includes send confirmation diagnostics in failure payloads", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/c/demo";
  const composer = {
    tagName: "TEXTAREA",
    value: "bridge-live-ok"
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  const error = context.sendConfirmationError(
    {
      id: "sync_unconfirmed_send",
      payloadText: "bridge-live-ok"
    },
    {
      composer,
      sendButton,
      sendAttempt: {
        hadPoint: true,
        usedTrustedClick: true,
        trustedClickOk: true
      }
    }
  );
  const payload = context.bridgeFailurePayload(error);

  assert.equal(payload.errorCode, "send_not_confirmed");
  assert.equal(payload.recoveryAction, "manual_send_or_refresh");
  assert.equal(payload.failureDetails.reason, "send_not_confirmed");
  assert.equal(payload.failureDetails.composerStillContainsDraft, true);
  assert.equal(payload.failureDetails.sendButton.label, "Send message");
  assert.equal(payload.failureDetails.sendAttempt.trustedClickOk, true);
});

test("content script includes send button diagnostics when the submit control is not ready", async () => {
  const context = await loadContentScriptContext();
  context.location.href = "https://chatgpt.com/c/demo";
  const composer = {
    tagName: "TEXTAREA",
    value: "continue image generation"
  };
  const stopButton = {
    disabled: false,
    textContent: "Stop generating",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };

  const error = context.sendButtonNotReadyError(
    {
      id: "sync_send_not_ready",
      payloadText: "continue image generation"
    },
    { composer }
  );
  const payload = context.bridgeFailurePayload(error);

  assert.equal(payload.errorCode, "send_button_not_ready");
  assert.equal(payload.recoveryAction, "wait_or_refresh_bound_page");
  assert.equal(payload.failureDetails.reason, "send_button_not_ready");
  assert.equal(payload.failureDetails.composerContainsDraft, true);
  assert.equal(payload.failureDetails.visibleButtons[0].label, "Stop generating Stop generating");
});

test("content script wraps the Chinese send-button timeout with structured diagnostics", async () => {
  const context = await loadContentScriptContext();
  const prompt = "continue image generation";
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const stopButton = {
    disabled: false,
    textContent: "Stop generating",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {};
  context.syncJobStillActive = async () => true;
  context.ensureExpectedChatGptPage = () => true;
  context.stopStaleGenerationIfNeeded = async () => {};
  context.dismissArtifactPreviewIfNeeded = async () => {};
  context.waitForComposer = async () => composer;
  context.waitForReadySendButton = async () => {
    throw new Error("GPT \u53d1\u9001\u6309\u94ae\u8fd8\u6ca1\u6709\u51c6\u5907\u597d\u3002");
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [stopButton];
    return [];
  };

  await assert.rejects(
    () => context.processJob({
      id: "sync_chinese_send_not_ready",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: prompt
    }),
    (error) => {
      assert.equal(error.errorCode, "send_button_not_ready");
      assert.equal(error.recoveryAction, "wait_or_refresh_bound_page");
      assert.equal(error.details.reason, "send_button_not_ready");
      assert.equal(error.details.composerContainsDraft, true);
      return true;
    }
  );
});

test("content script skips per-message preference sync when heartbeat already applied it", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  let modelSyncCalls = 0;
  let modeSyncCalls = 0;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const userNode = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelectorAll() {
      return [];
    }
  };
  const assistantNode = {
    textContent: "fresh answer",
    innerText: "fresh answer",
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [assistantNode];
      return [];
    },
    closest() {
      return null;
    }
  };
  const userTurn = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return userNode;
      return null;
    }
  };
  const assistantTurn = {
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantNode;
      return null;
    }
  };

  context.location.href = "https://chatgpt.com/c/demo";
  context.sleep = async () => {};
  context.setPreferenceStatus(
    {
      modePreference: "advanced",
      modelPreference: "gpt-5.6-sol",
      updatedAt: "2026-06-30T13:47:33.475Z"
    },
    {
      state: "applied",
      modeSynced: true,
      modelSynced: true
    }
  );
  context.selectModelPreference = async () => {
    modelSyncCalls += 1;
    throw new Error("model sync should be skipped");
  };
  context.selectModePreference = async () => {
    modeSyncCalls += 1;
    throw new Error("mode sync should be skipped");
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button") return [sendButton];
    if (selector === '[data-message-author-role="user"]') return sent ? [userNode] : [];
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistantNode] : [];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_skip_redundant_preferences",
    projectUrl: "https://chatgpt.com/c/demo",
    payloadText: "fresh prompt",
    modePreference: "advanced",
    modelPreference: "gpt-5.6-sol"
  });

  assert.equal(modelSyncCalls, 0);
  assert.equal(modeSyncCalls, 0);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/sync/jobs/sync_skip_redundant_preferences/sent",
      "/api/sync/jobs/sync_skip_redundant_preferences/complete"
    ]
  );
});

test("content script sends an extension heartbeat before claiming work", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
  assert.equal(JSON.parse(bridgeCalls[0].options.body).href, "https://chatgpt.com/c/demo");
});

test("content script claims work when heartbeat confirms control without preferences", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo",
        preferences: null,
        recovery: null
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script does not claim work while ChatGPT is actively generating", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const stopButton = {
    disabled: false,
    getAttribute(name) {
      if (name === "aria-label") return "Stop generating";
      return null;
    },
    title: "",
    textContent: "",
    getClientRects() {
      return [{ width: 20, height: 20 }];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = (selector) => (selector === "button" ? [stopButton] : []);
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        controlsCurrentPage: true,
        projectUrl: "https://chatgpt.com/c/demo",
        preferences: null,
        recovery: null,
        heartbeat: {
          pageStatus: {
            state: "working",
            code: "active_generation"
          }
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat"]
  );
});

test("content script applies heartbeat preferences without claiming a chat job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let selectedModeJob = null;
  let selectedModelJob = null;

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {};
  context.selectModePreference = async (job) => {
    selectedModeJob = job;
    return true;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/project/demo",
          modePreference: "high",
          modelPreference: "gpt-5.6-sol",
          updatedAt: "2026-06-28T00:00:00.000Z"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/extension/heartbeat"]);
  assert.equal(selectedModeJob.modePreference, "high");
  assert.equal(selectedModelJob.modelPreference, "gpt-5.6-sol");
});

test("content script applies linked model preferences before mode preferences", async () => {
  const context = await loadContentScriptContext();
  const order = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModelPreference = async (job) => {
    order.push(`model:${job.modelPreference}`);
    return true;
  };
  context.selectModePreference = async (job) => {
    order.push(`mode:${job.modePreference}`);
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.deepEqual(order, ["model:gpt-5.6-sol", "mode:high"]);
});

test("content script coerces unsupported GPT-5.3 modes before syncing preferences", async () => {
  const context = await loadContentScriptContext();
  let selectedModeJob = null;
  let selectedModelJob = null;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "balanced",
    modelPreference: "gpt-5.3",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };
  context.selectModePreference = async (job) => {
    selectedModeJob = job;
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.equal(selectedModelJob.modelPreference, "gpt-5.3");
  assert.equal(selectedModelJob.modePreference, "fast");
  assert.equal(selectedModeJob.modePreference, "fast");
});

test("content script skips mode selection for model-only ChatGPT preferences", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let selectedModelJob = null;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "balanced",
    modelPreference: "o3",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async (job) => {
    selectedModelJob = job;
    return true;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  assert.equal(modeAttempts, 0);
  assert.equal(selectedModelJob.modelPreference, "o3");
  assert.equal(selectedModelJob.modePreference, null);
});

test("content script retries heartbeat preferences after the preference timestamp changes", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };
  const changedPreferences = {
    ...preferences,
    updatedAt: "2026-06-28T00:00:01.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return false;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(changedPreferences), false);
  assert.equal(modeAttempts, 2);
  assert.equal(modelAttempts, 2);
});

test("content script reports heartbeat preference selection failures", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => true;
  context.selectModelPreference = async () => false;
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  await context.sendHeartbeat();

  assert.deepEqual(bridgeCalls[0].body.preferenceStatus, {
    state: "failed",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z",
    modeSynced: true,
    modelSynced: false,
    error: "model preference was not applied"
  });
});

test("content script reports the controls seen during a failed mode selection", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const combinedButton = {
    tagName: "BUTTON",
    textContent: "5.5 Pro",
    innerText: "5.5 Pro",
    title: "",
    getAttribute(name) {
      if (name === "role") return "button";
      return null;
    },
    getClientRects() {
      return [{ width: 100, height: 32 }];
    },
    click() {}
  };
  const composerScope = {
    querySelectorAll(selector) {
      return selector === "button,[role='button']" ? [combinedButton] : [];
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {},
    closest(selector) {
      return selector === '[data-testid*="composer"]' ? composerScope : null;
    },
    parentElement: null
  };

  context.location = { hostname: "chatgpt.com", href: "https://chatgpt.com/project/demo/c/abc" };
  context.document.title = "Demo chat";
  context.document.body = { innerText: "", textContent: "" };
  context.document.querySelector = (selector) => selector === "#prompt-textarea" ? composer : null;
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [combinedButton];
    if (selector === "[role='menuitem'],[role='option'],button,div") return [combinedButton];
    return [];
  };
  context.sleep = async () => {};
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences({
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "advanced",
    modelPreference: "gpt-5.5",
    updatedAt: "2026-07-12T00:00:00.000Z"
  }), false);
  await context.sendHeartbeat();

  const diagnostic = bridgeCalls[0].body.preferenceStatus.diagnostics;
  assert.equal(diagnostic.kind, "mode");
  assert.deepEqual(diagnostic.labels, ["高", "高级"]);
  assert.equal(diagnostic.currentControl.text, "5.5 Pro");
  assert.deepEqual(diagnostic.visibleOptions.map((item) => item.text), ["5.5 Pro"]);
});

test("content script does not repeatedly retry the same failed heartbeat preferences", async () => {
  const context = await loadContentScriptContext();
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(modeAttempts, 1);
  assert.equal(modelAttempts, 1);
});

test("content script does not retry the same failed heartbeat preferences on a timer", async () => {
  const context = await loadContentScriptContext();
  let now = 0;
  class FakeDate extends Date {
    static now() {
      return now;
    }
  }
  context.Date = FakeDate;
  let modeAttempts = 0;
  let modelAttempts = 0;
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") {
      return {
        tagName: "TEXTAREA",
        value: "",
        focus() {},
        dispatchEvent() {}
      };
    }
    return null;
  };
  context.selectModePreference = async () => {
    modeAttempts += 1;
    return true;
  };
  context.selectModelPreference = async () => {
    modelAttempts += 1;
    return false;
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  now = 60001;
  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  assert.equal(modeAttempts, 1);
  assert.equal(modelAttempts, 1);
});

test("content script clears a failed heartbeat preference when the page already shows the target labels", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const preferences = {
    projectUrl: "https://chatgpt.com/project/demo",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z"
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {},
    closest() {
      return null;
    }
  };
  let modelButtonLabel = "Wrong model";
  const modeButton = {
    textContent: context.modeLabelForPreference("high"),
    innerText: context.modeLabelForPreference("high"),
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 88, height: 32 }];
    }
  };
  const modelButton = {
    get textContent() {
      return modelButtonLabel;
    },
    get innerText() {
      return modelButtonLabel;
    },
    getAttribute() {
      return null;
    },
    getClientRects() {
      return [{ width: 88, height: 32 }];
    }
  };

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === "button,[role='button']") return [modeButton, modelButton];
    return [];
  };
  context.selectModePreference = async () => false;
  context.selectModelPreference = async () => false;
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    return {};
  };

  assert.equal(await context.applyHeartbeatPreferences(preferences), false);
  modelButtonLabel = context.modelLabelForPreference("gpt-5.6-sol");
  assert.equal(await context.applyHeartbeatPreferences(preferences), true);
  await context.sendHeartbeat();

  assert.deepEqual(bridgeCalls.at(-1).body.preferenceStatus, {
    state: "applied",
    modePreference: "high",
    modelPreference: "gpt-5.6-sol",
    updatedAt: "2026-06-28T00:00:00.000Z",
    modeSynced: true,
    modelSynced: true
  });
});

test("content script requests extension reload before claiming work when heartbeat is stale", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const runtimeMessages = [];
  const sessionValues = new Map();

  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.sessionStorage = {
    getItem(key) {
      return sessionValues.get(key) || null;
    },
    setItem(key, value) {
      sessionValues.set(key, value);
    }
  };
  context.chrome = {
    runtime: {
      lastError: null,
      sendMessage(payload, callback) {
        runtimeMessages.push(payload);
        callback?.({ ok: true });
        return undefined;
      }
    }
  };
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/extension/heartbeat") {
      return {
        reloadExtension: true,
        expectedExtensionVersion: "v20260703-repeat-file-reply"
      };
    }
    throw new Error(`unexpected call ${path}`);
  };

  await context.poll();
  await context.poll();

  assert.deepEqual(bridgeCalls, ["/api/extension/heartbeat", "/api/extension/heartbeat"]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtimeMessages)), [
    {
      type: "bridge:reloadExtension",
      expectedVersion: "v20260703-repeat-file-reply"
    }
  ]);
});

test("content script continues to claim chat work when preference sync is blocked by ChatGPT state", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/project/demo/c/abc"
  };
  context.document.title = "Demo chat";
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/project/demo",
          modePreference: "advanced",
          modelPreference: "gpt-5.3",
          updatedAt: "2026-06-28T00:00:00.000Z"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script reports structured blocker failures to Bridge", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return {
        preferences: {
          projectUrl: "https://chatgpt.com/c/demo"
        },
        recovery: null
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_human_verification",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "Please analyze the file."
        }
      };
    }
    return {};
  };

  await context.poll();

  const failCall = bridgeCalls.find((call) => call.path === "/api/sync/jobs/sync_human_verification/fail");
  assert.ok(failCall);
  assert.equal(failCall.body.errorCode, "human_verification");
  assert.equal(failCall.body.recoveryAction, "manual_verification");
  assert.match(failCall.body.error, /human verification|\u771f\u4eba\u9a8c\u8bc1/i);
});

test("content script leaves an interim completion running for the next resume poll", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "",
    textContent: ""
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    if (path === "/api/extension/heartbeat") {
      return { controlsCurrentPage: true };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_interim_reply",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "Write a long outline"
        }
      };
    }
    return {};
  };
  context.processJob = async () => {
    const error = new Error("GPT reply is still streaming or interrupted");
    error.status = 409;
    error.errorCode = "interim_chatgpt_reply";
    throw error;
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim"]
  );
});

test("content script reports current ChatGPT page status in heartbeat", async () => {
  const context = await loadContentScriptContext();
  let heartbeatBody = null;
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.document.body = {
    innerText: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE",
    textContent: "闂佽崵濮村ú銊╁礂濮椻偓閹澘鈻庨幋鐐茬彴婵炶揪绲块幊鎾寸閸洘鐓涢柛鏇㈡涧閻忥絾绻濋埀顒勫焺閸愵亶锟?CLOUDFLARE"
  };
  context.document.documentElement = {
    innerText: "",
    textContent: ""
  };
  context.bridgeApi = async (path, options = {}) => {
    if (path === "/api/extension/heartbeat") {
      heartbeatBody = JSON.parse(options.body);
      return {};
    }
    return {};
  };

  await context.sendHeartbeat();

  assert.equal(heartbeatBody.pageStatus.state, "blocked");
  assert.equal(heartbeatBody.pageStatus.code, "human_verification");
  assert.equal(heartbeatBody.pageStatus.recoveryAction, "manual_verification");
  assert.match(heartbeatBody.pageStatus.message, /human verification|\u771f\u4eba\u9a8c\u8bc1/i);
});

test("content script does not claim work when heartbeat cannot confirm the bound page", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/demo"
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      throw new Error("bridge unavailable");
    }
    return {};
  };

  await context.poll();

  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat"]
  );
});

test("content script ignores heartbeat recovery on non-bound ChatGPT pages", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let replacedUrl = null;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/other-chat",
    replace(url) {
      replacedUrl = url;
    },
    reload() {
      throw new Error("wrong ChatGPT page should navigate instead of reload");
    }
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "navigate",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_recover_navigate",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "fresh prompt"
          }
        }
      };
    }
    throw new Error("recovery should happen before claim");
  };

  await context.poll();

  assert.equal(replacedUrl, null);
  assert.deepEqual(bridgeCalls.map((call) => call.path), ["/api/extension/heartbeat"]);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script ignores navigation-only heartbeat recovery on non-bound ChatGPT pages", async () => {
  const context = await loadContentScriptContext();
  const navigations = [];
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/other-chat",
    replace(url) {
      navigations.push(url);
      this.href = url;
    }
  };

  const recovered = await context.handleHeartbeatRecovery({
    action: "navigate",
    reason: "ChatGPT page is not on the bound conversation",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: null
  });

  assert.equal(recovered, false);
  assert.deepEqual(navigations, []);
});

test("content script does not recover a claimed job from a non-bound ChatGPT page", async () => {
  const context = await loadContentScriptContext();
  let replacedUrl = null;
  const storage = new Map();
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/",
    replace(url) {
      replacedUrl = url;
      this.href = url;
    }
  };
  const workerId = context.currentWorkerId();

  const recovered = await context.handleHeartbeatRecovery({
    action: "reload",
    reason: "Claimed job was never sent",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: {
      id: "sync_stale_unsent",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      workerId,
      payloadText: "continue image generation"
    }
  });

  assert.equal(recovered, false);
  assert.equal(replacedUrl, null);
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
});

test("content script sends a stored pre-refresh job before applying another heartbeat recovery", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let sent = false;
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after stored job" : "",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "pre refresh prompt",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer after stored job",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_stored_refresh",
        projectUrl: "https://chatgpt.com/c/bound-chat",
        payloadText: "pre refresh prompt"
      }
    })
  );
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    replace() {
      throw new Error("stored pre-refresh job should send instead of navigating again");
    },
    reload() {
      throw new Error("stored pre-refresh job should send instead of reloading again");
    }
  };
  context.sleep = async () => {};
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return sent ? [assistant()] : [];
    if (selector === "button") return [sendButton];
    if (selector === 'section[data-testid^="conversation-turn-"]') return sent ? [userTurn, assistantTurn] : [];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "reload",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_stale_again",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "stale prompt",
            sentAt: "2026-06-28T04:00:00.000Z"
          },
          resendIfPromptMissing: true
        }
      };
    }
    if (path === "/api/sync/jobs/sync_stored_refresh") {
      return {
        job: {
          id: "sync_stored_refresh",
          status: "running",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          payloadText: "pre refresh prompt"
        }
      };
    }
    return {};
  };

  await context.poll();

  assert.equal(sent, true);
  assert.equal(composer.value, "pre refresh prompt");
  assert.equal(storage.has("chatgpt-codex-bridge:pre-send-refresh-job"), false);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    [
      "/api/extension/heartbeat",
      "/api/sync/jobs/sync_stored_refresh",
      "/api/sync/jobs/sync_stored_refresh",
      "/api/sync/jobs/sync_stored_refresh/sent",
      "/api/sync/jobs/sync_stored_refresh",
      "/api/sync/jobs/sync_stored_refresh",
      "/api/sync/jobs/sync_stored_refresh",
      "/api/sync/jobs/sync_stored_refresh/complete"
    ]
  );
});

test("content script can interrupt a busy wait with heartbeat recovery", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let reloaded = false;
  let firstSleepStarted;
  const firstSleep = new Promise((resolve) => {
    firstSleepStarted = resolve;
  });
  let heartbeatCount = 0;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloaded = true;
    },
    replace(url) {
      throw new Error(`same-page recovery should reload instead of navigating to ${url}`);
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = () => [];
  context.sleep = async () => {
    firstSleepStarted();
    return new Promise(() => {});
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    if (path === "/api/extension/heartbeat") {
      heartbeatCount += 1;
      if (heartbeatCount === 1) {
        return {
          preferences: {
            projectUrl: "https://chatgpt.com/c/bound-chat"
          }
        };
      }
      return {
        recovery: {
          action: "reload",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_busy_recover",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "busy prompt",
            sentAt: "2026-06-28T04:00:00.000Z"
          },
          resendIfPromptMissing: true
        }
      };
    }
    if (path === "/api/sync/jobs/claim") {
      return {
        job: {
          id: "sync_busy_original",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          payloadText: "original prompt",
          _bridgeRefreshAttempts: 1
        },
        resume: false
      };
    }
    return {};
  };

  context.poll();
  await firstSleep;
  await context.poll();

  assert.equal(reloaded, true);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/extension/heartbeat", "/api/sync/jobs/claim", "/api/extension/heartbeat"]
  );
  const stored = JSON.parse(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
  assert.equal(stored.job.id, "sync_busy_recover");
  assert.equal(stored.job._bridgeResendIfPromptMissing, false);
});

test("content script stops active generation when Bridge cancels the running GPT job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  const storage = new Map();
  let stopped = false;
  const stopButton = {
    disabled: false,
    textContent: "鍋滄鐢熸垚",
    title: "",
    getAttribute(name) {
      return name === "aria-label" ? "鍋滄鐢熸垚" : null;
    },
    getClientRects() {
      return stopped ? [] : [{ width: 10, height: 10 }];
    },
    click() {
      stopped = true;
    }
  };

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      throw new Error("cancel recovery should stop generation instead of reloading");
    },
    replace(url) {
      throw new Error(`cancel recovery should not navigate to ${url}`);
    }
  };
  context.document.querySelector = () => null;
  context.document.querySelectorAll = (selector) => selector === "button" ? [stopButton] : [];
  context.sleep = async () => {};
  context.bridgeApi = async (path) => {
    bridgeCalls.push(path);
    if (path === "/api/extension/heartbeat") {
      return {
        recovery: {
          action: "stop_generation",
          projectUrl: "https://chatgpt.com/c/bound-chat",
          job: {
            id: "sync_cancel_stop_page",
            projectUrl: "https://chatgpt.com/c/bound-chat",
            payloadText: "cancel me"
          }
        }
      };
    }
    throw new Error(`cancel recovery should not call ${path}`);
  };

  await context.poll();

  assert.equal(stopped, true);
  assert.deepEqual(bridgeCalls, ["/api/extension/heartbeat"]);
});

test("content script throttles duplicate heartbeat recovery for the same job", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let reloads = 0;

  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/c/bound-chat",
    reload() {
      reloads += 1;
    }
  };

  const recovery = {
    action: "reload",
    projectUrl: "https://chatgpt.com/c/bound-chat",
    job: {
      id: "sync_recovery_once",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "retry once",
      sentAt: "2026-06-28T04:00:00.000Z"
    },
    resendIfPromptMissing: true
  };

  assert.equal(await context.handleHeartbeatRecovery(recovery), true);
  assert.equal(await context.handleHeartbeatRecovery(recovery), false);
  assert.equal(reloads, 1);
});

test("content script resumes a sent job without resending it even when a legacy recovery flag is present", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let sent = false;
  let now = 0;
  class FakeDate extends Date {
    static now() {
      now += 1000;
      return now;
    }
  }
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: "answer already generated",
    querySelectorAll() {
      return [];
    },
    closest() {
      return assistantTurn;
    }
  });
  const userTurn = {
    textContent: "prompt that is missing from the page",
    querySelector(selector) {
      if (selector === '[data-message-author-role="user"]') return {};
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };
  const assistantTurn = {
    textContent: "answer already generated",
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistant();
      return null;
    },
    querySelectorAll() {
      return [];
    }
  };

  context.Date = FakeDate;
  context.sleep = async () => {};
  context.location.href = "https://chatgpt.com/c/demo";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return composer;
    if (selector === 'button[data-testid="send-button"]') return sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === "button") return [sendButton];
    if (selector === 'section[data-testid^="conversation-turn-"]') return [userTurn, assistantTurn];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob(
    {
      id: "sync_resend_missing_prompt",
      projectUrl: "https://chatgpt.com/c/demo",
      payloadText: "prompt that is missing from the page",
      sentAt: "2026-06-28T04:00:00.000Z",
      previousAssistantText: "old answer",
      _bridgeResendIfPromptMissing: true
    },
    { resume: true }
  );

  assert.equal(sent, false);
  assert.equal(composer.value, "");
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_resend_missing_prompt/complete"]
  );
});

test("content script navigates back to the project chat before pre-send refresh from a preview URL", async () => {
  const context = await loadContentScriptContext();
  const storage = new Map();
  let replacedUrl = null;
  context.sessionStorage = {
    getItem(key) {
      return storage.get(key) || null;
    },
    setItem(key, value) {
      storage.set(key, value);
    },
    removeItem(key) {
      storage.delete(key);
    }
  };
  storage.set(
    "chatgpt-codex-bridge:pre-send-refresh-job",
    JSON.stringify({
      job: {
        id: "sync_preview_refresh",
        projectUrl: "https://chatgpt.com/c/demo",
        payloadText: "fresh prompt"
      },
      createdAt: "2026-06-28T00:00:00.000Z"
    })
  );
  context.location = {
    hostname: "chatgpt.com",
    href: "https://chatgpt.com/backend-api/estuary/content?id=file_preview",
    replace(url) {
      replacedUrl = url;
    },
    reload() {
      throw new Error("preview URLs should navigate back to the project URL instead of reloading");
    }
  };
  context.document.querySelectorAll = () => [];
  context.bridgeApi = async (path) => {
    if (path === "/api/sync/jobs/sync_preview_refresh") {
      return {
        job: {
          id: "sync_preview_refresh",
          status: "running",
          projectUrl: "https://chatgpt.com/c/demo",
          payloadText: "fresh prompt"
        }
      };
    }
    if (path !== "/api/extension/heartbeat") {
      throw new Error(`preview pre-send recovery should not claim new work: ${path}`);
    }
    return {};
  };

  await context.poll();

  assert.equal(replacedUrl, "https://chatgpt.com/c/demo");
  assert.ok(storage.get("chatgpt-codex-bridge:pre-send-refresh-job"));
});

test("content script closes a ChatGPT artifact preview before sending a job", async () => {
  const context = await loadContentScriptContext();
  const bridgeCalls = [];
  let previewOpen = true;
  let sent = false;
  const closeButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Close";
      return null;
    },
    getClientRects() {
      return previewOpen ? [{ width: 24, height: 24 }] : [];
    },
    click() {
      previewOpen = false;
    }
  };
  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent() {}
  };
  const sendButton = {
    disabled: false,
    textContent: "",
    title: "",
    getAttribute(name) {
      if (name === "aria-label") return "Send message";
      return null;
    },
    getClientRects() {
      return previewOpen ? [] : [{ width: 24, height: 24 }];
    },
    click() {
      sent = true;
    }
  };
  const assistant = () => ({
    textContent: sent ? "answer after preview closed" : "old answer",
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    }
  });
  const userMessage = {
    textContent: "fresh prompt",
    innerText: "fresh prompt",
    getAttribute(name) {
      if (name === "data-message-author-role") return "user";
      return null;
    }
  };

  context.sleep = async () => {};
  context.document.title = "direct-10-icons-v2-01.png";
  context.document.querySelector = (selector) => {
    if (selector === "#prompt-textarea") return previewOpen ? null : composer;
    if (selector === 'button[data-testid="send-button"]') return previewOpen ? null : sendButton;
    return null;
  };
  context.document.querySelectorAll = (selector) => {
    if (selector === '[data-message-author-role="assistant"]') return [assistant()];
    if (selector === '[data-message-author-role="user"]') return sent ? [userMessage] : [];
    if (selector === "button") return previewOpen ? [closeButton] : [sendButton];
    return [];
  };
  context.bridgeApi = async (path, options = {}) => {
    bridgeCalls.push({ path, options });
    return {};
  };

  await context.processJob({
    id: "sync_close_preview",
    payloadText: "fresh prompt"
  });

  assert.equal(previewOpen, false);
  assert.equal(composer.value, "fresh prompt");
  assert.equal(sent, true);
  assert.deepEqual(
    bridgeCalls.map((call) => call.path),
    ["/api/sync/jobs/sync_close_preview/sent", "/api/sync/jobs/sync_close_preview/complete"]
  );
});
