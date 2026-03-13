import cliTruncate from "cli-truncate";
import stringWidth from "string-width";

export function getDisplayWidth(value: string): number {
  return stringWidth(value);
}

export function truncateForTerminal(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  return cliTruncate(value, width, {
    position: "end",
    space: false,
  });
}
