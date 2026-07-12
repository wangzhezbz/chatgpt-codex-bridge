import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { buildUserPackagePlan } from "../src/user-package.js";

const execFileAsync = promisify(execFile);

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  return pkg.version || "0.1.0";
}

async function copyEntry(entry, outputDir) {
  const target = path.join(outputDir, entry.to);
  await mkdir(path.dirname(target), { recursive: true });
  if (entry.content !== undefined) {
    await writeFile(target, entry.content, "utf8");
    return;
  }
  const sourceStat = await stat(entry.from);
  if (sourceStat.isDirectory()) {
    await cp(entry.from, target, {
      recursive: true,
      filter(source) {
        const normalized = source.replaceAll("\\", "/");
        return !/(^|\/)(node_modules|\.bridge|\.git|output|release)(\/|$)/.test(normalized);
      }
    });
    return;
  }
  await cp(entry.from, target);
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
  const version = await readPackageVersion();
  const outputRoot = process.argv[2] || "release";
  const packageDirName = `CodexBridge-User-Package-v${version}-${timestamp()}`;
  const outputDir = path.resolve(outputRoot, packageDirName);
  if (await fileExists(outputDir)) {
    throw new Error(`Package directory already exists: ${outputDir}`);
  }

  const plan = buildUserPackagePlan({
    version,
    packageName: packageDirName,
    packageDir: "<CodexBridge 安装目录>"
  });

  await mkdir(outputDir, { recursive: true });
  for (const entry of plan.entries) {
    await copyEntry(entry, outputDir);
  }
  await writeFile(
    path.join(outputDir, "PACKAGE_MANIFEST.json"),
    JSON.stringify(
      {
        name: packageDirName,
        version,
        createdAt: new Date().toISOString(),
        entries: plan.entries.map((entry) => entry.to)
      },
      null,
      2
    ),
    "utf8"
  );

  const archivePath = path.join(path.dirname(outputDir), plan.archiveName);
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
