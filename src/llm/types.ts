export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type SystemMessage = {
  role: "system";
  content: string;
};

export type UserMessage = {
  role: "user";
  content: string;
};

export type AssistantMessage = {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
  reasoningContent?: string;
};

export type ToolMessage = {
  role: "tool";
  content: string;
  toolCallId: string;
};

export type ChatMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolMessage;

export type ConversationMessage = UserMessage | AssistantMessage;

export type ChatResponse = {
  content: string;
  toolCalls: ToolCall[];
  reasoningContent?: string;
};

export type ChatOptions = {
  model?: string;
  temperature?: number;
  onChunk?: (chunk: string) => void;
  tools?: ToolDefinition[];
};

export interface LLMClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}
