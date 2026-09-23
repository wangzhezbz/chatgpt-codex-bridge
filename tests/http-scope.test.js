import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";
import * as bindingClient from "../public/project-binding-client.js";
import * as apiClient from "../public/bridge-api-client.js";
import { createProject, selectProject, getProject } from "../src/project-store.js";
import { getWorkspaceBinding } from "../src/conversation-store.js";
import { appendRoomMessage } from "../src/room-store.js";

test("clearing an inactive project's chat keeps its actual rule status and never changes global binding", async () => {
  await withServer(async (baseUrl, storeRoot) => {
    const a = await createProject(storeRoot, { name: "A", targetRepo: await mkdtemp(path.join(tmpdir(), "bridge-rules-a-")), chatgptProjectUrl: "https://chatgpt.com/c/a", currentCodexThreadId: "task-a" });
    const b = await createProject(storeRoot, { name: "B", targetRepo: await mkdtemp(path.join(tmpdir(), "bridge-rules-b-")), chatgptProjectUrl: "https://chatgpt.com/c/b", currentCodexThreadId: "task-b" });
    await selectProject(storeRoot, a.id);
    await selectProject(storeRoot, b.id);
    await appendRoomMessage(storeRoot, { conversationId: a.conversationId, from: "user", to: ["gpt"], text: "Clear only this room" });
    const beforeGlobal = await getWorkspaceBinding(storeRoot);
    const beforeProject = await getProject(storeRoot, a.id);
    const files = ["BRIDGE.md", "AGENTS.md"];
    const beforeFiles = await Promise.all(files.map(name => readFile(path.join(a.targetRepo, name), "utf8")));
    const { scopeToken } = await mintScope(baseUrl, { currentCodexThreadId: "task-a", projectId: a.id, conversationId: a.conversationId });
    const headers = scopeHeaders(scopeToken);
    const get = async route => {
      const response = await fetch(baseUrl + route, { headers });
      assert.equal(response.status, 200);
      return response.json();
    };
    for (const afterClear of [false, true]) {
      if (afterClear) assert.equal((await fetch(baseUrl + "/api/room/messages", { method: "DELETE", headers })).status, 200);
      const workspace = await get("/api/workspace");
      assert.equal(workspace.bridgeRulesPath, path.join(a.targetRepo, "BRIDGE.md"));
      assert.equal(workspace.codexDelegationPath, path.join(a.targetRepo, "AGENTS.md"));
      assert.equal((await get("/api/diagnostics/status")).workspace.bridgeRulesPath, workspace.bridgeRulesPath);
    }
    assert.deepEqual((await get("/api/room/messages")).messages, []);
    assert.deepEqual(await getWorkspaceBinding(storeRoot), beforeGlobal);
    assert.deepEqual(await getProject(storeRoot, a.id), beforeProject);
    assert.deepEqual(await Promise.all(files.map(name => readFile(path.join(a.targetRepo, name), "utf8"))), beforeFiles);
    await writeFile(path.join(a.targetRepo, "BRIDGE.md"), "# User document, not generated rules\n");
    assert.equal((await get("/api/workspace")).bridgeRulesPath, null, "must not report a file as ready merely because its path exists");
    await writeFile(path.join(a.targetRepo, "BRIDGE.md"), beforeFiles[0].replace(a.conversationId, "conv_stale"));
    assert.equal((await get("/api/workspace")).bridgeRulesPath, null, "stale bindings are not ready");
    assert.match(await readFile(path.join(a.targetRepo, "BRIDGE.md"), "utf8"), /conv_stale/, "status GET must not rewrite rules");
    await writeFile(path.join(a.targetRepo, "AGENTS.md"), beforeFiles[1].replaceAll(a.id, "project_stale"));
    assert.equal((await get("/api/workspace")).codexDelegationPath, null, "delegation status must match this project, not just its directory");
  });
});

test("image, preview and download URLs preserve the page project without custom request headers", async () => {
  await withServer(async baseUrl => {
    const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64");
    const post = async (route, body, headers) => {
      const response = await fetch(baseUrl + route, {method:"POST", headers:{"Content-Type":"application/json", ...headers}, body:JSON.stringify(body)});
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const {project: owned} = await post("/api/projects", {name:"Owned", currentCodexThreadId:"image-task", chatgptProjectUrl:"https://chatgpt.com/c/image"});
    const {scopeToken} = await mintScope(baseUrl, {currentCodexThreadId:"image-task", projectId:owned.id, conversationId:owned.conversationId});
    const standaloneHeaders = {"X-Bridge-Context":"standalone"};
    const {project: unowned} = await post("/api/projects", {name:"Standalone", chatgptProjectUrl:"https://chatgpt.com/c/standalone"}, standaloneHeaders);
    assert.equal(typeof apiClient.artifactResourceUrl, "function");
    for (const [project, token, headers] of [[owned, scopeToken, scopeHeaders(scopeToken)], [unowned, "", standaloneHeaders]]) {
      const {artifact} = await post(`/api/artifacts/import?projectId=${project.id}`, {filename:"poster.png", contentType:"image/png", base64Data:bytes.toString("base64")}, headers);
      for (const action of ["raw", "view", "download"]) {
        const url = apiClient.artifactResourceUrl(artifact.id, {action, scopeToken:token, projectId:project.id});
        const response = await fetch(baseUrl + url);
        assert.equal(response.status, 200, `${action} must work without fetch headers`);
        assert.equal(response.headers.get("content-type"), "image/png");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      }
      const wrongProject = project === owned ? unowned : owned;
      const wrongUrl = apiClient.artifactResourceUrl(artifact.id, {action:"raw", projectId:wrongProject.id});
      assert.equal((await fetch(baseUrl + wrongUrl)).status, 409, "must not expose another project's files");
    }
    const missingProject = await fetch(baseUrl + "/api/artifacts/missing/raw?context=standalone");
    assert.notEqual(missingProject.status, 200);
  });
});

test("home opens a saved project from another task without rebinding or losing it on refresh", async () => {
  await withServer(async baseUrl => {
    const api = async (route, options = {}) => {
      const response = await fetch(baseUrl + route, {...options, headers:{'Content-Type':'application/json'}});
      assert.ok(response.ok);
      return response.json();
    };
    const {project} = await api('/api/projects', {method:'POST',body:JSON.stringify({
      name:'Novel',currentCodexThreadId:'novel-thread',chatgptProjectUrl:'https://chatgpt.com/c/novel'
    })});
    const before = await api('/api/projects');
    assert.equal(before.projects.length, 0);
    assert.equal(typeof bindingClient.projectsForPage, 'function');
    assert.equal(typeof bindingClient.pageUrlForSavedProject, 'function');
    assert.deepEqual(bindingClient.projectsForPage(before, false).map(p=>p.id), [project.id]);
    assert.deepEqual(bindingClient.projectsForPage(before, true), []);
    const url = new URL(await bindingClient.pageUrlForSavedProject({api,project,pageUrl:baseUrl+'/'}));
    assert.equal(url.searchParams.get('project'),project.id);
    const scopedHeaders = scopeHeaders(url.searchParams.get('scope'));
    const config = await (await fetch(baseUrl+'/api/config',{headers:scopedHeaders})).json();
    assert.equal(config.currentCodexThreadId, 'novel-thread');
    const reopened = await (await fetch(baseUrl+'/api/projects',{headers:scopedHeaders})).json();
    assert.deepEqual(reopened.projects, [project]);
    assert.deepEqual(await api('/api/projects'), before, 'entering must not mutate owner, conversation, or selection');
  });
});

test("new-project form creates a separate conversation instead of replacing the process thread project", async () => {
  await withServer(async (baseUrl) => {
    const api = async (route, options = {}) => {
      const response = await fetch(baseUrl + route, {
        ...options, headers: { "Content-Type": "application/json" }
      });
      const result = await response.json();
      assert.ok(response.ok, JSON.stringify(result));
      return result;
    };
    const old = await api("/api/projects/current-session", {
      method: "POST", body: JSON.stringify({ name: "Existing", chatgptProjectUrl: "https://chatgpt.com/c/existing" })
    });
    const before = (await api("/api/projects")).projects.find(p => p.id === old.project.id);
    assert.equal(typeof bindingClient.createNewProjectForScope, "function");
    const added = await bindingClient.createNewProjectForScope({
      api, input: { name: "Novel", chatgptProjectUrl: "https://chatgpt.com/c/novel" }
    });
    assert.notEqual(added.project.id, old.project.id);
    assert.notEqual(added.project.conversationId, old.project.conversationId);
    const listed = await api("/api/projects");
    assert.equal(listed.projects.length, 2);
    assert.deepEqual(listed.projects.find(p => p.id === old.project.id), before);
    const messages = await api(`/api/room/messages?projectId=${added.project.id}`);
    assert.deepEqual(messages.messages, []);
  });
});

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
    await fn(baseUrl, storeRoot);
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
