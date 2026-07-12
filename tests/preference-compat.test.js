import assert from "node:assert/strict";
import test from "node:test";

import {
  compatibleModePreference,
  modePreferencesForModel,
  normalizeChatGptPreferences
} from "../src/preference-compat.js";

test("ChatGPT models keep their actual per-model mode sets", () => {
  assert.deepEqual(modePreferencesForModel("gpt-5.6-sol"), [
    "fast",
    "balanced",
    "advanced",
    "high",
    "pro"
  ]);
  assert.deepEqual(modePreferencesForModel("gpt-5.5"), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(modePreferencesForModel("gpt-5.4"), ["fast", "balanced", "advanced", "high", "pro"]);
  assert.deepEqual(modePreferencesForModel("gpt-5.3"), ["fast"]);
  assert.deepEqual(modePreferencesForModel("o3"), []);
  assert.equal(compatibleModePreference("gpt-5.6-sol", "fast"), "fast");
  assert.equal(compatibleModePreference("gpt-5.5", "high"), "high");
  assert.equal(compatibleModePreference("gpt-5.3", "high"), "fast");
  assert.deepEqual(normalizeChatGptPreferences({
    modelPreference: "gpt-5.6-sol",
    modePreference: "high"
  }), {
    modelPreference: "gpt-5.6-sol",
    modePreference: "high"
  });
});
