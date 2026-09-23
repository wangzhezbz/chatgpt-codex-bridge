import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const base = path.join(repo, ".bridge", "test-runs");
const marker = ".bridge-test-owner.json";
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

async function assertPlainPath(target) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Refusing linked test path: ${current}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (path.dirname(current) === current) break;
  }
}

export async function createTestDirectory() {
  await assertPlainPath(base);
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "run-"));
  const nonce = randomBytes(24).toString("hex");
  await writeFile(path.join(directory, marker), JSON.stringify({ nonce, directory }), { flag: "wx" });
  return {
    directory,
    async cleanup() {
      await assertPlainPath(directory);
      if (!samePath(path.dirname(directory), base) || !/^run-[a-z0-9]{6}$/i.test(path.basename(directory)) ||
          !samePath(await realpath(directory), directory)) throw new Error("Test cleanup scope mismatch");
      const ownerPath = path.join(directory, marker);
      if ((await lstat(ownerPath)).isSymbolicLink()) throw new Error("Linked test owner marker");
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      if (owner.nonce !== nonce || owner.directory !== directory) throw new Error("Test cleanup ownership mismatch");
      const files = [], dirs = [];
      async function collect(current) {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new Error(`Refusing linked test artifact: ${current}`);
        if (!info.isDirectory()) { if (current !== ownerPath) files.push(current); return; }
        for (const name of await readdir(current)) {
          const child = path.resolve(current, name);
          if (!child.startsWith(directory + path.sep)) throw new Error("Test artifact escaped run directory");
          await collect(child);
        }
        if (current !== directory) dirs.push(current);
      }
      // Validate the entire tree before deleting anything. No glob or recursive delete.
      await collect(directory);
      for (const file of files) { await assertPlainPath(file); await unlink(file); }
      for (const dir of dirs) { await assertPlainPath(dir); await rmdir(dir); }
      await unlink(ownerPath);
      await rmdir(directory);
    }
  };
}

async function main() {
  const run = await createTestDirectory();
  const logDir = path.join(base, "logs");
  await assertPlainPath(logDir);
  await mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, `${path.basename(run.directory)}.log`);
  const log = createWriteStream(logPath, { flags: "wx" });
  let interrupted = false, logError = null;
  const env = { ...process.env, TEMP: run.directory, TMP: run.directory, TMPDIR: run.directory };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["--max-old-space-size=4096", "--test", "--test-concurrency=8", ...process.argv.slice(2)], {
    cwd: repo, env, windowsHide: true, stdio: ["inherit", "pipe", "pipe"]
  });
  const interrupt = signal => { interrupted = true; child.kill(signal); };
  const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  log.on("error", error => { logError = error; interrupted = true; child.kill(); });
  for (const [stream, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on("data", chunk => { output.write(chunk); if (!log.write(chunk)) stream.pause(); });
    log.on("drain", () => stream.resume());
  }
  child.on("error", error => process.stderr.write(`${error.message}\n`));
  const code = await new Promise(resolve => child.once("close", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1)));
  log.end();
  try { await finished(log); } catch (error) { logError ||= error; }
  process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
  console.log(`BRIDGE_TEST_LOG=${logPath}`);
  process.exitCode = code || (logError ? 1 : 0);
  if (interrupted) {
    process.exitCode = 1;
    console.error(`Test run interrupted; temporary data retained for safe inspection: ${run.directory}`);
  } else {
    try { await run.cleanup(); console.log("BRIDGE_TEST_TEMP_CLEANED"); }
    catch (error) { process.exitCode ||= 1; console.error(`Test cleanup stopped: ${error.message}; retained: ${run.directory}`); }
  }
}

if (process.argv[1] && samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
