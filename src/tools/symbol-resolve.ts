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

export type FileSymbolEntry = {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  bodyHash: string;
};

export type SymbolSourceResult = {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  bodyHash: string;
  /** Full source text of the symbol declaration. */
  source: string;
  /** Import lines from the file header (for context). */
  imports: string[];
};

export type SymbolRangeResult = {
  name: string;
  kind: SymbolKind;
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
    const source = node.getFullText().trim();
    return {
      name,
      kind,
      startLine,
      endLine,
      bodyHash: computeBodyHash(source),
    };
  });
}

/**
 * Get the full source of a named symbol, plus the file's import lines.
 * Returns null if the symbol is not found or the file type is unsupported.
 */
export function getSymbolSource(
  absolutePath: string,
  content: string,
  symbolName: string,
): SymbolSourceResult | null {
  if (!isSupportedSourceFile(absolutePath)) return null;

  const sourceFile = parseSourceFile(absolutePath, content);
  const symbols = collectTopLevelSymbols(sourceFile);
  const match = symbols.find((s) => s.name === symbolName);
  if (!match) return null;

  const source = match.node.getFullText().trim();
  const imports = sourceFile.getImportDeclarations().map((d) => d.getText());

  return {
    name: match.name,
    kind: match.kind,
    startLine: match.node.getStartLineNumber(),
    endLine: match.node.getEndLineNumber(),
    bodyHash: computeBodyHash(source),
    source,
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
