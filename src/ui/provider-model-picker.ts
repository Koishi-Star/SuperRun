import type { ProviderCatalogModel } from "../llm/provider-catalog.js";

export type ProviderModelPickerChoice =
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

export function buildProviderModelPickerChoices(
  currentModel: string,
  models: ProviderCatalogModel[],
): ProviderModelPickerChoice[] {
  return [
    ...models.map((model) => ({
      value: model.id,
      name: model.id === currentModel ? `${model.id} (current)` : model.id,
      description:
        model.contextTokens === null
          ? "Context window unavailable from the current catalog."
          : `Context ${formatTokenCount(model.contextTokens)} (${model.contextSource}).`,
    })),
    {
      value: null,
      name: "Keep current model",
      description: "Return to chat without changing the current model.",
    },
  ];
}

function formatTokenCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : value.toString();
}
