import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimNextInboxItem,
  completeInboxItem,
  createInboxItem,
  getInboxItem,
  listInboxItems
} from "../src/codex-inbox-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-inbox-"));
}

test("createInboxItem persists a pending instruction for the current Codex thread", async () => {
  const storeRoot = await tempStore();

  const item = await createInboxItem(storeRoot, {
    source: "chatgpt_project",
    projectUrl: "https://chatgpt.com/project/demo",
    targetRepo: "F:/game_code/demo",
    syncJobId: "sync_1",
    promptText: "Check the login module and report verification steps."
  });

  assert.match(item.id, /^inbox_\d{8}T\d{6}_/);
  assert.equal(item.status, "pending");
  assert.equal(item.source, "chatgpt_project");
  assert.equal(item.targetRepo, "F:/game_code/demo");

  const saved = await getInboxItem(storeRoot, item.id);
  assert.equal(saved.promptText, "Check the login module and report verification steps.");
});

test("claimNextInboxItem claims the oldest pending instruction once", async () => {
  const storeRoot = await tempStore();
  const first = await createInboxItem(storeRoot, {
    promptText: "First instruction"
  });
  await createInboxItem(storeRoot, {
    promptText: "Second instruction"
  });

  const claimed = await claimNextInboxItem(storeRoot, {
    workerId: "current-codex-thread"
  });

  assert.equal(claimed.id, first.id);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.workerId, "current-codex-thread");

  const items = await listInboxItems(storeRoot);
  assert.deepEqual(
    items.map((item) => item.status).sort(),
    ["pending", "running"]
  );
});

test("completeInboxItem stores the current Codex thread result", async () => {
  const storeRoot = await tempStore();
  const item = await createInboxItem(storeRoot, {
    promptText: "Inspect the project."
  });
  const claimed = await claimNextInboxItem(storeRoot, {
    workerId: "current-codex-thread"
  });

  const completed = await completeInboxItem(storeRoot, claimed.id, {
    resultText: "Checked files, fixed one issue, tests passed."
  });

  assert.equal(completed.id, item.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.resultText, "Checked files, fixed one issue, tests passed.");
});
