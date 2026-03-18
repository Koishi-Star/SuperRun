/**
 * Symbol-aware code resolution engine backed by ts-morph.
 *
 * Provides AST-level symbol listing, source extraction, and range
 * resolution for TypeScript and JavaScript files.  Non-TS/JS files
 * gracefully return empty results so callers can fall back to
 * line-based editing.
 */

import { createHash } from "node:crypto";
import { Project, SyntaxKind, type SourceFile, type Node } from "ts-morph";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "unknown";

export type MemberEntry = {
  name: string;
  kind: "method" | "property" | "function" | "getter" | "setter";
  startLine: number;
  endLine: number;
};

export type FileSymbolEntry = {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  lineCount: number;
  bodyHash: string;
  /** Named members — class methods/properties or nested function declarations (one level only). */
  members?: MemberEntry[];
};

export type SymbolSourceResult = {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  bodyHash: string;
  /** Full or truncated source text of the symbol declaration. */
  source: string;
  /** True when the source was truncated because the symbol exceeds LARGE_SYMBOL_THRESHOLD. */
  truncated?: boolean;
  /** Named members when the symbol is large and was truncated. */
  members?: MemberEntry[];
  /** Import lines from the file header (for context). */
  imports: string[];
};

export type SymbolMemberSourceResult = {
  symbolName: string;
  memberName: string;
  kind: MemberEntry["kind"];
  startLine: number;
  endLine: number;
  bodyHash: string;
  source: string;
  imports: string[];
};

export type SymbolRangeResult = {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  bodyHash: string;
};

export type SymbolMemberRangeResult = {
  symbolName: string;
  memberName: string;
  kind: MemberEntry["kind"];
  startLine: number;
  endLine: number;
  bodyHash: string;
};

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/** Compute a short hex hash (8 chars) of a source string. */
export function computeBodyHash(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex").slice(0, 8);
}

// ---------------------------------------------------------------------------
// Supported file extensions
// ---------------------------------------------------------------------------

const SUPPORTED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs",
]);

export function isSupportedSourceFile(filePath: string): boolean {
  const dotIndex = filePath.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return SUPPORTED_EXTENSIONS.has(filePath.slice(dotIndex).toLowerCase());
}

// ---------------------------------------------------------------------------
// ts-morph project (lazy singleton — cheap to create, reuses TS lib cache)
// ---------------------------------------------------------------------------

let cachedProject: Project | null = null;

function getProject(): Project {
  if (!cachedProject) {
    cachedProject = new Project({
      compilerOptions: {
        allowJs: true,
        jsx: 4 /* JsxEmit.ReactJSX */,
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        // Do not resolve node_modules for symbol listing.
        types: [],
      },
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
    });
  }
  return cachedProject;
}

/**
 * Parse a single file into a ts-morph SourceFile.
 * Re-creates the source if the project already contains a file at that path
 * (ensures fresh content after external edits).
 */
function parseSourceFile(absolutePath: string, content: string): SourceFile {
  const project = getProject();
  const existing = project.getSourceFile(absolutePath);
  if (existing) {
    existing.replaceWithText(content);
    return existing;
  }
  return project.createSourceFile(absolutePath, content, { overwrite: true });
}

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

function syntaxKindToSymbolKind(kind: SyntaxKind): SymbolKind {
  switch (kind) {
    case SyntaxKind.FunctionDeclaration:
      return "function";
    case SyntaxKind.ClassDeclaration:
      return "class";
    case SyntaxKind.InterfaceDeclaration:
      return "interface";
    case SyntaxKind.TypeAliasDeclaration:
      return "type";
    case SyntaxKind.EnumDeclaration:
      return "enum";
    case SyntaxKind.VariableStatement:
      return "variable";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Top-level statement extraction
// ---------------------------------------------------------------------------

/**
 * Collect top-level named declarations from a source file.
 * For VariableStatements we emit one entry per declarator so that
 * `const foo = ...` and `const bar = ...` are separate symbols.
 */
function collectTopLevelSymbols(
  sourceFile: SourceFile,
): { name: string; kind: SymbolKind; node: Node }[] {
  const results: { name: string; kind: SymbolKind; node: Node }[] = [];

  for (const statement of sourceFile.getStatements()) {
    const sk = statement.getKind();

    if (sk === SyntaxKind.VariableStatement) {
      // Unwrap `export const foo = { ... }` into individual declarators,
      // but keep the *statement* as the node so the full text includes
      // `export` / `const` keywords.
      const decls = statement.asKindOrThrow(SyntaxKind.VariableStatement)
        .getDeclarationList()
        .getDeclarations();
      for (const decl of decls) {
        const name = decl.getName();
        if (name) {
          results.push({ name, kind: "variable", node: statement });
        }
      }
      continue;
    }

    const symbolKind = syntaxKindToSymbolKind(sk);
    if (symbolKind === "unknown") continue;

    // Named declarations have a getName() method.
    const nameNode = (statement as unknown as { getName?: () => string | undefined }).getName?.();
    if (!nameNode) continue;

    results.push({ name: nameNode, kind: symbolKind, node: statement });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Member collection (one level deep)
// ---------------------------------------------------------------------------

/** Lines above which a symbol is considered "large" and may be truncated. */
export const LARGE_SYMBOL_THRESHOLD = 200;

/** Truncated preview: how many leading/trailing lines to keep. */
const TRUNCATION_HEAD_LINES = 30;
const TRUNCATION_TAIL_LINES = 10;

/**
 * Collect named members inside a top-level symbol.
 * - ClassDeclaration → methods, properties, getters, setters.
 * - FunctionDeclaration / arrow-function variable → nested named FunctionDeclarations (one level).
 * Returns undefined for symbols that have no meaningful member structure.
 */
export function collectSymbolMembers(node: Node): MemberEntry[] | undefined {
  const kind = node.getKind();

  // --- Class members ---
  if (kind === SyntaxKind.ClassDeclaration) {
    const cls = node.asKindOrThrow(SyntaxKind.ClassDeclaration);
    const members: MemberEntry[] = [];
    for (const member of cls.getMembers()) {
      const mk = member.getKind();
      let memberKind: MemberEntry["kind"];
      if (mk === SyntaxKind.MethodDeclaration) memberKind = "method";
      else if (mk === SyntaxKind.PropertyDeclaration) memberKind = "property";
      else if (mk === SyntaxKind.GetAccessor) memberKind = "getter";
      else if (mk === SyntaxKind.SetAccessor) memberKind = "setter";
      else continue;

      const name = (member as unknown as { getName?: () => string | undefined }).getName?.();
      if (!name) continue;

      members.push({
        name,
        kind: memberKind,
        startLine: member.getStartLineNumber(),
        endLine: member.getEndLineNumber(),
      });
    }
    return members.length > 0 ? members : undefined;
  }

  // --- Function body → nested named functions ---
  if (kind === SyntaxKind.FunctionDeclaration) {
    const fn = node.asKindOrThrow(SyntaxKind.FunctionDeclaration);
    const body = fn.getBody();
    if (!body) return undefined;
    return collectNestedFunctions(body);
  }

  // --- Variable with arrow/function expression → nested named functions ---
  if (kind === SyntaxKind.VariableStatement) {
    const decls = node.asKindOrThrow(SyntaxKind.VariableStatement)
      .getDeclarationList()
      .getDeclarations();
    for (const decl of decls) {
      const init = decl.getInitializer();
      if (!init) continue;
      const ik = init.getKind();
      if (ik === SyntaxKind.ArrowFunction || ik === SyntaxKind.FunctionExpression) {
        // Arrow functions have a getBody that might be Block or expression.
        const bodyNode = (init as unknown as { getBody?: () => Node | undefined }).getBody?.();
        if (bodyNode && bodyNode.getKind() === SyntaxKind.Block) {
          return collectNestedFunctions(bodyNode);
        }
      }
    }
    return undefined;
  }

  return undefined;
}

/** Scan a Block node for direct child FunctionDeclaration nodes. */
function collectNestedFunctions(block: Node): MemberEntry[] | undefined {
  const members: MemberEntry[] = [];
  for (const child of block.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      // The actual statements live inside the SyntaxList.
      for (const stmt of child.getChildren()) {
        if (stmt.getKind() === SyntaxKind.FunctionDeclaration) {
          const name = stmt.asKindOrThrow(SyntaxKind.FunctionDeclaration).getName();
          if (name) {
            members.push({
              name,
              kind: "function",
              startLine: stmt.getStartLineNumber(),
              endLine: stmt.getEndLineNumber(),
            });
          }
        }
      }
    }
  }
  return members.length > 0 ? members : undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all top-level named symbols in a file.
 * Returns an empty array for unsupported file types.
 */
export function listFileSymbols(
  absolutePath: string,
  content: string,
): FileSymbolEntry[] {
  if (!isSupportedSourceFile(absolutePath)) return [];

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);

  return symbols.map(({ name, kind, node }) => {
    const startLine = node.getStartLineNumber();
    const endLine = node.getEndLineNumber();
    const lineCount = endLine - startLine + 1;
    const source = node.getFullText().trim();
    const members = collectSymbolMembers(node);
    return {
      name,
      kind,
      startLine,
      endLine,
      lineCount,
      bodyHash: computeBodyHash(source),
      ...(members ? { members } : {}),
    };
  });
}

/**
 * Get the source of a named symbol, with optional member drilling and large-symbol truncation.
 *
 * - If `memberName` is given, returns only that member's source (see `getSymbolMemberSource`).
 * - If the symbol exceeds LARGE_SYMBOL_THRESHOLD lines and `full` is not true,
 *   returns a truncated preview (head + member list + tail) instead of the full source.
 * - Pass `full: true` to force full source even for large symbols.
 */
export function getSymbolSource(
  absolutePath: string,
  content: string,
  symbolName: string,
  options?: { memberName?: string; full?: boolean },
): SymbolSourceResult | null {
  if (!isSupportedSourceFile(absolutePath)) return null;

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);
  const match = symbols.find((s) => s.name === symbolName);
  if (!match) return null;

  const imports = sourceFile.getImportDeclarations().map((d) => d.getText());
  const fullSource = match.node.getFullText().trim();
  const startLine = match.node.getStartLineNumber();
  const endLine = match.node.getEndLineNumber();
  const lineCount = endLine - startLine + 1;
  const bodyHash = computeBodyHash(fullSource);
  const members = collectSymbolMembers(match.node);

  // If a specific member is requested, delegate.
  if (options?.memberName) {
    // Still return SymbolSourceResult shape for the parent, but source is the member only.
    const memberResult = getSymbolMemberSource(absolutePath, content, symbolName, options.memberName);
    if (!memberResult) return null;
    return {
      name: symbolName,
      kind: match.kind,
      startLine: memberResult.startLine,
      endLine: memberResult.endLine,
      bodyHash: memberResult.bodyHash,
      source: memberResult.source,
      imports,
    };
  }

  // Truncation for large symbols (unless `full: true`).
  if (lineCount > LARGE_SYMBOL_THRESHOLD && !options?.full) {
    const sourceLines = fullSource.split("\n");
    const headLines = sourceLines.slice(0, TRUNCATION_HEAD_LINES);
    const tailLines = sourceLines.slice(-TRUNCATION_TAIL_LINES);

    const memberSummary = members
      ? members.map((m) => `  ${m.kind} ${m.name} (lines ${m.startLine}-${m.endLine})`).join("\n")
      : "  (no named members found — use search_workspace to locate specific code)";

    const truncatedSource = [
      ...headLines,
      "",
      `// ... [${lineCount - TRUNCATION_HEAD_LINES - TRUNCATION_TAIL_LINES} lines truncated] ...`,
      `// This symbol has ${lineCount} lines. Use the \`member\` parameter to read a specific member,`,
      `// or pass \`full: true\` to read the entire source.`,
      `//`,
      `// Named members:`,
      ...memberSummary.split("\n").map((l) => `// ${l}`),
      "",
      ...tailLines,
    ].join("\n");

    return {
      name: match.name,
      kind: match.kind,
      startLine,
      endLine,
      bodyHash,
      source: truncatedSource,
      truncated: true,
      ...(members ? { members } : {}),
      imports,
    };
  }

  return {
    name: match.name,
    kind: match.kind,
    startLine,
    endLine,
    bodyHash,
    source: fullSource,
    ...(members ? { members } : {}),
    imports,
  };
}

/**
 * Resolve a symbol to its line range and current hash.
 * Returns null if the symbol is not found.
 */
export function resolveSymbolRange(
  absolutePath: string,
  content: string,
  symbolName: string,
): SymbolRangeResult | null {
  if (!isSupportedSourceFile(absolutePath)) return null;

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);
  const match = symbols.find((s) => s.name === symbolName);
  if (!match) return null;

  const source = match.node.getFullText().trim();
  return {
    name: match.name,
    kind: match.kind,
    startLine: match.node.getStartLineNumber(),
    endLine: match.node.getEndLineNumber(),
    bodyHash: computeBodyHash(source),
  };
}

/**
 * Get the source of a specific member inside a top-level symbol.
 * Returns null if the parent symbol or member is not found.
 */
export function getSymbolMemberSource(
  absolutePath: string,
  content: string,
  symbolName: string,
  memberName: string,
): SymbolMemberSourceResult | null {
  if (!isSupportedSourceFile(absolutePath)) return null;

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);
  const match = symbols.find((s) => s.name === symbolName);
  if (!match) return null;

  const members = collectSymbolMembers(match.node);
  if (!members) return null;

  const memberMeta = members.find((m) => m.name === memberName);
  if (!memberMeta) return null;

  // Extract the member's source from the file content by line range.
  const lines = content.split("\n");
  const memberSource = lines.slice(memberMeta.startLine - 1, memberMeta.endLine).join("\n");
  const imports = sourceFile.getImportDeclarations().map((d) => d.getText());

  return {
    symbolName,
    memberName,
    kind: memberMeta.kind,
    startLine: memberMeta.startLine,
    endLine: memberMeta.endLine,
    bodyHash: computeBodyHash(memberSource),
    source: memberSource,
    imports,
  };
}

/**
 * Resolve a member inside a top-level symbol to its line range and current hash.
 * Returns null if the parent symbol or member is not found.
 */
export function resolveSymbolMemberRange(
  absolutePath: string,
  content: string,
  symbolName: string,
  memberName: string,
): SymbolMemberRangeResult | null {
  if (!isSupportedSourceFile(absolutePath)) return null;

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);
  const match = symbols.find((s) => s.name === symbolName);
  if (!match) return null;

  const members = collectSymbolMembers(match.node);
  if (!members) return null;

  const memberMeta = members.find((m) => m.name === memberName);
  if (!memberMeta) return null;

  const lines = content.split("\n");
  const memberSource = lines.slice(memberMeta.startLine - 1, memberMeta.endLine).join("\n");

  return {
    symbolName,
    memberName,
    kind: memberMeta.kind,
    startLine: memberMeta.startLine,
    endLine: memberMeta.endLine,
    bodyHash: computeBodyHash(memberSource),
  };
}

/**
 * Quick-check whether a string of TS/JS source parses without syntax errors.
 * Used after replace_symbol_body to verify the edit didn't break syntax.
 */
export function hasParseErrors(
  absolutePath: string,
  content: string,
): boolean {
  if (!isSupportedSourceFile(absolutePath)) return false;

  const sourceFile = parseSourceFile(absolutePath, content);
  // ts-morph exposes parsed diagnostics that catch syntax errors.
  const diagnostics = sourceFile.getPreEmitDiagnostics();
  return diagnostics.some(
    (d) => d.getCategory() === 1 /* DiagnosticCategory.Error */,
  );
}

/**
 * Return up to `maxErrors` syntax/parse error messages for a TS/JS file.
 * Each entry includes the line number and the error message text.
 * Returns an empty array for unsupported file types or clean files.
 */
export function getSyntaxErrors(
  absolutePath: string,
  content: string,
  maxErrors: number = 10,
): string[] {
  if (!isSupportedSourceFile(absolutePath)) return [];

  const sourceFile = parseSourceFile(absolutePath, content);
  const diagnostics = sourceFile.getPreEmitDiagnostics();
  const errors: string[] = [];

  for (const d of diagnostics) {
    if (d.getCategory() !== 1 /* DiagnosticCategory.Error */) continue;
    const line = d.getLineNumber() ?? 0;
    const messageText = d.getMessageText();
    const text = typeof messageText === "string"
      ? messageText
      : messageText.getMessageText();
    errors.push(`Line ${line}: ${text}`);
    if (errors.length >= maxErrors) break;
  }

  return errors;
}
