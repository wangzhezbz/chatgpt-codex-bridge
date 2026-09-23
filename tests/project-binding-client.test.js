import assert from "node:assert/strict";
import test from "node:test";

import {
  displayProjectConversationUrl,
  projectIdFromPageUrl,
  restoreProjectConversationUrl,
  saveProjectBindingForScope,
  selectProjectForScope,
  withProjectIdInPageUrl
} from "../public/project-binding-client.js";
import * as projectBindingClient from "../public/project-binding-client.js";

test("project binding displays the real copyable conversation address", () => {
  const realUrl = "https://chatgpt.com/c/6a4a4a41-90ac-83ea-9611-b61688629c70";
  const visibleUrl = displayProjectConversationUrl(realUrl);

  assert.equal(visibleUrl, realUrl);
  assert.equal(restoreProjectConversationUrl(visibleUrl), realUrl);
});

test("project page URL keeps the entered project across refresh without losing its signed scope", () => {
  const pageUrl = withProjectIdInPageUrl(
    "http://127.0.0.1:4317/?scope=signed-page-scope&qa=1",
    "project_current"
  );

  assert.equal(
    pageUrl,
    "http://127.0.0.1:4317/?scope=signed-page-scope&qa=1&project=project_current"
  );
  assert.equal(projectIdFromPageUrl(pageUrl), "project_current");
  assert.equal(
    withProjectIdInPageUrl(pageUrl, null),
    "http://127.0.0.1:4317/?scope=signed-page-scope&qa=1"
  );
});

test("project selection uses the global selectable project API without a Codex thread id", async () => {
  const calls = [];
  const result = await selectProjectForScope({
    api: async (path, options) => {
      calls.push({ path, options });
      return { activeProjectId: "project_one", project: { id: "project_one" } };
    },
    projectId: "project_one",
    currentCodexThreadId: null
  });

  assert.equal(result.activeProjectId, "project_one");
  assert.deepEqual(calls, [{
    path: "/api/projects/project_one/select",
    options: { method: "POST", body: JSON.stringify({}) }
  }]);
});

test("project binding saves and reselects the active project without a Codex thread id", async () => {
  const calls = [];
  const api = async (path, options) => {
    calls.push({ path, options });
    if (options.method === "PATCH") {
      return { project: { id: "project_one", name: "Demo", targetRepo: "C:/demo/new" } };
    }
    return {
      activeProjectId: "project_one",
      project: { id: "project_one", name: "Demo", targetRepo: "C:/demo/new" },
      workspace: { projectId: "project_one", targetRepo: "C:/demo/new" }
    };
  };

  const result = await saveProjectBindingForScope({
    api,
    currentCodexThreadId: null,
    activeProjectId: "project_one",
    activeProjectName: "Demo",
    patch: {
      chatgptProjectUrl: "https://chatgpt.com/c/new",
      targetRepo: "C:/demo/new"
    }
  });

  assert.equal(result.activeProjectId, "project_one");
  assert.equal(result.workspace.targetRepo, "C:/demo/new");
  assert.deepEqual(calls.map((call) => [call.path, call.options.method]), [
    ["/api/projects/project_one", "PATCH"],
    ["/api/projects/project_one/select", "POST"]
  ]);
});

test("project binding keeps the scoped current-session API when a Codex thread id exists", async () => {
  const calls = [];
  await saveProjectBindingForScope({
    api: async (path, options) => {
      calls.push({ path, options });
      return { activeProjectId: "project_scoped", project: { id: "project_scoped" } };
    },
    currentCodexThreadId: "thread_current",
    activeProjectId: "project_scoped",
    activeProjectName: "Scoped",
    patch: {
      chatgptProjectUrl: "https://chatgpt.com/c/scoped",
      targetRepo: "C:/scoped"
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/projects/current-session");
  assert.equal(calls[0].options.method, "POST");
});

test("a late refresh from the previous project cannot overwrite the newly selected project", async () => {
  assert.equal(
    typeof projectBindingClient.createProjectRefreshCoordinator,
    "function",
    "project refreshes need an explicit stale-response coordinator"
  );
  assert.equal(
    typeof projectBindingClient.runProjectRefresh,
    "function",
    "project refreshes need an atomic load-and-apply boundary"
  );

  const coordinator = projectBindingClient.createProjectRefreshCoordinator();
  let activeProjectId = "project_old";
  let resolveOld;
  let resolveCurrent;
  let appliedProjectId = null;
  const oldPayload = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const currentPayload = new Promise((resolve) => {
    resolveCurrent = resolve;
  });
  const load = (projectId) => projectId === "project_old" ? oldPayload : currentPayload;
  const apply = (_payload, projectId) => {
    appliedProjectId = projectId;
  };

  const oldRefresh = projectBindingClient.runProjectRefresh({
    coordinator,
    projectId: "project_old",
    getActiveProjectId: () => activeProjectId,
    load,
    apply
  });
  activeProjectId = "project_current";
  const currentRefresh = projectBindingClient.runProjectRefresh({
    coordinator,
    projectId: "project_current",
    getActiveProjectId: () => activeProjectId,
    load,
    apply
  });

  resolveCurrent({ messages: ["current"] });
  assert.equal(await currentRefresh, true);
  assert.equal(appliedProjectId, "project_current");

  resolveOld({ messages: ["old"] });
  assert.equal(await oldRefresh, false);
  assert.equal(appliedProjectId, "project_current");
});
