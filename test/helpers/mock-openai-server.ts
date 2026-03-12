import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { ChatMessage, ToolDefinition } from "../../src/llm/types.js";

export type MockChatRequest = {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  tools?: Array<{
    type?: string;
    function?: ToolDefinition;
  }>;
};

export type MockToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type MockChatResponse = {
  content?: string;
  toolCalls?: MockToolCall[];
  reasoningContent?: string;
};

type MockResponseFactory = (
  request: MockChatRequest,
  callIndex: number,
) => MockResponse;

export type MockResponse = string | MockChatResponse | MockResponseFactory;

export async function startMockOpenAIServer(responses: MockResponse[]) {
  const requests: MockChatRequest[] = [];
  let callIndex = 0;

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const request = JSON.parse(
      Buffer.concat(chunks).toString("utf8"),
    ) as MockChatRequest;
    requests.push(request);

    const response = responses[callIndex] ?? `mock response ${callIndex + 1}`;
    const payload =
      typeof response === "function"
        ? response(request, callIndex)
        : response;
    const resolvedResponse =
      typeof payload === "string"
        ? { content: payload }
        : payload;
    callIndex += 1;

    if (request.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
      });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: resolvedResponse.content ?? "" } }] })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              ...(resolvedResponse.content !== undefined
                ? { content: resolvedResponse.content }
                : {}),
              ...(resolvedResponse.reasoningContent !== undefined
                ? { reasoning_content: resolvedResponse.reasoningContent }
                : {}),
              ...(resolvedResponse.toolCalls?.length
                ? {
                    tool_calls: resolvedResponse.toolCalls.map((toolCall) => ({
                      id: toolCall.id,
                      type: "function",
                      function: {
                        name: toolCall.name,
                        arguments: toolCall.arguments,
                      },
                    })),
                  }
                : {}),
            },
          },
        ],
      }),
    );
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address() as AddressInfo;
  const baseURL = `http://${address.address}:${address.port}`;

  return {
    baseURL,
    requests,
    async close(): Promise<void> {
      server.close();
      await once(server, "close");
    },
  };
}
