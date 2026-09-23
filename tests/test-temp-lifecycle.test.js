import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createTestDirectory } from "../scripts/run-tests.js";

const execute = promisify(execFile);

test("test cleanup refuses a changed ownership marker before deleting files", async () => {
  const run = await createTestDirectory();
  const owner = path.join(run.directory, ".bridge-test-owner.json");
  const receipt = await readFile(owner, "utf8");
  const sentinel = path.join(run.directory, "keep.txt");
  try {
    await writeFile(sentinel, "UNCHANGED");
    await writeFile(owner, "{}");
    await assert.rejects(run.cleanup(), /ownership mismatch/);
    assert.equal(await readFile(sentinel, "utf8"), "UNCHANGED");
  } finally { await writeFile(owner, receipt); await run.cleanup(); }
});

test("test cleanup refuses a directory link without touching its target", async () => {
  const run = await createTestDirectory();
  const external = await mkdtemp(path.resolve(".bridge", "test-runner-outside-"));
  const sentinel = path.join(external, "keep.txt"), ownFile = path.join(run.directory, "keep.txt");
  const link = path.join(run.directory, "external-link");
  try {
    await writeFile(sentinel, "OUTSIDE");
    await writeFile(ownFile, "INSIDE");
    await symlink(external, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(run.cleanup(), /linked test artifact/);
    assert.equal(await readFile(sentinel, "utf8"), "OUTSIDE");
    assert.equal(await readFile(ownFile, "utf8"), "INSIDE");
  } finally {
    await unlink(link).catch(e => { if (e.code !== "ENOENT") throw e; });
    await run.cleanup(); await unlink(sentinel); await rmdir(external);
  }
});

for (const fails of [false, true]) {
  test(`npm test isolates and reclaims its own temporary files: failure=${fails}`, async t => {
    const parent = await mkdtemp(path.resolve(".bridge", "test-runner-probe-"));
    const sentinel = path.join(parent, "keep.txt");
    await writeFile(sentinel, "PARENT_MUST_SURVIVE");
    t.after(async () => {
      // Explicit test-owned files only; also clean up the pre-fix probe.
      await unlink(path.join(parent, "probe-nested", "probe.bin")).catch(e => { if (e.code !== "ENOENT") throw e; });
      await rmdir(path.join(parent, "probe-nested")).catch(e => { if (e.code !== "ENOENT") throw e; });
      await unlink(sentinel);
      await rmdir(parent);
    });
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const args = pkg.scripts.test.split(/\s+/).slice(1);
    const env = { ...process.env, TEMP: parent, TMP: parent, TMPDIR: parent, BRIDGE_TEST_PROBE_FAIL: fails ? "1" : "0" };
    delete env.NODE_TEST_CONTEXT;
    const result = await execute(process.execPath, [...args, "tests/fixtures/temp-lifecycle-probe.mjs"], {
      cwd: process.cwd(), env,
      windowsHide: true, maxBuffer: 1024 * 1024
    }).then(r => ({ ...r, code: 0 }), e => ({ stdout: e.stdout || "", stderr: e.stderr || "", code: e.code }));
    assert.equal(result.code, fails ? 1 : 0, result.stderr);
    const probeRoot = result.stdout.match(/PROBE_TEMP=([^\r\n]+)/)?.[1]?.trim();
    assert.ok(probeRoot, result.stdout);
    assert.notEqual(probeRoot, parent, "the test entry point must not reuse an inherited live temp directory");
    assert.equal(path.dirname(probeRoot), path.resolve(".bridge", "test-runs"));
    assert.match(path.basename(probeRoot), /^run-/);
    await assert.rejects(access(probeRoot), { code: "ENOENT" });
    assert.equal(await readFile(sentinel, "utf8"), "PARENT_MUST_SURVIVE");
    const log = result.stdout.match(/BRIDGE_TEST_LOG=([^\r\n]+)/)?.[1]?.trim();
    assert.ok(log, "test diagnostics must outlive temporary data");
    const logText = await readFile(log, "utf8");
    assert.match(logText, /temporary lifecycle probe/);
    if (fails) assert.match(logText, /intentional probe failure/);
  });
}
