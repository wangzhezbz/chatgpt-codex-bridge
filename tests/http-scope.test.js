import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";

async function withServer(fn) {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-scope-"));
  const server = createHttpServer({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "legacy-process-thread",
    apiToken: "scope-test-api-token",
    scopeSigningKey: "scope-test-signing-key"
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function mintScope(baseUrl, input) {
  const response = await fetch(`${baseUrl}/api/scopes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
  assert.equal(response.status, 201);
  return response.json();
}

function scopeHeaders(scopeToken) {
  return {
    "Content-Type": "application/json",
    "X-Bridge-Scope": scopeToken
  };
}

test("one Bridge service resolves two signed page scopes to different Codex tasks", async () => {
  await withServer(async (baseUrl) => {
    const scopeA = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-a"
    });
    const scopeB = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-b"
    });

    assert.match(scopeA.pagePath, /^\?scope=/);
    assert.equal(typeof scopeA.pageUrl, "string");
    assert.match(scopeA.pageUrl, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\?scope=`));
    assert.notEqual(scopeA.scopeToken, scopeB.scopeToken);

    const configA = await fetch(`${baseUrl}/api/config`, {
      headers: scopeHeaders(scopeA.scopeToken)
    });
    const configB = await fetch(`${baseUrl}/api/config`, {
      headers: scopeHeaders(scopeB.scopeToken)
    });

    assert.equal(configA.status, 200);
    assert.equal(configB.status, 200);
    assert.equal((await configA.json()).currentCodexThreadId, "thread-a");
    assert.equal((await configB.json()).currentCodexThreadId, "thread-b");
  });
});

test("project lists remain isolated between simultaneous signed Codex task scopes", async () => {
  await withServer(async (baseUrl) => {
    const scopeA = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-a"
    });
    const scopeB = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-b"
    });

    const createA = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: scopeHeaders(scopeA.scopeToken),
      body: JSON.stringify({
        name: "Project A",
        chatgptProjectUrl: "https://chatgpt.com/c/project-a",
        targetRepo: "F:/projects/a"
      })
    });
    const createB = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: scopeHeaders(scopeB.scopeToken),
      body: JSON.stringify({
        name: "Project B",
        chatgptProjectUrl: "https://chatgpt.com/c/project-b",
        targetRepo: "F:/projects/b"
      })
    });
    assert.equal(createA.status, 201);
    assert.equal(createB.status, 201);

    const listA = await fetch(`${baseUrl}/api/projects`, {
      headers: scopeHeaders(scopeA.scopeToken)
    });
    const listB = await fetch(`${baseUrl}/api/projects`, {
      headers: scopeHeaders(scopeB.scopeToken)
    });
    const projectsA = await listA.json();
    const projectsB = await listB.json();

    assert.deepEqual(projectsA.projects.map((project) => project.name), ["Project A"]);
    assert.deepEqual(projectsB.projects.map((project) => project.name), ["Project B"]);
    assert.deepEqual(projectsA.otherProjects.map((project) => project.name), ["Project B"]);
    assert.deepEqual(projectsB.otherProjects.map((project) => project.name), ["Project A"]);
  });
});

test("invalid page scope tokens are rejected instead of falling back to the process thread", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`, {
      headers: scopeHeaders("invalid.scope.token")
    });

    assert.equal(response.status, 403);
    assert.match(await response.text(), /scope/i);
  });
});

test("a project-bound page scope cannot list or select another project from the same Codex task", async () => {
  await withServer(async (baseUrl) => {
    const threadScope = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-project-bound"
    });
    const createProject = async (name, suffix) => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: scopeHeaders(threadScope.scopeToken),
        body: JSON.stringify({
          name,
          chatgptProjectUrl: `https://chatgpt.com/c/${suffix}`,
          targetRepo: `F:/projects/${suffix}`
        })
      });
      assert.equal(response.status, 201);
      return (await response.json()).project;
    };
    const projectA = await createProject("Bound A", "bound-a");
    const projectB = await createProject("Bound B", "bound-b");
    const projectScope = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-project-bound",
      projectId: projectA.id,
      conversationId: projectA.conversationId
    });
    const projectScopeUrl = new URL(projectScope.pageUrl);
    assert.equal(projectScopeUrl.searchParams.get("project"), projectA.id);
    assert.equal(projectScopeUrl.searchParams.get("scope"), projectScope.scopeToken);

    const listedResponse = await fetch(`${baseUrl}/api/projects`, {
      headers: scopeHeaders(projectScope.scopeToken)
    });
    const listed = await listedResponse.json();
    assert.deepEqual(listed.projects.map((project) => project.id), [projectA.id]);
    assert.deepEqual(listed.otherProjects, []);

    const crossSelect = await fetch(`${baseUrl}/api/projects/${projectB.id}/select`, {
      method: "POST",
      headers: scopeHeaders(projectScope.scopeToken),
      body: "{}"
    });
    assert.equal(crossSelect.status, 409);
    assert.match(await crossSelect.text(), /scope mismatch/i);
  });
});

test("a project-bound page scope cannot read or complete another project's GPT sync job", async () => {
  await withServer(async (baseUrl) => {
    const threadScope = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-sync-isolation"
    });
    const createProject = async (name, suffix) => {
      const response = await fetch(`${baseUrl}/api/projects`, {
        method: "POST",
        headers: scopeHeaders(threadScope.scopeToken),
        body: JSON.stringify({
          name,
          chatgptProjectUrl: `https://chatgpt.com/c/${suffix}`,
          targetRepo: `F:/projects/${suffix}`
        })
      });
      assert.equal(response.status, 201);
      return (await response.json()).project;
    };
    const projectA = await createProject("Sync A", "sync-a");
    const projectB = await createProject("Sync B", "sync-b");
    const scopeA = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-sync-isolation",
      projectId: projectA.id,
      conversationId: projectA.conversationId
    });
    const scopeB = await mintScope(baseUrl, {
      currentCodexThreadId: "thread-sync-isolation",
      projectId: projectB.id,
      conversationId: projectB.conversationId
    });

    const queuedResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: scopeHeaders(scopeB.scopeToken),
      body: JSON.stringify({
        projectId: projectB.id,
        text: "project B private GPT request",
        to: ["gpt"]
      })
    });
    assert.equal(queuedResponse.status, 201);
    const queued = await queuedResponse.json();
    assert.ok(queued.syncJob?.id);

    const crossRead = await fetch(`${baseUrl}/api/sync/jobs/${queued.syncJob.id}`, {
      headers: scopeHeaders(scopeA.scopeToken)
    });
    assert.equal(crossRead.status, 404);

    const crossComplete = await fetch(`${baseUrl}/api/sync/jobs/${queued.syncJob.id}/complete`, {
      method: "POST",
      headers: scopeHeaders(scopeA.scopeToken),
      body: JSON.stringify({ replyText: "wrong project result" })
    });
    assert.equal(crossComplete.status, 404);

    const ownerRead = await fetch(`${baseUrl}/api/sync/jobs/${queued.syncJob.id}`, {
      headers: scopeHeaders(scopeB.scopeToken)
    });
    assert.equal(ownerRead.status, 200);
    assert.equal((await ownerRead.json()).job.status, "pending");
  });
});
