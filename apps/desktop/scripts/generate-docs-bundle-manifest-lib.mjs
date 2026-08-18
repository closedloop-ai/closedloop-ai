// @ts-check
/**
 * ISS-5303 — the pure half of `generate-docs-bundle-manifest.mjs`.
 *
 * The entrypoint is a top-level side-effecting script: importing it reads the
 * real `apps/web/content/docs` tree, shells out to `git rev-parse HEAD`, and
 * writes `src/main/docs-help/docs-bundle-manifest.ts`. Nothing in it can be
 * asserted directly, so the parsing/indexing logic lives here instead and the
 * entrypoint keeps only orchestration and its write-if-changed block.
 *
 * Every filesystem-touching helper takes its root directory as an ARGUMENT
 * rather than deriving one from `import.meta.url`, so a test can point them at
 * a `mkdtemp` fixture instead of the checkout it happens to run in.
 *
 * Behaviour is a straight move — no parsing rule changed with the extraction.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const MDX_EXT_RE = /\.mdx$/;
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const FRONTMATTER_KEY_RE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`]*)`/g;
const JSX_TAG_RE = /<\/?[A-Za-z][^>]*>/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
const MD_EMPHASIS_RE = /[*_~]{1,3}/g;
const MULTISPACE_RE = /[ \t]+/g;
const MULTI_NEWLINE_RE = /\n{3,}/g;
const CODE_FENCE_SPLIT_RE = /(```[\s\S]*?```)/g;
const FENCE_LEAD_RE = /^```/;
const HEADING_LINE_RE = /^(#{1,6})\s+(.+?)\s*#*$/;
const SLUG_STRIP_RE = /[^a-z0-9\s-]/g;
const SLUG_SPACE_RE = /\s+/g;
const SEPARATOR_RE = /^---(.+)---$/;

/**
 * Recursively collect every `.mdx` file under `dir`, as paths relative to
 * `docsRoot`.
 *
 * `docsRoot` is what the emitted paths are made relative to and defaults to
 * `dir`, so a top-level `collectMdxFiles(docsDir)` behaves exactly as before
 * the extraction; the recursion threads the original root through.
 *
 * @param {string} dir Directory to scan.
 * @param {string} [docsRoot] Root the returned paths are relative to.
 * @returns {string[]}
 */
export function collectMdxFiles(dir, docsRoot = dir) {
  /** @type {string[]} */
  const out = [];
  const entries = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
    : [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMdxFiles(full, docsRoot));
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(path.relative(docsRoot, full));
    }
  }
  return out;
}

/**
 * Convert a docs-root-relative `.mdx` path to its `meta.json` page id.
 *
 * @param {string} relativeMdxPath
 * @returns {string}
 */
export function toPageId(relativeMdxPath) {
  return relativeMdxPath.replace(MDX_EXT_RE, "").split(path.sep).join("/");
}

/**
 * Strip one layer of matching single or double quotes from a frontmatter
 * scalar. A mismatched or unpaired quote is left alone.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripQuotes(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Parse leading `---` YAML-ish frontmatter (only simple `key: value` scalars).
 * A body with no recognizable frontmatter block is returned untouched.
 *
 * @param {string} raw
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
export function parseFrontmatter(raw) {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }
  /** @type {Record<string, string>} */
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(FRONTMATTER_KEY_RE);
    if (kv) {
      frontmatter[kv[1]] = stripQuotes(kv[2].trim());
    }
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

/**
 * Strip MDX/markdown/JSX down to readable plain text for body-match search.
 *
 * @param {string} mdxBody
 * @returns {string}
 */
export function toPlainText(mdxBody) {
  return mdxBody
    .replace(CODE_FENCE_RE, " ")
    .replace(HTML_COMMENT_RE, " ")
    .replace(IMAGE_RE, " ")
    .replace(JSX_TAG_RE, " ")
    .replace(LINK_RE, "$1")
    .replace(INLINE_CODE_RE, "$1")
    .replace(MD_EMPHASIS_RE, "")
    .replace(MULTISPACE_RE, " ")
    .replace(MULTI_NEWLINE_RE, "\n\n")
    .trim();
}

/**
 * Reduce an MDX body to markdown the desktop reader's markdown pipeline
 * (react-markdown + remark-gfm) renders faithfully: strip HTML comments and
 * MDX/JSX component tags (which react-markdown would drop or show as raw text)
 * while PRESERVING code fences, links, tables, lists, and emphasis. Unlike
 * `toPlainText` (which flattens everything for search), this keeps the document
 * structure so the reader shows real docs, not a stripped excerpt. Fenced code
 * blocks are passed through untouched so a `<Tag>` inside a code sample survives.
 *
 * @param {string} mdxBody
 * @returns {string}
 */
export function toRenderMarkdown(mdxBody) {
  return mdxBody
    .split(CODE_FENCE_SPLIT_RE)
    .map((segment) =>
      FENCE_LEAD_RE.test(segment)
        ? segment
        : segment.replace(HTML_COMMENT_RE, "").replace(JSX_TAG_RE, "")
    )
    .join("")
    .replace(MULTI_NEWLINE_RE, "\n\n")
    .trim();
}

/**
 * GitHub-style heading slug. Kept byte-for-byte in step with the renderer's
 * `slugifyHeading` (`src/renderer/components/help/help-slug.ts`) so a search
 * hit's `headingSlug` matches the `id` the Help reader stamps on the rendered
 * heading.
 *
 * @param {string} text
 * @returns {string}
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(SLUG_STRIP_RE, "")
    .trim()
    .replace(SLUG_SPACE_RE, "-");
}

/**
 * Extract H2..H6 headings (level, text, slug) from an MDX body, skipping code
 * fences so a `#` comment inside a code block is not mistaken for a heading.
 *
 * @param {string} mdxBody
 * @returns {{ level: number, text: string, slug: string }[]}
 */
export function extractHeadings(mdxBody) {
  const withoutFences = mdxBody.replace(CODE_FENCE_RE, "");
  /** @type {{ level: number; text: string; slug: string }[]} */
  const headings = [];
  for (const line of withoutFences.split("\n")) {
    const match = line.match(HEADING_LINE_RE);
    if (!match) {
      continue;
    }
    const level = match[1].length;
    // The frontmatter `title` owns the H1; index only sub-headings (##..######).
    if (level < 2) {
      continue;
    }
    const text = toPlainText(match[2]).trim();
    if (text) {
      headings.push({ level, text, slug: slugify(text) });
    }
  }
  return headings;
}

/**
 * Read and parse a folder's Fumadocs `meta.json`, or null if absent/invalid.
 *
 * @param {string} dirAbs
 */
export function readMeta(dirAbs) {
  const metaFile = path.join(dirAbs, "meta.json");
  if (!existsSync(metaFile)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(metaFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Resolve a `meta.json` `pages` entry to its on-disk page file and/or subfolder.
 * An entry can be both (a page with children), so `hasPage` and `subDir` are
 * independent.
 *
 * @param {string} dirAbs
 * @param {string} relPrefix
 * @param {string} entry
 * @returns {{ pageId: string, hasPage: boolean, subDir: string | null }}
 */
export function resolveNavEntry(dirAbs, relPrefix, entry) {
  const childDir = path.join(dirAbs, entry);
  const isDir = existsSync(childDir) && statSync(childDir).isDirectory();
  return {
    pageId: `${relPrefix}${entry}`,
    hasPage: existsSync(path.join(dirAbs, `${entry}.mdx`)),
    subDir: isDir ? childDir : null,
  };
}

/**
 * Map each page id to its Fumadocs nav group by walking the per-folder
 * `meta.json` tree under `docsRoot`. Each folder's `meta.json` is
 * `{ title, pages }`, where a `pages` entry is a page slug, a nested folder
 * name, or a `"---Label---"` section separator. A page's group is the nearest
 * enclosing separator label, else its folder's `title` — so the deepest, most
 * specific group wins (mirroring how the previous nav format nested groups).
 * Any `.mdx` not reached by the walk is still indexed later via the
 * alphabetical remainder pass, so a missing or partial `meta.json` degrades
 * safely.
 *
 * `orderedPageIds` is the nav order the bundle is emitted in, so it is the
 * walk order of the `pages` arrays — never sorted.
 *
 * @param {string} docsRoot
 * @returns {{ groupByPage: Map<string, string>, orderedPageIds: string[] }}
 */
export function buildGroupIndex(docsRoot) {
  /** @type {Map<string, string>} */
  const groupByPage = new Map();
  /** @type {string[]} */
  const orderedPageIds = [];

  /** @param {string} dirAbs @param {string} relPrefix @param {string | undefined} inheritedGroup */
  const walkDir = (dirAbs, relPrefix, inheritedGroup) => {
    const meta = readMeta(dirAbs);
    const entries = Array.isArray(meta?.pages) ? meta.pages : [];
    let group = typeof meta?.title === "string" ? meta.title : inheritedGroup;
    for (const entry of entries) {
      if (typeof entry !== "string") {
        continue;
      }
      const separator = entry.match(SEPARATOR_RE);
      if (separator) {
        group = separator[1].trim();
        continue;
      }
      const { pageId, hasPage, subDir } = resolveNavEntry(
        dirAbs,
        relPrefix,
        entry
      );
      if (hasPage && !groupByPage.has(pageId)) {
        groupByPage.set(pageId, group ?? "");
        orderedPageIds.push(pageId);
      }
      if (subDir) {
        walkDir(subDir, `${relPrefix}${entry}/`, group);
      }
    }
  };

  walkDir(docsRoot, "", undefined);
  return { groupByPage, orderedPageIds };
}
