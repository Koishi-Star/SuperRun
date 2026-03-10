import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { ChatMessage, ChatOptions, LLMClient } from "./types.js";
import { getOpenAICompatibleConfig } from "../utils/env.js";

// Respect HTTPS_PROXY / HTTP_PROXY / https_proxy / http_proxy env vars.
// undici does NOT pick up system proxy automatically, unlike curl.
function buildDispatcher(): Dispatcher {
  const proxyUrl =
    process.env["HTTPS_PROXY"] ??
    process.env["https_proxy"] ??
    process.env["HTTP_PROXY"] ??
    process.env["http_proxy"];

  const connectOptions = { timeout: 30_000 }; // 30s TCP connect timeout

  if (proxyUrl) {
    return new ProxyAgent({ uri: proxyUrl, connect: connectOptions });
  }
  return new Agent({ connect: connectOptions });
}

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

type OpenAICompatibleStreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
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
    const onChunk = options?.onChunk;
    const shouldStream = typeof onChunk === "function";
    const requestBody: Record<string, unknown> = {
      model,
      messages,
      stream: shouldStream,
    };

    if (options?.temperature !== undefined) {
      requestBody.temperature = options.temperature;
    }

    if (shouldStream) {
      return this.streamChat(requestBody, onChunk);
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

  private async streamChat(
    payload: Record<string, unknown>,
    onChunk: (chunk: string) => void,
  ): Promise<string> {
    const response = await this.requestStream("chat/completions", payload);
    try {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        const body = await response.response.text();
        throw new Error(getErrorMessage(body, response.statusCode));
      }

      if (!response.response.body) {
        throw new Error("LLM provider did not return a response body.");
      }

      const reader = response.response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? "";

          for (const event of events) {
            const chunk = parseSseEvent(event);
            if (chunk === null) {
              continue;
            }

            if (chunk === "[DONE]") {
              buffer = "";
              break;
            }

            let data: OpenAICompatibleStreamChunk;
            try {
              data = JSON.parse(chunk) as OpenAICompatibleStreamChunk;
            } catch {
              throw new Error("LLM returned an invalid stream chunk.");
            }

            if (data.error?.message) {
              throw new Error(data.error.message);
            }

            const delta = data.choices?.[0]?.delta?.content ?? "";
            if (!delta) {
              continue;
            }

            fullContent += delta;
            onChunk(delta);
          }
        }

        buffer += decoder.decode();
        const trailingChunk = parseSseEvent(buffer);
        if (trailingChunk && trailingChunk !== "[DONE]") {
          let data: OpenAICompatibleStreamChunk;
          try {
            data = JSON.parse(trailingChunk) as OpenAICompatibleStreamChunk;
          } catch {
            throw new Error("LLM returned an invalid trailing stream chunk.");
          }

          const delta = data.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullContent += delta;
            onChunk(delta);
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!fullContent.trim()) {
        throw new Error("Model returned empty content.");
      }

      return fullContent;
    } finally {
      clearTimeout(response.timer);
    }
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
        // @ts-expect-error — undici dispatcher is not in the standard fetch types
        dispatcher: buildDispatcher(),
      });
    } catch (err) {
      const cause = err instanceof Error && "cause" in err ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause : undefined;
      const causeMsg = cause instanceof Error ? ` (cause: ${cause.message})` : cause ? ` (cause: ${String(cause)})` : "";
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to reach LLM provider at ${url.origin}: ${msg}${causeMsg}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    return { statusCode: response.status, body: text };
  }

  private async requestStream(
    pathname: string,
    payload: Record<string, unknown>,
  ): Promise<{
    statusCode: number;
    response: Response;
    timer: ReturnType<typeof setTimeout>;
  }> {
    const url = new URL(pathname.replace(/^\/+/, ""), `${this.baseURL}/`);
    const body = JSON.stringify(payload);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`Request timed out after ${this.timeoutMs}ms.`));
    }, this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
        // @ts-expect-error undici dispatcher is not in the standard fetch types
        dispatcher: buildDispatcher(),
      });

      return { statusCode: response.status, response, timer };
    } catch (err) {
      clearTimeout(timer);
      const cause =
        err instanceof Error && "cause" in err
          ? (err as NodeJS.ErrnoException & { cause?: unknown }).cause
          : undefined;
      const causeMsg =
        cause instanceof Error
          ? ` (cause: ${cause.message})`
          : cause
            ? ` (cause: ${String(cause)})`
            : "";
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to reach LLM provider at ${url.origin}: ${msg}${causeMsg}`,
      );
    }
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

function parseSseEvent(event: string): string | null {
  const lines = event
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());

  if (dataLines.length === 0) {
    return null;
  }

  return dataLines.join("\n");
}

function getErrorMessage(body: string, statusCode: number): string {
  try {
    const data = JSON.parse(body) as OpenAICompatibleResponse;
    return (
      data.error?.message || `LLM request failed with status ${statusCode}.`
    );
  } catch {
    return `LLM request failed with status ${statusCode}.`;
  }
}
