import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getArtifact,
  listArtifacts,
  readArtifactText,
  saveArtifactToProject,
  saveArtifactFromBase64,
  saveArtifactFromLocalFile
} from "../src/artifact-store.js";

async function tempStore() {
  return mkdtemp(path.join(tmpdir(), "bridge-artifacts-"));
}

test("saveArtifactFromBase64 persists downloaded ChatGPT files for Codex post-processing", async () => {
  const storeRoot = await tempStore();

  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_1",
    conversationId: "conv_1",
    sourceMessageId: "roommsg_1",
    filename: "../report.txt",
    contentType: "text/plain",
    originalUrl: "blob:https://chatgpt.com/demo",
    base64Data: Buffer.from("hello from gpt", "utf8").toString("base64")
  });

  assert.equal(artifact.syncJobId, "sync_1");
  assert.equal(artifact.filename, "report.txt");
  assert.equal(artifact.contentType, "text/plain");
  assert.equal(artifact.sizeBytes, 14);
  assert.match(artifact.filePath, /report\.txt$/);
  assert.equal(await readFile(artifact.filePath, "utf8"), "hello from gpt");

  const listed = await listArtifacts(storeRoot, { syncJobId: "sync_1" });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, artifact.id);

  const loaded = await getArtifact(storeRoot, artifact.id);
  assert.equal(loaded.filePath, artifact.filePath);

  const text = await readArtifactText(storeRoot, artifact.id);
  assert.equal(text.text, "hello from gpt");
});

test("saveArtifactFromBase64 gives generic ChatGPT images readable filenames", async () => {
  const storeRoot = await tempStore();

  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_image",
    conversationId: "conv_image",
    sourceMessageId: "roommsg_image",
    filename: "content",
    contentType: "image/png",
    base64Data: Buffer.from("fake image bytes", "utf8").toString("base64")
  });

  assert.match(artifact.filename, /^chatgpt-image-[a-f0-9]{6}\.png$/);
  assert.match(artifact.filePath, /chatgpt-image-[a-f0-9]{6}\.png$/);
});

test("saveArtifactFromBase64 appends content-type extensions to extensionless files", async () => {
  const storeRoot = await tempStore();

  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_pdf",
    conversationId: "conv_pdf",
    sourceMessageId: "roommsg_pdf",
    filename: "brief",
    contentType: "application/pdf",
    base64Data: Buffer.from("%PDF fake", "utf8").toString("base64")
  });

  assert.equal(artifact.filename, "brief.pdf");
  assert.match(artifact.filePath, /brief\.pdf$/);
});

test("getArtifact presents legacy generic ChatGPT image names without renaming files", async () => {
  const storeRoot = await tempStore();
  const artifactId = "artifact_20260627T000000_abcdef";
  const directory = path.join(storeRoot, "artifacts", artifactId);
  const filePath = path.join(directory, "content");
  await mkdir(directory, { recursive: true });
  await writeFile(filePath, "legacy image bytes", "utf8");
  await writeFile(
    path.join(directory, "metadata.json"),
    `${JSON.stringify(
      {
        id: artifactId,
        syncJobId: "sync_legacy",
        conversationId: "conv_legacy",
        sourceMessageId: "roommsg_legacy",
        filename: "content",
        contentType: "image/png",
        sizeBytes: 18,
        originalUrl: null,
        filePath,
        createdAt: "2026-06-27T00:00:00.000Z"
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const artifact = await getArtifact(storeRoot, artifactId);

  assert.equal(artifact.filename, "chatgpt-image-abcdef.png");
  assert.equal(artifact.filePath, filePath);
});

test("saveArtifactFromLocalFile imports a completed browser download as an artifact", async () => {
  const storeRoot = await tempStore();
  const downloadDir = await mkdtemp(path.join(tmpdir(), "bridge-download-"));
  const sourcePath = path.join(downloadDir, "deck.pptx");
  const bytes = Buffer.from("fake pptx bytes", "utf8");
  await writeFile(sourcePath, bytes);

  const artifact = await saveArtifactFromLocalFile(storeRoot, {
    syncJobId: "sync_download",
    conversationId: "conv_download",
    sourceMessageId: "roommsg_download",
    localPath: sourcePath,
    filename: "deck.pptx",
    contentType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    originalUrl: "https://chatgpt.com/backend-api/files/deck"
  });

  assert.equal(artifact.syncJobId, "sync_download");
  assert.equal(artifact.filename, "deck.pptx");
  assert.equal(artifact.sizeBytes, bytes.length);
  assert.equal(await readFile(artifact.filePath, "utf8"), "fake pptx bytes");
  assert.notEqual(artifact.filePath, sourcePath);
});

test("saveArtifactToProject copies an artifact into a project artifact folder without overwriting", async () => {
  const storeRoot = await tempStore();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "bridge-project-"));
  const artifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_project",
    conversationId: "conv_project",
    sourceMessageId: "roommsg_project",
    filename: "notes.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("fresh artifact", "utf8").toString("base64")
  });
  const changedArtifact = await saveArtifactFromBase64(storeRoot, {
    syncJobId: "sync_project_2",
    conversationId: "conv_project",
    sourceMessageId: "roommsg_project_2",
    filename: "notes.txt",
    contentType: "text/plain",
    base64Data: Buffer.from("changed artifact", "utf8").toString("base64")
  });

  const first = await saveArtifactToProject(storeRoot, artifact.id, projectRoot);
  const second = await saveArtifactToProject(storeRoot, artifact.id, projectRoot);
  const third = await saveArtifactToProject(storeRoot, changedArtifact.id, projectRoot);

  assert.equal(first.filename, "notes.txt");
  assert.equal(second.filename, "notes.txt");
  assert.equal(second.reused, true);
  assert.equal(third.filename, "notes-1.txt");
  assert.equal(await readFile(first.savedPath, "utf8"), "fresh artifact");
  assert.equal(await readFile(second.savedPath, "utf8"), "fresh artifact");
  assert.equal(await readFile(third.savedPath, "utf8"), "changed artifact");
  assert.match(first.savedPath, /chatgpt-artifacts[\\/]notes\.txt$/);
  assert.match(second.savedPath, /chatgpt-artifacts[\\/]notes\.txt$/);
  assert.match(third.savedPath, /chatgpt-artifacts[\\/]notes-1\.txt$/);
});
