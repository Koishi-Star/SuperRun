import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 3;

const requestUserInputArgsSchema = z.object({
  title: z.string().trim().min(1).max(60),
  question: z.string().trim().min(1).max(240),
  options: z.array(z.object({
    value: z.string().trim().min(1).max(60),
    label: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(160),
  })).min(MIN_OPTIONS).max(MAX_OPTIONS),
});

type RequestUserInputArgs = z.infer<typeof requestUserInputArgsSchema>;

export const requestUserInputTool = {
  definition: {
    name: "request_user_input",
    description:
      "Ask the user one focused clarifying question during plan mode. Offer 2-3 concise options; the UI will also provide a custom-input path.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title shown in the clarification picker.",
        },
        question: {
          type: "string",
          description: "Single-sentence question describing the ambiguity.",
        },
        options: {
          type: "array",
          description: "Two or three mutually exclusive answer options, with the recommended option first.",
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          items: {
            type: "object",
            properties: {
              value: {
                type: "string",
                description: "Stable internal value for this option.",
              },
              label: {
                type: "string",
                description: "Short label shown to the user.",
              },
              description: {
                type: "string",
                description: "One concise sentence describing the tradeoff.",
              },
            },
            required: ["value", "label", "description"],
            additionalProperties: false,
          },
        },
      },
      required: ["title", "question", "options"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseRequestUserInputArgs(rawArguments);
      const requestUserInput = context?.userInput?.requestUserInput;
      if (!requestUserInput) {
        throw new Error("request_user_input requires the interactive TTY shell.");
      }

      const response = await requestUserInput(parsedArgs);
      context?.notices?.addNotice({
        level: "info",
        message:
          response.kind === "dismissed"
            ? `request_user_input was dismissed: ${parsedArgs.title}.`
            : `request_user_input answered: ${parsedArgs.title} -> ${response.answer}.`,
      });

      return JSON.stringify({
        ok: true,
        title: parsedArgs.title,
        question: parsedArgs.question,
        response,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown request_user_input error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

function parseRequestUserInputArgs(rawArguments: string): RequestUserInputArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return requestUserInputArgsSchema.parse(parsed);
}
