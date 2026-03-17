import { z } from "zod";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";

const updatePlanArgsSchema = z.object({
  step_id: z.string().trim().min(1),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]).optional(),
  note: z.string().trim().max(280).nullable().optional(),
});

type UpdatePlanArgs = z.infer<typeof updatePlanArgsSchema>;

export const updatePlanTool = {
  definition: {
    name: "update_plan",
    description:
      "Update the current task plan by marking one step pending, in progress, completed, or blocked. Use this when execution starts or finishes a planned step.",
    parameters: {
      type: "object",
      properties: {
        step_id: {
          type: "string",
          description: "Stable step identifier from the current task plan, for example step_1.",
        },
        status: {
          type: "string",
          description: "New status for this step.",
          enum: ["pending", "in_progress", "completed", "blocked"],
        },
        note: {
          type: ["string", "null"],
          description: "Optional short note to attach to the plan step.",
        },
      },
      required: ["step_id"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    try {
      const parsedArgs = parseUpdatePlanArgs(rawArguments);
      const updatePlan = context?.plan?.updatePlan;
      if (!updatePlan) {
        throw new Error("update_plan requires an active task plan.");
      }

      const result = await updatePlan({
        stepId: parsedArgs.step_id,
        ...(parsedArgs.status ? { status: parsedArgs.status } : {}),
        ...(parsedArgs.note !== undefined ? { note: parsedArgs.note } : {}),
      });
      context?.notices?.addNotice({
        level: "info",
        message: `update_plan updated ${result.stepId} -> ${result.status}.`,
      });
      return JSON.stringify({
        ok: true,
        ...result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown update_plan error.";
      return JSON.stringify({
        ok: false,
        error: message,
      });
    }
  },
};

function parseUpdatePlanArgs(rawArguments: string): UpdatePlanArgs {
  const parsed = rawArguments.trim()
    ? JSON.parse(rawArguments)
    : {};
  return updatePlanArgsSchema.parse(parsed);
}
