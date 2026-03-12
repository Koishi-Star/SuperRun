import type { SessionSummary } from "../session/store.js";

export const SESSION_PICKER_PAGE_SIZE = 3;
export const SESSION_PICKER_EXIT_LABEL = "Return to chat";

export type SessionPickerDirection = "up" | "down" | "left" | "right";

export type SessionPickerState = {
  pageIndex: number;
  selectedIndex: number;
};

export type SessionPickerOption =
  | {
      kind: "session";
      session: SessionSummary;
      globalIndex: number;
      isCurrent: boolean;
    }
  | {
      kind: "exit";
      label: string;
    };

export type SessionPickerViewModel = {
  pageIndex: number;
  totalPages: number;
  selectedIndex: number;
  filterQuery: string | null;
  resultCount: number;
  options: SessionPickerOption[];
};

export function createSessionPickerState(): SessionPickerState {
  return {
    pageIndex: 0,
    selectedIndex: 0,
  };
}

export function getSessionPickerViewModel(
  sessions: SessionSummary[],
  currentSessionId: string | null,
  state: SessionPickerState,
  viewOptions?: {
    filterQuery?: string | null | undefined;
  },
): SessionPickerViewModel {
  const normalizedState = normalizeSessionPickerState(state, sessions);
  const pageSessions = getPageSessions(sessions, normalizedState.pageIndex);
  const pickerOptions: SessionPickerOption[] = pageSessions.map((session, index) => ({
    kind: "session",
    session,
    globalIndex: normalizedState.pageIndex * SESSION_PICKER_PAGE_SIZE + index + 1,
    isCurrent: session.id === currentSessionId,
  }));
  pickerOptions.push({
    kind: "exit",
    label: SESSION_PICKER_EXIT_LABEL,
  });

  return {
    pageIndex: normalizedState.pageIndex,
    totalPages: getTotalPages(sessions),
    selectedIndex: normalizedState.selectedIndex,
    filterQuery: normalizeFilterQuery(viewOptions?.filterQuery),
    resultCount: sessions.length,
    options: pickerOptions,
  };
}

export function moveSessionPicker(
  state: SessionPickerState,
  sessions: SessionSummary[],
  direction: SessionPickerDirection,
): SessionPickerState {
  const normalizedState = normalizeSessionPickerState(state, sessions);
  const totalPages = getTotalPages(sessions);

  if (direction === "left") {
    return normalizeSessionPickerState(
      {
        pageIndex: Math.max(0, normalizedState.pageIndex - 1),
        selectedIndex: normalizedState.selectedIndex,
      },
      sessions,
    );
  }

  if (direction === "right") {
    return normalizeSessionPickerState(
      {
        pageIndex: Math.min(totalPages - 1, normalizedState.pageIndex + 1),
        selectedIndex: normalizedState.selectedIndex,
      },
      sessions,
    );
  }

  const optionCount = getPageOptionCount(sessions, normalizedState.pageIndex);

  if (direction === "down") {
    if (normalizedState.selectedIndex < optionCount - 1) {
      return {
        pageIndex: normalizedState.pageIndex,
        selectedIndex: normalizedState.selectedIndex + 1,
      };
    }

    if (normalizedState.pageIndex < totalPages - 1) {
      // Moving past the last row advances to the next page for faster browsing.
      return {
        pageIndex: normalizedState.pageIndex + 1,
        selectedIndex: 0,
      };
    }

    return normalizedState;
  }

  if (normalizedState.selectedIndex > 0) {
    return {
      pageIndex: normalizedState.pageIndex,
      selectedIndex: normalizedState.selectedIndex - 1,
    };
  }

  if (normalizedState.pageIndex > 0) {
    const previousPageIndex = normalizedState.pageIndex - 1;
    return {
      pageIndex: previousPageIndex,
      selectedIndex: getPageOptionCount(sessions, previousPageIndex) - 1,
    };
  }

  return normalizedState;
}

function normalizeSessionPickerState(
  state: SessionPickerState,
  sessions: SessionSummary[],
): SessionPickerState {
  const totalPages = getTotalPages(sessions);
  const pageIndex = clamp(state.pageIndex, 0, totalPages - 1);
  const selectedIndex = clamp(
    state.selectedIndex,
    0,
    getPageOptionCount(sessions, pageIndex) - 1,
  );

  return {
    pageIndex,
    selectedIndex,
  };
}

function getTotalPages(sessions: SessionSummary[]): number {
  return Math.max(1, Math.ceil(sessions.length / SESSION_PICKER_PAGE_SIZE));
}

function getPageSessions(
  sessions: SessionSummary[],
  pageIndex: number,
): SessionSummary[] {
  const start = pageIndex * SESSION_PICKER_PAGE_SIZE;
  return sessions.slice(start, start + SESSION_PICKER_PAGE_SIZE);
}

function getPageOptionCount(
  sessions: SessionSummary[],
  pageIndex: number,
): number {
  return getPageSessions(sessions, pageIndex).length + 1;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizeFilterQuery(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}
