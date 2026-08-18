import type { DocsHelpHeading } from "../src/shared/docs-help-contract.js";

export declare function collectMdxFiles(
  dir: string,
  docsRoot?: string
): string[];

export declare function toPageId(relativeMdxPath: string): string;

export declare function stripQuotes(value: string): string;

export type ParsedFrontmatter = {
  frontmatter: Record<string, string>;
  body: string;
};

export declare function parseFrontmatter(raw: string): ParsedFrontmatter;

export declare function toPlainText(mdxBody: string): string;

export declare function toRenderMarkdown(mdxBody: string): string;

export declare function slugify(text: string): string;

export declare function extractHeadings(mdxBody: string): DocsHelpHeading[];

/**
 * `JSON.parse` of the folder's `meta.json`, or `null` when it is absent or
 * unparseable. Deliberately `unknown`: the file is untrusted input, and
 * `buildGroupIndex` narrows `title` / `pages` itself rather than trusting a
 * declared shape.
 */
export declare function readMeta(dirAbs: string): unknown;

export type ResolvedNavEntry = {
  pageId: string;
  hasPage: boolean;
  subDir: string | null;
};

export declare function resolveNavEntry(
  dirAbs: string,
  relPrefix: string,
  entry: string
): ResolvedNavEntry;

export type DocsGroupIndex = {
  groupByPage: Map<string, string>;
  orderedPageIds: string[];
};

export declare function buildGroupIndex(docsRoot: string): DocsGroupIndex;
