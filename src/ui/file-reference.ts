import path from "node:path";
import { globby } from "globby";

const MAX_WORKSPACE_FILES = 5000;
const MAX_FILE_MATCHES = 6;

export type ActiveFileReference = {
  start: number;
  end: number;
  query: string;
};

export function findActiveFileReference(
  input: string,
  cursorIndex: number,
): ActiveFileReference | null {
  const safeCursorIndex = clamp(cursorIndex, 0, input.length);

  for (const reference of findFileReferences(input)) {
    if (safeCursorIndex >= reference.start + 1 && safeCursorIndex <= reference.end) {
      return reference;
    }
  }

  return null;
}

export function matchWorkspaceFiles(
  filePaths: string[],
  query: string,
  limit = MAX_FILE_MATCHES,
): string[] {
  const normalizedQuery = normalizeFileReferenceQuery(query);
  const rankedMatches = filePaths
    .flatMap((filePath) => {
      const score = getFileMatchScore(filePath, normalizedQuery);
      if (score === null) {
        return [];
      }

      return [{ filePath, score }];
    })
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }

      if (left.filePath.length !== right.filePath.length) {
        return left.filePath.length - right.filePath.length;
      }

      return left.filePath.localeCompare(right.filePath);
    });

  return rankedMatches.slice(0, limit).map((entry) => entry.filePath);
}

export function applyFileSuggestion(
  input: string,
  reference: ActiveFileReference,
  filePath: string,
): {
  nextInput: string;
  nextCursorIndex: number;
} {
  const nextChar = input[reference.end] ?? "";
  const needsTrailingSpace =
    !nextChar || (!/\s/.test(nextChar) && !/[.,;:!?)\]}]/.test(nextChar));
  const replacement = `@${filePath}${needsTrailingSpace ? " " : ""}`;
  const nextInput =
    input.slice(0, reference.start) +
    replacement +
    input.slice(reference.end);

  return {
    nextInput,
    nextCursorIndex: reference.start + replacement.length,
  };
}

export function getUnresolvedFileReferences(
  input: string,
  filePaths: string[],
): ActiveFileReference[] {
  return findFileReferences(input).filter(
    (reference) => !isResolvedFileReference(reference.query, filePaths),
  );
}

export function getFileReferenceErrorMessage(
  query: string,
  filePaths: string[],
): string {
  const matches = matchWorkspaceFiles(filePaths, query, 1);
  if (matches.length === 0) {
    return `No files match "@${query}".`;
  }

  return `Resolve file reference "@${query}" before sending.`;
}

export function normalizeFileReferenceEscapes(input: string): string {
  let output = "";

  for (let index = 0; index < input.length; index += 1) {
    const currentChar = input[index];
    const nextChar = input[index + 1];

    if (currentChar === "@" && nextChar === "@") {
      output += "@";
      index += 1;
      continue;
    }

    output += currentChar ?? "";
  }

  return output;
}

export async function loadWorkspaceFilePaths(
  workspaceRoot: string,
): Promise<string[]> {
  const filePaths = await globby(["**/*"], {
    cwd: workspaceRoot,
    onlyFiles: true,
    gitignore: true,
    ignore: [
      ".git/**",
      "node_modules/**",
      "dist/**",
    ],
    followSymbolicLinks: false,
  });

  return filePaths
    .map((filePath) => filePath.replace(/\\/g, "/"))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_WORKSPACE_FILES);
}

function findFileReferences(input: string): ActiveFileReference[] {
  const references: ActiveFileReference[] = [];

  for (let index = 0; index < input.length; index += 1) {
    const currentChar = input[index];
    const nextChar = input[index + 1];

    if (currentChar !== "@") {
      continue;
    }

    if (nextChar === "@") {
      index += 1;
      continue;
    }

    const beforeAt = index === 0 ? "" : input[index - 1] ?? "";
    if (!(index === 0 || /\s|["'([{]/.test(beforeAt))) {
      continue;
    }

    const end = findReferenceEnd(input, index + 1);
    references.push({
      start: index,
      end,
      query: input.slice(index + 1, end),
    });

    index = Math.max(index, end - 1);
  }

  return references;
}

function findReferenceEnd(input: string, fromIndex: number): number {
  for (let index = fromIndex; index < input.length; index += 1) {
    const currentChar = input[index];
    if (!currentChar || /\s/.test(currentChar)) {
      return index;
    }
  }

  return input.length;
}

function getFileMatchScore(filePath: string, query: string): number | null {
  const normalizedFilePath = normalizeFileReferenceQuery(filePath);
  if (!query) {
    return 5;
  }

  if (normalizedFilePath === query) {
    return 0;
  }

  if (normalizedFilePath.startsWith(query)) {
    return 1;
  }

  const basename = path.posix.basename(normalizedFilePath);
  if (basename === query) {
    return 2;
  }

  if (basename.startsWith(query)) {
    return 3;
  }

  if (normalizedFilePath.includes(`/${query}`)) {
    return 4;
  }

  if (normalizedFilePath.includes(query)) {
    return 5;
  }

  return null;
}

function isResolvedFileReference(query: string, filePaths: string[]): boolean {
  const normalizedQuery = normalizeFileReferenceQuery(query);

  return filePaths.some(
    (filePath) => normalizeFileReferenceQuery(filePath) === normalizedQuery,
  );
}

function normalizeFileReferenceQuery(query: string): string {
  return query.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
