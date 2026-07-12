import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bindCurrentSessionProject,
  createProject,
  deleteProject,
  ensureProjectForWorkspace,
  getProject,
  listProjects,
  selectProject
} from "../src/project-store.js";
import { getWorkspaceBinding, updateWorkspaceBinding } from "../src/conversation-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-projects-"));
}

test("project store creates selectable ChatGPT/Codex workspaces", async () => {
  const storeRoot = await tempStore();
  const first = await createProject(storeRoot, {
    name: "测试项目",
    chatgptProjectUrl: "https://chatgpt.com/c/project-one",
    targetRepo: "F:/game_code/one",
    currentCodexThreadId: "thread_one"
  });
  const second = await createProject(storeRoot, {
    name: "第二项目",
    chatgptProjectUrl: "https://chatgpt.com/c/project-two",
    targetRepo: "F:/game_code/two",
    currentCodexThreadId: "thread_two"
  });

  const listed = await listProjects(storeRoot);
  assert.equal(listed.projects.length, 2);
  assert.equal(listed.projects[0].id, second.id);
  assert.equal(listed.projects[1].id, first.id);

  const selected = await selectProject(storeRoot, first.id);
  assert.equal(selected.activeProjectId, first.id);
  assert.equal(selected.workspace.chatgptProjectUrl, "https://chatgpt.com/c/project-one");
  assert.equal(selected.workspace.targetRepo, "F:/game_code/one");
  assert.equal(selected.workspace.conversationId, first.conversationId);

  const workspace = await getWorkspaceBinding(storeRoot);
  assert.equal(workspace.projectId, first.id);
});

test("ensureProjectForWorkspace imports the existing single binding as a project", async () => {
  const storeRoot = await tempStore();
  const workspace = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/c/current",
    targetRepo: "F:/game_code/current"
  });

  const project = await ensureProjectForWorkspace(storeRoot, workspace, {
    currentCodexThreadId: "thread_current"
  });

  assert.equal(project.chatgptProjectUrl, "https://chatgpt.com/c/current");
  assert.equal(project.targetRepo, "F:/game_code/current");
  assert.equal(project.conversationId, workspace.conversationId);
  assert.equal((await getProject(storeRoot, project.id)).currentCodexThreadId, "thread_current");
});

test("ensureProjectForWorkspace does not claim a project owned by another Codex thread", async () => {
  const storeRoot = await tempStore();
  const other = await createProject(storeRoot, {
    name: "other thread",
    chatgptProjectUrl: "https://chatgpt.com/c/shared",
    targetRepo: "F:/game_code/shared",
    currentCodexThreadId: "thread-other"
  });
  const workspace = await updateWorkspaceBinding(storeRoot, {
    projectId: other.id,
    chatgptProjectUrl: other.chatgptProjectUrl,
    targetRepo: other.targetRepo,
    conversationId: other.conversationId
  });

  const imported = await ensureProjectForWorkspace(storeRoot, workspace, {
    currentCodexThreadId: "thread-current"
  });

  assert.equal(imported, null);
  assert.equal((await getProject(storeRoot, other.id)).currentCodexThreadId, "thread-other");
  const scoped = await listProjects(storeRoot, { currentCodexThreadId: "thread-current" });
  assert.deepEqual(scoped.projects, []);
  assert.deepEqual(scoped.otherProjects.map((project) => project.id), [other.id]);
});

test("bindCurrentSessionProject creates and activates a project owned by the current Codex thread", async () => {
  const storeRoot = await tempStore();
  const oldProject = await createProject(storeRoot, {
    name: "old session",
    chatgptProjectUrl: "https://chatgpt.com/c/old",
    targetRepo: "F:/game_code/old",
    currentCodexThreadId: "thread-old"
  });

  const bound = await bindCurrentSessionProject(
    storeRoot,
    {
      name: "current session",
      chatgptProjectUrl: "https://chatgpt.com/c/current",
      targetRepo: "F:/game_code/current"
    },
    {
      currentCodexThreadId: "thread-current"
    }
  );

  assert.notEqual(bound.project.id, oldProject.id);
  assert.equal(bound.created, true);
  assert.equal(bound.activeProjectId, bound.project.id);
  assert.equal(bound.project.currentCodexThreadId, "thread-current");
  assert.equal(bound.workspace.projectId, bound.project.id);
  assert.equal(bound.workspace.chatgptProjectUrl, "https://chatgpt.com/c/current");
  assert.equal(bound.workspace.targetRepo, "F:/game_code/current");

  const listed = await listProjects(storeRoot);
  assert.equal(listed.activeProjectId, bound.project.id);
});

test("listProjects scopes the primary project list to the current Codex thread", async () => {
  const storeRoot = await tempStore();
  const other = await createProject(storeRoot, {
    name: "other session",
    chatgptProjectUrl: "https://chatgpt.com/c/other",
    targetRepo: "F:/game_code/other",
    currentCodexThreadId: "thread-other"
  });
  const current = await createProject(storeRoot, {
    name: "current session",
    chatgptProjectUrl: "https://chatgpt.com/c/current",
    targetRepo: "F:/game_code/current",
    currentCodexThreadId: "thread-current"
  });

  await selectProject(storeRoot, other.id);

  const scoped = await listProjects(storeRoot, { currentCodexThreadId: "thread-current" });
  assert.deepEqual(scoped.projects.map((project) => project.id), [current.id]);
  assert.deepEqual(scoped.otherProjects.map((project) => project.id), [other.id]);
  assert.equal(scoped.activeProjectId, current.id);
});

test("bindCurrentSessionProject reuses the current thread project instead of duplicating it", async () => {
  const storeRoot = await tempStore();

  const first = await bindCurrentSessionProject(
    storeRoot,
    {
      name: "first",
      chatgptProjectUrl: "https://chatgpt.com/c/first",
      targetRepo: "F:/game_code/first"
    },
    {
      currentCodexThreadId: "thread-current"
    }
  );

  const second = await bindCurrentSessionProject(
    storeRoot,
    {
      name: "renamed",
      chatgptProjectUrl: "https://chatgpt.com/c/second",
      targetRepo: "F:/game_code/second"
    },
    {
      currentCodexThreadId: "thread-current"
    }
  );

  assert.equal(second.created, false);
  assert.equal(second.project.id, first.project.id);
  assert.equal(second.project.name, "renamed");
  assert.equal(second.workspace.chatgptProjectUrl, "https://chatgpt.com/c/second");
  assert.equal((await listProjects(storeRoot)).projects.length, 1);
});

test("deleteProject soft-hides a project and moves the active binding to the next visible project", async () => {
  const storeRoot = await tempStore();
  const first = await createProject(storeRoot, {
    name: "first",
    chatgptProjectUrl: "https://chatgpt.com/c/first",
    targetRepo: "F:/game_code/first"
  });
  const second = await createProject(storeRoot, {
    name: "second",
    chatgptProjectUrl: "https://chatgpt.com/c/second",
    targetRepo: "F:/game_code/second"
  });

  await selectProject(storeRoot, second.id);
  const deleted = await deleteProject(storeRoot, second.id);

  assert.equal(deleted.deletedProject.id, second.id);
  assert.ok(deleted.deletedProject.deletedAt);
  assert.equal(deleted.activeProjectId, first.id);
  assert.equal(deleted.workspace.projectId, first.id);
  assert.equal(deleted.workspace.chatgptProjectUrl, "https://chatgpt.com/c/first");

  const listed = await listProjects(storeRoot);
  assert.deepEqual(listed.projects.map((project) => project.id), [first.id]);
  await assert.rejects(() => getProject(storeRoot, second.id), /Project not found/);
});
