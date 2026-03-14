import {
  applyFileSuggestion,
  findActiveFileReference,
  getFileReferenceErrorMessage,
  getUnresolvedFileReferences,
  matchWorkspaceFiles,
  normalizeFileReferenceEscapes,
  type ActiveFileReference,
} from "./file-reference.js";

const MAX_VISIBLE_MATCHES = 6;
const SLASH_COMMAND_SUGGESTIONS = [
  "/help",
  "/mode",
  "/approvals",
  "/duration",
  "/settings",
  "/session",
  "/history",
  "/sessions",
  "/new",
  "/switch",
  "/rename",
  "/delete",
  "/trash",
  "/system",
  "/editor",
  "/clear",
  "/exit",
] as const;

export type ActiveSlashCommand = {
  start: number;
  end: number;
  query: string;
};

export type ComposerState = {
  buffer: string;
  cursorIndex: number;
  activeReference: ActiveFileReference | null;
  activeSlashCommand: ActiveSlashCommand | null;
  suggestions: string[];
  selectedSuggestionIndex: number;
  errorMessage: string | null;
};

export function createComposerState(): ComposerState {
  return syncComposerState({
    buffer: "",
    cursorIndex: 0,
    activeReference: null,
    activeSlashCommand: null,
    suggestions: [],
    selectedSuggestionIndex: 0,
    errorMessage: null,
  }, []);
}

export function syncComposerState(
  nextState: Omit<ComposerState, "activeReference" | "activeSlashCommand" | "suggestions"> & {
    activeReference?: ActiveFileReference | null;
    activeSlashCommand?: ActiveSlashCommand | null;
    suggestions?: string[];
  },
  workspaceFiles: string[],
): ComposerState {
  const cursorIndex = clamp(nextState.cursorIndex, 0, nextState.buffer.length);
  const activeReference = findActiveFileReference(nextState.buffer, cursorIndex);
  const activeSlashCommand = activeReference
    ? null
    : findActiveSlashCommand(nextState.buffer, cursorIndex);
  const suggestions = activeReference
    ? matchWorkspaceFiles(
        workspaceFiles,
        activeReference.query,
        MAX_VISIBLE_MATCHES,
      )
    : activeSlashCommand
      ? matchSlashCommands(activeSlashCommand.query, MAX_VISIBLE_MATCHES)
      : [];

  return {
    buffer: nextState.buffer,
    cursorIndex,
    activeReference,
    activeSlashCommand,
    suggestions,
    selectedSuggestionIndex: clamp(
      nextState.selectedSuggestionIndex,
      0,
      Math.max(0, suggestions.length - 1),
    ),
    errorMessage: nextState.errorMessage ?? null,
  };
}

export function insertComposerText(
  state: ComposerState,
  value: string,
  workspaceFiles: string[],
): ComposerState {
  return syncComposerState(
    {
      ...state,
      buffer:
        state.buffer.slice(0, state.cursorIndex) +
        value +
        state.buffer.slice(state.cursorIndex),
      cursorIndex: state.cursorIndex + value.length,
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function backspaceComposerText(
  state: ComposerState,
  workspaceFiles: string[],
): ComposerState {
  if (state.cursorIndex === 0) {
    return state;
  }

  return syncComposerState(
    {
      ...state,
      buffer:
        state.buffer.slice(0, state.cursorIndex - 1) +
        state.buffer.slice(state.cursorIndex),
      cursorIndex: state.cursorIndex - 1,
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function deleteComposerText(
  state: ComposerState,
  workspaceFiles: string[],
): ComposerState {
  if (state.cursorIndex >= state.buffer.length) {
    return state;
  }

  return syncComposerState(
    {
      ...state,
      buffer:
        state.buffer.slice(0, state.cursorIndex) +
        state.buffer.slice(state.cursorIndex + 1),
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function moveComposerCursor(
  state: ComposerState,
  nextCursorIndex: number,
  workspaceFiles: string[],
): ComposerState {
  return syncComposerState(
    {
      ...state,
      cursorIndex: nextCursorIndex,
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function moveComposerSuggestionSelection(
  state: ComposerState,
  direction: "up" | "down",
  workspaceFiles: string[],
): ComposerState {
  if (state.suggestions.length === 0) {
    return state;
  }

  return syncComposerState(
    {
      ...state,
      selectedSuggestionIndex:
        direction === "up"
          ? state.selectedSuggestionIndex - 1
          : state.selectedSuggestionIndex + 1,
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function clearComposerError(
  state: ComposerState,
  workspaceFiles: string[],
): ComposerState {
  if (!state.errorMessage) {
    return state;
  }

  return syncComposerState(
    {
      ...state,
      errorMessage: null,
    },
    workspaceFiles,
  );
}

export function applySelectedComposerSuggestion(
  state: ComposerState,
  workspaceFiles: string[],
): ComposerState {
  if (state.activeReference && state.suggestions.length > 0) {
    const selectedSuggestion = state.suggestions[state.selectedSuggestionIndex];
    if (!selectedSuggestion) {
      return state;
    }

    const applied = applyFileSuggestion(
      state.buffer,
      state.activeReference,
      selectedSuggestion,
    );

    return syncComposerState(
      {
        ...state,
        buffer: applied.nextInput,
        cursorIndex: applied.nextCursorIndex,
        selectedSuggestionIndex: 0,
        errorMessage: null,
      },
      workspaceFiles,
    );
  }

  if (state.activeSlashCommand && state.suggestions.length > 0) {
    const selectedSuggestion = state.suggestions[state.selectedSuggestionIndex];
    if (!selectedSuggestion) {
      return state;
    }

    return syncComposerState(
      {
        ...state,
        buffer:
          `${state.buffer.slice(0, state.activeSlashCommand.start)}${selectedSuggestion}` +
          state.buffer.slice(state.activeSlashCommand.end),
        cursorIndex: state.activeSlashCommand.start + selectedSuggestion.length,
        selectedSuggestionIndex: 0,
        errorMessage: null,
      },
      workspaceFiles,
    );
  }

  if (!state.activeReference && !state.activeSlashCommand) {
    return state;
  }

  const errorMessage = state.activeReference
    ? getFileReferenceErrorMessage(state.activeReference.query, workspaceFiles)
    : getSlashCommandErrorMessage(state.activeSlashCommand?.query ?? "");

  return syncComposerState(
    {
      ...state,
      errorMessage,
    },
    workspaceFiles,
  );
}

export function shouldAcceptSuggestionOnSubmit(state: ComposerState): boolean {
  if (!state.activeSlashCommand || state.suggestions.length === 0) {
    return false;
  }

  const selectedSuggestion = state.suggestions[state.selectedSuggestionIndex];
  const activeCommand = state.buffer.slice(
    state.activeSlashCommand.start,
    state.activeSlashCommand.end,
  );
  return Boolean(selectedSuggestion && selectedSuggestion !== activeCommand);
}

export function submitComposer(
  state: ComposerState,
  workspaceFiles: string[],
): {
  state: ComposerState;
  submittedText: string | null;
} {
  if (shouldAcceptSuggestionOnSubmit(state)) {
    return {
      state: applySelectedComposerSuggestion(state, workspaceFiles),
      submittedText: null,
    };
  }
  const unresolvedReferences = getUnresolvedFileReferences(
    state.buffer,
    workspaceFiles,
  );

  if (unresolvedReferences.length > 0) {
    const unresolvedReference = unresolvedReferences[0];
    return {
      state: syncComposerState(
        {
          ...state,
          errorMessage: getFileReferenceErrorMessage(
            unresolvedReference?.query ?? "",
            workspaceFiles,
          ),
        },
        workspaceFiles,
      ),
      submittedText: null,
    };
  }

  return {
    state: syncComposerState(
      {
        ...state,
        errorMessage: null,
      },
      workspaceFiles,
    ),
    submittedText: normalizeFileReferenceEscapes(state.buffer),
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function findActiveSlashCommand(
  buffer: string,
  cursorIndex: number,
): ActiveSlashCommand | null {
  if (!buffer.startsWith("/")) {
    return null;
  }

  const commandEndMatch = /\s/.exec(buffer);
  const commandEnd = commandEndMatch?.index ?? buffer.length;
  if (cursorIndex > commandEnd) {
    return null;
  }

  return {
    start: 0,
    end: commandEnd,
    query: buffer.slice(1, commandEnd),
  };
}

function matchSlashCommands(
  query: string,
  limit: number,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  const ranked: Array<{
    command: (typeof SLASH_COMMAND_SUGGESTIONS)[number];
    index: number;
    score: number;
  }> = [];

  for (const [index, command] of SLASH_COMMAND_SUGGESTIONS.entries()) {
    const score = getSlashCommandMatchScore(command, normalizedQuery);
    if (score === null) {
      continue;
    }

    ranked.push({
      command,
      index,
      score,
    });
  }

  ranked.sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.command.length !== right.command.length) {
        return left.command.length - right.command.length;
      }

      return left.index - right.index;
    });

  return ranked.slice(0, limit).map((entry) => entry.command);
}

function getSlashCommandMatchScore(
  command: string,
  normalizedQuery: string,
): number | null {
  if (!normalizedQuery) {
    return 0;
  }

  const normalizedCommand = command.slice(1).toLowerCase();
  if (normalizedCommand.startsWith(normalizedQuery)) {
    return 0;
  }

  if (normalizedCommand.includes(normalizedQuery)) {
    return 1;
  }

  return isSubsequenceMatch(normalizedCommand, normalizedQuery) ? 2 : null;
}

function isSubsequenceMatch(text: string, query: string): boolean {
  let queryIndex = 0;

  for (const character of text) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex >= query.length) {
        return true;
      }
    }
  }

  return query.length === 0;
}

function getSlashCommandErrorMessage(query: string): string {
  return `No commands match "/${query}".`;
}
