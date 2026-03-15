export type ProviderContextPickerValue = "auto" | "custom" | `${number}`;

export type ProviderContextPickerChoice = {
  value: ProviderContextPickerValue | null;
  name: string;
  description: string;
  tone: "default" | "accent";
};

export function buildProviderContextPickerChoices(options: {
  configuredContextLimitTokens?: number;
  modelContextTokens: number | null;
}): ProviderContextPickerChoice[] {
  const values = new Set<number>();
  if (options.modelContextTokens !== null) {
    values.add(options.modelContextTokens);
  }

  for (const preset of [32_000, 64_000, 128_000, 256_000, 512_000]) {
    if (options.modelContextTokens === null || preset <= options.modelContextTokens) {
      values.add(preset);
    }
  }

  if (typeof options.configuredContextLimitTokens === "number") {
    values.add(options.configuredContextLimitTokens);
  }

  const sortedValues = [...values].sort((left, right) => left - right);

  return [
    {
      value: "auto",
      name:
        options.configuredContextLimitTokens === undefined
          ? "Auto (current)"
          : "Auto",
      description:
        options.modelContextTokens === null
          ? "Clear the override and fall back to the provider's unknown default."
          : `Clear the override and use the model max ${formatTokenCount(options.modelContextTokens)}.`,
      tone: options.configuredContextLimitTokens === undefined ? "accent" : "default",
    },
    ...sortedValues.map((value) => ({
      value: String(value) as `${number}`,
      name:
        value === options.configuredContextLimitTokens
          ? `${formatTokenCount(value)} (current)`
          : formatTokenCount(value),
      description:
        options.modelContextTokens !== null && value === options.modelContextTokens
          ? "Use the current model's full known context window."
          : "Use this provider budget for future turns.",
      tone: value === options.configuredContextLimitTokens ? "accent" as const : "default" as const,
    })),
    {
      value: "custom",
      name: "Custom...",
      description: "Enter a custom token budget such as 128k or 256000.",
      tone: "default" as const,
    },
    {
      value: null,
      name: "Keep current value",
      description: "Return to chat without changing the provider budget.",
      tone: "default" as const,
    },
  ];
}

function formatTokenCount(value: number): string {
  return value >= 1_000 ? `${Math.round(value / 1_000)}k` : value.toString();
}
