import { cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { assertPortableUserPackageText, buildUserPackagePlan } from "../src/user-package.js";

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

async function readPackageMetadata() {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  return { packageJson, version: packageJson.version || "0.1.95" };
}

const TEXT_PACKAGE_EXTENSIONS = new Set([".cmd", ".css", ".html", ".js", ".json", ".md", ".mjs", ".ps1", ".toml"]);

async function auditPortablePackageTree(rootDir, currentDir = rootDir) {
  for (const entry of await readdir(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await auditPortablePackageTree(rootDir, fullPath);
      continue;
    }
    if (!TEXT_PACKAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const info = await stat(fullPath);
    if (info.size > 2 * 1024 * 1024) continue;
    assertPortableUserPackageText(path.relative(rootDir, fullPath), await readFile(fullPath, "utf8"));
  }
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
  const { packageJson, version } = await readPackageMetadata();
  const outputRoot = process.argv[2] || "release";
  const packageDirName = `CodexBridge-User-Package-v${version}-${timestamp()}`;
  const outputDir = path.resolve(outputRoot, packageDirName);
  if (await fileExists(outputDir)) {
    throw new Error(`Package directory already exists: ${outputDir}`);
  }

  const plan = buildUserPackagePlan({
    version,
    packageName: packageDirName,
    packageDir: "<CodexBridge 安装目录>",
    packageJson
  });

  await mkdir(outputDir, { recursive: true });
  for (const entry of plan.entries) {
    await copyEntry(entry, outputDir);
  }
  await auditPortablePackageTree(outputDir);
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
