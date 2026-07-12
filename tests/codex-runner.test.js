import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createTask, getTask } from "../src/task-store.js";
import { buildCodexExecArgs, runTask } from "../src/codex-runner.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-runner-"));
}

test("runTask uses manual fallback unless codex mode is explicitly enabled", async () => {
  const storeRoot = await tempStore();
  const task = await createTask(storeRoot, {
    title: "Manual task",
    prompt: "Add a README section.",
    targetRepo: "F:/game_code/demo"
  });

  const result = await runTask(storeRoot, task.id, { runnerMode: "manual" });

  assert.equal(result.mode, "manual");
  assert.equal(result.status, "waiting_for_codex");

  const updated = await getTask(storeRoot, task.id);
  assert.equal(updated.status, "waiting_for_codex");
  assert.equal(updated.resultPath.endsWith("RESULT.md"), true);

  const resultText = await readFile(updated.resultPath, "utf8");
  assert.match(resultText, /手动交给 Codex/);
  assert.match(resultText, /Add a README section/);
});

test("runTask rejects unknown runner modes without changing to succeeded", async () => {
  const storeRoot = await tempStore();
  const task = await createTask(storeRoot, { title: "Bad mode", prompt: "do work" });

  await assert.rejects(
    () => runTask(storeRoot, task.id, { runnerMode: "space-laser" }),
    /Unsupported runner mode/
  );

  const updated = await getTask(storeRoot, task.id);
  assert.equal(updated.status, "queued");
});

test("buildCodexExecArgs targets the selected repo and permits non-git folders", () => {
  const args = buildCodexExecArgs("F:/game_code/test", "Create AAA.txt");

  assert.deepEqual(args, [
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    "F:/game_code/test",
    "Create AAA.txt"
  ]);
});

test("runTask marks codex runs failed when the process times out", async () => {
  const storeRoot = await tempStore();
  const task = await createTask(storeRoot, {
    title: "Timeout task",
    prompt: "This command will hang.",
    targetRepo: storeRoot
  });

  const result = await runTask(storeRoot, task.id, {
    runnerMode: "codex",
    codexCommand: process.execPath,
    codexExtraArgs: ["-e", "setTimeout(() => {}, 10_000)"],
    timeoutMs: 50
  });

  assert.equal(result.status, "failed");
  assert.equal(result.timedOut, true);

  const updated = await getTask(storeRoot, task.id);
  assert.equal(updated.status, "failed");

  const resultText = await readFile(updated.resultPath, "utf8");
  assert.match(resultText, /超时/);
});

test("runTask closes child stdin so codex does not wait for extra input", async () => {
  const storeRoot = await tempStore();
  const task = await createTask(storeRoot, {
    title: "Stdin task",
    prompt: "The child should exit after stdin closes.",
    targetRepo: storeRoot
  });

  const result = await runTask(storeRoot, task.id, {
    runnerMode: "codex",
    codexCommand: process.execPath,
    codexExtraArgs: ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume();"],
    timeoutMs: 5000
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.timedOut, false);
});
