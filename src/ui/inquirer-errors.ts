const PROMPT_EXIT_ERROR_NAMES = new Set([
  "AbortPromptError",
  "CancelPromptError",
  "ExitPromptError",
]);

export function isPromptExitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    PROMPT_EXIT_ERROR_NAMES.has(error.name)
  );
}
