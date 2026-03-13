import type { Key } from "ink";

export type SemanticInputEvent =
  | { type: "interrupt" }
  | { type: "submit" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "move_left" }
  | { type: "move_right" }
  | { type: "move_up" }
  | { type: "move_down" }
  | { type: "move_home" }
  | { type: "move_end" }
  | { type: "cancel" }
  | { type: "apply_suggestion" }
  | { type: "insert_text"; text: string };

export function normalizeInkInput(
  inputValue: string,
  key: Key,
): SemanticInputEvent | null {
  if (key.ctrl && inputValue === "c") {
    return { type: "interrupt" };
  }

  if (
    key.return ||
    inputValue === "\r" ||
    inputValue === "\n" ||
    (key.ctrl && inputValue === "m")
  ) {
    return { type: "submit" };
  }

  if (
    key.backspace ||
    inputValue === "\b" ||
    inputValue === "\u007f" ||
    (key.ctrl && inputValue === "h")
  ) {
    return { type: "backspace" };
  }

  if (key.delete) {
    return { type: "delete" };
  }

  if (key.leftArrow) {
    return { type: "move_left" };
  }

  if (key.rightArrow) {
    return { type: "move_right" };
  }

  if (key.upArrow) {
    return { type: "move_up" };
  }

  if (key.downArrow) {
    return { type: "move_down" };
  }

  if (key.home || (key.ctrl && inputValue === "a")) {
    return { type: "move_home" };
  }

  if (key.end || (key.ctrl && inputValue === "e")) {
    return { type: "move_end" };
  }

  if (key.escape) {
    return { type: "cancel" };
  }

  if (key.tab) {
    return { type: "apply_suggestion" };
  }

  if (!key.ctrl && !key.escape && inputValue) {
    return {
      type: "insert_text",
      text: inputValue,
    };
  }

  return null;
}
