import { fetch } from "undici";
import { z } from "zod";
import { buildProviderDispatcher } from "../llm/http.js";
import type { ToolDefinition } from "../llm/types.js";
import type { ToolExecutionContext } from "./types.js";

export const FETCH_WEBPAGE_TOOL_NAME = "fetch_webpage";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_OUTLINE_MAX_CHARS = 2_500;
const DEFAULT_ARTICLE_MAX_CHARS = 6_000;
const MAX_OUTPUT_CHARS = 12_000;
const MAX_HEADINGS = 18;
const MAX_READER_TITLE_CHARS = 160;

const fetchWebpageArgsSchema = z.object({
  url: z
    .string()
    .trim()
    .url()
    .refine(
      (value) => value.startsWith("http://") || value.startsWith("https://"),
      "fetch_webpage only supports http:// and https:// URLs.",
    ),
  mode: z.enum(["outline", "article"]).optional(),
  max_chars: z.number().int().min(200).max(MAX_OUTPUT_CHARS).optional(),
  timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
});

export type FetchWebpageArgs = z.infer<typeof fetchWebpageArgsSchema>;
export type FetchWebpageMode = "outline" | "article";
type FetchWebpageExtraction = "reader" | "html-outline" | "html-article" | "plain-text";

type HeadingEntry = {
  level: number;
  text: string;
};

export type FetchWebpageResult = {
  url: string;
  finalUrl: string;
  mode: FetchWebpageMode;
  extraction: FetchWebpageExtraction;
  title: string | null;
  description: string | null;
  headings: HeadingEntry[];
  content: string;
  truncated: boolean;
};

export type FetchWebpageCacheEntry = {
  outline?: FetchWebpageResult;
  article?: FetchWebpageResult;
};

export type FetchWebpageSessionCache = Map<string, FetchWebpageCacheEntry>;

export type FetchWebpageToolResult = {
  ok: true;
  normalizedUrl: string;
  requestedMode: FetchWebpageMode;
  cacheHit: boolean;
  policyApplied?: "outline_before_article";
  note?: string;
} & FetchWebpageResult;

export const fetchWebpageTool = {
  definition: {
    name: FETCH_WEBPAGE_TOOL_NAME,
    description:
      "Fetch a web page without shelling out to curl. Prefer mode \"outline\" first to get the title, description, and heading structure. Use mode \"article\" only after the outline shows the page is worth reading or the user explicitly asks for fuller page text.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The absolute http:// or https:// URL to inspect.",
        },
        mode: {
          type: "string",
          enum: ["outline", "article"],
          description:
            "Use \"outline\" for a cheap first pass, then \"article\" only if more detail is needed.",
        },
        max_chars: {
          type: "integer",
          minimum: 200,
          maximum: MAX_OUTPUT_CHARS,
          description:
            `Optional response size cap in characters. Defaults to ${DEFAULT_OUTLINE_MAX_CHARS} for outline and ${DEFAULT_ARTICLE_MAX_CHARS} for article mode.`,
        },
        timeout_ms: {
          type: "integer",
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
          description: `Optional network timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  } satisfies ToolDefinition,
  async execute(
    rawArguments: string,
    context?: ToolExecutionContext,
  ): Promise<string> {
    return executeFetchWebpageToolCall(rawArguments, { context });
  },
};

type ExecuteFetchWebpageToolCallOptions = {
  cache?: FetchWebpageSessionCache | undefined;
  requestedModeOverride?: FetchWebpageMode | undefined;
  policyApplied?: "outline_before_article" | undefined;
  note?: string | undefined;
  context?: ToolExecutionContext | undefined;
};

export function createFetchWebpageSessionCache(): FetchWebpageSessionCache {
  return new Map();
}

export function parseFetchWebpageArgs(rawArguments: string): FetchWebpageArgs {
  const parsed = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  return fetchWebpageArgsSchema.parse(parsed);
}

export function normalizeFetchWebpageUrl(url: string): string {
  const parsedUrl = new URL(url);
  parsedUrl.hash = "";

  if (
    (parsedUrl.protocol === "https:" && parsedUrl.port === "443") ||
    (parsedUrl.protocol === "http:" && parsedUrl.port === "80")
  ) {
    parsedUrl.port = "";
  }

  return parsedUrl.toString();
}

export function getCachedFetchWebpageResult(
  cache: FetchWebpageSessionCache,
  url: string,
  mode: FetchWebpageMode,
): FetchWebpageResult | null {
  const entry = cache.get(normalizeFetchWebpageUrl(url));
  if (!entry) {
    return null;
  }

  return mode === "article" ? entry.article ?? null : entry.outline ?? null;
}

export function hasCachedFetchWebpageOutline(
  cache: FetchWebpageSessionCache,
  url: string,
): boolean {
  return getCachedFetchWebpageResult(cache, url, "outline") !== null;
}

export function cacheFetchWebpageResult(
  cache: FetchWebpageSessionCache,
  url: string,
  result: FetchWebpageResult,
): void {
  const normalizedUrl = normalizeFetchWebpageUrl(url);
  const entry = cache.get(normalizedUrl) ?? {};

  if (result.mode === "article") {
    entry.article = result;
  } else {
    entry.outline = result;
  }

  cache.set(normalizedUrl, entry);
}

export async function executeFetchWebpageToolCall(
  rawArguments: string,
  options?: ExecuteFetchWebpageToolCallOptions,
): Promise<string> {
  try {
    const parsedArgs = parseFetchWebpageArgs(rawArguments);
    const requestedMode = parsedArgs.mode ?? "outline";
    const effectiveMode = options?.requestedModeOverride ?? requestedMode;
    const effectiveArgs = {
      ...parsedArgs,
      mode: effectiveMode,
    } satisfies FetchWebpageArgs;
    const normalizedUrl = normalizeFetchWebpageUrl(parsedArgs.url);
    const cachedResult = options?.cache
      ? getCachedFetchWebpageResult(options.cache, normalizedUrl, effectiveMode)
      : null;

    if (cachedResult) {
      options?.context?.notices?.addNotice({
        level: "info",
        message: `fetch_webpage reused ${normalizedUrl} in ${effectiveMode} mode from the session cache.`,
      });
      return JSON.stringify(
        buildFetchWebpageToolResult(
          cachedResult,
          normalizedUrl,
          requestedMode,
          true,
          options,
        ),
      );
    }

    const result = await fetchWebpage(effectiveArgs);
    if (options?.cache) {
      cacheFetchWebpageResult(options.cache, normalizedUrl, result);
    }
    options?.context?.notices?.addNotice({
      level: "info",
      message: `fetch_webpage read ${result.finalUrl} in ${result.mode} mode via ${result.extraction}.`,
    });

    return JSON.stringify(
        buildFetchWebpageToolResult(
          result,
          normalizedUrl,
          requestedMode,
        false,
        options,
      ),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown fetch_webpage error.";
    return JSON.stringify({
      ok: false,
      error: message,
    });
  }
}

export async function fetchWebpage(
  args: FetchWebpageArgs,
): Promise<FetchWebpageResult> {
  const mode = args.mode ?? "outline";
  const maxChars = args.max_chars ??
    (mode === "article" ? DEFAULT_ARTICLE_MAX_CHARS : DEFAULT_OUTLINE_MAX_CHARS);
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  if (mode === "article") {
    const readerResult = await tryFetchReaderArticle(args.url, timeoutMs, maxChars);
    if (readerResult) {
      return readerResult;
    }
  }

  const response = await fetch(args.url, {
    dispatcher: buildProviderDispatcher(),
    headers: {
      Accept: "text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5",
      "User-Agent": "SuperRun/1.0 fetch_webpage",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(
      `fetch_webpage failed for ${args.url} with HTTP ${response.status} ${response.statusText}.`,
    );
  }

  const finalUrl = response.url || args.url;
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const body = await response.text();

  if (!body.trim()) {
    throw new Error(`fetch_webpage received an empty response body from ${finalUrl}.`);
  }

  if (!looksLikeHtml(contentType, body)) {
    const title = inferReaderTitle(body);
    const truncatedText = truncateText(normalizeExtractedText(body), maxChars);
    return {
      url: args.url,
      finalUrl,
      mode,
      extraction: "plain-text",
      title,
      description: null,
      headings: title ? [{ level: 1, text: title }] : [],
      content: truncatedText.value,
      truncated: truncatedText.truncated,
    };
  }

  const html = body;
  const title = extractTitle(html);
  const description = extractMetaDescription(html);
  const headings = extractHeadings(html);

  if (mode === "outline") {
    const outlineText = buildOutlineText({
      title,
      description,
      headings,
      fallbackText: extractArticleText(html),
    });
    const truncatedText = truncateText(outlineText, maxChars);
    return {
      url: args.url,
      finalUrl,
      mode,
      extraction: "html-outline",
      title,
      description,
      headings,
      content: truncatedText.value,
      truncated: truncatedText.truncated,
    };
  }

  const articleText = extractArticleText(html);
  const truncatedText = truncateText(articleText, maxChars);
  return {
    url: args.url,
    finalUrl,
    mode,
    extraction: "html-article",
    title,
    description,
    headings,
    content: truncatedText.value,
    truncated: truncatedText.truncated,
  };
}

async function tryFetchReaderArticle(
  url: string,
  timeoutMs: number,
  maxChars: number,
): Promise<FetchWebpageResult | null> {
  const template = process.env.SUPERRUN_WEB_READER_URL_TEMPLATE?.trim();
  if (!template) {
    return null;
  }

  const readerUrl = buildReaderUrl(template, url);
  if (!readerUrl) {
    return null;
  }

  try {
    const response = await fetch(readerUrl, {
      dispatcher: buildProviderDispatcher(),
      headers: {
        Accept: "text/markdown,text/plain,text/html;q=0.8,*/*;q=0.5",
        "User-Agent": "SuperRun/1.0 fetch_webpage_reader",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    if (!response.ok) {
      return null;
    }

    const finalUrl = response.url || url;
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const body = await response.text();
    if (!body.trim()) {
      return null;
    }

    const readerText = looksLikeHtml(contentType, body)
      ? extractArticleText(body)
      : normalizeExtractedText(body);
    if (!readerText) {
      return null;
    }

    const title = inferReaderTitle(readerText);
    const truncatedText = truncateText(readerText, maxChars);
    return {
      url,
      finalUrl,
      mode: "article",
      extraction: "reader",
      title,
      description: null,
      headings: title ? [{ level: 1, text: title }] : [],
      content: truncatedText.value,
      truncated: truncatedText.truncated,
    };
  } catch {
    return null;
  }
}

function buildReaderUrl(template: string, url: string): string | null {
  const normalizedTemplate = template.trim();
  if (!normalizedTemplate) {
    return null;
  }

  if (
    !normalizedTemplate.includes("{url}") &&
    !normalizedTemplate.includes("{url_raw}") &&
    !normalizedTemplate.includes("{url_no_scheme}")
  ) {
    return null;
  }

  const urlNoScheme = url.replace(/^https?:\/\//i, "");
  return normalizedTemplate
    .replaceAll("{url}", encodeURIComponent(url))
    .replaceAll("{url_raw}", url)
    .replaceAll("{url_no_scheme}", urlNoScheme);
}

function looksLikeHtml(contentType: string, body: string): boolean {
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }

  return /<html\b|<body\b|<main\b|<article\b|<div\b/i.test(body);
}

function extractTitle(html: string): string | null {
  return extractTagText(html, "title");
}

function extractMetaDescription(html: string): string | null {
  const targets = new Set(["description", "og:description", "twitter:description"]);
  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];

  for (const tag of metaTags) {
    const attributes = parseHtmlAttributes(tag);
    const name = (attributes.name ?? attributes.property ?? "").trim().toLowerCase();
    const content = attributes.content?.trim();
    if (!content || !targets.has(name)) {
      continue;
    }

    const cleaned = normalizeInlineText(content);
    if (cleaned) {
      return cleaned;
    }
  }

  return null;
}

function extractHeadings(html: string): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  const headingRegex = /<(h[1-3])\b[^>]*>([\s\S]*?)<\/\1>/gi;

  for (const match of html.matchAll(headingRegex)) {
    const rawLevel = match[1]?.toLowerCase();
    const innerHtml = match[2] ?? "";
    if (!rawLevel) {
      continue;
    }

    const text = normalizeInlineText(stripHtmlTags(innerHtml));
    if (!text) {
      continue;
    }

    headings.push({
      level: Number(rawLevel.slice(1)),
      text,
    });
    if (headings.length >= MAX_HEADINGS) {
      break;
    }
  }

  return headings;
}

function buildOutlineText(input: {
  title: string | null;
  description: string | null;
  headings: HeadingEntry[];
  fallbackText: string;
}): string {
  const sections: string[] = [];

  if (input.title) {
    sections.push(`Title: ${input.title}`);
  }

  if (input.description) {
    sections.push(`Description: ${input.description}`);
  }

  if (input.headings.length > 0) {
    sections.push(
      `Headings:\n${input.headings
        .map((heading) => `${"#".repeat(heading.level)} ${heading.text}`)
        .join("\n")}`,
    );
  }

  if (sections.length === 0 && input.fallbackText) {
    sections.push(input.fallbackText);
  }

  return sections.join("\n\n").trim();
}

function extractArticleText(html: string): string {
  const candidate = pickPrimaryHtmlSection(html);
  const withoutNoise = removeNoiseBlocks(candidate);
  const withLineBreaks = withoutNoise
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|li|ul|ol|table|tr|blockquote|pre|h[1-6])>/gi, "\n\n")
    .replace(/<(p|div|section|article|main|li|ul|ol|table|tr|blockquote|pre|h[1-6])\b[^>]*>/gi, "\n");
  return normalizeExtractedText(stripHtmlTags(withLineBreaks));
}

function pickPrimaryHtmlSection(html: string): string {
  const candidates = [
    ...extractTagBodies(html, "article"),
    ...extractTagBodies(html, "main"),
  ];

  if (candidates.length > 0) {
    return candidates.sort((left, right) => right.length - left.length)[0] ?? html;
  }

  const body = extractTagBody(html, "body");
  return body ?? html;
}

function extractTagText(html: string, tagName: string): string | null {
  const body = extractTagBody(html, tagName);
  if (!body) {
    return null;
  }

  const text = normalizeInlineText(stripHtmlTags(body));
  return text || null;
}

function extractTagBody(html: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "i");
  const match = html.match(regex);
  return match?.[1] ?? null;
}

function extractTagBodies(html: string, tagName: string): string[] {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "gi");
  return Array.from(html.matchAll(regex), (match) => match[1] ?? "");
}

function removeNoiseBlocks(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|header|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
}

function stripHtmlTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, " "));
}

function normalizeExtractedText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInlineText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRegex =
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;

  for (const match of tag.matchAll(attributeRegex)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!name) {
      continue;
    }

    attributes[name] = value;
  }

  return attributes;
}

function inferReaderTitle(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return null;
  }

  return firstLine.length > MAX_READER_TITLE_CHARS
    ? firstLine.slice(0, MAX_READER_TITLE_CHARS).trim()
    : firstLine;
}

function truncateText(value: string, maxChars: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return {
      value,
      truncated: false,
    };
  }

  return {
    value: value.slice(0, maxChars).trimEnd(),
    truncated: true,
  };
}

function buildFetchWebpageToolResult(
  result: FetchWebpageResult,
  normalizedUrl: string,
  requestedMode: FetchWebpageMode,
  cacheHit: boolean,
  options?: Pick<
    ExecuteFetchWebpageToolCallOptions,
    "note" | "policyApplied"
  >,
): FetchWebpageToolResult {
  return {
    ok: true,
    normalizedUrl,
    requestedMode,
    cacheHit,
    ...(options?.policyApplied ? { policyApplied: options.policyApplied } : {}),
    ...(options?.note ? { note: options.note } : {}),
    ...result,
  };
}
