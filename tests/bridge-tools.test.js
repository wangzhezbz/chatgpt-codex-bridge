import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createBridgeTools } from "../src/bridge-tools.js";
import { saveArtifactFromBase64 } from "../src/artifact-store.js";
import { updateWorkspaceBinding } from "../src/conversation-store.js";
import { createGptTransportRegistry } from "../src/gpt-transports/transport-registry.js";
import { createMockGptTransport } from "../src/gpt-transports/mock-transport.js";
import { createProject, selectProject } from "../src/project-store.js";
import { appendRoomMessage, createCodexTask } from "../src/room-store.js";
import { completeSyncJob, createSyncJob, listSyncJobs } from "../src/sync-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-tools-"));
}

test("bridge tools create, list, and read task results", async () => {
  const storeRoot = await tempStore();
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const created = await tools.createTask({
    title: "Tool task",
    prompt: "Hand this to Codex.",
    run: true
  });

  assert.equal(created.status, "waiting_for_codex");

  const tasks = await tools.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, created.id);

  const result = await tools.getTaskResult({ taskId: created.id });
  assert.match(result.text, /手动交给 Codex/);
});

test("bridge tools create revision tasks linked to the same target repo", async () => {
  const storeRoot = await tempStore();
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const original = await tools.createTask({
    title: "Original",
    prompt: "Do the first pass.",
    targetRepo: "F:/game_code/demo"
  });

  const revision = await tools.requestRevision({
    taskId: original.id,
    prompt: "Tighten the tests."
  });

  assert.equal(revision.title, "Revision: Original");
  assert.equal(revision.targetRepo, "F:/game_code/demo");
  assert.match(revision.promptText, /Tighten the tests/);
});

test("bridge tools expose the current Codex inbox flow", async () => {
  const storeRoot = await tempStore();
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const created = await tools.createInboxItem({
    source: "chatgpt_project",
    projectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    promptText: "Inspect the project from this Codex thread."
  });

  assert.equal(created.status, "pending");

  const claimed = await tools.claimNextInboxItem({
    workerId: "current-codex-thread"
  });

  assert.equal(claimed.id, created.id);
  assert.equal(claimed.status, "running");

  const completed = await tools.completeInboxItem({
    itemId: claimed.id,
    resultText: "Done from the current Codex thread."
  });

  assert.equal(completed.status, "succeeded");
  assert.equal(completed.resultText, "Done from the current Codex thread.");
});

test("bridge tools let the current Codex thread claim and answer room tasks", async () => {
  const storeRoot = await tempStore();
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    conversationId: "room-1"
  });

  const userMessage = await appendRoomMessage(storeRoot, {
    conversationId: "room-1",
    from: "user",
    to: ["codex"],
    text: "Create b.txt in the project."
  });

  const task = await createCodexTask(storeRoot, {
    conversationId: "room-1",
    sourceMessageId: userMessage.id,
    currentThreadId: "thread-current",
    targetRepo: "F:/game_code/demo",
    promptText: "Actually create b.txt from this current Codex thread."
  });

  const claimed = await tools.claimNextRoomCodexTask({
    currentThreadId: "thread-current",
    workerId: "codex-current"
  });

  assert.equal(claimed.id, task.id);
  assert.equal(claimed.status, "running");

  const completed = await tools.completeRoomCodexTask({
    taskId: claimed.id,
    resultText: "Created b.txt and verified it exists.",
    syncToChatGpt: true
  });

  assert.equal(completed.task.status, "succeeded");
  assert.equal(completed.message.from, "codex");
  assert.deepEqual(completed.message.to, ["user", "gpt"]);
  assert.equal(completed.message.text, "Created b.txt and verified it exists.");
  assert.equal(completed.syncJob.kind, "codex_result");
  assert.equal(completed.syncJob.sourceMessageId, completed.message.id);
  assert.match(completed.syncJob.payloadText, /Created b\.txt/);

  const messages = await tools.listRoomMessages({
    conversationId: "room-1"
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[1].from, "codex");

  const jobs = await listSyncJobs(storeRoot);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, completed.syncJob.id);
});

test("bridge tools default room claims to the configured current Codex thread", async () => {
  const storeRoot = await tempStore();
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  await createCodexTask(storeRoot, {
    conversationId: "room-1",
    currentThreadId: "thread-other",
    promptText: "This belongs to another Codex thread."
  });
  const currentTask = await createCodexTask(storeRoot, {
    conversationId: "room-1",
    currentThreadId: "thread-current",
    promptText: "This belongs to the current Codex thread."
  });

  const claimed = await tools.claimNextRoomCodexTask();

  assert.equal(claimed.id, currentTask.id);
  assert.equal(claimed.currentThreadId, "thread-current");
});

test("bridge tools let the current Codex thread ask the bound ChatGPT project", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    targetRepo: "F:/game_code/demo"
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const consultation = await tools.askChatGptProject({
    text: "Please review this plan before Codex executes it.",
    reason: "planning"
  });

  assert.equal(consultation.message.from, "codex");
  assert.deepEqual(consultation.message.to, ["gpt"]);
  assert.equal(consultation.syncJob.status, "pending");
  assert.equal(consultation.syncJob.kind, "codex_consultation");
  assert.equal(consultation.syncJob.sourceMessageId, consultation.message.id);

  const answer = await tools.readChatGptProjectAnswer({
    syncJobId: consultation.syncJob.id
  });

  assert.equal(answer.job.id, consultation.syncJob.id);
  assert.equal(answer.job.status, "pending");
});

test("bridge tools delegate Codex-only work without creating a GPT sync job", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    conversationId: "room-1"
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const delegated = await tools.delegateCurrentRequest({
    text: "Please run npm test locally and do not send this to GPT."
  });

  assert.equal(delegated.action, "codex_only");
  assert.equal(delegated.route.kind, "codex_only");
  assert.match(delegated.codexPromptText, /npm test/);
  assert.equal(delegated.syncJob, null);
  assert.equal(delegated.replyText, null);
  assert.ok(delegated.routingRules);

  const jobs = await listSyncJobs(storeRoot);
  assert.equal(jobs.length, 0);
});

test("bridge tools refuse GPT delegation without an explicit project or conversation scope", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const firstProject = await createProject(storeRoot, {
    name: "Project one",
    chatgptProjectUrl: "https://chatgpt.com/c/project-one",
    targetRepo: path.join(projectRoot, "one"),
    conversationId: "room-one",
    currentCodexThreadId: "thread-current"
  });
  await createProject(storeRoot, {
    name: "Project two",
    chatgptProjectUrl: "https://chatgpt.com/c/project-two",
    targetRepo: path.join(projectRoot, "two"),
    conversationId: "room-two",
    currentCodexThreadId: "thread-current"
  });
  await selectProject(storeRoot, firstProject.id);
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const delegated = await tools.delegateCurrentRequest({
    text: "Please analyze this screenshot.",
    attachmentCount: 1,
    waitForGpt: false
  });

  assert.equal(delegated.action, "scope_required");
  assert.equal(delegated.scopeRequired, true);
  assert.equal(delegated.message, null);
  assert.equal(delegated.syncJob, null);
  assert.match(delegated.error, /conversationId or projectId/);
  assert.equal((await listSyncJobs(storeRoot)).length, 0);
});

test("bridge tools route explicit conversation scope instead of the active workspace", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const activeProject = await createProject(storeRoot, {
    name: "Active project",
    chatgptProjectUrl: "https://chatgpt.com/c/active",
    targetRepo: path.join(projectRoot, "active"),
    conversationId: "room-active",
    currentCodexThreadId: "thread-current"
  });
  await createProject(storeRoot, {
    name: "Target project",
    chatgptProjectUrl: "https://chatgpt.com/c/target",
    targetRepo: path.join(projectRoot, "target"),
    conversationId: "room-target",
    currentCodexThreadId: "thread-current"
  });
  await selectProject(storeRoot, activeProject.id);
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const delegated = await tools.delegateCurrentRequest({
    conversationId: "room-target",
    text: "Please analyze this screenshot.",
    attachmentCount: 1,
    waitForGpt: false
  });

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.message.conversationId, "room-target");
  assert.equal(delegated.syncJob.conversationId, "room-target");
  assert.equal(delegated.syncJob.projectUrl, "https://chatgpt.com/c/target");
  assert.equal(delegated.message.metadata.chatgptProjectUrl, "https://chatgpt.com/c/target");
  const jobs = await listSyncJobs(storeRoot);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conversationId, "room-target");
});

test("bridge tools reject an explicit conversation bound to another Codex thread", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  await createProject(storeRoot, {
    name: "Other thread project",
    chatgptProjectUrl: "https://chatgpt.com/c/other-thread",
    targetRepo: path.join(projectRoot, "other-thread"),
    conversationId: "room-other-thread",
    currentCodexThreadId: "thread-owner"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  await assert.rejects(
    () =>
      tools.delegateCurrentRequest({
        conversationId: "room-other-thread",
        text: "Please analyze this screenshot.",
        attachmentCount: 1,
        waitForGpt: false
      }),
    /bound to another Codex thread/
  );
  assert.equal((await listSyncJobs(storeRoot)).length, 0);
});

test("bridge tools delegate text work to GPT and can wait for the result", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    conversationId: "room-1"
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const pending = tools.delegateCurrentRequest({
    text: "Please analyze this screenshot and explain what it is.",
    attachmentCount: 1,
    waitForGpt: true,
    timeoutMs: 1000,
    pollMs: 10
  });

  let job;
  for (let index = 0; index < 20 && !job; index += 1) {
    const jobs = await listSyncJobs(storeRoot);
    job = jobs.find((candidate) => candidate.kind === "chat_message");
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(job);
  await completeSyncJob(storeRoot, job.id, {
    replyText: "GPT result: this is a desktop shortcut icon."
  });

  const delegated = await pending;

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.route.kind, "gpt_only");
  assert.equal(delegated.syncJob.id, job.id);
  assert.equal(delegated.finalJob.status, "succeeded");
  assert.equal(delegated.replyText, "GPT result: this is a desktop shortcut icon.");
  assert.ok(delegated.routingRules.bridgeRulesPath);
  assert.ok(delegated.routingRules.codexDelegationPath);
});

test("bridge tools wait for GPT-routed text work by default", async () => {
  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    conversationId: "room-1"
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const pending = tools.delegateCurrentRequest({
    text: "请帮我写一个长篇小说大纲。",
    timeoutMs: 1000,
    pollMs: 10
  });

  let job;
  for (let index = 0; index < 20 && !job; index += 1) {
    const jobs = await listSyncJobs(storeRoot);
    job = jobs.find((candidate) => candidate.kind === "chat_message");
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.ok(job);
  await completeSyncJob(storeRoot, job.id, {
    replyText: "GPT result: novel outline."
  });

  const delegated = await pending;

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.finalJob.status, "succeeded");
  assert.equal(delegated.replyText, "GPT result: novel outline.");
});

test("bridge tools send only the first stage for multi-step creative delegation", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const delegated = await tools.delegateCurrentRequest({
    text: "我要写一篇玄幻穿越小说，你来协助我。先帮我设计前十集的大纲，再帮我写第一章内容，最后帮我生成一张小说海报。",
    waitForGpt: false
  });

  const jobs = await listSyncJobs(storeRoot);
  assert.equal(jobs.length, 1);
  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.route.sequentialPlan.id, "sequential_creative_chain");
  assert.equal(delegated.gptPayloadText, jobs[0].payloadText);
  assert.equal(delegated.message.text, jobs[0].payloadText);
  assert.match(delegated.message.metadata.originalRequestText, /最后帮我生成一张小说海报/);
  assert.match(jobs[0].payloadText, /请只完成第 1 步/);
  assert.match(jobs[0].payloadText, /前十集的大纲/);
  assert.match(jobs[0].payloadText, /不要写第一章/);
  assert.match(jobs[0].payloadText, /不要生成海报/);
  assert.doesNotMatch(jobs[0].payloadText, /最后帮我生成/);
});

test("bridge tools delegate local files from Codex to GPT without waiting when requested", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "screenshot.png");
  await writeFile(sourcePath, Buffer.from("fake image bytes", "utf8"));
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const delegated = await tools.delegateCurrentRequest({
    text: "让 GPT 分析这张图片，然后 Codex 用结果回答我。",
    waitForGpt: false,
    localFiles: [
      {
        localPath: sourcePath,
        contentType: "image/png"
      }
    ]
  });

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.route.kind, "gpt_only");
  assert.equal(delegated.artifacts.length, 1);
  assert.equal(delegated.artifacts[0].filename, "screenshot.png");
  assert.equal(delegated.queuedFiles.length, 1);
  assert.equal(delegated.syncJob.kind, "codex_file_analysis");
  assert.equal(delegated.syncJob.inputArtifacts[0].id, delegated.artifacts[0].id);
  assert.equal(delegated.queuedFiles[0].message.metadata.routingKind, "gpt_only");
  assert.match(delegated.syncJob.payloadText, /让 GPT 分析这张图片，然后 Codex 用结果回答我。/);
  assert.doesNotMatch(delegated.syncJob.payloadText, /适合 ChatGPT|Codex 会默认|本地项目目录|可执行的交接内容|targetRepo/);
  assert.equal(delegated.routingRules.bridgeRulesPath, path.join(projectRoot, "BRIDGE.md"));
  assert.equal(delegated.routingRules.codexDelegationPath, path.join(projectRoot, "AGENTS.md"));
  const delegationRules = await readFile(delegated.routingRules.codexDelegationPath, "utf8");
  assert.match(delegationRules, /delegate_current_request/);
  assert.match(delegationRules, /Codex's own visual\/content judgment/);
});

test("bridge tools wait for GPT by default when delegating Codex-attached local files", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "godot-shortcut.png");
  await writeFile(sourcePath, Buffer.from("fake image bytes", "utf8"));
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const pending = tools.delegateCurrentRequest({
    text: "分析这张图是什么，用中文回答。",
    localPath: sourcePath,
    contentType: "image/png",
    timeoutMs: 1000,
    pollMs: 10
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
    replyText: "GPT 结果：这是 Godot v4 的桌面快捷方式。"
  });

  const delegated = await pending;

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.route.kind, "gpt_only");
  assert.equal(delegated.syncJob.id, job.id);
  assert.equal(delegated.finalJob.status, "succeeded");
  assert.equal(delegated.timedOut, false);
  assert.equal(delegated.replyText, "GPT 结果：这是 Godot v4 的桌面快捷方式。");
});

test("bridge tools send a local file from the current Codex thread to the bound ChatGPT project", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "codex-drop.txt");
  await writeFile(sourcePath, "file handed directly to this Codex thread", "utf8");
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const queued = await tools.sendLocalFileToChatGptProject({
    localPath: sourcePath,
    contentType: "text/plain",
    note: "请分析这个用户直接发给当前 Codex 的文件。"
  });

  assert.equal(queued.artifact.filename, "codex-drop.txt");
  assert.equal(await readFile(queued.artifact.filePath, "utf8"), "file handed directly to this Codex thread");
  assert.equal(queued.message.from, "codex");
  assert.deepEqual(queued.message.to, ["gpt"]);
  assert.equal(queued.message.metadata.source, "current_codex_file");
  assert.equal(queued.message.metadata.initiatedBy, "codex");
  assert.equal(queued.message.metadata.currentCodexThreadId, "thread-current");
  assert.equal(queued.syncJob.kind, "codex_file_analysis");
  assert.equal(queued.syncJob.sourceMessageId, queued.message.id);
  assert.equal(queued.syncJob.inputArtifacts[0].id, queued.artifact.id);
  assert.match(queued.syncJob.payloadText, /codex-drop\.txt/);
  assert.match(queued.syncJob.payloadText, /只根据附件本身判断/);

  const jobs = await listSyncJobs(storeRoot);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, queued.syncJob.id);
});

test("bridge tools can send a local file and wait for the ChatGPT result in one call", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "codex-screenshot.png");
  await writeFile(sourcePath, Buffer.from("fake image bytes", "utf8"));
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const pending = tools.sendLocalFileToChatGptProjectAndWait({
    localPath: sourcePath,
    contentType: "image/png",
    note: "请识别图片内容。",
    timeoutMs: 1000,
    pollMs: 10
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
    replyText: "GPT 识别结果：这是剪映专业版快捷方式。"
  });

  const result = await pending;

  assert.equal(result.artifact.filename, "codex-screenshot.png");
  assert.equal(result.syncJob.id, job.id);
  assert.equal(result.finalJob.status, "succeeded");
  assert.equal(result.timedOut, false);
  assert.equal(result.replyText, "GPT 识别结果：这是剪映专业版快捷方式。");
});

test("bridge tools reuse a successful GPT file analysis for the same local file", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "same-screenshot.png");
  await writeFile(sourcePath, Buffer.from("same image bytes", "utf8"));
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const firstPending = tools.sendLocalFileToChatGptProjectAndWait({
    localPath: sourcePath,
    contentType: "image/png",
    note: "请识别这张图片。",
    timeoutMs: 1000,
    pollMs: 10
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
    replyText: "GPT 缓存结果：这是同一张图片。"
  });

  const first = await firstPending;
  assert.equal(first.replyText, "GPT 缓存结果：这是同一张图片。");

  const second = await tools.sendLocalFileToChatGptProjectAndWait({
    localPath: sourcePath,
    contentType: "image/png",
    note: "请识别这张图片。",
    timeoutMs: 1000,
    pollMs: 10
  });

  const jobs = await listSyncJobs(storeRoot);
  const fileAnalysisJobs = jobs.filter((candidate) => candidate.kind === "codex_file_analysis");
  assert.equal(fileAnalysisJobs.length, 1);
  assert.equal(second.cached, true);
  assert.equal(second.reusedSyncJobId, firstJob.id);
  assert.equal(second.replyText, "GPT 缓存结果：这是同一张图片。");
});

test("bridge tools fail a default delegated file wait when ChatGPT never returns", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "stuck-screenshot.png");
  await writeFile(sourcePath, Buffer.from("fake image bytes", "utf8"));
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/project/demo",
    targetRepo: projectRoot,
    conversationId: "room-1"
  });
  const tools = createBridgeTools({
    storeRoot,
    runnerMode: "manual",
    currentCodexThreadId: "thread-current"
  });

  const delegated = await tools.delegateCurrentRequest({
    text: "分析这张图是什么。",
    localPath: sourcePath,
    contentType: "image/png",
    timeoutMs: 1,
    pollMs: 1
  });

  assert.equal(delegated.timedOut, true);
  assert.equal(delegated.finalJob.status, "failed");
  assert.equal(delegated.finalJob.errorCode, "reply_timeout");
  assert.match(delegated.finalJob.error, /Timed out waiting for (?:ChatGPT|GPT) reply|等待 GPT 回复超时/);
});

test("bridge tools list and read ChatGPT downloaded artifacts for post-processing", async () => {
  const storeRoot = await tempStore();
  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_1",
    conversationId: "conv_1",
    filename: "article.md",
    contentType: "text/markdown",
    base64Data: Buffer.from("# GPT article", "utf8").toString("base64")
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const listed = await tools.listArtifacts({ syncJobId: "sync_1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifact.id);

  const text = await tools.readArtifactText({ artifactId: artifact.id });
  assert.equal(text.text, "# GPT article");
});

test("bridge tools list exposes bound-project artifact paths when available", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const job = await createSyncJob(storeRoot, {
    kind: "chat_message",
    projectUrl: "https://chatgpt.com/c/demo",
    targetRepo: projectRoot,
    conversationId: "conv_1",
    payloadText: "请生成一张海报"
  });
  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: job.id,
    conversationId: "conv_1",
    filename: "poster.png",
    contentType: "image/png",
    base64Data: Buffer.from("poster bytes", "utf8").toString("base64")
  });
  await completeSyncJob(storeRoot, job.id, {
    replyText: "已捕获 1 张图片",
    artifactIds: [artifact.id],
    projectArtifacts: [
      {
        artifact,
        projectRoot,
        filename: "poster.png",
        savedPath: path.join(projectRoot, "chatgpt-artifacts", "poster.png"),
        relativePath: path.join("chatgpt-artifacts", "poster.png"),
        savedAt: "2026-07-05T00:00:00.000Z"
      }
    ]
  });
  const tools = createBridgeTools({ storeRoot, runnerMode: "manual" });

  const listed = await tools.listArtifacts({ syncJobId: job.id });

  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifact.id);
  assert.equal(listed[0].projectArtifact.savedPath, path.join(projectRoot, "chatgpt-artifacts", "poster.png"));
  assert.equal(listed[0].projectSavedPath, path.join(projectRoot, "chatgpt-artifacts", "poster.png"));
  assert.equal(listed[0].projectRelativePath, path.join("chatgpt-artifacts", "poster.png"));
  assert.equal(listed[0].projectRoot, projectRoot);
});

test("bridge tools keep the complete legacy delegation path when Router V2 is disabled", async (t) => {
  const originalFlag = process.env.BRIDGE_ROUTER_V2;
  process.env.BRIDGE_ROUTER_V2 = "0";
  t.after(() => {
    if (originalFlag === undefined) {
      delete process.env.BRIDGE_ROUTER_V2;
    } else {
      process.env.BRIDGE_ROUTER_V2 = originalFlag;
    }
  });

  const storeRoot = await tempStore();
  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/c/legacy-router-off",
    targetRepo: await tempStore(),
    conversationId: "legacy-router-off"
  });
  let routerCalls = 0;
  const tools = createBridgeTools({
    storeRoot,
    routerOrchestrator: {
      async startRouterRun() {
        routerCalls += 1;
        throw new Error("Router V2 must stay disabled");
      }
    }
  });

  const delegated = await tools.delegateCurrentRequest({
    text: "请帮我写一个长篇故事大纲。",
    waitForGpt: false
  });

  assert.equal(routerCalls, 0);
  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.message.from, "codex");
  assert.equal(delegated.syncJob.status, "pending");
  assert.equal(delegated.routerRun, undefined);
  assert.equal((await listSyncJobs(storeRoot)).length, 1);
});

test("bridge tools enable Router V2 from the environment and preserve compatible fields with Mock", async (t) => {
  const originalFlag = process.env.BRIDGE_ROUTER_V2;
  process.env.BRIDGE_ROUTER_V2 = "1";
  t.after(() => {
    if (originalFlag === undefined) {
      delete process.env.BRIDGE_ROUTER_V2;
    } else {
      process.env.BRIDGE_ROUTER_V2 = originalFlag;
    }
  });

  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Router mock project",
    chatgptProjectUrl: "https://chatgpt.com/c/router-mock",
    targetRepo: projectRoot,
    conversationId: "router-mock-conversation",
    currentCodexThreadId: "thread-current"
  });
  const mock = createMockGptTransport({
    responses: { gpt: { replyText: "Mock Router reply" } },
    requestIdFactory: ({ sequence }) => `bridge-mock-${sequence}`
  });
  const registry = createGptTransportRegistry({
    transports: [mock],
    defaultTransportId: "mock",
    env: {}
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    gptTransportRegistry: registry,
    gptTransportId: "mock"
  });

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请帮我写一篇长篇小说大纲。",
    waitForGpt: true,
    timeoutMs: 10,
    pollMs: 1
  });

  for (const field of [
    "action",
    "route",
    "codexPromptText",
    "gptPayloadText",
    "message",
    "syncJob",
    "queuedFiles",
    "artifacts",
    "finalJob",
    "timedOut",
    "replyText",
    "routingRules",
    "routerRun",
    "transportResult",
    "projectArtifactPaths"
  ]) {
    assert.equal(Object.hasOwn(delegated, field), true, `missing compatible field: ${field}`);
  }
  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.message, null);
  assert.equal(delegated.syncJob, null);
  assert.equal(delegated.finalJob, null);
  assert.equal(delegated.timedOut, false);
  assert.equal(delegated.replyText, "Mock Router reply");
  assert.equal(delegated.routerRun.projectId, project.id);
  assert.equal(delegated.routerRun.conversationId, project.conversationId);
  assert.equal(delegated.routerRun.codexThreadId, "thread-current");
  assert.equal(delegated.routerRun.transportId, "mock");
  assert.equal(delegated.projectArtifactPaths.length, 1);
  assert.equal(
    delegated.projectArtifactPaths[0],
    path.join(projectRoot, ".bridge", "artifacts", delegated.routerRun.id, "gpt.md")
  );
  assert.equal(await readFile(delegated.projectArtifactPaths[0], "utf8"), "Mock Router reply\n");
  assert.equal(mock.submissions.length, 1);
  assert.equal((await listSyncJobs(storeRoot)).length, 0);
});

test("bridge tools Router V2 wraps the existing web sync queue without changing its job shape", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Router web project",
    chatgptProjectUrl: "https://chatgpt.com/c/router-web",
    targetRepo: projectRoot,
    conversationId: "router-web-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true
  });

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请帮我写一篇长篇小说大纲。",
    waitForGpt: false
  });

  assert.equal(delegated.action, "gpt_only");
  assert.equal(delegated.routerRun.status, "queued");
  assert.equal(delegated.routerRun.transportId, "web-sync");
  assert.equal(delegated.message.from, "codex");
  assert.equal(delegated.message.conversationId, project.conversationId);
  assert.equal(delegated.syncJob.status, "pending");
  assert.equal(delegated.syncJob.kind, "chat_message");
  assert.equal(delegated.syncJob.conversationId, project.conversationId);
  assert.equal(
    delegated.syncJob.id,
    `sync_router_${delegated.routerRun.id}_${delegated.routerRun.stages[0].id}`
  );
  assert.equal(delegated.transportResult.raw.syncJob.id, delegated.syncJob.id);
  assert.equal((await listSyncJobs(storeRoot)).length, 1);
});

test("bridge tools Router V2 gives web-sync file jobs the persisted Router request id", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "router-input.txt");
  await writeFile(sourcePath, "router file input", "utf8");
  const project = await createProject(storeRoot, {
    name: "Router web file project",
    chatgptProjectUrl: "https://chatgpt.com/c/router-web-file",
    targetRepo: projectRoot,
    conversationId: "router-web-file-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true
  });

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请分析这个文件。",
    waitForGpt: false,
    localFiles: [{ localPath: sourcePath, contentType: "text/plain" }]
  });
  const jobs = await listSyncJobs(storeRoot);

  assert.equal(delegated.routerRun.status, "queued");
  assert.equal(jobs.length, 1);
  assert.equal(delegated.routerRun.stages[0].transportRequestId, jobs[0].id);
  assert.equal(delegated.routerRun.stages[0].submissionState, "submitted");
  assert.match(jobs[0].id, /^sync_router_/);
});

test("bridge tools Router V2 preserves image generation semantics for a local reference image", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "reference.png");
  await writeFile(sourcePath, Buffer.from("reference image bytes"));
  const project = await createProject(storeRoot, {
    name: "Router reference image project",
    chatgptProjectUrl: "https://chatgpt.com/c/router-reference-image",
    targetRepo: projectRoot,
    conversationId: "router-reference-image-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true
  });
  const text = "Use this reference image to generate a new poster image.";

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text,
    waitForGpt: false,
    localFiles: [{ localPath: sourcePath, contentType: "image/png" }]
  });
  const jobs = await listSyncJobs(storeRoot);

  assert.equal(delegated.route.syncKind, "image_request");
  assert.equal(delegated.routerRun.status, "queued");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "image_request");
  assert.equal(jobs[0].payloadText, text);
  assert.equal(jobs[0].inputArtifacts[0].filename, "reference.png");
  assert.ok(delegated.routerRun.stages[0].inputArtifacts[0].id);
  assert.equal(
    delegated.routerRun.stages[0].inputArtifacts[0].id,
    jobs[0].inputArtifacts[0].id
  );
  assert.equal(
    delegated.routerRun.stages[0].inputArtifacts[0].contentHashSha256,
    jobs[0].inputArtifacts[0].contentHashSha256
  );
});

test("bridge tools Router V2 tracks every attachment in one sequential web-sync stage", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const firstPath = path.join(projectRoot, "setting.txt");
  const secondPath = path.join(projectRoot, "characters.txt");
  await writeFile(firstPath, "world setting", "utf8");
  await writeFile(secondPath, "character setting", "utf8");
  const project = await createProject(storeRoot, {
    name: "Router sequential files",
    chatgptProjectUrl: "https://chatgpt.com/c/router-sequential-files",
    targetRepo: projectRoot,
    conversationId: "router-sequential-files-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true
  });

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "我要写一篇玄幻穿越小说。先设计前十集大纲，再写第一章，最后生成小说海报。",
    waitForGpt: false,
    localFiles: [
      { localPath: firstPath, contentType: "text/plain" },
      { localPath: secondPath, contentType: "text/plain" }
    ]
  });
  const jobs = await listSyncJobs(storeRoot);

  assert.equal(delegated.routerRun.status, "queued");
  assert.equal(delegated.routerRun.stages[0].id, "outline");
  assert.equal(delegated.routerRun.stages[1].status, "pending");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, delegated.routerRun.stages[0].transportRequestId);
  assert.equal(jobs[0].inputArtifacts.length, 2);
  assert.deepEqual(
    jobs[0].inputArtifacts.map((artifact) => artifact.filename),
    ["setting.txt", "characters.txt"]
  );
  assert.equal(delegated.artifacts.length, 2);
});

test("bridge file queue retries reuse the Router request without duplicating room messages", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const sourcePath = path.join(projectRoot, "retry-input.txt");
  await writeFile(sourcePath, "same retry input", "utf8");
  const project = await createProject(storeRoot, {
    name: "Router file retry",
    chatgptProjectUrl: "https://chatgpt.com/c/router-file-retry",
    targetRepo: projectRoot,
    conversationId: "router-file-retry-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current"
  });
  const input = {
    requestId: "sync_router_file_retry",
    projectId: project.id,
    conversationId: project.conversationId,
    localPath: sourcePath,
    contentType: "text/plain",
    note: "analyze once"
  };

  const first = await tools.sendLocalFileToChatGptProject(input);
  const second = await tools.sendLocalFileToChatGptProject(input);
  const messages = await tools.listRoomMessages({ conversationId: project.conversationId });
  const artifacts = await tools.listArtifacts({ conversationId: project.conversationId });

  assert.equal(first.syncJob.id, input.requestId);
  assert.equal(second.syncJob.id, input.requestId);
  assert.equal(second.message, null);
  assert.equal(messages.length, 1);
  assert.equal((await listSyncJobs(storeRoot)).length, 1);
  assert.equal(artifacts.length, 1);
});

test("bridge tools Router V2 rejects mixed project and conversation scope before submission", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const projectOne = await createProject(storeRoot, {
    name: "Router scope one",
    chatgptProjectUrl: "https://chatgpt.com/c/router-scope-one",
    targetRepo: path.join(projectRoot, "one"),
    conversationId: "router-scope-one",
    currentCodexThreadId: "thread-current"
  });
  const projectTwo = await createProject(storeRoot, {
    name: "Router scope two",
    chatgptProjectUrl: "https://chatgpt.com/c/router-scope-two",
    targetRepo: path.join(projectRoot, "two"),
    conversationId: "router-scope-two",
    currentCodexThreadId: "thread-current"
  });
  const mock = createMockGptTransport({ responses: { gpt: { replyText: "unused" } } });
  const registry = createGptTransportRegistry({
    transports: [mock],
    defaultTransportId: "mock",
    env: {}
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true,
    gptTransportRegistry: registry,
    gptTransportId: "mock"
  });

  await assert.rejects(
    () =>
      tools.delegateCurrentRequest({
        projectId: projectOne.id,
        conversationId: projectTwo.conversationId,
        text: "请写一个故事。",
        waitForGpt: false
      }),
    /projectId.*conversationId|conversationId.*projectId|scope mismatch/i
  );
  assert.equal(mock.submissions.length, 0);
  assert.equal((await listSyncJobs(storeRoot)).length, 0);
});

test("bridge tools Router V2 isolates continue and cancel by the bound Codex thread", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Router thread owner",
    chatgptProjectUrl: "https://chatgpt.com/c/router-thread",
    targetRepo: projectRoot,
    conversationId: "router-thread-conversation",
    currentCodexThreadId: "thread-owner"
  });
  const mock = createMockGptTransport({
    responses: { gpt: { replyText: "thread result" } },
    requestIdFactory: ({ sequence }) => `thread-request-${sequence}`
  });
  const registry = createGptTransportRegistry({
    transports: [mock],
    defaultTransportId: "mock",
    env: {}
  });
  const ownerTools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-owner",
    routerV2Enabled: true,
    gptTransportRegistry: registry,
    gptTransportId: "mock"
  });
  const otherTools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-other",
    routerV2Enabled: true,
    gptTransportRegistry: registry,
    gptTransportId: "mock"
  });

  const queued = await ownerTools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请写一个故事。",
    waitForGpt: false
  });
  await assert.rejects(
    () =>
      otherTools.continueRouterRun({
        runId: queued.routerRun.id,
        projectId: project.id,
        conversationId: project.conversationId,
        waitForGpt: true
      }),
    /another Codex thread|scope mismatch|bound to another/i
  );
  await assert.rejects(
    () =>
      otherTools.cancelRouterRun({
        runId: queued.routerRun.id,
        projectId: project.id,
        conversationId: project.conversationId
      }),
    /another Codex thread|scope mismatch|bound to another/i
  );
  assert.equal(mock.submissions.length, 1);

  const completed = await ownerTools.continueRouterRun({
    runId: queued.routerRun.id,
    projectId: project.id,
    conversationId: project.conversationId,
    waitForGpt: true
  });
  assert.equal(completed.routerRun.status, "succeeded");
  assert.equal(completed.replyText, "thread result");
  assert.equal(mock.submissions.length, 1);

  const second = await ownerTools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请再写一个故事。",
    waitForGpt: false
  });
  const cancelled = await ownerTools.cancelRouterRun({
    runId: second.routerRun.id,
    projectId: project.id,
    conversationId: project.conversationId,
    reason: "owner cancelled"
  });
  assert.equal(cancelled.routerRun.status, "cancelled");
  assert.equal(cancelled.routerRun.codexThreadId, "thread-owner");
});

test("bridge tools Router V2 requires a configured current Codex thread", async () => {
  const storeRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Router requires thread",
    chatgptProjectUrl: "https://chatgpt.com/c/router-needs-thread",
    targetRepo: await tempStore(),
    conversationId: "router-needs-thread",
    currentCodexThreadId: "thread-owner"
  });
  const mock = createMockGptTransport({ responses: { gpt: { replyText: "unused" } } });
  const tools = createBridgeTools({
    storeRoot,
    routerV2Enabled: true,
    gptTransportRegistry: createGptTransportRegistry({
      transports: [mock],
      defaultTransportId: "mock",
      env: {}
    }),
    gptTransportId: "mock"
  });

  await assert.rejects(
    () =>
      tools.delegateCurrentRequest({
        projectId: project.id,
        conversationId: project.conversationId,
        text: "请写一个故事。",
        waitForGpt: false
      }),
    /current Codex thread/i
  );
  assert.equal(mock.submissions.length, 0);
});

test("bridge tools register the built-in Mock transport for environment-only startup", async (t) => {
  const originalRouterFlag = process.env.BRIDGE_ROUTER_V2;
  const originalTransport = process.env.BRIDGE_GPT_TRANSPORT;
  process.env.BRIDGE_ROUTER_V2 = "1";
  process.env.BRIDGE_GPT_TRANSPORT = "mock";
  t.after(() => {
    if (originalRouterFlag === undefined) delete process.env.BRIDGE_ROUTER_V2;
    else process.env.BRIDGE_ROUTER_V2 = originalRouterFlag;
    if (originalTransport === undefined) delete process.env.BRIDGE_GPT_TRANSPORT;
    else process.env.BRIDGE_GPT_TRANSPORT = originalTransport;
  });

  const storeRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Built-in mock project",
    chatgptProjectUrl: "https://chatgpt.com/c/built-in-mock",
    targetRepo: await tempStore(),
    conversationId: "built-in-mock-conversation",
    currentCodexThreadId: "thread-current"
  });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current"
  });

  const delegated = await tools.delegateCurrentRequest({
    projectId: project.id,
    conversationId: project.conversationId,
    text: "请写一个短故事。",
    waitForGpt: false
  });

  assert.equal(delegated.routerRun.transportId, "mock");
  assert.equal(delegated.transportResult.transportId, "mock");
  assert.equal((await listSyncJobs(storeRoot)).length, 0);
});

test("bridge tools Router V2 requires both projectId and conversationId from the caller", async () => {
  const storeRoot = await tempStore();
  const project = await createProject(storeRoot, {
    name: "Exact scope project",
    chatgptProjectUrl: "https://chatgpt.com/c/exact-scope",
    targetRepo: await tempStore(),
    conversationId: "exact-scope-conversation",
    currentCodexThreadId: "thread-current"
  });
  const mock = createMockGptTransport({ responses: { gpt: { replyText: "unused" } } });
  const tools = createBridgeTools({
    storeRoot,
    currentCodexThreadId: "thread-current",
    routerV2Enabled: true,
    gptTransportRegistry: createGptTransportRegistry({
      transports: [mock],
      defaultTransportId: "mock",
      env: {}
    }),
    gptTransportId: "mock"
  });

  const projectOnly = await tools.delegateCurrentRequest({
    projectId: project.id,
    text: "请写一个故事。",
    waitForGpt: false
  });
  const conversationOnly = await tools.delegateCurrentRequest({
    conversationId: project.conversationId,
    text: "请写一个故事。",
    waitForGpt: false
  });

  assert.equal(projectOnly.action, "scope_required");
  assert.equal(conversationOnly.action, "scope_required");
  assert.match(projectOnly.error, /both projectId and conversationId/i);
  assert.match(conversationOnly.error, /both projectId and conversationId/i);
  assert.equal(projectOnly.routerRun, null);
  assert.equal(conversationOnly.routerRun, null);
  assert.equal(mock.submissions.length, 0);
});
