import type { ChatMessage, ChatOptions, LLMClient } from "./types.js";
import { getOpenAICompatibleConfig } from "../utils/env.js";

type OpenAICompatibleResponse = {
  choices?: Array<{
    message?: {
      content?: OpenAICompatibleContent;
    };
  }>;
  error?: {
    message?: string;
  };
};

type OpenAICompatibleContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

export class OpenAICompatibleClient implements LLMClient {
  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly defaultModel: string;
  private readonly timeoutMs: number;

  constructor() {
    const config = getOpenAICompatibleConfig();
    this.apiKey = config.apiKey;
    this.baseURL = config.baseURL;
    this.defaultModel = config.model;
    this.timeoutMs = config.timeoutMs;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const model = options?.model ?? this.defaultModel;
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: false,
    };

    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    const response = await this.request("chat/completions", requestBody);

    let data: OpenAICompatibleResponse;

    try {
      data = JSON.parse(response.body) as OpenAICompatibleResponse;
    } catch {
      throw new Error("LLM returned a non-JSON response.");
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(
        data.error?.message ||
          `LLM request failed with status ${response.statusCode}.`,
      );
    }

    const rawContent = data.choices?.[0]?.message?.content;
    const content = normalizeAssistantContent(rawContent);

    if (!content) {
      throw new Error("Model returned empty content.");
    }

    return content;
  }

  private async request(
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<{ statusCode: number; body: string }> {
    const url = new URL(pathname.replace(/^\/+/, ""), `${this.baseURL}/`);
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${this.timeoutMs}ms.`));
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to reach LLM provider at ${url.origin}: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    return { statusCode: response.status, body: text };
  }
}

function normalizeAssistantContent(
  content: OpenAICompatibleContent | undefined,
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}
