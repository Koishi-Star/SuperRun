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

export type ComposerState = {
  buffer: string;
  cursorIndex: number;
  activeReference: ActiveFileReference | null;
  suggestions: string[];
  selectedSuggestionIndex: number;
  errorMessage: string | null;
};

export function createComposerState(): ComposerState {
  return syncComposerState({
    buffer: "",
    cursorIndex: 0,
    activeReference: null,
    suggestions: [],
    selectedSuggestionIndex: 0,
    errorMessage: null,
  }, []);
}

export function syncComposerState(
  nextState: Omit<ComposerState, "activeReference" | "suggestions"> & {
    activeReference?: ActiveFileReference | null;
    suggestions?: string[];
  },
  workspaceFiles: string[],
): ComposerState {
  const cursorIndex = clamp(nextState.cursorIndex, 0, nextState.buffer.length);
  const activeReference = findActiveFileReference(nextState.buffer, cursorIndex);
  const suggestions = activeReference
    ? matchWorkspaceFiles(
        workspaceFiles,
        activeReference.query,
        MAX_VISIBLE_MATCHES,
      )
    : [];

  return {
    buffer: nextState.buffer,
    cursorIndex,
    activeReference,
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
  if (!state.activeReference || state.suggestions.length === 0) {
    return syncComposerState(
      {
        ...state,
        errorMessage: state.activeReference
          ? getFileReferenceErrorMessage(state.activeReference.query, workspaceFiles)
          : state.errorMessage,
      },
      workspaceFiles,
    );
  }

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

export function submitComposer(
  state: ComposerState,
  workspaceFiles: string[],
): {
  state: ComposerState;
  submittedText: string | null;
} {
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
