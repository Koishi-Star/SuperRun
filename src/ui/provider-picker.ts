import type { ProviderId } from "../llm/provider.js";

export type ProviderPickerChoice =
  | {
      value: ProviderId;
      name: string;
      description: string;
    }
  | {
      value: null;
      name: string;
      description: string;
    };

export function buildProviderPickerChoices(
  currentProvider: ProviderId,
): ProviderPickerChoice[] {
  return [
    {
      value: "openai_compatible",
      name:
        currentProvider === "openai_compatible"
          ? "OpenAI-Compatible (current)"
          : "OpenAI-Compatible",
      description: "Use a configurable OpenAI-compatible endpoint, model, and API key.",
    },
    {
      value: "kimi",
      name: currentProvider === "kimi" ? "Kimi (current)" : "Kimi",
      description: "Use Moonshot Kimi with MOONSHOT_API_KEY or a locally stored key entered in the TTY.",
    },
    {
      value: null,
      name: "Keep current provider",
      description: "Return to chat without changing the active provider.",
    },
  ];
}
