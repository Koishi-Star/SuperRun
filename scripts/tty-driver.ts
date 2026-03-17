import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn as spawnPty, type IDisposable, type IPty } from "node-pty";
import type { InteractiveRendererTraceEvent } from "../src/ui/interactive-renderer.js";

export type InteractiveTraceRecord = {
  recordedAt: string;
  event: InteractiveRendererTraceEvent;
};

export type InteractiveCliPtySession = {
  terminal: IPty;
  output: string;
  tracePath: string;
  configDir: string;
  send: (text: string) => void;
  sendLine: (line: string) => void;
  readTrace: () => Promise<InteractiveTraceRecord[]>;
  waitForTrace: (
    predicate: (record: InteractiveTraceRecord, records: InteractiveTraceRecord[]) => boolean,
    timeoutMs?: number,
  ) => Promise<InteractiveTraceRecord>;
  waitForTraceCount: (
    kind: InteractiveRendererTraceEvent["kind"],
    minimumCount: number,
    timeoutMs?: number,
  ) => Promise<InteractiveTraceRecord>;
  waitForExit: (timeoutMs?: number) => Promise<{ exitCode: number; signal?: number }>;
  dispose: () => Promise<void>;
};

export async function spawnInteractiveCliPty(options?: {
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
}): Promise<InteractiveCliPtySession> {
  const cwd = options?.cwd ?? process.cwd();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "superrun-pty-"));
  const tracePath = path.join(tempRoot, "interactive-trace.jsonl");
  const configDir = path.join(tempRoot, "config");
  const cliPath = path.resolve(cwd, "src/index.ts");
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ...options?.env,
      SUPERRUN_CONFIG_DIR: configDir,
      SUPERRUN_TTY_TEST_TRACE: tracePath,
    }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
  const terminal = spawnPty(
    process.execPath,
    ["--import", "tsx", cliPath, ...(options?.args ?? [])],
    {
      name: "xterm-color",
      cols: options?.cols ?? 120,
      rows: options?.rows ?? 40,
      cwd,
      env,
      // The ConPTY backend can fail to enumerate console processes reliably in
      // CI-style runs on Windows. Force winpty for the test harness instead of
      // letting node-pty pick the default dynamically.
      ...(process.platform === "win32" ? { useConpty: false } : {}),
    },
  );

  let output = "";
  let exited = false;
  const dataSubscription: IDisposable = terminal.onData((chunk) => {
    output += chunk;
  });

  const exitPromise = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    const exitSubscription: IDisposable = terminal.onExit((event) => {
      exited = true;
      exitSubscription.dispose();
      resolve({
        exitCode: event.exitCode,
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
      });
    });
  });

  const readTraceRecords = async (): Promise<InteractiveTraceRecord[]> => {
    try {
      const content = await readFile(tracePath, "utf8");
      return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as InteractiveTraceRecord);
    } catch {
      return [];
    }
  };

  const waitForTrace = async (
    predicate: (record: InteractiveTraceRecord, records: InteractiveTraceRecord[]) => boolean,
    timeoutMs = 30_000,
  ): Promise<InteractiveTraceRecord> => {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const records = await readTraceRecords();
      const match = records.find((record) => predicate(record, records));
      if (match) {
        return match;
      }

      await sleep(50);
    }

    const capturedOutput = stripTerminalControl(output).slice(-4_000);
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for an interactive trace event.\n` +
        `Recent terminal output:\n${capturedOutput}`,
    );
  };

  return {
    terminal,
    get output() {
      return output;
    },
    tracePath,
    configDir,
    send: (text) => {
      terminal.write(text);
    },
    sendLine: (line) => {
      terminal.write(`${line}\r`);
    },
    readTrace: readTraceRecords,
    waitForTrace,
    waitForTraceCount: (kind, minimumCount, timeoutMs = 30_000) =>
      waitForTrace(
        (_record, records) =>
          records.filter((record) => record.event.kind === kind).length >= minimumCount,
        timeoutMs,
      ),
    waitForExit: async (timeoutMs = 30_000) =>
      waitWithTimeout(exitPromise, timeoutMs, "interactive CLI process exit"),
    dispose: async () => {
      try {
        if (!exited) {
          terminal.kill();
          await Promise.race([
            exitPromise.catch(() => undefined),
            sleep(2_000),
          ]);
        }
      } catch {
        // The process may already be gone when cleanup runs.
      }
      dataSubscription.dispose();
      await disposeWindowsPtyInternals(terminal);
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export function stripTerminalControl(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r/g, "");
}

async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${label}.`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function disposeWindowsPtyInternals(terminal: IPty): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const windowsTerminal = terminal as IPty & {
    _socket?: {
      destroy?: () => void;
      unref?: () => void;
    };
    _agent?: {
      _inSocket?: {
        destroy?: () => void;
        unref?: () => void;
      };
      _outSocket?: {
        destroy?: () => void;
        unref?: () => void;
      };
      _conoutSocketWorker?: {
        _drainTimeout?: {
          unref?: () => void;
        };
        _worker?: {
          terminate?: () => Promise<number>;
          unref?: () => void;
        };
        dispose?: () => void;
      };
    };
  };

  windowsTerminal._socket?.destroy?.();
  windowsTerminal._socket?.unref?.();
  windowsTerminal._agent?._inSocket?.destroy?.();
  windowsTerminal._agent?._inSocket?.unref?.();
  windowsTerminal._agent?._outSocket?.destroy?.();
  windowsTerminal._agent?._outSocket?.unref?.();

  const conoutWorker = windowsTerminal._agent?._conoutSocketWorker;
  conoutWorker?._drainTimeout?.unref?.();
  conoutWorker?._worker?.unref?.();

  if (conoutWorker?._worker?.terminate) {
    try {
      await Promise.race([
        conoutWorker._worker.terminate(),
        sleep(2_000),
      ]);
    } catch {
      // Best-effort cleanup is sufficient for the test harness.
    }
    return;
  }

  try {
    conoutWorker?.dispose?.();
  } catch {
    // Best-effort cleanup is sufficient for the test harness.
  }
}
