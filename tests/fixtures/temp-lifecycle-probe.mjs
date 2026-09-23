import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("temporary lifecycle probe", async () => {
  const root = tmpdir();
  await mkdir(path.join(root, "probe-nested"));
  await writeFile(path.join(root, "probe-nested", "probe.bin"), Buffer.alloc(4096));
  console.log(`PROBE_TEMP=${root}`);
  assert.notEqual(process.env.BRIDGE_TEST_PROBE_FAIL, "1", "intentional probe failure");
});
