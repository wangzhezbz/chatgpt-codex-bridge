import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";
import { saveArtifactFromBase64 } from "../src/artifact-store.js";
import { updateWorkspaceBinding } from "../src/conversation-store.js";
import { createProject } from "../src/project-store.js";
import { appendRoomMessage } from "../src/room-store.js";
import { completeSyncJob, createSyncJob, failSyncJob, listSyncJobs, markSyncJobSent } from "../src/sync-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-http-"));
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

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("POST /api/tasks creates a task and GET /api/tasks lists it", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Build bridge",
        prompt: "Create the task-board prototype.",
        targetRepo: "F:/game_code/bridge",
        run: false
      })
    });

    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.title, "Build bridge");
    assert.equal(created.status, "queued");

    const listResponse = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const tasks = await listResponse.json();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, created.id);
  });
});

test("POST /api/tasks with run=true uses manual runner and exposes result", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Run manual",
        prompt: "Prepare Codex handoff.",
        run: true
      })
    });
    const created = await createdResponse.json();

    assert.equal(created.status, "waiting_for_codex");

    const resultResponse = await fetch(`${baseUrl}/api/tasks/${created.id}/result`);
    assert.equal(resultResponse.status, 200);
    const result = await resultResponse.json();
    assert.match(result.text, /\u624b\u52a8\u4ea4\u7ed9 Codex/);
  });
});

test("GET /api/config exposes runner mode and current Codex thread", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/config`);
    assert.equal(response.status, 200);

    const config = await response.json();
    assert.equal(config.runnerMode, "manual");
    assert.equal(config.autoExecutesCodex, false);
    assert.equal(config.currentCodexThreadId, "thread_current");
    assert.match(config.extensionSourceDir, /chrome-extension$/);
    assert.match(config.expectedExtensionVersion, /^v20\d{6}-/);
  });
});

test("project APIs expose a selectable project home and keep workspace binding per project", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/current",
        targetRepo: "F:/game_code/current"
      })
    });

    const importedResponse = await fetch(`${baseUrl}/api/projects`);
    assert.equal(importedResponse.status, 200);
    const imported = await importedResponse.json();
    assert.equal(imported.projects.length, 1);
    assert.equal(imported.projects[0].targetRepo, "F:/game_code/current");
    assert.equal(imported.projects[0].currentCodexThreadId, "thread_current");

    const createResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "another project",
        chatgptProjectUrl: "https://chatgpt.com/c/next",
        targetRepo: "F:/game_code/next"
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();
    assert.equal(created.project.name, "another project");

    const selectResponse = await fetch(`${baseUrl}/api/projects/${created.project.id}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(selectResponse.status, 200);
    const selected = await selectResponse.json();
    assert.equal(selected.workspace.chatgptProjectUrl, "https://chatgpt.com/c/next");
    assert.equal(selected.workspace.projectId, created.project.id);
  });
});

test("current-session project API claims the Bridge project for the running Codex thread", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const oldResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "old session",
        chatgptProjectUrl: "https://chatgpt.com/c/old",
        targetRepo: "F:/game_code/old",
        currentCodexThreadId: "thread_old"
      })
    });
    assert.equal(oldResponse.status, 201);
    const oldProject = await oldResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/projects/current-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "current session",
        chatgptProjectUrl: "https://chatgpt.com/c/current",
        targetRepo: "F:/game_code/current"
      })
    });
    assert.equal(claimResponse.status, 201);
    const claimed = await claimResponse.json();
    assert.notEqual(claimed.project.id, oldProject.project.id);
    assert.equal(claimed.project.currentCodexThreadId, "thread_current");
    assert.equal(claimed.workspace.projectId, claimed.project.id);
    assert.equal(claimed.activeProjectId, claimed.project.id);

    const listedResponse = await fetch(`${baseUrl}/api/projects`);
    const listed = await listedResponse.json();
    assert.equal(listed.activeProjectId, claimed.project.id);
  });
});

test("project list does not auto-enter a project owned by another Codex thread", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const oldResponse = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "other thread",
        chatgptProjectUrl: "https://chatgpt.com/c/other",
        targetRepo: "F:/game_code/other",
        currentCodexThreadId: "thread_other"
      })
    });
    assert.equal(oldResponse.status, 201);

    const listedResponse = await fetch(`${baseUrl}/api/projects`);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.equal(listed.projects.length, 0);
    assert.equal(listed.otherProjects.length, 1);
    assert.equal(listed.activeProjectId, null);
  });
});

test("current-session project API updates the same current thread project on repeated binds", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const firstResponse = await fetch(`${baseUrl}/api/projects/current-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "first",
        chatgptProjectUrl: "https://chatgpt.com/c/first",
        targetRepo: "F:/game_code/first"
      })
    });
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();

    const secondResponse = await fetch(`${baseUrl}/api/projects/current-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "second",
        chatgptProjectUrl: "https://chatgpt.com/c/second",
        targetRepo: "F:/game_code/second"
      })
    });
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json();
    assert.equal(second.project.id, first.project.id);
    assert.equal(second.project.name, "second");
    assert.equal(second.workspace.chatgptProjectUrl, "https://chatgpt.com/c/second");

    const listedResponse = await fetch(`${baseUrl}/api/projects`);
    const listed = await listedResponse.json();
    assert.equal(listed.projects.length, 1);
  });
});

test("room APIs do not read or write a workspace bound to another Codex thread", async () => {
  const storeRoot = await tempStore();
  const other = await createProject(storeRoot, {
    name: "other thread",
    chatgptProjectUrl: "https://chatgpt.com/c/other",
    targetRepo: "F:/game_code/other",
    currentCodexThreadId: "thread_other"
  });
  await updateWorkspaceBinding(storeRoot, {
    projectId: other.id,
    chatgptProjectUrl: other.chatgptProjectUrl,
    targetRepo: other.targetRepo,
    conversationId: other.conversationId
  });
  await appendRoomMessage(storeRoot, {
    conversationId: other.conversationId,
    from: "gpt",
    to: ["user"],
    text: "old room message"
  });

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    assert.equal(roomResponse.status, 200);
    const room = await roomResponse.json();
    assert.deepEqual(room.messages, []);

    const sendResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "娴ｇ姴?",
        to: ["gpt"]
      })
    });
    assert.equal(sendResponse.status, 409);
    const rejected = await sendResponse.json();
    assert.match(rejected.error, /current Codex session is not bound/i);
  });
});

test("artifact APIs only operate on the current Codex thread room", async () => {
  const storeRoot = await tempStore();
  const sourcePath = path.join(await mkdtemp(path.join(tmpdir(), "bridge-cross-artifact-")), "note.txt");
  await writeFile(sourcePath, "current room note", "utf8");

  const current = await createProject(storeRoot, {
    name: "current thread",
    chatgptProjectUrl: "https://chatgpt.com/c/current",
    targetRepo: "F:/game_code/current",
    currentCodexThreadId: "thread_current"
  });
  const other = await createProject(storeRoot, {
    name: "other thread",
    chatgptProjectUrl: "https://chatgpt.com/c/other",
    targetRepo: "F:/game_code/other",
    currentCodexThreadId: "thread_other"
  });
  await updateWorkspaceBinding(storeRoot, {
    projectId: other.id,
    chatgptProjectUrl: other.chatgptProjectUrl,
    targetRepo: other.targetRepo,
    conversationId: other.conversationId
  });

  const otherArtifact = await saveArtifactFromBase64(storeRoot, {
    filename: "other-room.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("other room artifact", "utf8").toString("base64"),
    conversationId: other.conversationId
  });

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    const blockedImportResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain"
      })
    });
    assert.equal(blockedImportResponse.status, 409);
    const blockedImport = await blockedImportResponse.json();
    assert.equal(blockedImport.code, "current_session_not_bound");

    const hiddenListResponse = await fetch(`${baseUrl}/api/artifacts`);
    assert.equal(hiddenListResponse.status, 200);
    assert.deepEqual((await hiddenListResponse.json()).artifacts, []);

    await updateWorkspaceBinding(storeRoot, {
      projectId: current.id,
      chatgptProjectUrl: current.chatgptProjectUrl,
      targetRepo: current.targetRepo,
      conversationId: current.conversationId
    });

    const crossReadResponse = await fetch(`${baseUrl}/api/artifacts/${otherArtifact.id}`);
    assert.equal(crossReadResponse.status, 409);
    assert.equal((await crossReadResponse.json()).code, "artifact_not_in_current_room");

    const crossRoomSendResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "请分析这个文件",
        inputArtifactIds: [otherArtifact.id],
        to: ["gpt"]
      })
    });
    assert.equal(crossRoomSendResponse.status, 409);
    assert.equal((await crossRoomSendResponse.json()).code, "artifact_not_in_current_room");

    const crossAnalyzeResponse = await fetch(`${baseUrl}/api/artifacts/${otherArtifact.id}/analyze-with-gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "请分析"
      })
    });
    assert.equal(crossAnalyzeResponse.status, 409);
    assert.equal((await crossAnalyzeResponse.json()).code, "artifact_not_in_current_room");

    const currentImportResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain",
        conversationId: other.conversationId
      })
    });
    assert.equal(currentImportResponse.status, 201);
    const currentImport = await currentImportResponse.json();
    assert.equal(currentImport.artifact.conversationId, current.conversationId);
  });
});

test("workspace and chat APIs bind a ChatGPT project and queue sync from chat", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const bindingResponse = await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });
    assert.equal(bindingResponse.status, 200);

    const turnResponse = await fetch(`${baseUrl}/api/chat/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Ask ChatGPT to plan the login module fix.",
        run: false
      })
    });
    assert.equal(turnResponse.status, 201);

    const turn = await turnResponse.json();
    assert.equal(turn.assistant, null);
    assert.equal(turn.task, null);
    assert.equal(turn.syncJob.status, "pending");
    assert.match(turn.syncJob.payloadText, /F:\/game_code\/demo/);

    const messagesResponse = await fetch(`${baseUrl}/api/chat/messages`);
    assert.equal(messagesResponse.status, 200);
    const messages = await messagesResponse.json();
    assert.equal(messages.length, 1);
  });
});

test("sync API completes ChatGPT reply and queues a current-thread Codex inbox item", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/chat/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Ask GPT to design login page copy, then let Codex implement it in the local repo.",
        run: true
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claimed = await claimResponse.json();
    assert.equal(claimed.job.kind, "user_request");
    assert.match(claimed.job.payloadText, /login page copy/);

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "ChatGPT suggests Codex inspect the login route and provide verification steps."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "succeeded");
    assert.equal(completed.chatgptMessage.role, "chatgpt");
    assert.equal(completed.task, null);
    assert.equal(completed.resultMessage, null);
    assert.equal(completed.resultSyncJob, null);
    assert.equal(completed.inboxItem.status, "pending");
    assert.equal(completed.inboxItem.source, "chatgpt_project");
    assert.match(completed.inboxItem.promptText, /GPT/);
    assert.match(completed.inboxItem.promptText, /GPT \u4e0a\u6e38\u7ed3\u679c/);
    assert.match(completed.inboxItem.promptText, /GPT \u7ed3\u679c\u6d88\u8d39\u89c4\u5219/);
    assert.match(completed.inboxItem.promptText, /\u9ed8\u8ba4\u4f7f\u7528 GPT/);
    assert.match(completed.inboxItem.promptText, /Codex/);

    const inboxResponse = await fetch(`${baseUrl}/api/codex-inbox/next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "current-codex-thread"
      })
    });
    assert.equal(inboxResponse.status, 200);
    const inbox = await inboxResponse.json();
    assert.equal(inbox.item.id, completed.inboxItem.id);
    assert.equal(inbox.item.status, "running");
  });
});

test("codex inbox API can create a current-thread item explicitly", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/codex-inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "manual",
        projectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo",
        conversationId: "conv_manual",
        promptText: "Create b.txt in the target repo."
      })
    });
    assert.equal(createResponse.status, 201);
    const created = await createResponse.json();

    assert.equal(created.item.status, "pending");
    assert.equal(created.item.targetRepo, "F:/game_code/demo");
    assert.equal(created.item.promptText, "Create b.txt in the target repo.");
  });
});

test("room API sends user messages to the current Codex thread", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current"
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "create b.txt",
          to: ["codex"]
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(created.message.from, "user");
      assert.deepEqual(created.message.to, ["codex"]);
      assert.equal(created.codexTask.status, "pending");
      assert.equal(created.codexTask.currentThreadId, "thread_current");
      assert.equal(created.syncJob, null);

      const claimResponse = await fetch(`${baseUrl}/api/current-codex/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentThreadId: "thread_current"
        })
      });
      assert.equal(claimResponse.status, 200);
      const claimed = await claimResponse.json();
      assert.equal(claimed.task.id, created.codexTask.id);
    }
  );
});

test("room API rejects likely question-mark encoding loss before queuing GPT sync", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "????? 10 ????????? AI ?????????????",
        to: ["gpt"]
      })
    });

    assert.equal(response.status, 400);
    const rejected = await response.json();
    assert.match(rejected.error, /\u6587\u672c\u7f16\u7801\u5f02\u5e38/);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.deepEqual(room.messages, []);

    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.length, 0);
  });
});

test("current Codex completion can optionally sync the result back to GPT", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current"
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: "F:/game_code/demo",
          modePreference: "advanced",
          modelPreference: "gpt-5.5"
        })
      });

      const roomResponse = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Check the login page and sync the result back to GPT for review.",
          to: ["codex"]
        })
      });
      assert.equal(roomResponse.status, 201);
      const room = await roomResponse.json();

      const claimResponse = await fetch(`${baseUrl}/api/current-codex/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentThreadId: "thread_current"
        })
      });
      assert.equal(claimResponse.status, 200);
      const claimed = await claimResponse.json();
      assert.equal(claimed.task.id, room.codexTask.id);

      const completeResponse = await fetch(`${baseUrl}/api/current-codex/${claimed.task.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resultText: "Codex checked the login page and did not find a blocker. npm test passed.",
          syncToChatGpt: true,
          modePreference: "balanced",
          modelPreference: "gpt-5.5"
        })
      });
      assert.equal(completeResponse.status, 200);
      const completed = await completeResponse.json();

      assert.equal(completed.task.status, "succeeded");
      assert.equal(completed.message.from, "codex");
      assert.deepEqual(completed.message.to, ["user", "gpt"]);
      assert.equal(completed.syncJob.kind, "codex_result");
      assert.equal(completed.syncJob.status, "pending");
      assert.equal(completed.syncJob.sourceMessageId, completed.message.id);
      assert.equal(completed.syncJob.projectUrl, "https://chatgpt.com/project/demo");
      assert.equal(completed.syncJob.modePreference, "balanced");
      assert.equal(completed.syncJob.modelPreference, "gpt-5.5");
      assert.match(completed.syncJob.payloadText, /Codex checked the login page/);
      assert.match(completed.syncJob.payloadText, /npm test passed/);
    }
  );
});

test("room API can send one user message to both GPT and current Codex", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current"
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Create and check b.txt",
          to: ["gpt", "codex"],
          modePreference: "balanced",
          modelPreference: "gpt-5.5"
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(created.syncJob.status, "pending");
      assert.equal(created.syncJob.modePreference, "balanced");
      assert.equal(created.syncJob.modelPreference, "gpt-5.5");
      assert.equal(created.codexTask.status, "pending");
      assert.equal(created.codexTask.currentThreadId, "thread_current");

      const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
      const room = await roomResponse.json();
      assert.equal(room.messages.length, 1);
      assert.deepEqual(room.messages[0].to, ["gpt", "codex"]);
      assert.equal(room.messages[0].metadata.syncJobId, created.syncJob.id);
      assert.equal(room.messages[0].metadata.syncStatus, "pending");
      assert.match(room.messages[0].metadata.syncReason, /\u7b49\u5f85 GPT \u9875\u9762\u63a5\u6536\u4efb\u52a1/);

      await fetch(`${baseUrl}/api/sync/jobs/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectUrl: "https://chatgpt.com/project/demo/c/abc",
          workerId: "test-extension"
        })
      });

      const runningRoomResponse = await fetch(`${baseUrl}/api/room/messages`);
      const runningRoom = await runningRoomResponse.json();
      assert.equal(runningRoom.messages[0].metadata.syncJobId, created.syncJob.id);
      assert.equal(runningRoom.messages[0].metadata.syncStatus, "running");
    }
  );
});

test("POST /api/preferences/sync stores preferences without queuing a ChatGPT message", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "advanced",
        modelPreference: "gpt-5.4"
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.syncJob, null);
    assert.equal(created.workspace.modePreference, "advanced");
    assert.equal(created.workspace.modelPreference, "gpt-5.4");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();
    assert.equal(claimed.job, null);

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeat = await heartbeatResponse.json();
    assert.deepEqual(heartbeat.preferences, {
      projectUrl: "https://chatgpt.com/project/demo",
      modePreference: "advanced",
      modelPreference: "gpt-5.4",
      updatedAt: created.workspace.updatedAt
    });

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 0);
  });
});

test("extension heartbeat preference timestamp ignores unrelated workspace updates", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "project-demo"
      })
    });

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    const heartbeat = await heartbeatResponse.json();

    assert.equal(heartbeat.preferences.updatedAt, created.workspace.preferenceUpdatedAt);
    assert.notEqual(heartbeat.preferences.updatedAt, heartbeat.heartbeat.updatedAt);
  });
});

test("extension heartbeat does not resend already applied preferences", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });
    const created = await response.json();

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        preferenceStatus: {
          state: "applied",
          modePreference: "advanced",
          modelPreference: "gpt-5.5",
          updatedAt: created.workspace.preferenceUpdatedAt,
          modeSynced: true,
          modelSynced: true
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();

    assert.equal(heartbeat.controlsCurrentPage, true);
    assert.equal(heartbeat.preferences, null);
  });
});

test("extension heartbeat resends failed preferences so the page can recheck visible state", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });
    const created = await response.json();

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        preferenceStatus: {
          state: "failed",
          modePreference: "advanced",
          modelPreference: "gpt-5.5",
          updatedAt: created.workspace.preferenceUpdatedAt,
          modeSynced: true,
          modelSynced: false,
          error: "model preference was not applied"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();

    assert.equal(heartbeat.controlsCurrentPage, true);
    assert.deepEqual(heartbeat.preferences, {
      projectUrl: "https://chatgpt.com/project/demo",
      modePreference: "advanced",
      modelPreference: "gpt-5.5",
      updatedAt: created.workspace.preferenceUpdatedAt
    });
  });
});

test("extension heartbeat preserves applied preferences across extension reloads", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });
    const created = await response.json();
    const workerId = "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:stable-tab";

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId,
        preferenceStatus: {
          state: "applied",
          modePreference: "advanced",
          modelPreference: "gpt-5.5",
          updatedAt: created.workspace.preferenceUpdatedAt,
          modeSynced: true,
          modelSynced: true
        }
      })
    });

    const reloadHeartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId
      })
    });
    const reloadHeartbeat = await reloadHeartbeatResponse.json();

    assert.equal(reloadHeartbeat.controlsCurrentPage, true);
    assert.equal(reloadHeartbeat.preferences, null);
    assert.equal(reloadHeartbeat.heartbeat.preferenceStatus.state, "applied");
  });
});

test("POST /api/preferences/sync drops retired ChatGPT models that are no longer on the web page", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "balanced",
        modelPreference: "gpt-4.5"
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.workspace.modePreference, "balanced");
    assert.equal(created.workspace.modelPreference, null);

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    const heartbeat = await heartbeatResponse.json();

    assert.deepEqual(heartbeat.preferences, {
      projectUrl: "https://chatgpt.com/project/demo",
      modePreference: "balanced",
      modelPreference: null,
      updatedAt: created.workspace.updatedAt
    });
  });
});

test("POST /api/preferences/sync coerces unsupported mode preferences for limited ChatGPT models", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/preferences/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modePreference: "balanced",
        modelPreference: "gpt-5.3"
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.workspace.modePreference, "fast");
    assert.equal(created.workspace.modelPreference, "gpt-5.3");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    const heartbeat = await heartbeatResponse.json();

    assert.deepEqual(heartbeat.preferences, {
      projectUrl: "https://chatgpt.com/project/demo",
      modePreference: "fast",
      modelPreference: "gpt-5.3",
      updatedAt: created.workspace.updatedAt
    });
  });
});

test("extension heartbeat only sends preferences to the current extension version", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo",
        modePreference: "advanced",
        modelPreference: "gpt-5.4"
      })
    });

    const oldResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260628-preference-heartbeat-2:runtime-ok"
      })
    });
    const oldHeartbeat = await oldResponse.json();
    assert.equal(oldHeartbeat.preferences, null);
    assert.equal(oldHeartbeat.recovery, null);

    const currentResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    const currentHeartbeat = await currentResponse.json();
    assert.equal(currentHeartbeat.preferences.modePreference, "advanced");
    assert.equal(currentHeartbeat.preferences.modelPreference, "gpt-5.4");
  });
});

test("extension heartbeat asks stale extension versions to reload themselves", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260702-quiet-download:runtime-ok"
      })
    });
    assert.equal(response.status, 200);
    const heartbeat = await response.json();
    assert.equal(heartbeat.reloadExtension, true);
    assert.equal(heartbeat.expectedExtensionVersion, "v20260711-router-v2-safety");
    assert.equal(heartbeat.controlsCurrentPage, false);
    assert.equal(heartbeat.preferences, null);
    assert.equal(heartbeat.recovery, null);
  });
});

test("extension heartbeat stores preference application status for diagnostics", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo",
        modePreference: "balanced",
        modelPreference: "gpt-4.5"
      })
    });

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        preferenceStatus: {
          state: "failed",
          modePreference: "balanced",
          modelPreference: "gpt-4.5",
          modeSynced: true,
          modelSynced: false,
          error: "model preference was not applied"
        }
      })
    });
    assert.equal(heartbeatResponse.status, 200);

    const diagnosticsResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const diagnostics = await diagnosticsResponse.json();
    assert.deepEqual(diagnostics.extension.heartbeat.preferenceStatus, {
      state: "failed",
      modePreference: "balanced",
      modelPreference: "gpt-4.5",
      modeSynced: true,
      modelSynced: false,
      error: "model preference was not applied"
    });
  });
});

test("extension heartbeat does not navigate wrong ChatGPT pages when no job is active", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });

    assert.equal(heartbeatResponse.status, 200);
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery, null);

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.latestSyncJob, null);
    assert.equal(status.activeSyncJob, null);
    assert.equal(status.extension.needsReload, false);
    assert.equal(status.extension.projectMatches, false);
    assert.equal(status.extension.expectedHref, "https://chatgpt.com/c/bound-chat");
    assert.equal(status.workflowStatus.level, "blocked");
    assert.match(status.workflowStatus.detail, /chatgpt\.com\/c\/bound-chat/);
  });
});

test("extension heartbeat only sends control instructions to the bound ChatGPT page", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo",
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate an xlsx file.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.sentAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const wrongPageResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_other"
      })
    });
    const wrongPageHeartbeat = await wrongPageResponse.json();
    assert.equal(wrongPageHeartbeat.preferences, null);
    assert.equal(wrongPageHeartbeat.recovery, null);

    const boundPageResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });
    const boundPageHeartbeat = await boundPageResponse.json();
    assert.equal(boundPageHeartbeat.preferences.modelPreference, "gpt-5.5");
    assert.equal(boundPageHeartbeat.recovery.action, "reload");
    assert.equal(boundPageHeartbeat.recovery.job.id, created.syncJob.id);
  });
});

test("diagnostics prefers the bound ChatGPT heartbeat when other ChatGPT tabs are also open", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });
    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_other"
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.extension.href, "https://chatgpt.com/c/bound-chat");
    assert.equal(status.extension.projectMatches, true);
    assert.equal(status.workflowStatus.level, "ready");
  });
});

test("diagnostics scopes active sync jobs to the current workspace", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/current-chat",
        targetRepo: "F:/game_code/current",
        conversationId: "conv-current"
      })
    });

    await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/other-chat",
      targetRepo: "F:/game_code/other",
      conversationId: "conv-other",
      payloadText: "A pending job from another project"
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/current-chat",
        title: "Current chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_current"
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.latestSyncJob, null);
    assert.equal(status.activeSyncJob, null);
    assert.equal(status.workflowStatus.level, "ready");
    assert.equal(status.connection.scope, "bound-chatgpt-page");
    assert.equal(status.connection.ready, true);
    assert.deepEqual(status.connection.blockers, []);
  });
});

test("diagnostics reports actionable workflow status for stale extensions and current preference failures", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const workspaceResponse = await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo",
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });
    const workspace = await workspaceResponse.json();

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Old extension",
        workerId: "codex-chatgpt-project-extension-v20260629-old:runtime-ok",
        pageStatus: {
          state: "working",
          code: "active_generation",
          message: "GPT 正在生成上一条回复，Bridge 会等它结束后继续。"
        }
      })
    });

    const staleResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const stale = await staleResponse.json();
    assert.equal(stale.workflowStatus.level, "blocked");
    assert.equal(stale.workflowStatus.label, "\u6269\u5c55\u9700\u91cd\u8f7d");
    assert.match(stale.workflowStatus.nextStep, /\u91cd\u8f7d Bridge \u6269\u5c55/);
    assert.equal(stale.status.state, "blocked");
    assert.match(stale.status.reason, /Bridge \u6269\u5c55\u7248\u672c\u8fc7\u65e7/);
    assert.equal(stale.connection.checks.find((check) => check.id === "page-state").state, "passed");
    assert.deepEqual(stale.connection.working, []);

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        preferenceStatus: {
          state: "failed",
          modePreference: "advanced",
          modelPreference: "gpt-5.5",
          updatedAt: workspace.updatedAt,
          modeSynced: true,
          modelSynced: false,
          error: "model preference was not applied"
        }
      })
    });

    const failedResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const failed = await failedResponse.json();
    assert.equal(failed.workflowStatus.level, "ready");
    assert.equal(failed.workflowStatus.label, "\u540c\u6b65\u5c31\u7eea");
    assert.equal(failed.connection.level, "ready");
    assert.equal(failed.connection.label, "\u8fde\u63a5\u5c31\u7eea");
    const preferenceCheck = failed.connection.checks.find((check) => check.id === "preferences");
    assert.equal(preferenceCheck.state, "warning");
    assert.match(preferenceCheck.detail, /model preference was not applied/);
    assert.ok(failed.connection.warnings.some((warning) => /\u504f\u597d|preference|\u6a21\u578b|model/i.test(warning)));
  });
});

test("diagnostics blocks previous extension versions after capture-critical extension updates", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Compatible extension",
        workerId: "codex-chatgpt-project-extension-v20260702-artifact-upload-raw:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ready"
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.workflowStatus.level, "blocked");
    assert.equal(status.workflowStatus.label, "扩展需重载");
    assert.equal(status.connection.canSendToGpt, false);
    assert.equal(status.connection.ready, false);
    const extensionVersionCheck = status.connection.checks.find((check) => check.id === "extension-version");
    assert.ok(status.connection.blockers.length > 0);
    assert.equal(extensionVersionCheck.state, "blocked");
    assert.match(extensionVersionCheck.detail, /v20260702-artifact-upload-raw/);

    const preflightResponse = await fetch(`${baseUrl}/api/gpt/preflight`);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.action, "reload_extension");
  });
});

test("GPT preflight prioritizes required extension reload over bound-page mismatch", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat",
        workerId: "codex-chatgpt-project-extension-v20260702-artifact-upload-raw:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ready"
        }
      })
    });

    const preflightResponse = await fetch(`${baseUrl}/api/gpt/preflight`);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.action, "reload_extension");
    assert.equal(preflight.workflowStatus.level, "blocked");
    assert.match(preflight.workflowStatus.detail, /v20260702-artifact-upload-raw/);
  });
});

test("diagnostics blocks active GPT progress when the extension version is stale", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Compatible extension",
        workerId: "codex-chatgpt-project-extension-v20260702-artifact-upload-raw:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ready"
        }
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please reply only: bridge-progress-ok.",
        to: ["gpt"]
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.workflowStatus.level, "blocked");
    assert.equal(status.workflowStatus.label, "扩展需重载");
    assert.equal(status.connection.canSendToGpt, false);
    assert.equal(status.connection.checks.find((check) => check.id === "extension-version").state, "blocked");
  });
});

test("diagnostics treats unrelated busy GPT page state as ready when no Bridge job is active", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "working",
          code: "active_generation",
          message: "ChatGPT is still generating. Bridge will wait for the current reply to finish."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const visibleStatus = JSON.stringify({
      workflowStatus: status.workflowStatus,
      pageState: status.connection.checks.find((check) => check.id === "page-state")
    });

    assert.equal(status.workflowStatus.level, "ready");
    assert.equal(status.connection.canSendToGpt, true);
    assert.equal(status.connection.checks.find((check) => check.id === "page-state").state, "passed");
    assert.doesNotMatch(visibleStatus, /ChatGPT|page cannot receive|still generating|Keep this page/i);

    const preflightResponse = await fetch(`${baseUrl}/api/gpt/preflight`);
    const preflight = await preflightResponse.json();
    assert.equal(preflight.canSend, true);
    assert.equal(preflight.level, "ready");
    assert.equal(preflight.action, "send");
  });
});

test("diagnostics connection checks use product Chinese copy", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "GPT 页面已就绪。"
        },
        preferenceStatus: {
          state: "applied",
          modePreference: "balanced",
          modelPreference: "gpt-5.5"
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const visibleConnection = JSON.stringify(status.connection.checks);

    assert.doesNotMatch(
      visibleConnection,
      /GPT project|Bridge extension|Extension version|Bound page|Page state|Sync task|Model preferences|No blocking|Current |Needs |Model and mode|No preference/i
    );
    assert.match(visibleConnection, /GPT 会话/);
    assert.match(visibleConnection, /绑定页面/);
  });
});

test("sync progress uses GPT wording instead of ChatGPT wording", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "GPT 页面已就绪。"
        }
      })
    });

    const job = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Generate an image."
    });
    await markSyncJobSent(storeRoot, job.id, { workerId: "chrome-extension" });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.workflowStatus.label, "GPT \u5904\u7406\u4e2d");
    assert.equal(status.activeSyncJob.progress.stage, "waiting_reply");
    assert.match(status.activeSyncJob.progress.message, /GPT/);
    assert.doesNotMatch(status.activeSyncJob.progress.message, /ChatGPT/);
  });
});

test("diagnostics ignores legacy preference sync jobs when reporting latest user-visible sync", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const visible = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Visible user request"
    });
    const legacyPreference = await createSyncJob(storeRoot, {
      kind: "preference_sync",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Bridge preference sync",
      modePreference: "advanced",
      modelPreference: "gpt-5.4"
    });
    await completeSyncJob(storeRoot, legacyPreference.id, {
      replyText: "Bridge preference sync ok"
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.latestSyncJob.id, visible.id);
    assert.notEqual(status.latestSyncJob.id, legacyPreference.id);
    assert.equal(status.activeSyncJob.id, visible.id);
    assert.equal(status.extension.version, "v20260711-router-v2-safety");
    assert.equal(status.extension.needsReload, false);
  });
});

test("diagnostics prefers a current extension heartbeat over a newer old tab heartbeat", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Current tab",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });
    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Old duplicate tab",
        workerId: "codex-chatgpt-project-extension-v20260628-preference-heartbeat-2:runtime-ok"
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.extension.version, "v20260711-router-v2-safety");
    assert.equal(status.extension.needsReload, false);
    assert.equal(status.extension.title, "Current tab");
  });
});

test("diagnostics does not treat a historical failed sync as the active job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const failed = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Historical failed request"
    });
    await failSyncJob(storeRoot, failed.id, { error: "Previous task failed" });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.latestSyncJob.id, failed.id);
    assert.equal(status.latestSyncJob.status, "failed");
    assert.equal(status.activeSyncJob, null);
    assert.equal(status.status.state, "idle");
    assert.equal(status.extension.connected, true);
    assert.equal(status.extension.projectMatches, true);
  });
});

test("diagnostics does not block on a structured failed job after the ChatGPT page is ready", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const failed = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Blocked request"
    });
    await failSyncJob(storeRoot, failed.id, {
      error: "ChatGPT page requires human verification.",
      errorCode: "human_verification",
      recoveryAction: "manual_verification"
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ChatGPT page can receive Bridge messages."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.activeSyncJob, null);
    assert.equal(status.latestSyncJob.errorCode, "human_verification");
    assert.equal(status.extension.pageStatus.code, "ready");
    assert.equal(status.connection.canSendToGpt, true);
    assert.equal(status.workflowStatus.level, "ready");
  });
});

test("diagnostics does not treat unrelated page generation as an active Bridge task", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "working",
          code: "active_generation",
          message: "GPT is still generating a non-Bridge response."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const pageStateCheck = status.connection.checks.find((check) => check.id === "page-state");
    const activeSyncCheck = status.connection.checks.find((check) => check.id === "active-sync");

    assert.equal(status.activeSyncJob, null);
    assert.equal(status.connection.canSendToGpt, true);
    assert.equal(status.workflowStatus.level, "ready");
    assert.equal(pageStateCheck.state, "passed");
    assert.equal(activeSyncCheck.state, "passed");
  });
});

test("diagnostics marks a stale sent sync as retryable instead of active processing", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const job = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Ask GPT to generate a poster."
    });
    await markSyncJobSent(storeRoot, job.id, {
      workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
    const sentJob = JSON.parse(await readFile(jobPath, "utf8"));
    sentJob.sentAt = "2026-06-27T10:00:00.000Z";
    sentJob.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(sentJob, null, 2)}\n`, "utf8");

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ChatGPT page can receive Bridge messages."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const activeSyncCheck = status.connection.checks.find((check) => check.id === "active-sync");

    assert.equal(status.activeSyncJob.id, job.id);
    assert.equal(status.workflowStatus.level, "warning");
    assert.match(status.workflowStatus.title, /capture|reply|捕获|回复/i);
    assert.notEqual(status.workflowStatus.label, "GPT processing");
    assert.equal(activeSyncCheck.state, "warning");
    assert.match(activeSyncCheck.detail, /刷新|重试|卡住|refresh|retry|stuck/i);
    assert.match(status.status.reason, /刷新|重试|卡住|refresh|retry|stuck/i);
  });
});

test("diagnostics short-circuits a sent sync when the GPT page is already ready", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const job = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Ask GPT to create a tiny txt file."
    });
    await markSyncJobSent(storeRoot, job.id, {
      workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
    const sentJob = JSON.parse(await readFile(jobPath, "utf8"));
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    sentJob.sentAt = twoMinutesAgo;
    sentJob.updatedAt = twoMinutesAgo;
    await writeFile(jobPath, `${JSON.stringify(sentJob, null, 2)}\n`, "utf8");

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "GPT page is ready."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const activeSyncCheck = status.connection.checks.find((check) => check.id === "active-sync");

    assert.equal(status.workflowStatus.level, "warning");
    assert.notEqual(status.workflowStatus.title, "GPT \u6b63\u5728\u5904\u7406");
    assert.equal(activeSyncCheck.state, "warning");
    assert.match(status.status.reason, /GPT|retry|refresh|\u91cd\u8bd5|\u5237\u65b0|\u5361/);
  });
});

test("ready-page stale sent sync jobs are retryable from the room timeline", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable pptx.",
        to: ["gpt"]
      })
    });
    const created = await createResponse.json();

    await markSyncJobSent(storeRoot, created.syncJob.id, {
      workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const sentJob = JSON.parse(await readFile(jobPath, "utf8"));
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    sentJob.sentAt = twoMinutesAgo;
    sentJob.updatedAt = twoMinutesAgo;
    await writeFile(jobPath, `${JSON.stringify(sentJob, null, 2)}\n`, "utf8");

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "GPT page is ready."
        }
      })
    });

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    const sourceMessage = room.messages.find((message) => message.id === created.message.id);
    assert.equal(sourceMessage.metadata.syncStatus, "running");
    assert.equal(sourceMessage.metadata.syncCanRetry, true);
    assert.equal(sourceMessage.metadata.syncCanCancel, true);
    assert.match(sourceMessage.metadata.syncReason, /刷新|重试|卡住|GPT/);

    const retryResponse = await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 201);
    const retried = await retryResponse.json();
    assert.equal(retried.retriedSyncJobId, created.syncJob.id);
    assert.equal(retried.syncJob.status, "pending");
    assert.equal(retried.message.metadata.retryOfSyncJobId, created.syncJob.id);
  });
});

test("diagnostics keeps image generation running when the GPT page becomes ready before capture finishes", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const job = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      payloadText: "Generate 3 separate downloadable images about a futuristic AI workspace."
    });
    await markSyncJobSent(storeRoot, job.id, {
      workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${job.id}.json`);
    const sentJob = JSON.parse(await readFile(jobPath, "utf8"));
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    sentJob.sentAt = twoMinutesAgo;
    sentJob.updatedAt = twoMinutesAgo;
    await writeFile(jobPath, `${JSON.stringify(sentJob, null, 2)}\n`, "utf8");

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "GPT page is ready."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    const activeSyncCheck = status.connection.checks.find((check) => check.id === "active-sync");

    assert.equal(status.workflowStatus.level, "working");
    assert.equal(status.workflowStatus.label, "GPT \u5904\u7406\u4e2d");
    assert.equal(activeSyncCheck.state, "working");
    assert.doesNotMatch(status.status.reason, /鍒锋柊|閲嶈瘯|鍗′綇|refresh|retry|stuck/i);
  });
});

test("diagnostics explains when the bound ChatGPT page heartbeat is stale", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });

    const staleHeartbeat = {
      records: [
        {
          href: "https://chatgpt.com/c/bound-chat",
          title: "Bound chat",
          workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
          updatedAt: new Date(Date.now() - 45000).toISOString()
        }
      ]
    };
    await writeFile(
      path.join(storeRoot, "extension", "heartbeat.json"),
      `${JSON.stringify(staleHeartbeat, null, 2)}\n`,
      "utf8"
    );

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.workflowStatus.level, "blocked");
    assert.equal(status.workflowStatus.title, "\u7ed1\u5b9a\u7684 GPT \u9875\u9762\u5df2\u65ad\u5f00");
    assert.equal(status.extension.projectMatches, true);
    assert.equal(status.extension.connected, false);
    assert.equal(status.connection.checks.find((check) => check.id === "extension-connected").state, "blocked");
    const visibleStatus = JSON.stringify(status);
    assert.match(visibleStatus, /\u79d2\u524d|\u5206\u949f\u524d|\u5c0f\u65f6\u524d/);
    assert.match(status.workflowStatus.nextStep, /Bridge \u4e0d\u4f1a\u7ee7\u7eed\u81ea\u52a8\u5237\u65b0/);
    assert.doesNotMatch(visibleStatus, /ERR_BLOCKED_BY_CLIENT/);
    assert.doesNotMatch(visibleStatus, /\b\d+[smh] ago\b|unknown time/);
  });
});

test("diagnostics surfaces blocker state reported by the bound ChatGPT page heartbeat", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        pageStatus: {
          state: "blocked",
          code: "human_verification",
          recoveryAction: "manual_verification",
          message: "ChatGPT page requires human verification."
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.workflowStatus.level, "blocked");
    assert.match(status.workflowStatus.detail, /human verification|\u771f\u4eba\u9a8c\u8bc1/i);
    assert.equal(status.extension.pageStatus.code, "human_verification");
    assert.equal(status.connection.checks.find((check) => check.id === "page-state").state, "blocked");
  });
});

test("diagnostics names client-side GPT blocking instead of generic action required", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        pageStatus: {
          state: "blocked",
          code: "client_blocked",
          recoveryAction: "disable_client_blocker",
          message: "ERR_BLOCKED_BY_CLIENT"
        }
      })
    });

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();
    assert.equal(status.connection.label, "页面被拦截");
    assert.equal(status.workflowStatus.label, "页面被拦截");
    assert.match(status.workflowStatus.detail, /chatgpt\.com/);
    assert.doesNotMatch(JSON.stringify(status), /\u9700\u8981\u5904\u7406.*ERR_BLOCKED_BY_CLIENT/);
  });
});

test("GPT preflight blocks sending when the active ChatGPT page is not the bound conversation", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_other"
      })
    });

    const response = await fetch(`${baseUrl}/api/gpt/preflight`);
    assert.equal(response.status, 200);
    const preflight = await response.json();

    assert.equal(preflight.canSend, false);
    assert.equal(preflight.level, "blocked");
    assert.equal(preflight.action, "open_bound_chat");
    assert.equal(preflight.workflowStatus.level, "blocked");
    assert.match(preflight.message, /\u5f53\u524d GPT \u9875\u9762\u4e0d\u662f\u7ed1\u5b9a\u4f1a\u8bdd|bound/i);
    assert.match(preflight.detail, /chatgpt\.com\/c\/bound-chat/);
  });
});

test("room API refuses GPT sends when the loaded extension version is stale", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260706-bound-cancel:runtime-ok:tab_bound",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ChatGPT page can receive Bridge messages."
        }
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "浣犲ソ",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 409);
    const blocked = await response.json();
    assert.equal(blocked.code, "extension_needs_reload");
    assert.ok(blocked.error);

    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.length, 0);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 0);
  });
});

test("sync retry refuses to create another GPT job when the loaded extension version is stale", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260706-bound-cancel:runtime-ok:tab_bound",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ChatGPT page can receive Bridge messages."
        }
      })
    });

    const originalJob = await createSyncJob(storeRoot, {
      kind: "chat_message",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      targetRepo: "F:/game_code/demo",
      conversationId: "default",
      userText: "浣犲ソ",
      payloadText: "浣犲ソ"
    });
    await failSyncJob(storeRoot, originalJob.id, {
      error: "Previous attempt failed"
    });

    const retryResponse = await fetch(`${baseUrl}/api/sync/jobs/${originalJob.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 409);
    const blocked = await retryResponse.json();
    assert.equal(blocked.code, "extension_needs_reload");

    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.length, 1);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 0);
  });
});

test("GPT preflight allows sending when only ChatGPT preference sync failed", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo",
        modePreference: "advanced",
        modelPreference: "gpt-5.5"
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        pageStatus: {
          state: "ready",
          code: "ready",
          message: "ChatGPT page can receive Bridge messages."
        },
        preferenceStatus: {
          state: "failed",
          modePreference: "advanced",
          modelPreference: "gpt-5.5",
          modeSynced: false,
          modelSynced: true,
          updatedAt: (await (await fetch(`${baseUrl}/api/workspace`)).json()).updatedAt,
          error: "mode preference was not applied"
        }
      })
    });

    const response = await fetch(`${baseUrl}/api/gpt/preflight`);
    assert.equal(response.status, 200);
    const preflight = await response.json();

    assert.equal(preflight.canSend, true);
    assert.equal(preflight.level, "ready");
    assert.equal(preflight.action, "send");
    assert.equal(preflight.workflowStatus.label, "\u540c\u6b65\u5c31\u7eea");
    assert.equal(preflight.connection.label, "\u8fde\u63a5\u5c31\u7eea");
    assert.ok(preflight.connection.warnings.length >= 1);
    assert.ok(preflight.connection.warnings.some((warning) => /\u504f\u597d|preference|\u6a21\u578b|model/i.test(warning)));
  });
});

test("room API auto-routes local execution messages to Codex", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current"
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Check the login module, edit code directly, and run tests"
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(created.syncJob, null);
      assert.equal(created.codexTask.status, "pending");
      assert.equal(created.codexTask.currentThreadId, "thread_current");
      assert.deepEqual(created.message.to, ["codex"]);
      assert.equal(created.message.metadata.routeKind, "codex_only");
      assert.match(created.message.metadata.routeReason, /Codex|local|project/i);
      assert.equal(created.message.metadata.routePolicy.id, "codex_only");
      assert.equal(created.message.metadata.routePolicy.primaryActor, "codex");
      assert.match(created.codexTask.promptText, /login module/i);
    }
  );
});

test("room API auto-routes design-first execution through GPT then Codex", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current"
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Ask GPT to design login page interactions and copy, then let Codex implement it.",
          modePreference: "balanced",
          modelPreference: "gpt-5.5"
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(created.codexTask, null);
      assert.equal(created.syncJob.status, "pending");
      assert.equal(created.syncJob.kind, "user_request");
      assert.match(created.syncJob.payloadText, /\u53ef\u76f4\u63a5\u6d88\u8d39\u7684\u7ed3\u679c/);
      assert.deepEqual(created.message.to, ["gpt"]);
      assert.equal(created.message.metadata.routeKind, "gpt_then_codex");
      assert.match(created.message.metadata.routeReason, /GPT/);
      assert.equal(created.message.metadata.routePolicy.id, "gpt_then_codex");
      assert.equal(created.message.metadata.routePolicy.codexUsesGptResult, true);
    }
  );
});

test("room route preview returns the same automatic target before sending", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/route-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Ask GPT to design login page copy, then let Codex implement it.",
        attachmentCount: 0
      })
    });
    assert.equal(response.status, 200);
    const preview = await response.json();

    assert.equal(preview.kind, "gpt_then_codex");
    assert.deepEqual(preview.targets, ["gpt"]);
    assert.equal(preview.label, "\u5148 GPT\uff0c\u540e Codex");
    assert.equal(preview.willUseGpt, true);
    assert.equal(preview.willUseCodex, true);
    assert.equal(preview.policy.id, "gpt_then_codex");
    assert.equal(preview.policy.codexUsesGptResult, true);
    assert.equal(preview.policy.codexMayReanalyzeGptWork, false);
    assert.deepEqual(
      preview.policy.stages.map((stage) => stage.actor),
      ["gpt", "codex"]
    );
    assert.equal(Object.hasOwn(preview, "gptPayloadText"), false);
    assert.equal(Object.hasOwn(preview, "codexPromptText"), false);
  });
});

test("delegate API keeps Codex-only requests out of the GPT queue", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/delegate/current-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please run npm test locally and do not send this to GPT."
      })
    });
    assert.equal(response.status, 201);
    const delegated = await response.json();

    assert.equal(delegated.action, "codex_only");
    assert.equal(delegated.route.kind, "codex_only");
    assert.equal(delegated.syncJob, null);
    assert.match(delegated.codexPromptText, /npm test/);

    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.length, 0);
  });
});

test("delegate API queues local files from Codex for GPT analysis", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const imagePath = path.join(projectRoot, "desktop-shot.png");
  await writeFile(imagePath, Buffer.from("fake image bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual", currentCodexThreadId: "thread_current" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const response = await fetch(`${baseUrl}/api/delegate/current-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please analyze this image and tell me what it shows.",
        localPath: imagePath,
        contentType: "image/png",
        timeoutMs: 1,
        pollMs: 1
      })
    });
    assert.equal(response.status, 201);
    const delegated = await response.json();

    assert.equal(delegated.action, "gpt_only");
    assert.equal(delegated.route.kind, "gpt_only");
    assert.equal(delegated.artifacts.length, 1);
    assert.equal(delegated.artifacts[0].filename, "desktop-shot.png");
    assert.equal(delegated.syncJob.kind, "codex_file_analysis");
    assert.equal(delegated.syncJob.inputArtifacts[0].filename, "desktop-shot.png");
    assert.equal(delegated.queuedFiles[0].message.metadata.routingKind, "gpt_only");
    assert.equal(delegated.timedOut, false);
    assert.equal(delegated.finalJob, null);

    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, delegated.syncJob.id);
  });
});

test("sync API relays GPT then Codex room results into the current Codex thread", async () => {
  const storeRoot = await tempStore();
  const relayedTasks = [];

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current",
      codexRelay: {
        relayCodexTask: async (task) => {
          relayedTasks.push(task);
          return {
            status: "sent",
            result: { turnId: "turn_handoff" }
          };
        }
      }
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: "F:/game_code/demo"
        })
      });

      const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Ask GPT to design login page copy, then let Codex implement it."
        })
      });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json();
      assert.equal(created.message.metadata.routeKind, "gpt_then_codex");
      assert.equal(created.codexTask, null);

      const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectUrl: "https://chatgpt.com/project/demo/c/abc",
          workerId: "test-extension"
        })
      });
      const claimed = await claimResponse.json();
      assert.equal(claimed.job.id, created.syncJob.id);

      const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replyText: "Use a calm blue primary button, concise Chinese labels, and validate by checking the login route."
        })
      });
      assert.equal(completeResponse.status, 200);
      const completed = await completeResponse.json();

      assert.equal(completed.inboxItem.status, "pending");
      assert.equal(completed.task.status, "pending");
      assert.equal(completed.task.currentThreadId, "thread_current");
      assert.equal(completed.task.targetRepo, "F:/game_code/demo");
      assert.equal(completed.task.sourceMessageId, completed.roomMessage.id);
      assert.match(completed.task.promptText, /GPT \u4e0a\u6e38\u7ed3\u679c/);
      assert.match(completed.task.promptText, /Use a calm blue primary button/);
      assert.match(completed.task.promptText, /\u4e0d\u8981\u91cd\u65b0\u770b\u56fe\u3001\u91cd\u5199\u6587\u6848\u6216\u91cd\u505a\u8bbe\u8ba1\u5224\u65ad/);
      assert.equal(completed.codexRelay.status, "sent");
      assert.equal(relayedTasks.length, 1);
      assert.equal(relayedTasks[0].id, completed.task.id);
    }
  );
});

test("room API preserves Codex-origin metadata for acceptance prompts", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Acceptance test: generate a plain text reply.",
        to: ["gpt"],
        metadata: {
          origin: "acceptance",
          actor: "codex",
          acceptanceCheckId: "text-reply"
        }
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.message.metadata.origin, "acceptance");
    assert.equal(created.message.metadata.actor, "codex");
    assert.equal(created.message.metadata.acceptanceCheckId, "text-reply");
    assert.equal(created.message.metadata.targetRepo, "F:/game_code/demo");
  });
});

test("room API explains when a pending ChatGPT sync has no extension claim for too long", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate a table.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.createdAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();

    assert.equal(room.messages[0].metadata.syncStatus, "pending");
    assert.match(room.messages[0].metadata.syncReason, /\u6269\u5c55\u672a\u8fde\u63a5|\u91cd\u65b0\u52a0\u8f7d Bridge \u6269\u5c55/);
  });
});

test("room API explains when a sent ChatGPT sync has been running too long", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate a downloadable spreadsheet.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "chrome-extension"
      })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.sentAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages[0].metadata.syncStatus, "running");
    assert.equal(room.messages[0].metadata.syncCanRetry, true);
    assert.match(room.messages[0].metadata.syncReason, /GPT/);
    assert.match(room.messages[0].metadata.syncReason, /GPT/);

    const retryResponse = await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 201);
    const retried = await retryResponse.json();
    assert.equal(retried.message.from, "user");
    assert.equal(retried.syncJob.status, "pending");

    const retiredJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(retiredJob.status, "failed");
    assert.match(retiredJob.error, /retried/i);
  });
});

test("sync API lets the user cancel a stuck ChatGPT job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate a downloadable spreadsheet.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });

    const cancelResponse = await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/cancel`, {
      method: "POST"
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json();
    assert.equal(cancelled.job.status, "failed");
    assert.equal(cancelled.job.errorCode, "manual_cancelled");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "ready",
          code: "ready"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery?.action, "stop_generation");
    assert.equal(heartbeat.recovery?.job?.id, created.syncJob.id);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    const original = room.messages.find((message) => message.id === created.message.id);
    assert.equal(original.metadata.syncStatus, "failed");
    assert.equal(original.metadata.syncCanCancel, false);
    assert.match(original.metadata.syncReason, /手动停止|cancel|stop|manual/i);

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
  });
});

test("extension heartbeat stops GPT generation after cancelling an unclaimed Bridge job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please only reply ok.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const cancelResponse = await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/cancel`, {
      method: "POST"
    });
    assert.equal(cancelResponse.status, 200);
    const cancelled = await cancelResponse.json();
    assert.equal(cancelled.job.status, "failed");
    assert.equal(cancelled.job.errorCode, "manual_cancelled");
    assert.equal(cancelled.job.claimedAt, null);
    assert.equal(cancelled.job.sentAt, null);

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "working",
          code: "active_generation"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery?.action, "stop_generation");
    assert.equal(heartbeat.recovery?.job?.id, created.syncJob.id);
  });
});

test("extension heartbeat stops a manually cancelled GPT generation before a queued follow-up", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const firstResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please write a long answer.",
        to: ["gpt"]
      })
    });
    const first = await firstResponse.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });

    await fetch(`${baseUrl}/api/sync/jobs/${first.syncJob.id}/cancel`, {
      method: "POST"
    });

    const secondResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please only reply ok.",
        to: ["gpt"]
      })
    });
    const second = await secondResponse.json();
    assert.equal(second.syncJob.status, "pending");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "working",
          code: "active_generation"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery?.action, "stop_generation");
    assert.equal(heartbeat.recovery?.job?.id, first.syncJob.id);
    assert.equal(heartbeat.recovery?.job?._bridgeRecoveryIssued, undefined);

    const secondHeartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "working",
          code: "active_generation"
        }
      })
    });
    const secondHeartbeat = await secondHeartbeatResponse.json();
    assert.equal(secondHeartbeat.recovery?.action, "stop_generation");
    assert.equal(secondHeartbeat.recovery?.job?.id, first.syncJob.id);
    assert.equal(secondHeartbeat.recovery?.job?._bridgeRecoveryIssued, undefined);
  });
});

test("extension heartbeat can stop orphan GPT generation after a failed Bridge job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please write a very long answer.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });

    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/cancel`, {
      method: "POST"
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    job.updatedAt = fifteenMinutesAgo;
    job.completedAt = fifteenMinutesAgo;
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "working",
          code: "active_generation"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery?.action, "stop_generation");
    assert.equal(heartbeat.recovery?.job?.id, created.syncJob.id);
  });
});

test("extension heartbeat stops orphan generation after missing download capture", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Create a real downloadable PDF named bridge-regression.pdf.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Download bridge-regression.pdf",
        artifacts: [],
        artifactIds: [],
        artifactErrors: [
          {
            code: "missing_download",
            filename: "bridge-regression.pdf",
            error: "Timed out waiting for Chrome download bridge-regression.pdf"
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_bound",
        href: "https://chatgpt.com/project/demo",
        title: "Demo",
        pageStatus: {
          state: "working",
          code: "active_generation"
        }
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery?.action, "stop_generation");
    assert.equal(heartbeat.recovery?.job?.id, created.syncJob.id);
  });
});

test("diagnostics and room messages expose precise GPT sync progress timing", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Ask GPT to reply with one sentence.",
        to: ["gpt"]
      })
    });
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo",
        workerId: "chrome-extension"
      })
    });
    const claimed = await claimResponse.json();
    assert.equal(claimed.job.id, created.syncJob.id);
    assert.ok(claimed.job.claimedAt);

    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "chrome-extension"
      })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.status = "succeeded";
    job.createdAt = "2026-06-27T10:00:00.000Z";
    job.claimedAt = "2026-06-27T10:00:03.000Z";
    job.sentAt = "2026-06-27T10:00:05.000Z";
    job.completedAt = "2026-06-27T10:00:20.000Z";
    job.updatedAt = "2026-06-27T10:00:20.000Z";
    job.replyText = "GPT replied.";
    job.thoughtDurationMs = 12000;
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.latestSyncJob.id, created.syncJob.id);
    assert.equal(status.latestSyncJob.progress.stage, "completed");
    assert.match(status.latestSyncJob.progress.message, /GPT|Bridge/);
    assert.equal(status.latestSyncJob.progress.timeline.createdAt, "2026-06-27T10:00:00.000Z");
    assert.equal(status.latestSyncJob.progress.timeline.claimedAt, "2026-06-27T10:00:03.000Z");
    assert.equal(status.latestSyncJob.progress.timeline.sentAt, "2026-06-27T10:00:05.000Z");
    assert.equal(status.latestSyncJob.progress.timeline.completedAt, "2026-06-27T10:00:20.000Z");
    assert.deepEqual(status.latestSyncJob.progress.durations, {
      queueMs: 3000,
      preSendMs: 2000,
      responseMs: 15000,
      totalMs: 20000,
      gptThoughtMs: 12000
    });

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages[0].metadata.syncProgress.stage, "completed");
    assert.match(room.messages[0].metadata.syncReason, /GPT|Bridge/);
    assert.equal(room.messages[0].metadata.syncDurationTotalMs, 20000);
    assert.equal(room.messages[0].metadata.syncProgress.durations.gptThoughtMs, 12000);
  });
});

test("room API displays the actual Codex-to-GPT sync payload for staged tasks", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/novel",
        conversationId: "novel-room"
      })
    });

    const originalText =
      "I want help with three tasks: outline ten episodes, write chapter one, and make a poster.";
    const stagedPayload = [
      "Please only complete step 1: outline the first ten episodes.",
      "",
      "Requirements:",
      "- Output only the outline, core setting, main characters, and episode summaries.",
      "- Do not write chapter one.",
      "- Do not generate a poster."
    ].join("\n");

    const message = await appendRoomMessage(storeRoot, {
      conversationId: "novel-room",
      from: "codex",
      to: ["gpt"],
      text: originalText,
      metadata: {
        source: "current_codex_thread"
      }
    });
    const job = await createSyncJob(storeRoot, {
      kind: "codex_consultation",
      projectUrl: "https://chatgpt.com/c/bound-chat",
      targetRepo: "F:/game_code/novel",
      conversationId: "novel-room",
      sourceMessageId: message.id,
      userText: originalText,
      payloadText: stagedPayload
    });

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 1);
    assert.equal(room.messages[0].text, stagedPayload);
    assert.equal(room.messages[0].metadata.originalRequestText, originalText);
    assert.equal(room.messages[0].metadata.displayedSyncPayloadText, true);
    assert.equal(room.messages[0].metadata.syncJobId, job.id);
  });
});

test("room API displays the routed first-stage payload for composer sequential creative requests", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/novel",
        conversationId: "novel-room"
      })
    });

    const originalText =
      "I want help writing a fantasy novel: outline the first ten episodes, then chapter one, then a poster.";

    const postResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: originalText,
        to: ["auto"]
      })
    });
    assert.equal(postResponse.status, 201);
    const posted = await postResponse.json();
    assert.match(posted.syncJob.payloadText, /第\s*1\s*步|step 1/i);
    assert.match(posted.syncJob.payloadText, /大纲|前十集|outline|ten episodes/i);
    assert.doesNotMatch(posted.syncJob.payloadText, /poster/i);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 1);
    assert.equal(room.messages[0].text, posted.syncJob.payloadText);
    assert.equal(room.messages[0].metadata.originalRequestText, originalText);
    assert.equal(room.messages[0].metadata.displayedSyncPayloadText, true);
  });
});

test("sync API advances sequential creative chains one GPT stage at a time", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-sequential-chain-"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: projectRoot,
        conversationId: "novel-room"
      })
    });

    const originalText =
      "I want help writing a fantasy novel: outline the first ten episodes, then chapter one, then a poster.";

    const postResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: originalText,
        to: ["auto"]
      })
    });
    assert.equal(postResponse.status, 201);
    const posted = await postResponse.json();
    assert.equal(posted.route.sequentialPlan.stages.length, 3);

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${posted.syncJob.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Outline result: ten episode arc with protagonist, rival, sect conflict, and cliffhangers."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.sequentialContinuationJob.kind, "chat_message");
    assert.match(completed.sequentialContinuationJob.payloadText, /chapter one|\u7b2c\u4e00/i);
    assert.match(completed.sequentialContinuationJob.payloadText, /Outline result/i);
    assert.doesNotMatch(completed.sequentialContinuationJob.payloadText, /poster/i);
    assert.equal(completed.sequentialContinuationMessage.metadata.sequentialStageId, "chapter");
    assert.equal(completed.sequentialContinuationMessage.metadata.sequentialStageIndex, 1);

    const jobs = await listSyncJobs(storeRoot);
    const continuation = jobs.find((job) => job.id === completed.sequentialContinuationJob.id);
    assert.ok(continuation);
    assert.equal(continuation.userText, originalText);
    assert.equal(continuation.sourceMessageId, completed.sequentialContinuationMessage.id);

    const secondCompleteResponse = await fetch(`${baseUrl}/api/sync/jobs/${completed.sequentialContinuationJob.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Chapter one result: the hero awakens in the ruined sect and chooses the forbidden path."
      })
    });
    assert.equal(secondCompleteResponse.status, 200);
    const secondCompleted = await secondCompleteResponse.json();

    assert.equal(secondCompleted.sequentialContinuationJob.kind, "chat_message");
    assert.match(secondCompleted.sequentialContinuationJob.payloadText, /海报|封面|图片|poster|cover|image/i);
    assert.match(secondCompleted.sequentialContinuationJob.payloadText, /Chapter one result/i);
    assert.equal(secondCompleted.sequentialContinuationMessage.metadata.sequentialStageId, "poster");
    assert.equal(secondCompleted.sequentialContinuationMessage.metadata.sequentialStageIndex, 2);
  });
});

test("diagnostics reports extension heartbeat and project page mismatch", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate an xlsx file.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.createdAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260625-clean-capture-6:runtime-ok",
        href: "https://chatgpt.com/c/other-chat",
        title: "Other chat"
      })
    });
    assert.equal(heartbeatResponse.status, 200);
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.preferences, null);
    assert.equal(heartbeat.recovery, null);

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.extension.connected, true);
    assert.equal(status.extension.href, "https://chatgpt.com/c/other-chat");
    assert.equal(status.extension.version, "v20260625-clean-capture-6");
    assert.equal(status.extension.expectedVersion, "v20260711-router-v2-safety");
    assert.equal(status.extension.needsReload, true);
    assert.match(status.extension.sourceDir, /chrome-extension$/);
    assert.match(status.status.reason, /\u4e0d\u662f\u7ed1\u5b9a\u4f1a\u8bdd/);
    assert.match(status.status.reason, /https:\/\/chatgpt\.com\/c\/other-chat/);
  });
});

test("extension heartbeat asks ChatGPT page to reload when a sent sync is stale", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate an xlsx file.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "chrome-extension" })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.sentAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat"
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery.action, "reload");
    assert.equal(heartbeat.recovery.job.id, created.syncJob.id);
    assert.equal(heartbeat.recovery.resendIfPromptMissing, false);
  });
});

test("extension heartbeat asks ChatGPT page to reload when a claimed sync was never sent", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate 10 images.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.claimedAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const heartbeatResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat"
      })
    });
    const heartbeat = await heartbeatResponse.json();
    assert.equal(heartbeat.recovery.action, "reload");
    assert.equal(heartbeat.recovery.job.id, created.syncJob.id);
    assert.equal(heartbeat.recovery.job.sentAt, null);
    assert.equal(heartbeat.recovery.resendIfPromptMissing, true);
  });
});

test("extension heartbeat does not repeatedly reload the same stale sync", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Analyze this image.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "chrome-extension" })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const job = JSON.parse(await readFile(jobPath, "utf8"));
    job.sentAt = "2026-06-27T10:00:00.000Z";
    job.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, "utf8");

    const firstResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat"
      })
    });
    const first = await firstResponse.json();
    assert.equal(first.recovery.action, "reload");

    const secondResponse = await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok",
        href: "https://chatgpt.com/c/bound-chat",
        title: "Bound chat"
      })
    });
    const second = await secondResponse.json();
    assert.equal(second.recovery, null);

    const updatedJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(updatedJob._bridgeRecoveryIssued, true);
  });
});

test("sync claim does not hand a navigation recovery job to the wrong ChatGPT page", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Analyze this local screenshot.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "chrome-extension" })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    storedJob.sentAt = "2026-06-27T10:00:00.000Z";
    storedJob.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(storedJob, null, 2)}\n`, "utf8");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/",
        workerId: "old-extension"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);

    const after = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(after.sentAt, "2026-06-27T10:00:00.000Z");
  });
});

test("sync claim does not give jobs to an explicitly old Bridge extension version", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate an xlsx file.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260628-single-bound-tab-1:runtime-ok"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);
    assert.match(claim.error, /needs reload/);

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(storedJob.status, "pending");
    assert.equal(storedJob.workerId, null);
  });
});

test("sync claim blocks the previous quiet-download extension after final reply guard changes", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please inspect this zip.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260702-quiet-download:runtime-ok"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);
    assert.match(claim.error, /needs reload/);

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(storedJob.status, "pending");
    assert.equal(storedJob.workerId, null);
  });
});

test("sync claim blocks the previous text-artifact extension after thinking label filtering changes", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please design a fantasy novel outline.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260705-text-artifact-fallback:runtime-ok"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);
    assert.match(claim.error, /needs reload/);

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(storedJob.status, "pending");
    assert.equal(storedJob.workerId, null);
  });
});

test("sync claim blocks the previous send-ready-diagnostics extension after quiet resource capture changes", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please inspect this zip quietly.",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260703-send-ready-diagnostics:runtime-ok"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);
    assert.match(claim.error, /needs reload/);

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(storedJob.status, "pending");
    assert.equal(storedJob.workerId, null);
  });
});

test("sync claim blocks previous Bridge extension versions after capture-critical extension updates", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "hello from compatible extension",
        to: ["gpt"]
      })
    });
    assert.equal(response.status, 201);

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "codex-chatgpt-project-extension-v20260702-artifact-upload-raw:runtime-ok"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.job, null);
    assert.equal(claim.resume, false);
    assert.match(claim.error, /needs reload/);
  });
});

test("sync job pre-send refresh endpoint persists refresh attempts before page reload", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "濠电姷鏁搁崑鐘诲箵椤忓棗绶ら柟绋垮閸欏繘鏌熺紒銏犳灈锟?",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const markResponse = await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/pre-send-refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "extension-worker" })
    });
    assert.equal(markResponse.status, 200);
    const marked = await markResponse.json();
    assert.equal(marked.job._bridgePreSendRefresh, true);
    assert.equal(marked.job._bridgeRefreshAttempts, 1);
    assert.equal(marked.job.workerId, "extension-worker");
    assert.ok(marked.job._bridgePreSendRefreshAt);

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "extension-worker"
      })
    });
    const claim = await claimResponse.json();
    assert.equal(claim.job.id, created.syncJob.id);
    assert.equal(claim.job.sentAt, null);
    assert.equal(claim.job._bridgePreSendRefresh, true);
    assert.equal(claim.job._bridgeRefreshAttempts, 1);
  });
});

test("sync claim hands a fresh ready-page job to the extension without a forced pre-send refresh", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "濠电姷鏁搁崑鐘诲箵椤忓棗绶ら柟绋垮閸欏繘鏌熺紒銏犳灈锟?",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const firstClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "extension-worker"
      })
    });
    const firstClaim = await firstClaimResponse.json();
    assert.equal(firstClaim.job.id, created.syncJob.id);
    assert.equal(firstClaim.job.sentAt, null);
    assert.equal(firstClaim.job._bridgeNeedsPreSendRefresh, undefined);
    assert.equal(firstClaim.job._bridgeRefreshAttempts, undefined);

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedAfterFirstClaim = JSON.parse(await readFile(jobPath, "utf8"));
    assert.equal(storedAfterFirstClaim._bridgeNeedsPreSendRefresh, undefined);
    assert.equal(storedAfterFirstClaim._bridgePreSendRefresh, undefined);
    assert.equal(storedAfterFirstClaim._bridgeRefreshAttempts, undefined);

    const secondClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "extension-worker"
      })
    });
    const secondClaim = await secondClaimResponse.json();
    assert.equal(secondClaim.job.id, created.syncJob.id);
    assert.equal(secondClaim.job.sentAt, null);
    assert.equal(secondClaim.job._bridgeNeedsPreSendRefresh, undefined);
    assert.equal(secondClaim.job._bridgePreSendRefresh, undefined);
    assert.equal(secondClaim.job._bridgeRefreshAttempts, undefined);
  });
});

test("sync claim returns a reload recovery job when an old extension resumes a stale sent sync", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a spreadsheet.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: "chrome-extension" })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    storedJob.sentAt = "2026-06-27T10:00:00.000Z";
    storedJob.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(storedJob, null, 2)}\n`, "utf8");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "old-extension"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.resume, false);
    assert.equal(claim.job.id, created.syncJob.id);
    assert.equal(claim.job.sentAt, null);
    assert.equal(claim.job._bridgeRecoveryAction, "reload");
    assert.equal(claim.job._bridgeResendIfPromptMissing, true);
    assert.match(claim.job.projectUrl, /^https:\/\/chatgpt\.com\/c\/bound-chat\?bridge_recover=\d+$/);
  });
});

test("sync claim resumes a stale sent sync for the current extension without resending", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a spreadsheet.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const currentWorkerId = "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok:tab_current";
    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: currentWorkerId
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${created.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: currentWorkerId })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    storedJob.sentAt = "2026-06-27T10:00:00.000Z";
    storedJob.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(storedJob, null, 2)}\n`, "utf8");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: currentWorkerId
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.resume, true);
    assert.equal(claim.job.id, created.syncJob.id);
    assert.equal(claim.job.sentAt, "2026-06-27T10:00:00.000Z");
    assert.equal(claim.job.projectUrl, "https://chatgpt.com/c/bound-chat");
    assert.equal(claim.job._bridgeResendIfPromptMissing, undefined);
  });
});

test("sync claim returns a reload recovery job for a stale claimed-but-unsent sync", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/bound-chat",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate 10 images.",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "chrome-extension"
      })
    });

    const jobPath = path.join(storeRoot, "sync", "jobs", `${created.syncJob.id}.json`);
    const storedJob = JSON.parse(await readFile(jobPath, "utf8"));
    storedJob.claimedAt = "2026-06-27T10:00:00.000Z";
    storedJob.updatedAt = "2026-06-27T10:00:00.000Z";
    await writeFile(jobPath, `${JSON.stringify(storedJob, null, 2)}\n`, "utf8");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/bound-chat",
        workerId: "old-extension"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claim = await claimResponse.json();
    assert.equal(claim.resume, false);
    assert.equal(claim.job.id, created.syncJob.id);
    assert.equal(claim.job.sentAt, null);
    assert.equal(claim.job._bridgeRecoveryAction, "reload");
    assert.equal(claim.job._bridgeResendIfPromptMissing, true);
    assert.match(claim.job.projectUrl, /^https:\/\/chatgpt\.com\/c\/bound-chat\?bridge_recover=\d+$/);
  });
});

test("diagnostics prefers a running sync job over a newer pending job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const firstResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "First job",
        to: ["gpt"]
      })
    });
    const first = await firstResponse.json();
    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/c/demo?mweb_fallback=1",
        workerId: "chrome-extension"
      })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${first.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "chrome-extension",
        previousAssistantText: "old"
      })
    });

    const secondResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Second job",
        to: ["gpt"]
      })
    });
    const second = await secondResponse.json();

    const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    const status = await statusResponse.json();

    assert.equal(status.latestSyncJob.id, second.syncJob.id);
    assert.equal(status.latestSyncJob.status, "pending");
    assert.equal(status.activeSyncJob.id, first.syncJob.id);
    assert.equal(status.status.state, "running");
    assert.match(status.status.reason, /GPT/);
  });
});

test("room API relays Codex-targeted messages into the current Codex thread", async () => {
  const storeRoot = await tempStore();
  const relayedTasks = [];

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current",
      codexRelay: {
        relayCodexTask: async (task) => {
          relayedTasks.push(task);
          return {
            status: "sent",
            result: { turnId: "turn_1" }
          };
        }
      }
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "濠电姷鏁搁崑鐐差焽濞嗘搩鏁勯柛顐犲劜锟?Codex relay",
          to: ["codex"]
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(relayedTasks.length, 1);
      assert.equal(relayedTasks[0].id, created.codexTask.id);
      assert.equal(relayedTasks[0].currentThreadId, "thread_current");
      assert.equal(created.codexRelay.status, "sent");
    }
  );
});

test("room API shows a Codex message when relay fails", async () => {
  const storeRoot = await tempStore();

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current",
      codexRelay: {
        relayCodexTask: async () => {
          throw new Error("thread not loaded");
        }
      }
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetRepo: "F:/game_code/demo"
        })
      });

      const response = await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "濠电姷鏁搁崑鐐差焽濞嗘搩鏁勯柛顐犲劜锟?Codex relay",
          to: ["codex"]
        })
      });
      assert.equal(response.status, 201);
      const created = await response.json();

      assert.equal(created.codexRelay.status, "failed");
      assert.match(created.codexRelay.error, /thread not loaded/);
      assert.equal(created.codexRelayMessage.from, "codex");
      assert.match(created.codexRelayMessage.text, /Codex \u8fde\u63a5\u5931\u8d25/);

      const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
      const room = await roomResponse.json();
      assert.equal(room.messages.length, 2);
      assert.equal(room.messages[1].from, "codex");
    }
  );
});

test("sync API writes ChatGPT replies back into the shared room", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Ask GPT to check this.",
        to: ["gpt"]
      })
    });
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();
    assert.equal(claimed.job.sourceMessageId, created.message.id);

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "GPT replied and suggests continuing validation."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.from, "gpt");
    assert.equal(completed.roomMessage.text, "GPT replied and suggests continuing validation.");

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 2);
    assert.equal(room.messages[1].from, "gpt");
  });
});

test("sync API writes ChatGPT failures back into the shared room", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable image.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const failResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "ChatGPT page requires human verification. Complete verification on the ChatGPT page; Bridge will not bypass it.",
        errorCode: "human_verification",
        recoveryAction: "manual_verification"
      })
    });
    assert.equal(failResponse.status, 200);
    const failed = await failResponse.json();

    assert.equal(failed.job.status, "failed");
    assert.equal(failed.job.errorCode, "human_verification");
    assert.equal(failed.job.recoveryAction, "manual_verification");
    assert.equal(failed.roomMessage.from, "gpt");
    assert.equal(failed.roomMessage.metadata.syncStatus, "failed");
    assert.equal(failed.roomMessage.metadata.syncErrorCode, "human_verification");
    assert.equal(failed.roomMessage.metadata.syncRecoveryAction, "manual_verification");
    assert.match(failed.roomMessage.text, /GPT/);
    assert.match(failed.roomMessage.text, /\u771f\u4eba\u9a8c\u8bc1/);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 2);
    assert.equal(room.messages[1].from, "gpt");
    assert.equal(room.messages[1].metadata.syncStatus, "failed");
    assert.equal(room.messages[0].metadata.syncErrorCode, "human_verification");
    assert.equal(room.messages[0].metadata.syncRecoveryAction, "manual_verification");
    assert.match(room.messages[0].metadata.syncReason, /\u771f\u4eba\u9a8c\u8bc1/);
  });
});

test("sync API can retry a failed ChatGPT room message", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable image.",
        to: ["gpt"],
        modePreference: "balanced",
        modelPreference: "gpt-5.5"
      })
    });
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Timed out waiting for ChatGPT reply"
      })
    });

    const retryResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 201);
    const retried = await retryResponse.json();

    assert.equal(retried.message.from, "user");
    assert.deepEqual(retried.message.to, ["gpt"]);
    assert.equal(retried.message.text, created.message.text);
    assert.equal(retried.message.metadata.retryOfSyncJobId, claimed.job.id);
    assert.equal(retried.syncJob.status, "pending");
    assert.equal(retried.syncJob.payloadText, claimed.job.payloadText);
    assert.equal(retried.syncJob.modePreference, "balanced");
    assert.equal(retried.syncJob.modelPreference, "gpt-5.5");
    assert.equal(retried.syncJob.sourceMessageId, retried.message.id);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 3);
    assert.equal(room.messages[2].metadata.syncStatus, "pending");
  });
});

test("sync failure messages hide raw transport errors from users", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Inspect this zip file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const failedResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to fetch"
      })
    });
    assert.equal(failedResponse.status, 200);
    const failed = await failedResponse.json();

    assert.match(failed.roomMessage.text, /\u9644\u4ef6\u4e0a\u4f20\u5931\u8d25/);
    assert.doesNotMatch(failed.roomMessage.text, /Failed to fetch/);
    assert.doesNotMatch(failed.roomMessage.text, /ChatGPT Project sync failed/);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages[0].metadata.syncStatus, "failed");
    assert.match(room.messages[0].metadata.syncReason, /\u9644\u4ef6\u4e0a\u4f20\u5931\u8d25/);
    assert.doesNotMatch(room.messages[0].metadata.syncReason, /Failed to fetch/);
  });
});

test("sync failure messages explain common ChatGPT page failures in plain language", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    async function failNextMessage(error, errorCode = undefined) {
      await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Ask GPT to test failure handling.",
          to: ["gpt"]
        })
      });

      const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectUrl: "https://chatgpt.com/project/demo/c/abc",
          workerId: "test-extension"
        })
      });
      const claimed = await claimResponse.json();

      const failedResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error, errorCode })
      });
      assert.equal(failedResponse.status, 200);
      return failedResponse.json();
    }

    const stuck = await failNextMessage("Timed out waiting for ChatGPT reply", "reply_timeout");
    assert.ok(stuck.roomMessage.text);
    assert.doesNotMatch(stuck.roomMessage.text, /Timed out/i);

    const stuckByCode = await failNextMessage("ChatGPT did not complete", "reply_timeout");
    assert.match(stuckByCode.roomMessage.text, /GPT \u5361\u4f4f/);
    assert.doesNotMatch(stuckByCode.roomMessage.text, /ChatGPT did not complete/);

    const blocked = await failNextMessage("net::ERR_BLOCKED_BY_CLIENT at chrome-extension://bridge");
    assert.ok(blocked.roomMessage.text);
    assert.equal(blocked.job.errorCode, "client_blocked");
    assert.equal(blocked.job.recoveryAction, "disable_client_blocker");
    assert.match(blocked.roomMessage.text, /GPT \u9875\u9762\u88ab Chrome \u62e6\u622a/);
    assert.doesNotMatch(blocked.roomMessage.text, /ERR_BLOCKED_BY_CLIENT/);
    assert.doesNotMatch(blocked.roomMessage.text, /chrome-extension/);

    const blockedByCode = await failNextMessage("GPT page was blocked by Chrome or another extension.", "client_blocked");
    assert.match(blockedByCode.roomMessage.text, /chatgpt\.com/);
    assert.doesNotMatch(blockedByCode.roomMessage.text, /blocked by Chrome/i);

    const unknown = await failNextMessage("Unexpected low-level stack trace from content script");
    assert.match(unknown.roomMessage.text, /GPT \u540c\u6b65\u5931\u8d25/);
    assert.doesNotMatch(unknown.roomMessage.text, /Unexpected low-level/);
  });
});

test("sync API retries legacy input artifacts through raw upload URLs", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const legacyJob = await createSyncJob(storeRoot, {
      kind: "codex_file_analysis",
      projectUrl: "https://chatgpt.com/project/demo",
      conversationId: "conv_default",
      userText: "Inspect this old task attachment.",
      payloadText: "Inspect this old task attachment.",
      inputArtifacts: [
        {
          id: "artifact_legacy_docx",
          filename: "legacy.docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 123,
          downloadUrl: "/api/artifacts/artifact_legacy_docx/download"
        },
        {
          id: "artifact_legacy_id_only",
          filename: "legacy-id-only.zip",
          contentType: "application/zip",
          sizeBytes: 549
        }
      ]
    });
    const legacyJobPath = path.join(storeRoot, "sync", "jobs", `${legacyJob.id}.json`);
    const oldShapeJob = JSON.parse(await readFile(legacyJobPath, "utf8"));
    oldShapeJob.inputArtifacts = [
      {
        id: "artifact_legacy_docx",
        filename: "legacy.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 123,
        downloadUrl: "/api/artifacts/artifact_legacy_docx/download",
        uploadUrl: ""
      },
      {
        id: "artifact_legacy_id_only",
        filename: "legacy-id-only.zip",
        contentType: "application/zip",
        sizeBytes: 549
      }
    ];
    await writeFile(legacyJobPath, `${JSON.stringify(oldShapeJob, null, 2)}\n`, "utf8");
    await failSyncJob(storeRoot, legacyJob.id, {
      error: "Timed out waiting for ChatGPT reply"
    });

    const retryResponse = await fetch(`${baseUrl}/api/sync/jobs/${legacyJob.id}/retry`, {
      method: "POST"
    });
    assert.equal(retryResponse.status, 201);
    const retried = await retryResponse.json();

    assert.equal(retried.syncJob.inputArtifacts.length, 2);
    assert.equal(retried.syncJob.inputArtifacts[0].downloadUrl, "/api/artifacts/artifact_legacy_docx/download");
    assert.equal(retried.syncJob.inputArtifacts[0].uploadUrl, "/api/artifacts/artifact_legacy_docx/raw");
    assert.equal(retried.syncJob.inputArtifacts[1].downloadUrl, "/api/artifacts/artifact_legacy_id_only/download");
    assert.equal(retried.syncJob.inputArtifacts[1].uploadUrl, "/api/artifacts/artifact_legacy_id_only/raw");
    assert.deepEqual(retried.message.metadata.inputArtifactIds, ["artifact_legacy_docx", "artifact_legacy_id_only"]);
  });
});

test("sync API does not append a failure message for an already completed job", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Say hi.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Hi."
      })
    });

    const failResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "late failure"
      })
    });
    assert.equal(failResponse.status, 200);
    const failed = await failResponse.json();
    assert.equal(failed.job.status, "succeeded");
    assert.equal(failed.roomMessage, null);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages.length, 2);
    assert.equal(room.messages[1].text, "Hi.");
  });
});

test("sync API stores ChatGPT downloadable artifacts and exposes them by id", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable report.txt file.",
        to: ["gpt"]
      })
    });
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Here is report.txt.",
        artifacts: [
          {
            filename: "report.txt",
            contentType: "text/plain",
            originalUrl: "blob:https://chatgpt.com/report",
            base64Data: Buffer.from("report from gpt", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.artifacts.length, 1);
    assert.equal(completed.artifacts[0].filename, "report.txt");
    assert.deepEqual(completed.job.artifactIds, [completed.artifacts[0].id]);
    assert.deepEqual(completed.roomMessage.metadata.artifactIds, [completed.artifacts[0].id]);
    assert.equal(completed.roomMessage.metadata.sourceMessageId, created.message.id);

    const artifactResponse = await fetch(`${baseUrl}/api/artifacts/${completed.artifacts[0].id}`);
    assert.equal(artifactResponse.status, 200);
    const artifact = await artifactResponse.json();
    assert.equal(artifact.filename, "report.txt");

    const downloadResponse = await fetch(`${baseUrl}/api/artifacts/${completed.artifacts[0].id}/download`);
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "report from gpt");

    const viewResponse = await fetch(`${baseUrl}/api/artifacts/${completed.artifacts[0].id}/view`);
    assert.equal(viewResponse.status, 200);
    assert.match(viewResponse.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(await viewResponse.text(), "report from gpt");
  });
});

test("sync API hides internal no-reply placeholder when a file artifact was captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable report.txt file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "GPT did not return a usable reply.",
        artifacts: [
          {
            filename: "report.txt",
            contentType: "text/plain",
            originalUrl: "blob:https://chatgpt.com/report",
            base64Data: Buffer.from("report from gpt", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.text, "\u5df2\u6355\u83b7 1 \u4e2a\u6587\u4ef6");
    assert.doesNotMatch(completed.roomMessage.text, /usable reply/i);
  });
});

test("sync API treats captured image artifacts as final output and saves them into the bound project", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-project-artifacts-"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const createResponse = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "\u8bf7\u751f\u6210\u4e00\u5f20\u5c0f\u8bf4\u6d77\u62a5\u3002",
        to: ["gpt"]
      })
    });
    const created = await createResponse.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText:
          "ChatGPT \u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u8bf7\u6c42\uff0cBridge \u6ca1\u6709\u62ff\u5230\u6700\u7ec8\u53ef\u7528\u56de\u590d\u3002",
        artifacts: [
          {
            filename: "novel-poster.png",
            contentType: "image/png",
            originalUrl: "blob:https://chatgpt.com/image",
            base64Data: Buffer.from("poster bytes", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.metadata.sourceMessageId, created.message.id);
    assert.equal(completed.roomMessage.text, "\u5df2\u6355\u83b7 1 \u5f20\u56fe\u7247");
    assert.doesNotMatch(completed.roomMessage.text, /\u8fd8\u5728\u5904\u7406|\u6700\u7ec8\u53ef\u7528/);
    assert.equal(completed.roomMessage.metadata.projectArtifacts.length, 1);
    assert.equal(completed.job.projectArtifacts.length, 1);
    assert.match(completed.job.projectArtifacts[0].relativePath, /chatgpt-artifacts[\\/]novel-poster\.png$/);
    assert.equal(await readFile(completed.job.projectArtifacts[0].savedPath, "utf8"), "poster bytes");

    const listedResponse = await fetch(`${baseUrl}/api/artifacts?syncJobId=${encodeURIComponent(claimed.job.id)}`);
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.equal(listed.artifacts.length, 1);
    assert.equal(listed.artifacts[0].projectSavedPath, completed.job.projectArtifacts[0].savedPath);
    assert.equal(listed.artifacts[0].projectRelativePath, completed.job.projectArtifacts[0].relativePath);
    assert.equal(listed.artifacts[0].projectRoot, projectRoot);

    const singleResponse = await fetch(`${baseUrl}/api/artifacts/${encodeURIComponent(listed.artifacts[0].id)}`);
    assert.equal(singleResponse.status, 200);
    const single = await singleResponse.json();
    assert.equal(single.projectSavedPath, completed.job.projectArtifacts[0].savedPath);
  });
});

test("artifact download supports non-ASCII filenames", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const importResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "PPT\u8bfe\u4ef6.md",
        contentType: "text/markdown",
        base64Data: Buffer.from("sample markdown content", "utf8").toString("base64")
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();

    const downloadResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/download`);
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "sample markdown content");
    const disposition = downloadResponse.headers.get("content-disposition") || "";
    assert.match(disposition, /^attachment;/);
    assert.match(disposition, /filename="PPT_+\.md"/);
    assert.match(disposition, /filename\*=UTF-8''.*\.md/);

    const viewResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/view`);
    assert.equal(viewResponse.status, 200);
    assert.equal(await viewResponse.text(), "sample markdown content");
    assert.match(viewResponse.headers.get("content-disposition") || "", /^inline;/);
  });
});

test("product artifact APIs expose diagnostics, preview, save and Codex analysis actions", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-project-"));
  let saveAsArtifact = null;

  await withServer(
    {
      storeRoot,
      runnerMode: "manual",
      currentCodexThreadId: "thread_current",
      saveArtifactAs: async (artifact) => {
        saveAsArtifact = artifact;
        return {
          saved: true,
          path: path.join(projectRoot, "chosen-notes.txt"),
          filename: "chosen-notes.txt"
        };
      }
    },
    async (baseUrl) => {
      await fetch(`${baseUrl}/api/workspace`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatgptProjectUrl: "https://chatgpt.com/project/demo",
          targetRepo: projectRoot
        })
      });

      await fetch(`${baseUrl}/api/room/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Generate a downloadable notes.txt file.",
          to: ["gpt"]
        })
      });

      const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectUrl: "https://chatgpt.com/project/demo/c/abc",
          workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
        })
      });
      const claimed = await claimResponse.json();

      await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/sent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
        })
      });

      const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replyText: "Here is notes.txt.",
          artifacts: [
            {
              filename: "notes.txt",
              contentType: "text/plain",
              originalUrl: "blob:https://chatgpt.com/notes",
              base64Data: Buffer.from("notes from gpt", "utf8").toString("base64")
            }
          ]
        })
      });
      const completed = await completeResponse.json();
      const artifactId = completed.artifacts[0].id;

      const listResponse = await fetch(`${baseUrl}/api/artifacts`);
      const listed = await listResponse.json();
      assert.equal(listed.artifacts[0].id, artifactId);
      assert.equal(listed.artifacts[0].filename, "notes.txt");

      const textResponse = await fetch(`${baseUrl}/api/artifacts/${artifactId}/text?maxChars=20`);
      assert.equal(textResponse.status, 200);
      const preview = await textResponse.json();
      assert.equal(preview.text, "notes from gpt");

      const saveResponse = await fetch(`${baseUrl}/api/artifacts/${artifactId}/save-to-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      assert.equal(saveResponse.status, 200);
      const saved = await saveResponse.json();
      assert.equal(await readFile(saved.savedPath, "utf8"), "notes from gpt");
      assert.match(saved.savedPath, /chatgpt-artifacts[\\/]notes\.txt$/);

      const saveAsResponse = await fetch(`${baseUrl}/api/artifacts/${artifactId}/save-as`, {
        method: "POST"
      });
      assert.equal(saveAsResponse.status, 200);
      const saveAs = await saveAsResponse.json();
      assert.deepEqual(saveAs, {
        saved: true,
        path: path.join(projectRoot, "chosen-notes.txt"),
        filename: "chosen-notes.txt"
      });
      assert.equal(saveAsArtifact.id, artifactId);
      assert.equal(saveAsArtifact.filename, "notes.txt");

      const analyzeResponse = await fetch(`${baseUrl}/api/artifacts/${artifactId}/analyze-with-codex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: "Summarize this file for the user."
        })
      });
      assert.equal(analyzeResponse.status, 201);
      const analysis = await analyzeResponse.json();
      assert.equal(analysis.codexTask.currentThreadId, "thread_current");
      assert.match(analysis.codexTask.promptText, /notes\.txt/);
      assert.match(analysis.codexTask.promptText, /Summarize this file/);

      const statusResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      assert.equal(status.workspace.targetRepo, projectRoot);
      assert.equal(status.latestSyncJob.id, claimed.job.id);
      assert.equal(status.latestSyncJob.status, "succeeded");
      assert.equal(status.extension.workerId, "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok");
      assert.equal(status.extension.version, "v20260711-router-v2-safety");
      assert.equal(status.artifactCount, 1);
    }
  );
});

test("artifact preview API summarizes spreadsheets and presentations for GPT-like cards", async () => {
  const storeRoot = await tempStore();
  const xlsx = zipBuffer({
    "xl/sharedStrings.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<sst>",
      "<si><t>number</t></si>",
      "<si><t>joke</t></si>",
      "<si><t>teacher joke</t></si>",
      "<si><t>late joke</t></si>",
      "</sst>"
    ].join(""),
    "xl/worksheets/sheet1.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<x:worksheet xmlns:x=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><x:sheetData>",
      "<x:row r=\"1\"><x:c r=\"A1\" t=\"s\"><x:v>0</x:v></x:c><x:c r=\"B1\" t=\"s\"><x:v>1</x:v></x:c></x:row>",
      "<x:row r=\"2\"><x:c r=\"A2\"><x:v>1</x:v></x:c><x:c r=\"B2\" t=\"s\"><x:v>2</x:v></x:c></x:row>",
      "<x:row r=\"3\"><x:c r=\"A3\"><x:v>2</x:v></x:c><x:c r=\"B3\" t=\"s\"><x:v>3</x:v></x:c></x:row>",
      "</x:sheetData></x:worksheet>"
    ].join("")
  });
  const pptx = zipBuffer({
    "ppt/slides/slide1.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<p:sld><p:cSld><p:spTree>",
      "<a:t>Bridge Food Preview</a:t><a:t>Hot pot, sushi, and grilled fish.</a:t>",
      "</p:spTree></p:cSld></p:sld>"
    ].join(""),
    "ppt/slides/slide2.xml": [
      "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<p:sld><p:cSld><p:spTree>",
      "<a:t>Hot Pot</a:t><a:t>Warm soup for friends.</a:t>",
      "</p:spTree></p:cSld></p:sld>"
    ].join("")
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const xlsxImport = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "jokes.xlsx",
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        base64Data: xlsx.toString("base64")
      })
    });
    const xlsxArtifact = await xlsxImport.json();

    const sheetResponse = await fetch(`${baseUrl}/api/artifacts/${xlsxArtifact.artifact.id}/preview`);
    assert.equal(sheetResponse.status, 200);
    const sheetPreview = await sheetResponse.json();
    assert.equal(sheetPreview.kind, "spreadsheet");
    assert.deepEqual(sheetPreview.preview.rows[0], ["number", "joke"]);
    assert.deepEqual(sheetPreview.preview.rows[1], ["1", "teacher joke"]);
    assert.equal(sheetPreview.preview.rowCount, 3);

    const pptxImport = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "food-mini.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        base64Data: pptx.toString("base64")
      })
    });
    const pptxArtifact = await pptxImport.json();

    const deckResponse = await fetch(`${baseUrl}/api/artifacts/${pptxArtifact.artifact.id}/preview`);
    assert.equal(deckResponse.status, 200);
    const deckPreview = await deckResponse.json();
    assert.equal(deckPreview.kind, "presentation");
    assert.equal(deckPreview.preview.slideCount, 2);
    assert.equal(deckPreview.preview.slides[0].title, "Bridge Food Preview");
    assert.match(deckPreview.preview.slides[1].body, /Warm soup/);
  });
});

test("artifact preview API returns full document previews when requested", async () => {
  const storeRoot = await tempStore();
  const paragraphs = Array.from(
    { length: 30 },
    (_, index) => `<w:p><w:r><w:t>HTTP paragraph ${index + 1}</w:t></w:r></w:p>`
  );
  const docx = zipBuffer({
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>${paragraphs.join("")}</w:body></w:document>`
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const importResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "long-http-doc.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        base64Data: docx.toString("base64")
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();

    const compactResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/preview`);
    assert.equal(compactResponse.status, 200);
    const compact = await compactResponse.json();
    assert.equal(compact.preview.paragraphs.length, 12);
    assert.equal(compact.preview.truncated, true);

    const fullResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/preview?full=1`);
    assert.equal(fullResponse.status, 200);
    const full = await fullResponse.json();
    assert.equal(full.preview.paragraphs.length, 30);
    assert.equal(full.preview.truncated, false);
    assert.equal(full.preview.paragraphs.at(-1), "HTTP paragraph 30");
  });
});

test("artifact APIs import local Codex files and queue them for GPT analysis", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-codex-file-"));
  const sourcePath = path.join(projectRoot, "codex-notes.txt");
  await writeFile(sourcePath, "notes created by Codex", "utf8");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const importResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain"
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();
    assert.equal(imported.artifact.filename, "codex-notes.txt");
    assert.ok(imported.artifact.conversationId);

    const analyzeResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/analyze-with-gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        note: "Please judge whether this Codex-generated note is clear."
      })
    });
    assert.equal(analyzeResponse.status, 201);
    const queued = await analyzeResponse.json();
    assert.equal(queued.syncJob.kind, "codex_file_analysis");
    assert.equal(queued.syncJob.projectUrl, "https://chatgpt.com/project/demo");
    assert.equal(queued.syncJob.conversationId, imported.artifact.conversationId);
    assert.match(queued.syncJob.payloadText, /codex-notes\.txt/);
    assert.match(queued.syncJob.payloadText, /Codex-generated note/);
    assert.equal(queued.syncJob.inputArtifacts.length, 1);
    assert.equal(queued.syncJob.inputArtifacts[0].id, imported.artifact.id);
    assert.equal(queued.syncJob.inputArtifacts[0].filename, "codex-notes.txt");
    assert.equal(queued.syncJob.inputArtifacts[0].downloadUrl, `/api/artifacts/${imported.artifact.id}/download`);
    assert.equal(queued.syncJob.inputArtifacts[0].uploadUrl, `/api/artifacts/${imported.artifact.id}/raw`);
    assert.ok(queued.syncJob.payloadText.includes("codex-notes.txt"));
    assert.ok(queued.syncJob.payloadText.includes("Codex-generated note"));
    assert.equal(queued.message.from, "user");
    assert.deepEqual(queued.message.to, ["gpt"]);

    const rawResponse = await fetch(`${baseUrl}${queued.syncJob.inputArtifacts[0].uploadUrl}`);
    assert.equal(rawResponse.status, 200);
    assert.equal(await rawResponse.text(), "notes created by Codex");
    assert.equal(rawResponse.headers.get("content-disposition"), null);

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "chrome-extension"
      })
    });
    const claimed = await claimResponse.json();
    assert.equal(claimed.job.id, queued.syncJob.id);
    assert.equal(claimed.job.inputArtifacts[0].filename, "codex-notes.txt");
  });
});

test("common local file types queue to GPT with separated raw upload and browser download URLs", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-common-files-"));
  const files = [
    { filename: "sample.png", contentType: "image/png", data: Buffer.from("png bytes") },
    { filename: "sample.jpg", contentType: "image/jpeg", data: Buffer.from("jpg bytes") },
    { filename: "sample.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4\nBridge PDF\n") },
    {
      filename: "sample.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: zipBuffer({ "word/document.xml": "<w:document><w:t>Bridge docx</w:t></w:document>" })
    },
    {
      filename: "sample.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: zipBuffer({ "xl/worksheets/sheet1.xml": "<worksheet><sheetData /></worksheet>" })
    },
    {
      filename: "sample.pptx",
      contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      data: zipBuffer({ "ppt/slides/slide1.xml": "<p:sld><a:t>Bridge deck</a:t></p:sld>" })
    },
    { filename: "sample.zip", contentType: "application/zip", data: zipBuffer({ "readme.txt": "Bridge zip" }) },
    { filename: "sample.txt", contentType: "text/plain", data: Buffer.from("Bridge plain text", "utf8") },
    { filename: "sample.md", contentType: "text/markdown", data: Buffer.from("# Bridge markdown\n", "utf8") },
    { filename: "sample.json", contentType: "application/json", data: Buffer.from('{"bridge":true}', "utf8") }
  ];

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/common-files",
        targetRepo: projectRoot
      })
    });

    for (const file of files) {
      const localPath = path.join(projectRoot, file.filename);
      await writeFile(localPath, file.data);

      const importResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          localPath,
          contentType: file.contentType
        })
      });
      assert.equal(importResponse.status, 201);
      const imported = await importResponse.json();

      const analyzeResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/analyze-with-gpt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          note: `闂佽崵濮村ú銈夊床閺屻儱鍨傞幖娣妼锟?${file.filename}`
        })
      });
      assert.equal(analyzeResponse.status, 201);
      const queued = await analyzeResponse.json();
      const [inputArtifact] = queued.syncJob.inputArtifacts;
      assert.equal(inputArtifact.filename, file.filename);
      assert.equal(inputArtifact.contentType, file.contentType);
      assert.equal(inputArtifact.downloadUrl, `/api/artifacts/${imported.artifact.id}/download`);
      assert.equal(inputArtifact.uploadUrl, `/api/artifacts/${imported.artifact.id}/raw`);

      const rawResponse = await fetch(`${baseUrl}${inputArtifact.uploadUrl}`);
      assert.equal(rawResponse.status, 200);
      assert.equal(rawResponse.headers.get("content-disposition"), null);
      assert.deepEqual(Buffer.from(await rawResponse.arrayBuffer()), file.data);

      const downloadResponse = await fetch(`${baseUrl}${inputArtifact.downloadUrl}`);
      assert.equal(downloadResponse.status, 200);
      assert.match(downloadResponse.headers.get("content-disposition") || "", /attachment/);
      assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), file.data);
    }
  });
});

test("local file API sends a machine file directly to GPT analysis", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-file-"));
  const sourcePath = path.join(projectRoot, "screen-note.txt");
  await writeFile(sourcePath, "local file dropped to Codex", "utf8");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const analyzeResponse = await fetch(`${baseUrl}/api/local-files/analyze-with-gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain",
        note: "Please extract key information from this local file."
      })
    });
    assert.equal(analyzeResponse.status, 201);
    const queued = await analyzeResponse.json();
    assert.equal(queued.artifact.filename, "screen-note.txt");
    assert.equal(await readFile(queued.artifact.filePath, "utf8"), "local file dropped to Codex");
    assert.equal(queued.syncJob.kind, "codex_file_analysis");
    assert.equal(queued.syncJob.inputArtifacts[0].id, queued.artifact.id);
    assert.equal(queued.syncJob.inputArtifacts[0].uploadUrl, `/api/artifacts/${queued.artifact.id}/raw`);
    assert.match(queued.syncJob.payloadText, /screen-note\.txt/);
    assert.match(queued.syncJob.payloadText, /local file/);
    assert.equal(queued.message.from, "user");
    assert.deepEqual(queued.message.to, ["gpt"]);

    const pendingRoomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const pendingRoom = await pendingRoomResponse.json();
    const pendingMessage = pendingRoom.messages.find((message) => message.id === queued.message.id);
    assert.equal(pendingMessage.metadata.syncInputArtifactCount, 1);
    assert.deepEqual(pendingMessage.metadata.syncInputArtifactNames, ["screen-note.txt"]);
    assert.equal(pendingMessage.metadata.syncInputArtifactStatus, "pending");
    assert.match(pendingMessage.metadata.syncReason, /GPT/);

    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "chrome-extension"
      })
    });
    const runningRoomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const runningRoom = await runningRoomResponse.json();
    const runningMessage = runningRoom.messages.find((message) => message.id === queued.message.id);
    assert.equal(runningMessage.metadata.syncInputArtifactStatus, "uploading");
    assert.equal(runningMessage.metadata.syncReason, "\u6b63\u5728\u628a 1 \u4e2a\u9644\u4ef6 \u4ea4\u7ed9 GPT");

    await fetch(`${baseUrl}/api/sync/jobs/${queued.syncJob.id}/sent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "chrome-extension",
        previousAssistantText: ""
      })
    });
    const sentRoomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const sentRoom = await sentRoomResponse.json();
    const sentMessage = sentRoom.messages.find((message) => message.id === queued.message.id);
    assert.equal(sentMessage.metadata.syncInputArtifactStatus, "uploaded");
    assert.equal(sentMessage.metadata.syncReason, "GPT \u5df2\u63a5\u6536 1 \u4e2a\u9644\u4ef6\uff0c\u7b49\u5f85\u5206\u6790\u7ed3\u679c");

    const codexAnalyzeResponse = await fetch(`${baseUrl}/api/local-files/analyze-with-gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain",
        note: "Please inspect this screenshot for the user.",
        from: "codex"
      })
    });
    assert.equal(codexAnalyzeResponse.status, 201);
    const codexQueued = await codexAnalyzeResponse.json();
    assert.equal(codexQueued.message.from, "codex");
    assert.deepEqual(codexQueued.message.to, ["gpt"]);
    assert.equal(codexQueued.message.metadata.initiatedBy, "codex");
  });
});

test("local file wait API returns the ChatGPT reply without external polling", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-wait-"));
  const sourcePath = path.join(projectRoot, "screen.png");
  await writeFile(sourcePath, Buffer.from("fake screenshot bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const pending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "image/png",
        note: "Please identify this screenshot.",
        from: "codex",
        timeoutMs: 1000,
        pollMs: 10
      })
    });

    let job;
    for (let index = 0; index < 20 && !job; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      job = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(job);
    await completeSyncJob(storeRoot, job.id, {
      replyText: "#### ChatGPT says:\n\nGPT says this is a desktop shortcut."
    });

    const response = await pending;
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.syncJob.id, job.id);
    assert.equal(result.finalJob.status, "succeeded");
    assert.equal(result.timedOut, false);
    assert.equal(result.replyText, "GPT says this is a desktop shortcut.");

    const jobResponse = await fetch(`${baseUrl}/api/sync/jobs/${encodeURIComponent(job.id)}`);
    assert.equal(jobResponse.status, 200);
    const fetched = await jobResponse.json();
    assert.equal(fetched.job.id, job.id);
    assert.equal(fetched.job.replyText, "#### ChatGPT says:\n\nGPT says this is a desktop shortcut.");
  });
});

test("local file analysis does not treat the uploaded input file as a missing generated download", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-input-artifact-"));
  const sourcePath = path.join(projectRoot, "screen.png");
  await writeFile(sourcePath, Buffer.from("fake screenshot bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const pending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "image/png",
        note: "Please identify this screenshot. Do not generate a file.",
        from: "codex",
        timeoutMs: 1000,
        pollMs: 10
      })
    });

    let job;
    for (let index = 0; index < 20 && !job; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      job = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(job);
    await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "This is a desktop shortcut icon."
      })
    });
    assert.equal(completeResponse.status, 200);

    const response = await pending;
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.finalJob.status, "succeeded");
    assert.deepEqual(result.finalJob.artifactErrors, []);
    assert.equal(result.replyText, "This is a desktop shortcut icon.");
  });
});

test("local file wait API does not return interim ChatGPT analysis text as usable output", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-interim-"));
  const sourcePath = path.join(projectRoot, "archive.zip");
  await writeFile(sourcePath, Buffer.from("fake zip bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const pending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "application/zip",
        note: "Please identify this file.",
        from: "codex",
        timeoutMs: 1000,
        pollMs: 10
      })
    });

    let job;
    for (let index = 0; index < 20 && !job; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      job = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(job);
    await completeSyncJob(storeRoot, job.id, {
      replyText: "#### ChatGPT says:\n\nReading file-related skill notes"
    });

    const response = await pending;
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.finalJob.status, "succeeded");
    assert.equal(result.timedOut, false);
    assert.match(result.replyText, /\u8fd8\u5728\u5904\u7406\u8fd9\u6b21\u6587\u4ef6\u5206\u6790|final usable reply/i);
    assert.doesNotMatch(result.replyText, /Reading file-related skill notes|Check ZIP file path and details/);
  });
});

test("local file wait API accepts a sent GPT reply during timeout grace", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-timeout-grace-"));
  const sourcePath = path.join(projectRoot, "slow-archive.zip");
  await writeFile(sourcePath, Buffer.from("fake slow zip bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const pending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "application/zip",
        note: "Please identify this file.",
        from: "codex",
        timeoutMs: 80,
        timeoutGraceMs: 300,
        pollMs: 10
      })
    });

    let job;
    for (let index = 0; index < 20 && !job; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      job = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(job);
    await markSyncJobSent(storeRoot, job.id, {
      workerId: "chrome-extension"
    });

    const lateComplete = new Promise((resolve, reject) => {
      setTimeout(() => {
        completeSyncJob(storeRoot, job.id, {
          replyText: "This ZIP contains one installer script."
        }).then(resolve, reject);
      }, 140);
    });

    const response = await pending;
    await lateComplete;
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.finalJob.status, "succeeded");
    assert.equal(result.timedOut, false);
    assert.equal(result.replyText, "This ZIP contains one installer script.");
  });
});

test("local file wait API accepts a queued GPT reply during timeout grace", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-queue-grace-"));
  const sourcePath = path.join(projectRoot, "queued.pdf");
  await writeFile(sourcePath, Buffer.from("fake queued pdf bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const pending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "application/pdf",
        note: "Please identify this file.",
        from: "codex",
        timeoutMs: 30,
        timeoutGraceMs: 300,
        pollMs: 10
      })
    });

    let job;
    for (let index = 0; index < 20 && !job; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      job = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!job) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(job);

    const lateComplete = new Promise((resolve, reject) => {
      setTimeout(async () => {
        try {
          await markSyncJobSent(storeRoot, job.id, {
            workerId: "chrome-extension"
          });
          await completeSyncJob(storeRoot, job.id, {
            replyText: "This PDF contains one test page."
          });
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 80);
    });

    const response = await pending;
    await lateComplete;
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.finalJob.status, "succeeded");
    assert.equal(result.timedOut, false);
    assert.equal(result.replyText, "This PDF contains one test page.");
  });
});

test("local file wait API fails timed out jobs so they do not block the room", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-direct-timeout-"));
  const sourcePath = path.join(projectRoot, "stuck-note.txt");
  await writeFile(sourcePath, "stuck attachment", "utf8");

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const response = await fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "text/plain",
        note: "Please identify this file.",
        from: "codex",
        timeoutMs: 1,
        pollMs: 1
      })
    });

    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.timedOut, true);
    assert.equal(result.finalJob.status, "failed");
    assert.equal(result.finalJob.errorCode, "reply_timeout");

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "chrome-extension"
      })
    });
    assert.equal(claimResponse.status, 200);
    const claimResult = await claimResponse.json();
    assert.equal(claimResult.job, null);
  });
});

test("local file wait API reuses a successful GPT analysis for the same file", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-http-cache-file-"));
  const sourcePath = path.join(projectRoot, "same-screen.png");
  await writeFile(sourcePath, Buffer.from("same screenshot bytes", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: projectRoot
      })
    });

    const firstPending = fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "image/png",
        note: "Please identify this screenshot.",
        from: "codex",
        timeoutMs: 1000,
        pollMs: 10
      })
    });

    let firstJob;
    for (let index = 0; index < 20 && !firstJob; index += 1) {
      const jobs = await listSyncJobs(storeRoot);
      firstJob = jobs.find((candidate) => candidate.kind === "codex_file_analysis");
      if (!firstJob) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    assert.ok(firstJob);
    await completeSyncJob(storeRoot, firstJob.id, {
      replyText: "GPT cached result: same screenshot."
    });

    const firstResponse = await firstPending;
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json();
    assert.equal(first.replyText, "GPT cached result: same screenshot.");

    const secondResponse = await fetch(`${baseUrl}/api/local-files/analyze-with-gpt-and-wait`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        localPath: sourcePath,
        contentType: "image/png",
        note: "Please identify this screenshot.",
        from: "codex",
        timeoutMs: 1000,
        pollMs: 10
      })
    });

    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json();
    const jobs = await listSyncJobs(storeRoot);
    const fileAnalysisJobs = jobs.filter((candidate) => candidate.kind === "codex_file_analysis");
    assert.equal(fileAnalysisJobs.length, 1);
    assert.equal(second.cached, true);
    assert.equal(second.reusedSyncJobId, firstJob.id);
    assert.equal(second.replyText, "GPT cached result: same screenshot.");

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    const cachedMessage = room.messages.find((message) => message.id === second.message.id);
    assert.equal(cachedMessage.metadata.syncStatus, "succeeded");
    assert.equal(cachedMessage.metadata.syncReason, "\u5df2\u590d\u7528 GPT \u5df2\u6709\u5206\u6790\u7ed3\u679c");
    assert.equal(cachedMessage.metadata.syncJobId, firstJob.id);
  });
});

test("download import API attaches a completed Chrome download to a sync job", async () => {
  const storeRoot = await tempStore();
  const downloadDir = await mkdtemp(path.join(tmpdir(), "bridge-http-download-"));
  const downloadedPath = path.join(downloadDir, "slides.pptx");
  await writeFile(downloadedPath, Buffer.from("pptx from chatgpt", "utf8"));

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable PPT file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const importResponse = await fetch(`${baseUrl}/api/downloads/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncJobId: claimed.job.id,
        localPath: downloadedPath,
        filename: "slides.pptx",
        contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        originalUrl: "blob:https://chatgpt.com/slides"
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();
    assert.equal(imported.artifact.filename, "slides.pptx");

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Here is slides.pptx.",
        artifactIds: [imported.artifact.id]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.deepEqual(completed.job.artifactIds, [imported.artifact.id]);
    assert.deepEqual(completed.roomMessage.metadata.artifactIds, [imported.artifact.id]);

    const downloadResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/download`);
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "pptx from chatgpt");
  });
});

test("download import API can attach base64 content fetched by the extension", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable ZIP file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const importResponse = await fetch(`${baseUrl}/api/downloads/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncJobId: claimed.job.id,
        filename: "multi-image-live-v3-icons.zip",
        contentType: "application/zip",
        originalUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_123",
        base64Data: Buffer.from("zip bytes from extension", "utf8").toString("base64")
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();
    assert.equal(imported.artifact.filename, "multi-image-live-v3-icons.zip");

    const downloadResponse = await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/download`);
    assert.equal(downloadResponse.status, 200);
    assert.equal(await downloadResponse.text(), "zip bytes from extension");
  });
});

test("sync API suppresses zip-internal artifact errors when the zip artifact was captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate bridge-regression-small.zip containing ok.txt.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const importResponse = await fetch(`${baseUrl}/api/downloads/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncJobId: claimed.job.id,
        filename: "bridge-regression-small.zip",
        contentType: "application/zip",
        originalUrl: "https://chatgpt.com/backend-api/estuary/content?id=file_zip",
        base64Data: zipBuffer({ "ok.txt": "bridge zip artifact ok" }).toString("base64")
      })
    });
    assert.equal(importResponse.status, 201);
    const imported = await importResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated file.",
        artifactIds: [imported.artifact.id],
        artifactErrors: [
          {
            filename: "ok.txt",
            originalUrl: null,
            error: "Timed out waiting for Chrome download ok.txt"
          },
          {
            filename: "ok.txt",
            originalUrl: null,
            error: "Timed out waiting for Chrome download ok.txt"
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "succeeded");
    assert.deepEqual(completed.job.artifactIds, [imported.artifact.id]);
    assert.deepEqual(completed.job.artifactErrors, []);
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, []);
  });
});

test("sync API summarizes captured text artifacts instead of showing ChatGPT generation code", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "闁荤姴娲ˉ鎾诲极閹捐绠ｉ柟閭︿簽椤忓崬鈽夐幙鍐х敖婵犫偓閿涘嫧鍋撻崷顓炰粶鐟滄澘寮剁粙澶屸偓锝庡幗缁佷即锟?txt 闂佸搫鍊稿ú锝呪枎閵忋倖鏅悘鐐靛亾閻庮喖霉閻樼儤纭鹃柟?bridge-regression-note.txt",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const noisyReply = [
      "Generated:",
      "",
      "```python",
      "from pathlib import Path",
      "path = Path(\"/mnt/data/bridge-regression-note.txt\")",
      "path.write_text(\"bridge txt capture ok\", encoding=\"utf-8\")",
      "print(f\"Created: {path}\")",
      "```",
      "",
      "Analyzing",
      "",
      "```python",
      "from pathlib import Path",
      "path = Path(\"/mnt/data/bridge-regression-note.txt\")",
      "path.write_text(\"bridge txt capture ok\", encoding=\"utf-8\")",
      "```"
    ].join("\n");

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: noisyReply,
        artifacts: [
          {
            filename: "bridge-regression-note.txt",
            contentType: "text/plain; charset=utf-8",
            originalUrl: "chatgpt-generated-text:bridge-regression-note.txt",
            base64Data: Buffer.from("bridge txt capture ok", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "succeeded");
    assert.match(completed.job.replyText, /write_text/);
    assert.match(completed.roomMessage.text, /1/);
    assert.match(completed.chatgptMessage.text, /1/);
    assert.equal(completed.roomMessage.metadata.artifactIds.length, 1);
  });
});

test("sync API fails an image request when no real image artifact was captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await updateWorkspaceBinding(storeRoot, {
      chatgptProjectUrl: "https://chatgpt.com/c/demo",
      targetRepo: "F:/game_code/demo",
      conversationId: "novel-room"
    });
    const job = await createSyncJob(storeRoot, {
      kind: "image_request",
      projectUrl: "https://chatgpt.com/c/demo",
      targetRepo: "F:/game_code/demo",
      conversationId: "novel-room",
      userText: "Generate a novel poster image.",
      payloadText: "Generate a novel poster image."
    });

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Crafted a novel poster",
        artifacts: [],
        artifactIds: [],
        artifactErrors: []
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].code, "missing_download");
  });
});

test("sync API fails an image request when the supplied artifact is only text", async () => {
  const storeRoot = await tempStore();
  const textArtifact = await saveArtifactFromBase64(storeRoot, {
    filename: "poster-description.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("not an image", "utf8").toString("base64")
  });

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const job = await createSyncJob(storeRoot, {
      kind: "image_request",
      projectUrl: "https://chatgpt.com/c/demo",
      conversationId: "novel-room",
      userText: "Generate a novel poster image.",
      payloadText: "Generate a novel poster image."
    });

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Crafted a novel poster",
        artifactIds: [textArtifact.id]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.deepEqual(completed.job.artifactIds, [textArtifact.id]);
    assert.ok(completed.job.artifactErrors.some((error) => error.code === "missing_download"));
  });
});

test("sync API fails an image request when the supplied artifact id does not exist", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const job = await createSyncJob(storeRoot, {
      kind: "image_request",
      projectUrl: "https://chatgpt.com/c/demo",
      conversationId: "novel-room",
      userText: "Generate a novel poster image.",
      payloadText: "Generate a novel poster image."
    });

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Crafted a novel poster",
        artifactIds: ["artifact_does_not_exist"]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.deepEqual(completed.job.artifactIds, []);
    assert.ok(completed.job.artifactErrors.some((error) => error.code === "invalid_artifact_reference"));
    assert.ok(completed.job.artifactErrors.some((error) => error.code === "missing_download"));
  });
});

test("sync API flags a generated file card when no real artifact was captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable favorite-foods.pptx file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated favorite-foods.pptx and opened the presentation in fullscreen."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].filename, "favorite-foods.pptx");
    assert.equal(completed.job.artifactErrors[0].code, "missing_download");
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, completed.job.artifactErrors);
  });
});

test("room API can send one GPT message with multiple imported input artifacts", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const firstImportResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "drop-image.png",
        contentType: "image/png",
        base64Data: Buffer.from("fake image").toString("base64")
      })
    });
    const secondImportResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "drop-note.txt",
        contentType: "text/plain",
        base64Data: Buffer.from("note body").toString("base64")
      })
    });
    assert.equal(firstImportResponse.status, 201);
    assert.equal(secondImportResponse.status, 201);
    const firstImported = await firstImportResponse.json();
    const secondImported = await secondImportResponse.json();

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Analyze these attachments together.",
        to: ["gpt"],
        inputArtifactIds: [firstImported.artifact.id, secondImported.artifact.id],
        modePreference: "balanced",
        modelPreference: "gpt-5.5"
      })
    });
    assert.equal(response.status, 201);
    const created = await response.json();

    assert.equal(created.message.from, "user");
    assert.deepEqual(created.message.to, ["gpt"]);
    assert.deepEqual(created.message.metadata.inputArtifactIds, [
      firstImported.artifact.id,
      secondImported.artifact.id
    ]);
    assert.equal(created.message.metadata.source, "composer_attachments");
    assert.equal(created.syncJob.kind, "codex_file_analysis");
    assert.equal(created.syncJob.inputArtifacts.length, 2);
    assert.deepEqual(
      created.syncJob.inputArtifacts.map((artifact) => artifact.filename),
      ["drop-image.png", "drop-note.txt"]
    );
    assert.ok(created.syncJob.payloadText.includes("Analyze these attachments together."));
    assert.ok(created.syncJob.payloadText.includes("drop-image.png"));
    assert.ok(created.syncJob.payloadText.includes("drop-note.txt"));
    assert.doesNotMatch(created.syncJob.payloadText, /bottom-left arrow/);
    assert.match(created.syncJob.payloadText, /drop-image\.png/);
    assert.match(created.syncJob.payloadText, /drop-note\.txt/);

    const roomResponse = await fetch(`${baseUrl}/api/room/messages`);
    const room = await roomResponse.json();
    assert.equal(room.messages[0].metadata.syncInputArtifactCount, 2);
    assert.deepEqual(room.messages[0].metadata.syncInputArtifactNames, ["drop-image.png", "drop-note.txt"]);
    assert.match(room.messages[0].metadata.syncReason, /GPT/);
  });
});

test("sync API flags a requested file when GPT returns no downloadable artifact", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable xlsx file named bridge-smoke-jokes.xlsx with only 3 short Chinese jokes.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT says:\n\nGenerated bridge-smoke-jokes.xlsx."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].filename, "bridge-smoke-jokes.xlsx");
    assert.equal(completed.job.artifactErrors[0].code, "missing_download");
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, completed.job.artifactErrors);
  });
});

test("sync API flags a requested downloadable file when GPT returns unrelated text without an artifact", async () => {
  const storeRoot = await tempStore();
  const filename = "bridge-regression-xlsx-unrelated.xlsx";

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          `Please create a real downloadable Excel file named ${filename}. ` +
          "Do not only explain; provide a clickable downloadable XLSX file.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Read the API quickstart guide"
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].filename, filename);
    assert.equal(completed.job.artifactErrors[0].code, "missing_download");
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, completed.job.artifactErrors);
  });
});

test("sync API flags a Chinese requested PDF when GPT returns no downloadable artifact", async () => {
  const storeRoot = await tempStore();
  const filename = "bridge-regression-pdf-20260708125759.pdf";

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text:
          `\u8bf7\u751f\u6210\u4e00\u4e2a\u771f\u5b9e\u53ef\u4e0b\u8f7d\u7684 PDF \u6587\u4ef6\uff0c\u6587\u4ef6\u540d\u4e3a ${filename}\u3002` +
          "PDF \u53ea\u9700\u8981 1 \u9875\uff0c\u6807\u9898\u5199 Bridge PDF Regression 20260708125759\uff0c\u6b63\u6587\u5199 bridge pdf ok 20260708125759\u3002" +
          "\u4e0d\u8981\u53ea\u7ed9\u8bf4\u660e\uff0c\u8bf7\u63d0\u4f9b\u53ef\u70b9\u51fb\u4e0b\u8f7d\u7684 PDF \u6587\u4ef6\u3002",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "\u8bfb\u53d6SKILL.md\u5e76\u751f\u6210PDF"
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].filename, filename);
    assert.equal(completed.job.artifactErrors[0].code, "missing_download");
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, completed.job.artifactErrors);
  });
});

test("sync API rejects preview images that are mislabeled as downloadable office files", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable xlsx file named bridge-regression-table.xlsx.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "閻庤鐡曠亸娆撳极閹捐绠ｉ柟鏉垮缁愭鈽夐幘鎰佸創锟?bridge-regression-table.xlsx",
        artifacts: [
          {
            filename: "bridge-regression-table.xlsx",
            contentType: "image/png",
            originalUrl: "data:image/png;base64,iVBORw0KGgo=",
            base64Data: "iVBORw0KGgo="
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors.length, 1);
    assert.equal(completed.job.artifactErrors[0].filename, "bridge-regression-table.xlsx");
    assert.match(completed.job.artifactErrors[0].error, /does not match/i);
    assert.deepEqual(completed.roomMessage.metadata.artifactIds, []);
  });
});

test("sync API fails Chinese downloadable file replies when no real artifact is captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate a real downloadable xlsx file named bridge-regression-cn.xlsx.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "鐎规瓕灏欓弫鎾诲箣閹邦剙璁插☉鎾愁儓锟?Excel 闁哄倸娲ｅ▎銏ゆ晬濮濇樆\nbridge-regression-cn.xlsx",
        artifactErrors: [
          {
            filename: "bridge-regression-cn.xlsx",
            originalUrl: "https://chatgpt.com/backend-api/conversation/demo/interpreter/download?message_id=msg&sandbox_path=%2Fmnt%2Fdata%2Fbridge-regression-cn.xlsx",
            error: "ChatGPT direct download failed with status 401"
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "failed");
    assert.equal(completed.job.errorCode, "missing_download");
    assert.equal(completed.job.artifactIds.length, 0);
    assert.equal(completed.job.artifactErrors[0].filename, "bridge-regression-cn.xlsx");
    assert.deepEqual(completed.roomMessage.metadata.artifactIds, []);
  });
});

test("sync API strips ChatGPT wrapper headings from visible replies", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
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
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT says:\n\nThis is the final answer."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.roomMessage.text, "This is the final answer.");
    assert.equal(completed.chatgptMessage.text, "This is the final answer.");
  });
});

test("sync API rejects empty ChatGPT wrapper headings without artifacts", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "generate images",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT \u8bf4\uff1a"
      })
    });

    assert.equal(completeResponse.status, 409);
    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.find((job) => job.id === claimed.job.id).status, "running");
  });
});

test("sync API does not treat interim ChatGPT text as a final visible reply", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please analyze this attachment.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT says:\n\nReading document-related skill notes"
      })
    });
    assert.equal(completeResponse.status, 409);
    const rejected = await completeResponse.json();

    assert.equal(rejected.code, "interim_chatgpt_reply");
    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.find((job) => job.id === claimed.job.id).status, "running");
  });
});

test("sync API accepts a complete long-form reply containing ordinary 正在 text", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please design a complete fantasy novel outline.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();
    const replyText = [
      "《我在玄幻世界修补天道》前十集大纲",
      "青云宗地下灵脉正在被邪气污染，林砚通过天道灵眼发现规则裂痕。",
      "第一集到第三集建立穿越、系统觉醒和杂役求生；第四集到第六集推进宗门调查与人物关系；第七集到第九集揭开逆天盟阴谋；第十集完成灵脉修复并获得天道碎片。",
      "主要人物包括林砚、苏清月、陆长风、白小鱼、赵烈、韩绝和黑袍人。每个人物都有明确的剧情作用、冲突关系与成长方向。",
      "这是一份已经完成的结构化大纲，包含核心设定、主线、主要人物、十集概要，以及下一步写第一章可以直接使用的开场、冲突、爽点和结尾钩子。"
    ].join("\n\n");

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyText })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.equal(completed.job.status, "succeeded");
    assert.equal(completed.job.replyText, replyText);
  });
});

test("sync API accepts a complete long-form reply containing a standalone 正在分析 status phrase", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });
    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Write the final architecture analysis.", to: ["gpt"] })
    });
    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();
    const replyText = [
      "最终架构分析已经完成。系统 正在分析，文件生命周期只是完整设计中的一个运行态描述，并不是等待提示。",
      "Router 负责按依赖顺序推进阶段，并在每次提交前持久化 requestId、payload 和当前状态。这样即使进程恢复，也能从首个未完成阶段继续。",
      "Transport 只暴露统一结果协议，网页同步链路的内部字段保留在 raw 中，公共编排层不依赖 Chrome 私有状态。",
      "取消、失败和超时均为停止条件；任何终态都不得被陈旧执行重新改回 running。产物路径由运行目录精确返回，调用方无需搜索磁盘。",
      "以上内容是完整结论，包含职责边界、恢复策略、错误处理和产物约束，可以直接进入实现与验收。"
    ].join("\n\n");
    assert.ok(replyText.length > 220);

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyText })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();
    assert.equal(completed.job.status, "succeeded");
    assert.equal(completed.job.replyText, replyText);
  });
});

test("sync API accepts a complete incident report containing historical connection lost text", async () => {
  const storeRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/demo",
    conversationId: "incident-room",
    userText: "Write the final incident report.",
    payloadText: "Write the final incident report."
  });
  const replyText = [
    "The incident review is complete and all corrective actions have been verified.",
    "The connection lost event was caused by an expired upstream route, and the service recovered after the route table was refreshed.",
    "No Router stage was duplicated. Persisted request ids and terminal guards prevented a stale continuation from replaying completed work.",
    "Monitoring now distinguishes historical incident language from a live interruption banner, and the final report is ready for handoff.",
    "This is the complete final answer, including cause, impact, recovery, validation, and prevention work."
  ].join("\n\n");
  assert.ok(replyText.length > 220);

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/sync/jobs/${job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replyText })
    });
    assert.equal(response.status, 200);
    const completed = await response.json();
    assert.equal(completed.job.status, "succeeded");
    assert.equal(completed.job.replyText, replyText);
  });
});

test("sync API does not treat model thinking labels as final visible replies", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Write a novel",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Pro thinking",
      })
    });
    assert.equal(completeResponse.status, 409);
    const rejected = await completeResponse.json();

    assert.equal(rejected.code, "interim_chatgpt_reply");
    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.find((job) => job.id === claimed.job.id).status, "running");
  });
});

test("sync API refuses a late completion after a manual cancel", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please answer later.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const cancelResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/cancel`, {
      method: "POST"
    });
    assert.equal(cancelResponse.status, 200);

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "late reply after stop"
      })
    });

    assert.equal(completeResponse.status, 409);
    const rejected = await completeResponse.json();
    assert.equal(rejected.code, "sync_job_not_active");
    const jobs = await listSyncJobs(storeRoot);
    const job = jobs.find((item) => item.id === claimed.job.id);
    assert.equal(job.status, "failed");
    assert.equal(job.errorCode, "manual_cancelled");
    assert.equal(job.replyText, "");
  });
});

test("sync API does not complete when ChatGPT reports an interrupted connection", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Write a novel",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Connection interrupted. Waiting for the complete reply"
      })
    });
    assert.equal(completeResponse.status, 409);
    const rejected = await completeResponse.json();

    assert.equal(rejected.code, "interim_chatgpt_reply");
    const jobs = await listSyncJobs(storeRoot);
    assert.equal(jobs.find((job) => job.id === claimed.job.id).status, "running");
  });
});

test("sync API auto-queues follow-up image jobs until the requested image count is captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate 10 images about a futuristic AI workbench.",
        to: ["gpt"]
      })
    });

    const firstClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const firstClaimed = await firstClaimResponse.json();

    const firstCompleteResponse = await fetch(`${baseUrl}/api/sync/jobs/${firstClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT says:\n\nPreview",
        artifacts: [
          {
            filename: "ai-workbench-01.png",
            contentType: "image/png",
            base64Data: Buffer.from("fake png 1").toString("base64")
          }
        ]
      })
    });
    assert.equal(firstCompleteResponse.status, 200);
    const firstCompleted = await firstCompleteResponse.json();

    assert.equal(firstCompleted.job.artifactIds.length, 1);
    assert.equal(firstCompleted.imageContinuationMessage.from, "codex");
    assert.deepEqual(firstCompleted.imageContinuationMessage.to, ["gpt"]);
    assert.match(firstCompleted.imageContinuationMessage.text, /\u5269\u4f59 9 \u5f20\u56fe\u7247|remaining 9 images/i);
    assert.equal(firstCompleted.imageContinuationJob.status, "pending");
    assert.equal(firstCompleted.imageContinuationJob._bridgeImageBatchTotal, 10);
    assert.equal(firstCompleted.imageContinuationJob._bridgeImageBatchCaptured, 1);

    const secondClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const secondClaimed = await secondClaimResponse.json();
    assert.equal(secondClaimed.job.id, firstCompleted.imageContinuationJob.id);

    const secondCompleteResponse = await fetch(`${baseUrl}/api/sync/jobs/${secondClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "#### ChatGPT says:\n\nThe remaining images have been generated.",
        artifacts: Array.from({ length: 9 }, (_, index) => ({
          filename: `ai-workbench-${String(index + 2).padStart(2, "0")}.png`,
          contentType: "image/png",
          base64Data: Buffer.from(`fake png ${index + 2}`).toString("base64")
        }))
      })
    });
    assert.equal(secondCompleteResponse.status, 200);
    const secondCompleted = await secondCompleteResponse.json();
    assert.equal(secondCompleted.job.artifactIds.length, 10);
    assert.equal(secondCompleted.roomMessage.metadata.artifactIds.length, 10);
    assert.equal(secondCompleted.roomMessage.text, "\u5df2\u6355\u83b7 10 \u5f20\u56fe\u7247");
    assert.equal(secondCompleted.imageContinuationJob, null);
  });
});

test("sync API summarizes multi-image preview replies with captured image count", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "\u8bf7\u751f\u6210 10 \u5f20\u56fe\u7247\uff0c\u4e3b\u9898\uff1a\u672a\u6765\u611f AI \u5de5\u4f5c\u53f0\u3002",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "\u9884\u89c8",
        artifacts: Array.from({ length: 10 }, (_, index) => ({
          filename: `ai-workbench-${String(index + 1).padStart(2, "0")}.png`,
          contentType: "image/png",
          base64Data: Buffer.from(`fake png ${index + 1}`).toString("base64")
        }))
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.artifactIds.length, 10);
    assert.equal(completed.roomMessage.text, "\u5df2\u6355\u83b7 10 \u5f20\u56fe\u7247");
    assert.equal(completed.chatgptMessage.text, "\u5df2\u6355\u83b7 10 \u5f20\u56fe\u7247");
  });
});

test("sync API summarizes image planning text with captured images as image count", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "\u8bf7\u751f\u6210 10 \u5f20\u56fe\u7247\uff0c\u4e3b\u9898\uff1a\u672a\u6765\u611f AI \u5de5\u4f5c\u53f0\u3002",
        to: ["gpt"]
      })
    });
    const created = await response.json();

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Creating diverse futuristic AI workstation images\n\nEach will have a 1:1 aspect ratio unless stated otherwise.\n\n\u9884\u89c8",
        artifacts: Array.from({ length: 10 }, (_, index) => ({
          filename: `ai-workbench-${String(index + 1).padStart(2, "0")}.png`,
          contentType: "image/png",
          base64Data: Buffer.from(`fake png ${index + 1}`).toString("base64")
        }))
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(created.syncJob.id, claimed.job.id);
    assert.equal(completed.job.artifactIds.length, 10);
    assert.equal(completed.roomMessage.text, "\u5df2\u6355\u83b7 10 \u5f20\u56fe\u7247");
    assert.equal(completed.chatgptMessage.text, "\u5df2\u6355\u83b7 10 \u5f20\u56fe\u7247");
  });
});

test("sync API summarizes misleading single-image text when multiple images are captured", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "\u8bf7\u751f\u6210 10 \u5f20\u56fe\u7247\uff0c\u4e3b\u9898\uff1a\u672a\u6765\u611f AI \u5de5\u4f5c\u53f0\u3002",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "\u751f\u6210\u4e86\u4e00\u5f20\u56fe\u7247\u3002",
        artifacts: Array.from({ length: 9 }, (_, index) => ({
          filename: `ai-workbench-${String(index + 1).padStart(2, "0")}.png`,
          contentType: "image/png",
          base64Data: Buffer.from(`fake png ${index + 1}`).toString("base64")
        }))
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.artifactIds.length, 9);
    assert.equal(completed.roomMessage.text, "\u5df2\u6355\u83b7 9 \u5f20\u56fe\u7247");
    assert.equal(completed.chatgptMessage.text, "\u5df2\u6355\u83b7 9 \u5f20\u56fe\u7247");
  });
});

test("sync API stops image batch continuation when a follow-up captures no new images", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Please generate 10 images of a futuristic AI workbench.",
        to: ["gpt"]
      })
    });

    const firstClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const firstClaimed = await firstClaimResponse.json();

    const firstCompleteResponse = await fetch(`${baseUrl}/api/sync/jobs/${firstClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Preview",
        artifacts: [
          {
            filename: "ai-workbench-01.png",
            contentType: "image/png",
            base64Data: Buffer.from("fake png 1").toString("base64")
          }
        ]
      })
    });
    assert.equal(firstCompleteResponse.status, 200);
    const firstCompleted = await firstCompleteResponse.json();
    assert.ok(firstCompleted.imageContinuationJob);

    const secondClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const secondClaimed = await secondClaimResponse.json();

    const secondCompleteResponse = await fetch(`${baseUrl}/api/sync/jobs/${secondClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Continue generating the remaining 9 images."
      })
    });
    assert.equal(secondCompleteResponse.status, 200);
    const secondCompleted = await secondCompleteResponse.json();
    assert.equal(secondCompleted.job.artifactIds.length, 0);
    assert.equal(secondCompleted.imageContinuationJob, null);
  });
});

test("sync API builds Codex inbox instructions from the original user request", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/chat/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Create b.txt and write one sentence inside.",
        run: true
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated b.txt.",
        artifacts: [
          {
            filename: "b.txt",
            contentType: "text/plain",
            base64Data: Buffer.from("one sentence", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.job.status, "succeeded");
    assert.ok(completed.chatgptMessage.text.length > 0);
    assert.ok(completed.inboxItem);
    assert.match(completed.inboxItem.promptText, /Generated b\.txt/);
    assert.match(completed.inboxItem.promptText, /b.txt/);
    assert.ok(completed.inboxItem.promptText.length > 0);
  });
});

test("sync API does not infer missing artifacts from example filenames in normal text", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Explain common generated image filenames.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "The filename imagegen.png is only an example; no file was generated."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.deepEqual(completed.job.artifactIds, []);
    assert.deepEqual(completed.job.artifactErrors, []);
    assert.deepEqual(completed.roomMessage.metadata.artifactErrors, []);
  });
});

test("sync API completes a normal chat reply without creating a Codex inbox item", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/chat/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Hello.",
        run: true
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();
    assert.equal(claimed.job.kind, "chat_message");

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Hello back from GPT without a Codex task."
      })
    });
    assert.equal(completeResponse.status, 200);
    const completed = await completeResponse.json();

    assert.equal(completed.chatgptMessage.role, "chatgpt");
    assert.equal(completed.inboxItem, null);
    assert.equal(completed.task, null);

    const inboxResponse = await fetch(`${baseUrl}/api/codex-inbox/next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workerId: "current-codex-thread"
      })
    });
    const inbox = await inboxResponse.json();
    assert.equal(inbox.item, null);
  });
});

test("acceptance API summarizes captured GPT data scenarios for the active room", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatgptProjectUrl: "https://chatgpt.com/project/demo",
        targetRepo: "F:/game_code/demo"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Return a short reply, a long paragraph, code, images, office files and a zip.",
        to: ["gpt"]
      })
    });

    const claimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const claimed = await claimResponse.json();

    const completeResponse = await fetch(`${baseUrl}/api/sync/jobs/${claimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: [
          "This is a plain text reply.",
          "This is a long body. ".repeat(90),
          "```js",
          "console.log('bridge acceptance');",
          "```"
        ].join("\n"),
        artifacts: [
          {
            filename: "content",
            contentType: "image/png",
            base64Data: Buffer.from("image one", "utf8").toString("base64")
          },
          {
            filename: "content",
            contentType: "image/png",
            base64Data: Buffer.from("image two", "utf8").toString("base64")
          },
          {
            filename: "content",
            contentType: "image/png",
            base64Data: Buffer.from("image three", "utf8").toString("base64")
          },
          {
            filename: "photo.jpg",
            contentType: "image/jpeg",
            base64Data: Buffer.from("jpg", "utf8").toString("base64")
          },
          {
            filename: "proposal.docx",
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            base64Data: Buffer.from("docx", "utf8").toString("base64")
          },
          {
            filename: "jokes.xlsx",
            contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            base64Data: Buffer.from("xlsx", "utf8").toString("base64")
          },
          {
            filename: "food.pptx",
            contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            base64Data: Buffer.from("pptx", "utf8").toString("base64")
          },
          {
            filename: "brief.pdf",
            contentType: "application/pdf",
            base64Data: Buffer.from("pdf", "utf8").toString("base64")
          },
          {
            filename: "bundle.zip",
            contentType: "application/zip",
            base64Data: Buffer.from("zip", "utf8").toString("base64")
          },
          {
            filename: "note.txt",
            contentType: "text/plain",
            base64Data: Buffer.from("txt", "utf8").toString("base64")
          },
          {
            filename: "plan.md",
            contentType: "text/markdown",
            base64Data: Buffer.from("# plan", "utf8").toString("base64")
          },
          {
            filename: "data.json",
            contentType: "application/json",
            base64Data: Buffer.from("{\"ok\":true}", "utf8").toString("base64")
          }
        ]
      })
    });
    assert.equal(completeResponse.status, 200);

    const importedResponse = await fetch(`${baseUrl}/api/artifacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "local-note.txt",
        contentType: "text/plain",
        base64Data: Buffer.from("local file", "utf8").toString("base64")
      })
    });
    const imported = await importedResponse.json();

    await fetch(`${baseUrl}/api/artifacts/${imported.artifact.id}/analyze-with-gpt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "Analyze this local file." })
    });
    const localFileClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const localFileClaimed = await localFileClaimResponse.json();
    assert.equal(localFileClaimed.job.kind, "codex_file_analysis");
    await fetch(`${baseUrl}/api/sync/jobs/${localFileClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Local file analyzed successfully."
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "This job will fail first.",
        to: ["gpt"]
      })
    });
    const retryClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const retryClaimed = await retryClaimResponse.json();
    await fetch(`${baseUrl}/api/sync/jobs/${retryClaimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Timed out waiting for ChatGPT reply" })
    });
    await fetch(`${baseUrl}/api/sync/jobs/${retryClaimed.job.id}/retry`, {
      method: "POST"
    });
    const retrySuccessClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const retrySuccessClaimed = await retrySuccessClaimResponse.json();
    assert.equal(retrySuccessClaimed.job.userText, "This job will fail first.");
    await fetch(`${baseUrl}/api/sync/jobs/${retrySuccessClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Retry succeeded."
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "This attachment upload will fail.",
        to: ["gpt"]
      })
    });
    const uploadFailureClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const uploadFailureClaimed = await uploadFailureClaimResponse.json();
    await fetch(`${baseUrl}/api/sync/jobs/${uploadFailureClaimed.job.id}/fail`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to fetch",
        errorCode: "attachment_upload_failed"
      })
    });

    await fetch(`${baseUrl}/api/room/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Generate a downloadable bridge-missing.xlsx file.",
        to: ["gpt"]
      })
    });
    const missingDownloadClaimResponse = await fetch(`${baseUrl}/api/sync/jobs/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectUrl: "https://chatgpt.com/project/demo/c/abc",
        workerId: "test-extension"
      })
    });
    const missingDownloadClaimed = await missingDownloadClaimResponse.json();
    await fetch(`${baseUrl}/api/sync/jobs/${missingDownloadClaimed.job.id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        replyText: "Generated bridge-missing.xlsx. Click to download."
      })
    });

    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        title: "Old extension",
        workerId: "codex-chatgpt-project-extension-v20260629-old:runtime-ok"
      })
    });
    await fetch(`${baseUrl}/api/extension/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        href: "https://chatgpt.com/project/demo/c/abc",
        title: "Current extension",
        workerId: "codex-chatgpt-project-extension-v20260711-router-v2-safety:runtime-ok"
      })
    });

    const legacyJob = await createSyncJob(storeRoot, {
      kind: "codex_file_analysis",
      projectUrl: "https://chatgpt.com/project/demo",
      conversationId: claimed.job.conversationId,
      userText: "Inspect the old task attachment.",
      payloadText: "Inspect the old task attachment.",
      inputArtifacts: [
        {
          id: "artifact_legacy_acceptance",
          filename: "legacy.zip",
          contentType: "application/zip",
          downloadUrl: "/api/artifacts/artifact_legacy_acceptance/download"
        }
      ]
    });
    await failSyncJob(storeRoot, legacyJob.id, {
      error: "old task failed"
    });
    const legacyRetryResponse = await fetch(`${baseUrl}/api/sync/jobs/${legacyJob.id}/retry`, {
      method: "POST"
    });
    assert.equal(legacyRetryResponse.status, 201);

    const acceptanceResponse = await fetch(`${baseUrl}/api/acceptance/status`);
    assert.equal(acceptanceResponse.status, 200);
    const acceptance = await acceptanceResponse.json();
    const checks = new Map(acceptance.checks.map((check) => [check.id, check]));

    assert.match(checks.get("code-block").prompt, /```js/);
    assert.equal(acceptance.summary.total, 31);
    assert.equal(acceptance.summary.passed, 31);
    assert.equal(acceptance.groupSummaries.data.total, 11);
    assert.equal(acceptance.groupSummaries.data.passed, 11);
    assert.equal(acceptance.groupSummaries.formats.total, 10);
    assert.equal(acceptance.groupSummaries.formats.passed, 10);
    assert.equal(acceptance.groupSummaries.reliability.total, 5);
    assert.equal(acceptance.groupSummaries.reliability.passed, 5);
    assert.equal(acceptance.groupSummaries.routing.total, 5);
    assert.equal(acceptance.groupSummaries.routing.passed, 5);
    assert.equal(checks.get("text-reply").status, "passed");
    assert.equal(checks.get("long-text").status, "passed");
    assert.equal(checks.get("code-block").status, "passed");
    assert.equal(checks.get("single-image").status, "passed");
    assert.equal(checks.get("multi-image").status, "passed");
    assert.equal(checks.get("spreadsheet").status, "passed");
    assert.equal(checks.get("presentation").status, "passed");
    assert.equal(checks.get("pdf").status, "passed");
    assert.equal(checks.get("zip").status, "passed");
    assert.equal(checks.get("local-file-to-gpt").status, "passed");
    assert.equal(checks.get("failed-retry").status, "passed");
    assert.equal(checks.get("gpt-stuck").status, "passed");
    assert.equal(checks.get("extension-reload").status, "passed");
    assert.equal(checks.get("attachment-upload-failure").status, "passed");
    assert.equal(checks.get("missing-download").status, "passed");
    assert.equal(checks.get("legacy-raw-retry").status, "passed");
    assert.match(checks.get("legacy-raw-retry").evidence, /\/raw/);
    for (const extension of ["png", "jpg", "pdf", "docx", "xlsx", "pptx", "zip", "txt", "md", "json"]) {
      assert.equal(checks.get(`format-${extension}`).status, "passed", extension);
    }
    assert.equal(checks.get("multi-image").status, "passed");

    const diagnosticsResponse = await fetch(`${baseUrl}/api/diagnostics/status`);
    assert.equal(diagnosticsResponse.status, 200);
    const diagnostics = await diagnosticsResponse.json();
    assert.equal(diagnostics.extension.needsReload, false);
    assert.equal(diagnostics.dataCoverage.label, "\u6570\u636e\u8bfb\u53d6 11/11");
    assert.equal(diagnostics.dataCoverage.summary.total, 11);
    assert.equal(diagnostics.dataCoverage.summary.passed, 11);
    assert.equal(diagnostics.dataCoverage.checks.length, 11);
    assert.equal(diagnostics.routeCoverage.label, "\u81ea\u52a8\u8def\u7531 5/5");
    assert.equal(diagnostics.routeCoverage.summary.total, 5);
    assert.equal(diagnostics.routeCoverage.summary.passed, 5);
    assert.equal(diagnostics.routeCoverage.checks.length, 5);

    const reportResponse = await fetch(`${baseUrl}/api/acceptance/report`);
    assert.equal(reportResponse.status, 200);
    assert.equal(reportResponse.headers.get("content-type")?.includes("text/markdown"), true);
    const report = await reportResponse.text();
    assert.match(report, /Bridge/);
    assert.match(report, /raw/i);
    assert.match(report, /31\/31/);

    const realRecordResponse = await fetch(`${baseUrl}/api/acceptance/real-browser-record`);
    assert.equal(realRecordResponse.status, 200);
    assert.equal(realRecordResponse.headers.get("content-type")?.includes("text/markdown"), true);
    const realRecord = await realRecordResponse.text();
    assert.match(realRecord, /CodexBridge/);
    assert.match(realRecord, /0\/31|31\/31/);
    assert.match(realRecord, /multi-image|image/i);
    assert.match(realRecord, /raw/i);
    assert.match(realRecord, /https:\/\/chatgpt\.com\/project\/demo/);
    assert.match(realRecord, /F:\/game_code\/demo/);
  });
});

test("chat turn defaults to running the configured runner and returns a result message", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/chat/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Check project status."
      })
    });
    assert.equal(response.status, 201);

    const turn = await response.json();
    assert.equal(turn.task.status, "waiting_for_codex");
    assert.equal(turn.resultMessage.kind, "codex_result");
    assert.match(turn.resultMessage.text, /Codex/);
  });
});

test("chat reply API can create a Codex task from a pasted ChatGPT response", async () => {
  const storeRoot = await tempStore();

  await withServer({ storeRoot, runnerMode: "manual" }, async (baseUrl) => {
    await fetch(`${baseUrl}/api/workspace`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetRepo: "F:/game_code/demo"
      })
    });

    const response = await fetch(`${baseUrl}/api/chat/replies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "ChatGPT plan: let Codex write a failing test first, then fix it.",
        createTask: true
      })
    });
    assert.equal(response.status, 201);

    const imported = await response.json();
    assert.equal(imported.message.role, "chatgpt");
    assert.equal(imported.task.title, "GPT \u89c4\u5212\u6267\u884c");
    assert.equal(imported.task.status, "queued");
  });
});
