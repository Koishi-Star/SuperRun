import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { getConfigDirectoryPath } from "../config/paths.js";
import {
  normalizeRelativeWorkspacePath,
  resolveWorkspacePath,
} from "./workspace.js";

type TrashIndex = {
  entries: DeletedFileEntry[];
};

export type DeletedFileEntry = {
  id: string;
  originalPath: string;
  deletedAt: string;
  sizeBytes: number;
  storedFileName: string;
};

export type DeleteAreaStatus = {
  fileCount: number;
  totalBytes: number;
};

export async function moveWorkspaceFileToTrash(
  toolName: string,
  targetPath: string,
): Promise<{
  entry: DeletedFileEntry;
  status: DeleteAreaStatus;
}> {
  const workspaceRoot = process.cwd();
  const relativePath = normalizeRelativeWorkspacePath(toolName, targetPath);
  const absolutePath = resolveWorkspacePath(toolName, workspaceRoot, relativePath);
  const stat = await lstat(absolutePath);

  if (!stat.isFile()) {
    throw new Error(`${toolName} currently supports files only.`);
  }

  const trashPaths = getWorkspaceTrashPaths(workspaceRoot);
  const index = await loadTrashIndex(trashPaths.indexPath);
  const entry: DeletedFileEntry = {
    id: randomUUID(),
    originalPath: relativePath,
    deletedAt: new Date().toISOString(),
    sizeBytes: stat.size,
    storedFileName: buildStoredFileName(relativePath),
  };
  const storedFilePath = path.join(trashPaths.filesDirectoryPath, entry.storedFileName);

  await mkdir(trashPaths.filesDirectoryPath, { recursive: true });
  await copyFile(absolutePath, storedFilePath);
  await unlink(absolutePath);

  index.entries.push(entry);
  await saveTrashIndex(trashPaths.indexPath, index);

  return {
    entry,
    status: summarizeTrashIndex(index),
  };
}

export async function restoreWorkspaceFileFromTrash(
  id: string,
): Promise<{
  restoredPath: string;
  entry: DeletedFileEntry;
  status: DeleteAreaStatus;
}> {
  const workspaceRoot = process.cwd();
  const trashPaths = getWorkspaceTrashPaths(workspaceRoot);
  const index = await loadTrashIndex(trashPaths.indexPath);
  const entry = index.entries.find((candidate) => candidate.id === id);

  if (!entry) {
    throw new Error(`Deleted file does not exist: ${id}`);
  }

  const storedFilePath = path.join(trashPaths.filesDirectoryPath, entry.storedFileName);
  const restoredRelativePath = await chooseRestorePath(workspaceRoot, entry.originalPath);
  const restoredAbsolutePath = resolveWorkspacePath(
    "restore_deleted_file",
    workspaceRoot,
    restoredRelativePath,
  );

  await mkdir(path.dirname(restoredAbsolutePath), { recursive: true });
  await copyFile(storedFilePath, restoredAbsolutePath);
  await unlink(storedFilePath);

  index.entries = index.entries.filter((candidate) => candidate.id !== id);
  await saveTrashIndex(trashPaths.indexPath, index);

  return {
    restoredPath: restoredRelativePath,
    entry,
    status: summarizeTrashIndex(index),
  };
}

async function chooseRestorePath(
  workspaceRoot: string,
  originalPath: string,
): Promise<string> {
  let candidate = originalPath;
  let suffixIndex = 0;

  while (true) {
    const absoluteCandidate = resolveWorkspacePath(
      "restore_deleted_file",
      workspaceRoot,
      candidate,
    );

    try {
      await lstat(absoluteCandidate);
      suffixIndex += 1;
      candidate = suffixIndex === 1
        ? buildRecoverPath(originalPath)
        : buildRecoverPath(originalPath, suffixIndex);
    } catch (error) {
      if (isMissingFileError(error)) {
        return candidate;
      }

      throw error;
    }
  }
}

function buildRecoverPath(filePath: string, suffixIndex?: number): string {
  const directory = path.posix.dirname(filePath);
  const extension = path.posix.extname(filePath);
  const baseName = extension
    ? path.posix.basename(filePath, extension)
    : path.posix.basename(filePath);
  const recoverSuffix = suffixIndex && suffixIndex > 1
    ? `-recover-${suffixIndex}`
    : "-recover";
  const recoveredName = `${baseName}${recoverSuffix}${extension}`;

  return directory === "." ? recoveredName : path.posix.join(directory, recoveredName);
}

function buildStoredFileName(originalPath: string): string {
  const extension = path.posix.extname(originalPath);
  return `${randomUUID()}${extension}`;
}

function getWorkspaceTrashPaths(workspaceRoot: string): {
  indexPath: string;
  filesDirectoryPath: string;
} {
  const workspaceKey = createHash("sha1")
    .update(normalizeWorkspaceRoot(workspaceRoot))
    .digest("hex")
    .slice(0, 16);
  const rootPath = getConfigDirectoryPath("trash", workspaceKey);

  return {
    indexPath: path.join(rootPath, "index.json"),
    filesDirectoryPath: path.join(rootPath, "files"),
  };
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function loadTrashIndex(indexPath: string): Promise<TrashIndex> {
  try {
    const content = await readFile(indexPath, "utf8");
    const parsed = JSON.parse(content) as Partial<TrashIndex>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(isDeletedFileEntry)
      : [];
    return { entries };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { entries: [] };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Trash index is not valid JSON: ${indexPath}`);
    }

    throw error;
  }
}

async function saveTrashIndex(indexPath: string, index: TrashIndex): Promise<void> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(`${indexPath}`, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

function summarizeTrashIndex(index: TrashIndex): DeleteAreaStatus {
  return {
    fileCount: index.entries.length,
    totalBytes: index.entries.reduce((total, entry) => total + entry.sizeBytes, 0),
  };
}

function isDeletedFileEntry(value: unknown): value is DeletedFileEntry {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as DeletedFileEntry).id === "string" &&
    typeof (value as DeletedFileEntry).originalPath === "string" &&
    typeof (value as DeletedFileEntry).deletedAt === "string" &&
    typeof (value as DeletedFileEntry).sizeBytes === "number" &&
    typeof (value as DeletedFileEntry).storedFileName === "string";
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}
