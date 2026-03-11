export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage<Role extends ChatRole = ChatRole> = {
  role: Role;
  content: string;
};

export type ConversationMessage = ChatMessage<"user" | "assistant">;

export type ChatOptions = {
  model?: string;
  temperature?: number;
  onChunk?: (chunk: string) => void;
};

export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
