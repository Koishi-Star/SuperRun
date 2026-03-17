import assert from "node:assert/strict";
import test from "node:test";
import { startMockOpenAIServer } from "./helpers/mock-openai-server.js";
import { spawnInteractiveCliPty } from "../scripts/tty-driver.ts";

test("interactive TTY mode accepts a prompt and completes a turn through the PTY harness", async () => {
  const server = await startMockOpenAIServer([
    JSON.stringify({
      title: "Greet the user",
      steps: [
        { title: "Inspect the prompt" },
        { title: "Produce the response" },
        { title: "Verify the output format" },
      ],
    }),
    {
      toolCalls: [
        {
          id: "call_1",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_1",
            status: "completed",
          }),
        },
        {
          id: "call_2",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_2",
            status: "completed",
          }),
        },
        {
          id: "call_3",
          name: "update_plan",
          arguments: JSON.stringify({
            step_id: "step_3",
            status: "completed",
          }),
        },
      ],
    },
    "Hello from interactive TTY.",
  ]);

  const session = await spawnInteractiveCliPty({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: server.baseURL,
      OPENAI_MODEL: "mock-model",
      OPENAI_TIMEOUT_MS: "5000",
    },
  });

  try {
    await session.waitForTraceCount("prompt_requested", 1, 60_000);
    session.sendLine("Hello there.");

    await session.waitForTrace((record) => record.event.kind === "turn_completed", 60_000);
    await session.waitForTraceCount("prompt_requested", 2, 60_000);

    const trace = await session.readTrace();
    const planFrame = trace.find((record) =>
      record.event.kind === "shell_frame" &&
      record.event.planLines.some((line) => /plan  Greet the user/i.test(line))
    );
    const assistantText = trace
      .filter((record) => record.event.kind === "assistant_chunk")
      .map((record) => record.event.chunk)
      .join("");

    assert.ok(planFrame, "Expected the interactive shell trace to include the plan card.");
    assert.match(assistantText, /Hello from interactive TTY\./);

    session.sendLine("/exit");
    const exit = await session.waitForExit(30_000);
    assert.equal(exit.exitCode, 0);
  } finally {
    await session.dispose();
    await server.close();
  }
});

test("interactive TTY mode toggles the top SuperRun header card with /hide", async () => {
  const session = await spawnInteractiveCliPty({
    env: {
      OPENAI_API_KEY: "test-key",
      OPENAI_MODEL: "mock-model",
    },
  });

  try {
    await session.waitForTraceCount("prompt_requested", 1, 60_000);

    let trace = await session.readTrace();
    let latestFrame = [...trace]
      .reverse()
      .find((record) => record.event.kind === "shell_frame");
    assert.ok(latestFrame?.event.kind === "shell_frame");
    assert.ok(latestFrame.event.workspaceLines.length > 0);
    assert.ok(latestFrame.event.statusLines.length > 0);

    session.sendLine("/hide");
    await session.waitForTraceCount("prompt_requested", 2, 60_000);

    trace = await session.readTrace();
    latestFrame = [...trace]
      .reverse()
      .find((record) => record.event.kind === "shell_frame");
    assert.ok(latestFrame?.event.kind === "shell_frame");
    assert.deepEqual(latestFrame.event.workspaceLines, []);
    assert.deepEqual(latestFrame.event.statusLines, []);
    assert.deepEqual(latestFrame.event.footerLines, []);

    session.sendLine("/hide");
    await session.waitForTraceCount("prompt_requested", 3, 60_000);

    trace = await session.readTrace();
    latestFrame = [...trace]
      .reverse()
      .find((record) => record.event.kind === "shell_frame");
    assert.ok(latestFrame?.event.kind === "shell_frame");
    assert.ok(latestFrame.event.workspaceLines.length > 0);
    assert.ok(latestFrame.event.statusLines.length > 0);

    session.sendLine("/exit");
    const exit = await session.waitForExit(30_000);
    assert.equal(exit.exitCode, 0);
  } finally {
    await session.dispose();
  }
});
