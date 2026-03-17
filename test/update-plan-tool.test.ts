import assert from "node:assert/strict";
import test from "node:test";
import { createTaskPlan, updateTaskPlanStep } from "../src/agent/plan.js";
import { updatePlanTool } from "../src/tools/update_plan.js";

test("update_plan updates the requested step through the plan context", async () => {
  let activePlan = createTaskPlan({
    title: "Implement feature",
    sourcePrompt: "Implement feature",
    steps: [
      { title: "Inspect" },
      { title: "Implement" },
      { title: "Verify" },
    ],
  });

  const result = JSON.parse(await updatePlanTool.execute(
    JSON.stringify({
      step_id: "step_2",
      status: "in_progress",
      note: "Editing the CLI flow.",
    }),
    {
      plan: {
        updatePlan: async (request) => {
          activePlan = updateTaskPlanStep(activePlan, request.stepId, request);
          const updatedStep = activePlan.steps.find((step) => step.id === request.stepId);
          assert.ok(updatedStep);
          return {
            planId: activePlan.id,
            stepId: updatedStep.id,
            status: updatedStep.status,
          };
        },
      },
    },
  ));

  assert.equal(result.ok, true);
  assert.equal(result.stepId, "step_2");
  assert.equal(result.status, "in_progress");
  assert.equal(activePlan.steps[1]?.status, "in_progress");
});
