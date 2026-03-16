const ENTER_ALT_SCREEN = "\u001B[?1049h";
const EXIT_ALT_SCREEN = "\u001B[?1049l";
const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";
const CLEAR_LINE = "\u001B[2K";

export type TerminalScreen = {
  render: (output: string, height: number) => void;
  clear: () => void;
  suspend: () => void;
  resume: () => void;
  dispose: () => void;
};

export function createTerminalScreen(
  output: NodeJS.WriteStream,
): TerminalScreen {
  let mounted = false;
  let disposed = false;
  let needsFullRepaint = true;
  let lastHeight = 0;
  let lastLines: string[] = [];

  return {
    render(document, height) {
      if (disposed) {
        return;
      }

      const safeHeight = Math.max(1, Math.floor(height) || 1);
      const nextLines = normalizeDocumentLines(document, safeHeight);

      if (!mounted) {
        output.write(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
        mounted = true;
        needsFullRepaint = true;
      }

      if (needsFullRepaint || lastHeight !== safeHeight || lastLines.length !== nextLines.length) {
        output.write(buildFullRepaint(nextLines));
      } else {
        const diff = buildIncrementalPatch(lastLines, nextLines);
        if (diff.length > 0) {
          output.write(diff);
        }
      }

      lastHeight = safeHeight;
      lastLines = nextLines;
      needsFullRepaint = false;
    },
    clear() {
      lastLines = [];
      needsFullRepaint = true;
    },
    suspend() {
      if (!mounted || disposed) {
        return;
      }

      output.write(`${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
      mounted = false;
      needsFullRepaint = true;
    },
    resume() {
      if (disposed) {
        return;
      }

      needsFullRepaint = true;
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      if (mounted) {
        output.write(`${SHOW_CURSOR}${EXIT_ALT_SCREEN}`);
      }
    },
  };
}

function normalizeDocumentLines(
  output: string,
  height: number,
): string[] {
  const lines = output
    ? output.replace(/\r\n/g, "\n").split("\n")
    : [];
  const normalized = lines.slice(0, height);

  while (normalized.length < height) {
    normalized.push("");
  }

  return normalized;
}

function buildFullRepaint(lines: string[]): string {
  const writes = [`${moveCursor(1, 1)}`];

  for (let index = 0; index < lines.length; index += 1) {
    writes.push(`${CLEAR_LINE}${lines[index] ?? ""}`);
    if (index < lines.length - 1) {
      writes.push("\n");
    }
  }

  writes.push(moveCursor(lines.length, 1));
  return writes.join("");
}

function buildIncrementalPatch(
  previousLines: string[],
  nextLines: string[],
): string {
  const writes: string[] = [];

  for (let index = 0; index < nextLines.length; index += 1) {
    if (nextLines[index] === previousLines[index]) {
      continue;
    }

    writes.push(`${moveCursor(index + 1, 1)}${CLEAR_LINE}${nextLines[index] ?? ""}`);
  }

  if (writes.length > 0) {
    writes.push(moveCursor(nextLines.length, 1));
  }

  return writes.join("");
}

function moveCursor(row: number, column: number): string {
  return `\u001B[${row};${column}H`;
}
