import { execFile } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { buildEmbeddedPackagePlan } from "../src/embedded-package.js";

const execFileAsync = promisify(execFile);
const FORBIDDEN_SEGMENTS = new Set([
  ".bridge",
  ".git",
  "node_modules",
  "release",
  "tests",
  "test-data",
  "logs",
  "docs",
  "output"
]);

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

function pathIsAllowed(value) {
  return !path
    .relative(process.cwd(), path.resolve(value))
    .split(path.sep)
    .some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()));
}

async function copyEntry(entry, outputDir) {
  const target = path.join(outputDir, entry.to);
  const excludedPaths = new Set((entry.exclude || []).map((value) => path.resolve(value)));
  await mkdir(path.dirname(target), { recursive: true });
  const sourceStat = await stat(entry.from);
  if (sourceStat.isDirectory()) {
    await cp(entry.from, target, {
      recursive: true,
      filter(source) {
        return pathIsAllowed(source) && !excludedPaths.has(path.resolve(source));
      }
    });
    return;
  }
  await cp(entry.from, target);
}

async function auditTree(rootDir, currentDir = rootDir) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(rootDir, fullPath);
    const segments = relativePath.split(path.sep).map((segment) => segment.toLowerCase());
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) {
      throw new Error(`Embedded package contains forbidden path: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      await auditTree(rootDir, fullPath);
    }
  }
}

async function createZipArchive(outputDir, archivePath) {
  if (process.platform !== "win32") {
    return false;
  }
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  await execFileAsync("powershell", [
    "-NoProfile",
    "-Command",
    `Compress-Archive -LiteralPath ${quote(outputDir)} -DestinationPath ${quote(archivePath)} -Force`
  ]);
  return true;
}

async function main() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const version = packageJson.version || "0.1.0";
  const outputRoot = path.resolve(process.argv[2] || "release");
  const packageName = `ChatGPT-Codex-Bridge-Embedded-v${version}-${timestamp()}`;
  const outputDir = path.join(outputRoot, packageName);
  const plan = buildEmbeddedPackagePlan({ version, packageName });

  await mkdir(outputDir, { recursive: false });
  for (const entry of plan.entries) {
    await copyEntry(entry, outputDir);
  }
  await auditTree(outputDir);

  const archivePath = path.join(outputRoot, plan.archiveName);
  const zipped = await createZipArchive(outputDir, archivePath);
  console.log(outputDir);
  if (zipped) {
    console.log(archivePath);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
