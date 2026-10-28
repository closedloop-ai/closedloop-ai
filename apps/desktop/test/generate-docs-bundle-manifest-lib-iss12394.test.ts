/**
 * ISS-12394 — branch coverage for the docs-bundle generator's pure half on the
 * inputs `docs-bundle-manifest-lib.test.ts` does not feed it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGroupIndex,
  collectMdxFiles,
  extractHeadings,
  parseFrontmatter,
  readMeta,
  resolveNavEntry,
  stripQuotes,
  toRenderMarkdown,
} from "../scripts/generate-docs-bundle-manifest-lib.mjs";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "docs-bundle-iss12394-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFixture(relative: string, contents: string): void {
  const full = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function writeMeta(relativeDir: string, meta: unknown): void {
  const prefix = relativeDir ? `${relativeDir}/` : "";
  writeFixture(`${prefix}meta.json`, JSON.stringify(meta));
}

describe("collectMdxFiles", () => {
  it("returns an empty list for a directory that does not exist", () => {
    expect(collectMdxFiles(path.join(root, "missing"))).toEqual([]);
  });

  it("recurses into subdirectories and keeps only .mdx files, relative to the root", () => {
    writeFixture("a.mdx", "x");
    writeFixture("notes.md", "x");
    writeFixture("nested/deeper/b.mdx", "x");
    writeFixture("nested/c.txt", "x");

    expect(collectMdxFiles(root).sort()).toEqual(
      ["a.mdx", path.join("nested", "deeper", "b.mdx")].sort()
    );
  });
});

describe("stripQuotes", () => {
  it.each([
    ['"quoted"', "quoted"],
    ["'single'", "single"],
    ["\"mismatch'", "\"mismatch'"],
    ["plain", "plain"],
    ['"', '"'],
    ['""', ""],
  ])("stripQuotes(%j) -> %j", (input, expected) => {
    expect(stripQuotes(input)).toBe(expected);
  });
});

describe("parseFrontmatter", () => {
  it("returns the raw body untouched and empty frontmatter when there is no block", () => {
    const raw = "# Title\nbody";
    expect(parseFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });

  it("skips lines that are not key: value and strips quotes from values", () => {
    const parsed = parseFrontmatter(
      "---\ntitle: 'Hello'\n  not a key line\ndescription: plain\n---\nbody"
    );
    expect(parsed).toEqual({
      frontmatter: { title: "Hello", description: "plain" },
      body: "body",
    });
  });
});

describe("toRenderMarkdown", () => {
  it("keeps JSX inside code fences and strips it outside", () => {
    const body =
      "<Callout>hi</Callout>\n```tsx\n<Tag />\n```\n<!-- note -->end";
    expect(toRenderMarkdown(body)).toBe("hi\n```tsx\n<Tag />\n```\nend");
  });
});

describe("extractHeadings", () => {
  it("skips H1, empty-after-strip headings, and headings inside fences", () => {
    const body = [
      "# Top",
      "## Getting *Started*",
      // JSX is stripped before inline code is unwrapped, so this empties out.
      "### `<Tag>`",
      "```",
      "## not a heading",
      "```",
      "###### Deep",
      "## <Br />",
    ].join("\n");

    expect(extractHeadings(body)).toEqual([
      { level: 2, text: "Getting Started", slug: "getting-started" },
      { level: 6, text: "Deep", slug: "deep" },
    ]);
  });
});

describe("readMeta", () => {
  it("returns null when meta.json is absent", () => {
    expect(readMeta(root)).toBeNull();
  });

  it("returns null when meta.json is not valid JSON", () => {
    writeFixture("meta.json", "{ not json");
    expect(readMeta(root)).toBeNull();
  });

  it("returns the parsed object when meta.json is valid", () => {
    writeMeta("", { title: "T", pages: ["a"] });
    expect(readMeta(root)).toEqual({ title: "T", pages: ["a"] });
  });
});

describe("resolveNavEntry", () => {
  it("reports a page with no folder", () => {
    writeFixture("page.mdx", "x");
    expect(resolveNavEntry(root, "pre/", "page")).toEqual({
      pageId: "pre/page",
      hasPage: true,
      subDir: null,
    });
  });

  it("reports a folder with a sibling page as both", () => {
    writeFixture("both.mdx", "x");
    writeFixture("both/child.mdx", "x");
    expect(resolveNavEntry(root, "", "both")).toEqual({
      pageId: "both",
      hasPage: true,
      subDir: path.join(root, "both"),
    });
  });

  it("does not treat a plain file named like the entry as a folder", () => {
    writeFixture("thing", "not a dir");
    expect(resolveNavEntry(root, "", "thing")).toEqual({
      pageId: "thing",
      hasPage: false,
      subDir: null,
    });
  });
});

describe("buildGroupIndex", () => {
  it("returns empty results when the root has no meta.json", () => {
    writeFixture("a.mdx", "x");
    const index = buildGroupIndex(root);
    expect(index.orderedPageIds).toEqual([]);
    expect([...index.groupByPage]).toEqual([]);
  });

  it("ignores a meta.json whose pages is not an array", () => {
    writeFixture("a.mdx", "x");
    writeMeta("", { title: "Root", pages: "a" });
    expect(buildGroupIndex(root).orderedPageIds).toEqual([]);
  });

  it("groups by title, separators, and inheritance; skips non-strings, duplicates and missing pages", () => {
    writeFixture("intro.mdx", "x");
    writeFixture("setup.mdx", "x");
    writeFixture("guides.mdx", "x");
    writeFixture("guides/first.mdx", "x");
    writeFixture("guides/second.mdx", "x");
    writeMeta("", {
      title: "Docs",
      pages: [
        "intro",
        42,
        "intro",
        "ghost",
        "---  Setup Section  ---",
        "setup",
        "guides",
      ],
    });
    // A non-string title falls back to the inherited separator group.
    writeMeta("guides", {
      title: 7,
      pages: ["first", "---Advanced---", "second"],
    });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    expect(orderedPageIds).toEqual([
      "intro",
      "setup",
      "guides",
      "guides/first",
      "guides/second",
    ]);
    expect(Object.fromEntries(groupByPage)).toEqual({
      intro: "Docs",
      setup: "Setup Section",
      guides: "Setup Section",
      "guides/first": "Setup Section",
      "guides/second": "Advanced",
    });
  });

  it("maps a page to an empty group when no title or separator applies", () => {
    writeFixture("lonely.mdx", "x");
    writeMeta("", { pages: ["lonely"] });
    expect(Object.fromEntries(buildGroupIndex(root).groupByPage)).toEqual({
      lonely: "",
    });
  });

  it("walks a nested folder that has no page of its own", () => {
    writeFixture("folder/inner.mdx", "x");
    writeMeta("", { title: "Root", pages: ["folder"] });
    writeMeta("folder", { pages: ["inner"] });
    expect(Object.fromEntries(buildGroupIndex(root).groupByPage)).toEqual({
      "folder/inner": "Root",
    });
  });
});
