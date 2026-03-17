import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InteractiveRendererTraceEvent } from "../ui/interactive-renderer.js";

export function createInteractiveTraceEventSinkFromEnv():
  | ((event: InteractiveRendererTraceEvent) => void)
  | null {
  const tracePath = process.env.SUPERRUN_TTY_TEST_TRACE?.trim();
  if (!tracePath) {
    return null;
  }

  mkdirSync(path.dirname(tracePath), { recursive: true });
  writeFileSync(tracePath, "", "utf8");

  return (event) => {
    appendFileSync(
      tracePath,
      `${JSON.stringify({
        recordedAt: new Date().toISOString(),
        event,
      })}\n`,
      "utf8",
    );
  };
}
