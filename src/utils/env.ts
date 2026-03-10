export type OpenAICompatibleConfig = {
  apiKey: string;
  baseURL: string;
  model: string;
  timeoutMs: number;
};

export function getOpenAICompatibleConfig(): OpenAICompatibleConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  const baseURL = (
    process.env.OPENAI_BASE_URL?.trim() ?? "https://api.openai.com/v1"
  ).replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL?.trim() ?? "gpt-4o-mini";
  const timeoutValue = process.env.OPENAI_TIMEOUT_MS?.trim() ?? "120000";
  const timeoutMs = Number.parseInt(timeoutValue, 10);

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY in environment variables.");
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("OPENAI_TIMEOUT_MS must be a positive integer when set.");
  }

  return {
    apiKey,
    baseURL,
    model,
    timeoutMs,
  };
}
