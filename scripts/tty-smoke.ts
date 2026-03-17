import { spawnInteractiveCliPty, stripTerminalControl } from "./tty-driver.ts";

async function main(): Promise<void> {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt) {
    throw new Error('Usage: npm run tty:smoke -- "<prompt>"');
  }

  const session = await spawnInteractiveCliPty();

  try {
    await session.waitForTraceCount("prompt_requested", 1, 60_000);
    session.sendLine(prompt);

    const outcome = await Promise.race([
      session.waitForTrace((record) => record.event.kind === "turn_completed", 300_000),
      session.waitForTrace((record) => record.event.kind === "turn_failed", 300_000),
      session.waitForTrace(
        (record) => record.event.kind === "error" &&
          /overloaded|timed out|request failed/i.test(record.event.message),
        300_000,
      ),
    ]);

    const trace = await session.readTrace();
    const latestFrame = [...trace]
      .reverse()
      .find((record) => record.event.kind === "shell_frame");
    const assistantText = trace
      .filter((record) => record.event.kind === "assistant_chunk")
      .map((record) => record.event.chunk)
      .join("");

    if (latestFrame?.event.kind === "shell_frame" && latestFrame.event.planLines.length > 0) {
      console.log("plan:");
      for (const line of latestFrame.event.planLines) {
        console.log(line);
      }
      console.log("");
    }

    if (assistantText.trim()) {
      console.log("assistant:");
      console.log(assistantText.trim());
      console.log("");
    }

    if (outcome.event.kind === "turn_failed") {
      console.error(`turn failed: ${outcome.event.message}`);
      process.exitCode = 1;
    } else if (outcome.event.kind === "error") {
      console.error(`runtime error: ${outcome.event.message}`);
      process.exitCode = 1;
    } else {
      console.log("turn completed.");
    }

    await session.waitForTraceCount("prompt_requested", 2, 30_000).catch(() => undefined);
    session.sendLine("/exit");
    await session.waitForExit(30_000);
  } finally {
    const rawOutput = stripTerminalControl(session.output).trim();
    if (rawOutput) {
      console.log("tty output:");
      console.log(rawOutput);
    }
    await session.dispose();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
