import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendEvent,
  createTask,
  getTask,
  listTasks,
  updateTask,
  writeResult
} from "../src/task-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-store-"));
}

test("createTask persists prompt, metadata, and a created event", async () => {
  const storeRoot = await tempStore();

  const task = await createTask(storeRoot, {
    title: "Refactor payments",
    prompt: "Inspect payment errors and propose a safe refactor.",
    targetRepo: "F:/game_code/demo",
    source: "chatgpt"
  });

  assert.match(task.id, /^task_\d{8}T\d{6}_/);
  assert.equal(task.title, "Refactor payments");
  assert.equal(task.status, "queued");
  assert.equal(task.targetRepo, "F:/game_code/demo");

  const saved = await getTask(storeRoot, task.id);
  assert.equal(saved.promptPath.endsWith("PROMPT.md"), true);

  const prompt = await readFile(saved.promptPath, "utf8");
  assert.equal(prompt, "Inspect payment errors and propose a safe refactor.\n");

  const events = await readFile(path.join(storeRoot, "tasks", task.id, "events.ndjson"), "utf8");
  const firstEvent = JSON.parse(events.trim());
  assert.equal(firstEvent.type, "task.created");
  assert.equal(firstEvent.taskId, task.id);
});
test("listTasks returns newest tasks first and updateTask patches status", async () => {
  const storeRoot = await tempStore();
  const first = await createTask(storeRoot, { title: "First", prompt: "one" });
  const second = await createTask(storeRoot, { title: "Second", prompt: "two" });

  await updateTask(storeRoot, first.id, { status: "running" });
  await appendEvent(storeRoot, first.id, { type: "runner.started", message: "Runner started" });

  const tasks = await listTasks(storeRoot);
  assert.deepEqual(tasks.map((task) => task.title), ["Second", "First"]);

  const updated = await getTask(storeRoot, first.id);
  assert.equal(updated.status, "running");

  const events = await readFile(path.join(storeRoot, "tasks", first.id, "events.ndjson"), "utf8");
  assert.match(events, /runner\.started/);
});

test("writeResult stores result text and marks the task succeeded", async () => {
  const storeRoot = await tempStore();
  const task = await createTask(storeRoot, { title: "Result", prompt: "produce result" });

  const resultPath = await writeResult(storeRoot, task.id, "Task finished.");

  assert.equal(resultPath.endsWith("RESULT.md"), true);
  assert.equal(await readFile(resultPath, "utf8"), "Task finished.\n");

  const updated = await getTask(storeRoot, task.id);
  assert.equal(updated.status, "succeeded");
  assert.equal(updated.resultPath, resultPath);
});
