import {
  ALTERNATE_KIMI_BASE_URL,
  DEFAULT_KIMI_BASE_URL,
} from "../llm/provider.js";

export const KIMI_BASE_URL_PICKER_EXIT_LABEL = "Keep current endpoint";

export type KimiBaseURLPickerChoice =
  | {
      value: string;
      name: string;
      description: string;
    }
  | {
      value: null;
      name: string;
      description: string;
    };

export function buildKimiBaseURLPickerChoices(
  currentBaseURL: string,
): KimiBaseURLPickerChoice[] {
  return [
    {
      value: DEFAULT_KIMI_BASE_URL,
      name:
        currentBaseURL === DEFAULT_KIMI_BASE_URL
          ? "api.moonshot.cn (current)"
          : "api.moonshot.cn",
      description: "Default Moonshot endpoint for standard network paths.",
    },
    {
      value: ALTERNATE_KIMI_BASE_URL,
      name:
        currentBaseURL === ALTERNATE_KIMI_BASE_URL
          ? "api.moonshot.ai (current)"
          : "api.moonshot.ai",
      description: "Alternate Moonshot endpoint for networks where the .cn route is unavailable.",
    },
    {
      value: currentBaseURL,
      name: KIMI_BASE_URL_PICKER_EXIT_LABEL,
      description: "Keep the current Kimi endpoint and continue to the API key step.",
    },
  ];
}
