export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatOptions = {
  model?: string;
  temperature?: number;
  onChunk?: (chunk: string) => void;
};

export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
