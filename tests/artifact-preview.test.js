import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildArtifactPreview } from "../src/artifact-preview.js";

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const [filename, value] of Object.entries(entries)) {
    const name = Buffer.from(filename, "utf8");
    const data = Buffer.from(value, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

async function writeArtifact(filename, content, contentType = "application/octet-stream") {
  const dir = await mkdtemp(path.join(tmpdir(), "bridge-preview-"));
  const filePath = path.join(dir, filename);
  await writeFile(filePath, content);
  return {
    id: `artifact_${filename.replace(/\W+/g, "_")}`,
    filename,
    contentType,
    filePath,
    sizeBytes: Buffer.byteLength(content)
  };
}

test("buildArtifactPreview extracts Word document text", async () => {
  const artifact = await writeArtifact(
    "brief.docx",
    zipBuffer({
      "word/document.xml": [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<w:document><w:body>",
        "<w:p><w:r><w:t>第一段标题</w:t></w:r></w:p>",
        "<w:p><w:r><w:t>第二段正文</w:t></w:r></w:p>",
        "</w:body></w:document>"
      ].join("")
    }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );

  const preview = await buildArtifactPreview(artifact);

  assert.equal(preview.kind, "document");
  assert.deepEqual(preview.preview.paragraphs, ["第一段标题", "第二段正文"]);
});

test("buildArtifactPreview returns fuller Word text when requested", async () => {
  const paragraphs = Array.from(
    { length: 20 },
    (_, index) => `<w:p><w:r><w:t>Paragraph ${index + 1}</w:t></w:r></w:p>`
  );
  const artifact = await writeArtifact(
    "long-brief.docx",
    zipBuffer({
      "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document><w:body>${paragraphs.join("")}</w:body></w:document>`
    }),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );

  const compact = await buildArtifactPreview(artifact);
  const full = await buildArtifactPreview(artifact, { full: true });

  assert.equal(compact.preview.paragraphs.length, 12);
  assert.equal(compact.preview.truncated, true);
  assert.equal(full.preview.paragraphs.length, 20);
  assert.equal(full.preview.truncated, false);
  assert.equal(full.preview.paragraphs.at(-1), "Paragraph 20");
});

test("buildArtifactPreview lists ZIP entries", async () => {
  const artifact = await writeArtifact(
    "bundle.zip",
    zipBuffer({
      "docs/readme.md": "# Hello",
      "images/photo.png": "png-bytes"
    }),
    "application/zip"
  );

  const preview = await buildArtifactPreview(artifact);

  assert.equal(preview.kind, "archive");
  assert.equal(preview.preview.entryCount, 2);
  assert.deepEqual(
    preview.preview.entries.map((entry) => entry.name),
    ["docs/readme.md", "images/photo.png"]
  );
});

test("buildArtifactPreview reads PSD header information", async () => {
  const psd = Buffer.alloc(26);
  psd.write("8BPS", 0, "ascii");
  psd.writeUInt16BE(1, 4);
  psd.writeUInt16BE(3, 12);
  psd.writeUInt32BE(1080, 14);
  psd.writeUInt32BE(1920, 18);
  psd.writeUInt16BE(8, 22);
  psd.writeUInt16BE(3, 24);
  const artifact = await writeArtifact("mockup.psd", psd, "image/vnd.adobe.photoshop");

  const preview = await buildArtifactPreview(artifact);

  assert.equal(preview.kind, "psd");
  assert.equal(preview.preview.width, 1920);
  assert.equal(preview.preview.height, 1080);
  assert.equal(preview.preview.channels, 3);
  assert.equal(preview.preview.colorMode, "RGB");
});

test("buildArtifactPreview summarizes PDF metadata", async () => {
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF");
  const artifact = await writeArtifact("report.pdf", pdf, "application/pdf");

  const preview = await buildArtifactPreview(artifact);

  assert.equal(preview.kind, "pdf");
  assert.equal(preview.preview.pageCount, 2);
  assert.equal(preview.preview.canInlinePreview, true);
});

test("buildArtifactPreview keeps long natural language text readable", async () => {
  const text = `${"long plan paragraph\n\n".repeat(500)}ending`;
  assert.ok(text.length > 8000);
  const artifact = await writeArtifact("plan.txt", text, "text/plain");

  const preview = await buildArtifactPreview(artifact);

  assert.equal(preview.kind, "text");
  assert.equal(preview.preview.text.length, text.length);
  assert.equal(preview.preview.truncated, false);
  assert.equal(preview.preview.charCount, text.length);
  assert.ok(preview.preview.lineCount > 500);
});

test("buildArtifactPreview treats XML and YAML extensions as text even with application content types", async () => {
  const xml = await writeArtifact("config.xml", "<bridge enabled=\"true\" />", "application/xml");
  const yaml = await writeArtifact("config.yaml", "bridge:\n  enabled: true\n", "application/x-yaml");

  const xmlPreview = await buildArtifactPreview(xml);
  const yamlPreview = await buildArtifactPreview(yaml);

  assert.equal(xmlPreview.kind, "text");
  assert.match(xmlPreview.preview.text, /bridge/);
  assert.equal(yamlPreview.kind, "text");
  assert.match(yamlPreview.preview.text, /enabled/);
});

test("buildArtifactPreview avoids loading huge files into the page preview", async () => {
  const preview = await buildArtifactPreview({
    id: "artifact_huge_docx",
    filename: "huge-report.docx",
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    filePath: path.join(tmpdir(), "bridge-preview-file-that-should-not-be-read.docx"),
    sizeBytes: 50_000_000
  });

  assert.equal(preview.kind, "file");
  assert.equal(preview.preview.large, true);
  assert.match(preview.preview.message, /完整文件已交给 GPT/);
  assert.match(preview.preview.message, /Bridge 只展示摘要/);
});
