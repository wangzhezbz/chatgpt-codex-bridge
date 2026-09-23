import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { rawText: text };
  }
  return { body, status: response.status };
}

async function waitForHealth(baseUrl, child, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Semantic Router smoke service exited early with code ${child.exitCode}`);
    }
    try {
      const result = await requestJson(baseUrl, "/health");
      if (result.status === 200) {
        return result.body;
      }
    } catch {
      // The child can take a moment to bind its port.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Semantic Router smoke service did not become healthy");
}

async function routerRunCount(storeRoot) {
  try {
    return (await readdir(path.join(storeRoot, "router-runs"))).filter((name) =>
      name.endsWith(".json")
    ).length;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) {
    return;
  }
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode == null && child.signalCode == null) {
    const forceExited = once(child, "exit");
    child.kill("SIGKILL");
    await Promise.race([
      forceExited,
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ]);
  }
  if (child.exitCode == null && child.signalCode == null) {
    throw new Error("Semantic Router smoke service did not stop");
  }
}

async function main() {
  const storeRoot = await mkdtemp(path.join(os.tmpdir(), "bridge-semantic-smoke-"));
  const targetRepo = path.join(storeRoot, "project");
  await mkdir(targetRepo);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const threadId = "local-semantic-smoke-thread";
  const env = {
    ...process.env,
    BRIDGE_PORT: String(port),
    BRIDGE_DATA_DIR: storeRoot,
    BRIDGE_CURRENT_CODEX_THREAD_ID: threadId,
    BRIDGE_ROUTER_V2: "1",
    BRIDGE_GPT_TRANSPORT: "mock"
  };
  delete env.BRIDGE_SEMANTIC_ROUTER;

  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    const health = await waitForHealth(baseUrl, child);
    const bound = await requestJson(baseUrl, "/api/projects/current-session", {
      method: "POST",
      body: JSON.stringify({
        name: "Semantic smoke project",
        chatgptProjectUrl: "https://chatgpt.com/c/semantic-smoke",
        targetRepo
      })
    });
    assert(bound.status === 201, `Project binding failed with HTTP ${bound.status}`);
    const project = bound.body?.project;
    assert(project?.currentCodexThreadId === threadId, "Project did not bind to the smoke Codex thread");

    const delegated = await requestJson(baseUrl, "/api/delegate/current-request", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        conversationId: project.conversationId,
        text: "Analyze this code for concurrency bugs",
        waitForGpt: false,
        routingProposal: {
          version: "1",
          routeKind: "codex_only",
          confidence: 0.96,
          reason: "Requires local code inspection"
        }
      })
    });
    assert(delegated.status === 201, `Semantic delegation failed with HTTP ${delegated.status}`);
    assert(delegated.body?.action === "codex_only", "Model proposal did not override legacy keyword routing");
    assert(
      delegated.body?.route?.decisionSource === "semantic_proposal",
      "Semantic Router was not enabled by default"
    );
    assert(
      delegated.body?.routerRun?.codexThreadId === threadId,
      "Router Run did not preserve the current Codex thread scope"
    );

    const runCountBeforeCrossScope = await routerRunCount(storeRoot);
    const crossScope = await requestJson(baseUrl, "/api/delegate/current-request", {
      method: "POST",
      body: JSON.stringify({
        projectId: project.id,
        conversationId: "another-project-conversation",
        text: "Write a launch article",
        waitForGpt: false,
        routingProposal: {
          version: "1",
          routeKind: "gpt_only",
          confidence: 0.99
        }
      })
    });
    const runCountAfterCrossScope = await routerRunCount(storeRoot);
    assert(crossScope.status >= 400, "Cross-project semantic request was not rejected");
    assert(
      runCountAfterCrossScope === runCountBeforeCrossScope,
      "Cross-project semantic request created a Router Run"
    );

    await access(path.join(targetRepo, "AGENTS.md"));
    return {
      baseUrl,
      storeRoot,
      healthStatus: health?.status || null,
      projectId: project.id,
      conversationId: project.conversationId,
      codexThreadId: threadId,
      semanticEnvWasUnset: true,
      routeKind: delegated.body.route.kind,
      decisionSource: delegated.body.route.decisionSource,
      policyVersion: delegated.body.route.policyVersion,
      confidence: delegated.body.route.confidence,
      routerRunStatus: delegated.body.routerRun.status,
      crossScopeHttpStatus: crossScope.status,
      crossScopeError: crossScope.body?.error || crossScope.body?.message || crossScope.body,
      runCountBeforeCrossScope,
      runCountAfterCrossScope,
      serviceStdout: stdout.trim(),
      serviceStderr: stderr.trim()
    };
  } finally {
    await stopChild(child);
  }
}

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
}
