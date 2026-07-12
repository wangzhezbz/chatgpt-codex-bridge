const EMBEDDED_COPY_ENTRIES = [
  "src",
  "public",
  "chrome-extension",
  "package.json",
  "package-lock.json",
  "embedded-manifest.json",
  "LICENSE"
];

export function buildEmbeddedPackagePlan(options = {}) {
  const version = options.version || "0.1.0";
  const packageName = options.packageName || `ChatGPT-Codex-Bridge-Embedded-v${version}`;
  return {
    packageName,
    archiveName: `${packageName}.zip`,
    version,
    entries: EMBEDDED_COPY_ENTRIES.map((from) => ({
      from,
      to: from,
      ...(from === "src" ? { exclude: ["src/embedded-package.js"] } : {})
    }))
  };
}
