import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexDelegationInstructions,
  ensureBridgeRoutingRules,
  ensureCodexDelegationInstructions
} from "../src/bridge-routing-rules.js";
import { updateWorkspaceBinding } from "../src/conversation-store.js";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "bridge-routing-rules-"));
}

test("Router-aware delegation instructions require both explicit scope ids", () => {
  const instructions = buildCodexDelegationInstructions({
    projectId: "project-router-scope",
    conversationId: "conversation-router-scope",
    chatgptProjectUrl: "https://chatgpt.com/c/router-scope",
    targetRepo: "F:/game_code/router-scope"
  });

  assert.match(instructions, /projectId: "project-router-scope"/);
  assert.match(instructions, /conversationId: "conversation-router-scope"/);
  assert.match(instructions, /both.*projectId.*conversationId/i);
  assert.doesNotMatch(instructions, /required `conversationId` or `projectId`/i);
});

test("workspace binding creates the project BRIDGE routing rules once", async () => {
  const storeRoot = await tempDir();
  const projectRoot = await tempDir();

  const workspace = await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    targetRepo: projectRoot
  });

  const rulesPath = path.join(projectRoot, "BRIDGE.md");
  const rules = await readFile(rulesPath, "utf8");
  assert.equal(workspace.bridgeRulesPath, rulesPath);
  assert.match(rules, /BEGIN CODEXBRIDGE ROUTING RULES/);
  assert.match(rules, /END CODEXBRIDGE ROUTING RULES/);
  assert.match(rules, /GPT/);
  assert.match(rules, /Codex/);

  await updateWorkspaceBinding(storeRoot, {
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    targetRepo: projectRoot
  });
  const secondRead = await readFile(rulesPath, "utf8");
  assert.equal(secondRead.match(/BEGIN CODEXBRIDGE ROUTING RULES/g)?.length, 1);

  const agentsPath = path.join(projectRoot, "AGENTS.md");
  const agents = await readFile(agentsPath, "utf8");
  assert.equal(workspace.codexDelegationPath, agentsPath);
  assert.match(agents, /BEGIN CODEXBRIDGE CODEX DELEGATION/);
  assert.match(agents, /delegate_current_request/);
  assert.match(agents, /waitForGpt/);
  assert.match(agents, /Forward the user's original wording/);
  assert.match(agents, /Activation scope/);
  assert.match(agents, /Do not use Bridge from any other Codex project/);
  assert.match(agents, /Do not ask the user to reply with a magic phrase/);
  assert.match(agents, /Do not say an existing Bridge binding points to another project/);
  assert.match(agents, /Priority over local creative skills/);
  assert.match(agents, /before local creative skills/);
  assert.match(agents, /Explicit user override/);
  assert.match(agents, /hard gate/);
  assert.match(agents, /MCP tool is unavailable/);
  assert.match(agents, /玄幻穿越小说/);
  assert.match(agents, /sequentialPlan/);
  assert.match(agents, /continue_router_run/);
  assert.doesNotMatch(agents, /call `delegate_current_request` again for the next stage/);

  const secondAgentsRead = await readFile(agentsPath, "utf8");
  assert.equal(secondAgentsRead.match(/BEGIN CODEXBRIDGE CODEX DELEGATION/g)?.length, 1);
});

test("routing rule bootstrap appends to an existing BRIDGE file without overwriting it", async () => {
  const projectRoot = await tempDir();
  const rulesPath = path.join(projectRoot, "BRIDGE.md");
  await writeFile(rulesPath, "# Existing Project Notes\n\nKeep this paragraph.\n", "utf8");

  const result = await ensureBridgeRoutingRules({
    targetRepo: projectRoot,
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    conversationId: "conv-1"
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  const rules = await readFile(rulesPath, "utf8");
  assert.match(rules, /# Existing Project Notes/);
  assert.match(rules, /Keep this paragraph/);
  assert.match(rules, /BEGIN CODEXBRIDGE ROUTING RULES/);
});

test("routing rule bootstrap refreshes an older generated BRIDGE block", async () => {
  const projectRoot = await tempDir();
  const rulesPath = path.join(projectRoot, "BRIDGE.md");
  await writeFile(
    rulesPath,
    [
      "# Existing Project Notes",
      "",
      "Keep this hand-written note.",
      "",
      "<!-- BEGIN CODEXBRIDGE ROUTING RULES -->",
      "## CodexBridge 分工规则",
      "",
      "- Old generated routing rule.",
      "<!-- END CODEXBRIDGE ROUTING RULES -->",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = await ensureBridgeRoutingRules({
    targetRepo: projectRoot,
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    conversationId: "conv-1"
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.reason, "refreshed");
  const rules = await readFile(rulesPath, "utf8");
  assert.match(rules, /Keep this hand-written note/);
  assert.doesNotMatch(rules, /Old generated routing rule/);
  assert.match(rules, /Codex 默认只做整理、落地和低成本验收/);
  assert.match(rules, /不要编造 GPT 结果/);
  assert.equal(rules.match(/BEGIN CODEXBRIDGE ROUTING RULES/g)?.length, 1);
});

test("Codex delegation bootstrap appends AGENTS instructions without overwriting project guidance", async () => {
  const projectRoot = await tempDir();
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  await writeFile(agentsPath, "# Existing Agent Notes\n\nDo not batch delete files.\n", "utf8");

  const result = await ensureCodexDelegationInstructions({
    targetRepo: projectRoot,
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    conversationId: "conv-1"
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /# Existing Agent Notes/);
  assert.match(agents, /Do not batch delete files/);
  assert.match(agents, /BEGIN CODEXBRIDGE CODEX DELEGATION/);
  assert.match(agents, /delegate_current_request/);
  assert.match(agents, /Do not re-analyze GPT conclusions/);
  assert.match(agents, /Codex's own visual\/content judgment/);
  assert.match(agents, /Required MCP scope/);
  assert.match(agents, /conversationId: "conv-1"/);
  assert.match(agents, /Bound local project root/);
  assert.match(agents, /unscoped calls are rejected/);
  assert.match(agents, /Activation scope/);
  assert.match(agents, /ignore this block and handle normally/);
  assert.match(agents, /Do not ask the user to reply with a magic phrase/);
  assert.match(agents, /Do not say an existing Bridge binding points to another project/);
  assert.match(agents, /Priority over local creative skills/);
  assert.match(agents, /hard gate/);
  assert.match(agents, /MCP tool is unavailable/);
  assert.match(agents, /玄幻穿越小说/);
  assert.match(agents, /sequentialPlan/);
});

test("Codex delegation bootstrap refreshes an older generated AGENTS block", async () => {
  const projectRoot = await tempDir();
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  await writeFile(
    agentsPath,
    [
      "# Existing Agent Notes",
      "",
      "Keep this hand-written note.",
      "",
      "<!-- BEGIN CODEXBRIDGE CODEX DELEGATION -->",
      "## CodexBridge delegation rules",
      "",
      "- Old generated rule.",
      "<!-- END CODEXBRIDGE CODEX DELEGATION -->",
      ""
    ].join("\n"),
    "utf8"
  );

  const result = await ensureCodexDelegationInstructions({
    targetRepo: projectRoot,
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    conversationId: "conv-1"
  });

  assert.equal(result.created, false);
  assert.equal(result.updated, true);
  assert.equal(result.reason, "refreshed");
  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /Keep this hand-written note/);
  assert.doesNotMatch(agents, /Old generated rule/);
  assert.match(agents, /Forward the user's original wording/);
  assert.match(agents, /Priority over local creative skills/);
  assert.match(agents, /Codex's own visual\/content judgment/);
  assert.match(agents, /Required MCP scope/);
  assert.match(agents, /conversationId: "conv-1"/);
  assert.match(agents, /Bound local project root/);
  assert.match(agents, /unscoped calls are rejected/);
  assert.match(agents, /Activation scope/);
  assert.match(agents, /Do not ask the user to reply with a magic phrase/);
  assert.match(agents, /Do not say an existing Bridge binding points to another project/);
  assert.match(agents, /MCP tool is unavailable/);
  assert.equal(agents.match(/BEGIN CODEXBRIDGE CODEX DELEGATION/g)?.length, 1);
});

test("Codex delegation bootstrap refreshes stale conversation scope", async () => {
  const projectRoot = await tempDir();
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  await writeFile(
    agentsPath,
    [
      "# Existing Agent Notes",
      "",
      "Keep this note.",
      "",
      buildCodexDelegationInstructions({
        targetRepo: projectRoot,
        chatgptProjectUrl: "https://chatgpt.com/c/demo",
        conversationId: "room-old"
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  const result = await ensureCodexDelegationInstructions({
    targetRepo: projectRoot,
    chatgptProjectUrl: "https://chatgpt.com/c/demo",
    conversationId: "room-new"
  });

  assert.equal(result.updated, true);
  assert.equal(result.reason, "refreshed");
  const agents = await readFile(agentsPath, "utf8");
  assert.match(agents, /Keep this note/);
  assert.match(agents, /Bridge conversation: room-new/);
  assert.match(agents, /conversationId: "room-new"/);
  assert.doesNotMatch(agents, /room-old/);
});

test("Codex delegation bootstrap refreshes a same-version block missing project scope", async () => {
  const projectRoot = await tempDir();
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  await writeFile(
    agentsPath,
    [
      "# Existing Agent Notes",
      "",
      buildCodexDelegationInstructions({
        chatgptProjectUrl: "https://chatgpt.com/c/project-refresh",
        conversationId: "conversation-project-refresh",
        targetRepo: projectRoot
      }),
      ""
    ].join("\n"),
    "utf8"
  );

  const result = await ensureCodexDelegationInstructions({
    projectId: "project-refresh",
    chatgptProjectUrl: "https://chatgpt.com/c/project-refresh",
    conversationId: "conversation-project-refresh",
    targetRepo: projectRoot
  });
  const agents = await readFile(agentsPath, "utf8");

  assert.equal(result.updated, true);
  assert.match(agents, /Bridge project: project-refresh/);
  assert.match(agents, /projectId: "project-refresh"/);
});

test("Codex delegation bootstrap refreshes same-version stale Router wording", async () => {
  const projectRoot = await tempDir();
  const agentsPath = path.join(projectRoot, "AGENTS.md");
  const exactInput = {
    projectId: "project-wording-refresh",
    chatgptProjectUrl: "https://chatgpt.com/c/wording-refresh",
    conversationId: "conversation-wording-refresh",
    targetRepo: projectRoot
  };
  const staleBlock = buildCodexDelegationInstructions(exactInput)
    .replaceAll("both the exact `projectId` and `conversationId`", "the required `conversationId` or `projectId`")
    .replaceAll("`continue_router_run`", "`delegate_current_request`");
  await writeFile(agentsPath, `# Existing Agent Notes\n\n${staleBlock}\n`, "utf8");

  const result = await ensureCodexDelegationInstructions(exactInput);
  const agents = await readFile(agentsPath, "utf8");

  assert.equal(result.updated, true);
  assert.match(agents, /both the exact `projectId` and `conversationId`/);
  assert.match(agents, /continue_router_run/);
  assert.doesNotMatch(agents, /required `conversationId` or `projectId`/);
});
