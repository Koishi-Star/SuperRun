import path from "node:path";

export function normalizeRelativeWorkspacePath(
  toolName: string,
  value: string | undefined,
): string {
  const normalized = value?.trim() || ".";
  if (path.isAbsolute(normalized)) {
    throw new Error(`${toolName} path must be relative to the workspace root.`);
  }

  return normalized.replace(/\\/g, "/");
}

export function resolveWorkspacePath(
  toolName: string,
  workspaceRoot: string,
  relativePath: string,
): string {
  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const relativeToRoot = path.relative(workspaceRoot, resolvedPath);

  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`${toolName} path must stay inside the workspace root.`);
  }

  return resolvedPath;
}
