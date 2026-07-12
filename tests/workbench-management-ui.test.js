import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("workbench can manage projects and conversations without page-length drift", async () => {
  const html = await readFile("public/index.html", "utf8");
  const js = await readFile("public/app.js", "utf8");
  const css = await readFile("public/styles.css", "utf8");

  assert.match(html, /id="clearMessagesButton"/);
  assert.match(js, /async function deleteProject/);
  assert.match(js, /\/api\/projects\/current-session/);
  assert.match(js, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(js, /method: "DELETE"/);
  assert.match(js, /async function deleteRoomMessage/);
  assert.match(js, /\/api\/room\/messages\/\$\{encodeURIComponent\(messageId\)\}/);
  assert.match(js, /async function clearRoomConversation/);
  assert.match(js, /\/api\/room\/messages"/);
  assert.match(js, /clearMessagesButton\.addEventListener\("click", clearRoomConversation\)/);
  assert.match(js, /className = "project-card-actions"/);
  assert.match(js, /className = "message-header-actions"/);
  assert.match(js, /className = "message-delete-button"/);
  assert.match(js, /button\.textContent = "×"/);
  assert.match(js, /button\.setAttribute\("aria-label", "删除这条消息"\)/);
  assert.doesNotMatch(js, /button\.textContent = "删除"/);

  assert.match(css, /\.project-view\s*\{[\s\S]*overflow-y: auto;/);
  assert.doesNotMatch(css, /\.project-view\s*\{[^}]*overflow: hidden;/);
  assert.match(css, /\.project-list\s*\{[\s\S]*overflow: auto;/);
  assert.match(css, /\.project-list\s*\{[\s\S]*min-height: 0;/);
  assert.match(css, /\.project-card-actions/);
  assert.match(css, /\.project-delete/);
  assert.match(css, /\.message-header-actions/);
  assert.match(css, /\.message-delete-button/);
  assert.match(css, /\.message-delete-button\s*\{[\s\S]*place-items: center;/);
});

test("project binding form works both inside and outside a scoped Codex task", async () => {
  const html = await readFile("public/index.html", "utf8");
  const js = await readFile("public/app.js", "utf8");

  assert.doesNotMatch(html, /F:\/game_code\/project/i);
  assert.match(html, /placeholder="请选择或粘贴本地项目目录"/);
  assert.match(js, /api\("\/api\/config"\)/);
  assert.match(js, /currentCodexThreadId/);
  assert.match(js, /state\.currentCodexThreadId\s*\?\s*"\/api\/projects\/current-session"\s*:\s*"\/api\/projects"/);
  assert.match(js, /\/api\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/select/);
  assert.match(js, /els\.newProjectForm\.addEventListener\("submit", async \(event\) => \{[\s\S]*try\s*\{[\s\S]*catch \(error\)[\s\S]*showToast\(error\.message\)/);
});

test("expanded long text state survives polling refreshes and manual scroll", async () => {
  const js = await readFile("public/app.js", "utf8");

  assert.match(js, /expandedLongTextKeys: new Set\(\)/);
  assert.match(js, /longTextScrollPositions: new Map\(\)/);
  assert.match(js, /readingLongTextUntil: 0/);
  assert.match(js, /function longTextKey/);
  assert.match(js, /function rememberLongTextScroll/);
  assert.match(js, /function markLongTextReadingIntent/);
  assert.match(js, /function isLongTextReadingActive/);
  assert.match(js, /function restoreLongTextScroll/);
  assert.match(js, /function renderLongText\(text, key/);
  assert.match(js, /state\.expandedLongTextKeys\.has\(key\)/);
  assert.match(js, /state\.expandedLongTextKeys\.add\(key\)/);
  assert.match(js, /state\.expandedLongTextKeys\.delete\(key\)/);
  assert.match(js, /markLongTextReadingIntent\(\);\s*rememberLongTextScroll\(key, body\)/);
  assert.match(js, /restoreLongTextScroll\(key, body\)/);
  assert.match(js, /renderCodeBlocks\(displayTextForMessage\(message\), message\.id/);
  assert.match(js, /function latestVisibleMessageId/);
  assert.match(js, /const previousLastMessageId = latestVisibleMessageId\(\)/);
  assert.match(js, /const nextLastMessageId = latestVisibleMessageId\(\)/);
  assert.match(js, /previousLastMessageId !== nextLastMessageId/);
  assert.match(js, /!chatScrollState\.readingLongText/);
  assert.match(js, /else if \(chatScrollState\.readingLongText\)\s*\{\s*clearBottomScrollSettle\(\);/);
  assert.match(js, /pageBottomOffset/);
  assert.doesNotMatch(js, /if \(scrollToBottom \|\| chatScrollState\.nearBottom\)/);
});

test("inline PDF previews survive polling refreshes without iframe reload flicker", async () => {
  const js = await readFile("public/app.js", "utf8");

  assert.match(js, /stablePreviewNodes: new Map\(\)/);
  assert.match(js, /function stablePreviewKey/);
  assert.match(js, /function renderStableArtifactPreviewShell/);
  assert.match(js, /state\.stablePreviewNodes\.has\(key\)/);
  assert.match(js, /state\.stablePreviewNodes\.set\(key, shell\)/);
  assert.match(js, /renderStableArtifactPreviewShell\(artifact\)/);
  assert.doesNotMatch(js, /els\.chatMessages\.replaceChildren\(\);\s*const visibleMessages/);
});

test("chat view lands at the newest message on initial entry", async () => {
  const js = await readFile("public/app.js", "utf8");

  assert.match(js, /initialBottomScrollUntil: 0/);
  assert.match(js, /const INITIAL_BOTTOM_SCROLL_WINDOW_MS = 30000/);
  assert.match(js, /function startInitialBottomScrollSettle/);
  assert.match(js, /function shouldForceInitialBottomScroll/);
  assert.match(js, /state\.initialBottomScrollUntil = Date\.now\(\) \+ INITIAL_BOTTOM_SCROLL_WINDOW_MS/);
  assert.match(js, /state\.initialBottomScrollUntil = 0/);
  assert.match(js, /function showChat\(\) \{[\s\S]*startInitialBottomScrollSettle\(\);[\s\S]*\}/);
  assert.match(js, /scrollToBottom \|\| shouldForceInitialBottomScroll\(\)/);
  assert.match(js, /function latestMessageAnchor/);
  assert.match(js, /function forceLatestMessageIntoView/);
  assert.match(js, /forceLatestMessageIntoView\(\)/);
  assert.match(js, /addEventListener\("load", bottomScrollLoadHandler, true\)/);
  assert.match(js, /addEventListener\("transitionend", bottomScrollLoadHandler, true\)/);
  assert.match(js, /removeEventListener\("load", bottomScrollLoadHandler, true\)/);
});
