import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listExtensionHeartbeats,
  saveExtensionHeartbeat
} from "../src/extension-heartbeat-store.js";

test("concurrent extension heartbeats preserve every active GPT tab", async (t) => {
  const storeRoot = await mkdtemp(path.join(tmpdir(), "bridge-heartbeat-race-"));
  t.after(async () => {
    await unlink(path.join(storeRoot, "extension", "heartbeat.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(path.join(storeRoot, "extension")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rmdir(storeRoot).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  });

  const expectedWorkerIds = Array.from({ length: 10 }, (_, index) => `worker-${index}`);
  await Promise.all(
    expectedWorkerIds.map((workerId, index) =>
      saveExtensionHeartbeat(storeRoot, {
        workerId,
        href: `https://chatgpt.com/c/conversation-${index}`,
        pageStatus: { state: "ready" }
      })
    )
  );

  const records = await listExtensionHeartbeats(storeRoot, { includeDisconnected: true });
  assert.deepEqual(
    records.map((record) => record.workerId).sort(),
    expectedWorkerIds.sort()
  );
});
