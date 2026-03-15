import assert from "node:assert/strict";
import test from "node:test";
import {
  ALTERNATE_KIMI_BASE_URL,
  DEFAULT_KIMI_BASE_URL,
} from "../src/llm/provider.js";
import {
  KIMI_BASE_URL_PICKER_EXIT_LABEL,
  buildKimiBaseURLPickerChoices,
} from "../src/ui/kimi-base-url-picker.js";

test("Kimi base URL picker marks the active endpoint and includes an exit option", () => {
  const choices = buildKimiBaseURLPickerChoices(DEFAULT_KIMI_BASE_URL);

  assert.deepEqual(choices, [
    {
      value: DEFAULT_KIMI_BASE_URL,
      name: "api.moonshot.cn (current)",
      description: "Default Moonshot endpoint for standard network paths.",
    },
    {
      value: ALTERNATE_KIMI_BASE_URL,
      name: "api.moonshot.ai",
      description: "Alternate Moonshot endpoint for networks where the .cn route is unavailable.",
    },
    {
      value: DEFAULT_KIMI_BASE_URL,
      name: KIMI_BASE_URL_PICKER_EXIT_LABEL,
      description: "Keep the current Kimi endpoint and continue to the API key step.",
    },
  ]);
});

test("Kimi base URL picker moves the current marker when the alternate endpoint is active", () => {
  const choices = buildKimiBaseURLPickerChoices(ALTERNATE_KIMI_BASE_URL);

  assert.equal(choices[0]?.name, "api.moonshot.cn");
  assert.equal(choices[1]?.name, "api.moonshot.ai (current)");
});
