import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { maskVisibleBrandName } from "../public/visible-branding.js";

function visibleHtmlCopy(html) {
  const withoutCode = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "");
  const text = Array.from(withoutCode.matchAll(/>([^<]+)</g), (match) => match[1]);
  const attributes = Array.from(
    withoutCode.matchAll(/\b(?:alt|aria-label|placeholder|title)="([^"]*)"/gi),
    (match) => match[1],
  );
  return [...text, ...attributes].join("\n");
}

test("visible branding preserves GPT names and real URLs", () => {
  assert.equal(
    maskVisibleBrandName("ChatGPT / GPT / gpt-5.6 / 请打开 chatgpt.com"),
    "ChatGPT / GPT / gpt-5.6 / 请打开 chatgpt.com",
  );
});

test("visible branding restores legacy masked labels and conversation hosts", () => {
  assert.equal(maskVisibleBrandName("G某T / g某t-5.6 / https://G某T.com/c/test"), "GPT / GPT-5.6 / https://chatgpt.com/c/test");
});

test("initial workbench copy uses GPT without masked branding", async () => {
  const html = await readFile("public/index.html", "utf8");
  const copy = visibleHtmlCopy(html);

  assert.match(copy, /GPT/);
  assert.doesNotMatch(copy, /g某t/i);
});

test("bound conversation URLs stay readable without password dots", async () => {
  const html = await readFile("public/index.html", "utf8");
  const projectUrlInput = html.match(/<input id="projectUrlInput"[^>]*>/)?.[0] || "";
  const settingsProjectUrlInput = html.match(/<input id="settingsProjectUrlInput"[^>]*>/)?.[0] || "";

  assert.match(projectUrlInput, /\btype="text"/);
  assert.match(settingsProjectUrlInput, /\btype="text"/);
  assert.doesNotMatch(projectUrlInput, /\btype="password"/);
  assert.doesNotMatch(settingsProjectUrlInput, /\btype="password"/);
  assert.match(projectUrlInput, /\bname="chatgptProjectUrl"/);
  assert.match(settingsProjectUrlInput, /\bname="chatgptProjectUrl"/);
});

test("Chrome extension listing uses GPT without masked branding", async () => {
  const manifest = JSON.parse(await readFile("chrome-extension/manifest.json", "utf8"));
  const listingCopy = `${manifest.name}\n${manifest.description}`;

  assert.match(listingCopy, /GPT/);
  assert.doesNotMatch(listingCopy, /g某t/i);
  assert.ok(manifest.host_permissions.includes("https://chatgpt.com/*"));
});

test("image preview fallback copy stays readable", async () => {
  const js = await readFile("public/app.js", "utf8");

  assert.match(js, /artifact\.filename \|\| "图片"/);
  assert.match(js, /artifact\.filename \|\| "图片预览"/);
  assert.doesNotMatch(js, /鍥剧墖|杈撳嚭鍥剧墖/);
});
