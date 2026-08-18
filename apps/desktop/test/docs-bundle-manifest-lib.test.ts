import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildGroupIndex,
  collectMdxFiles,
  extractHeadings,
  parseFrontmatter,
  readMeta,
  resolveNavEntry,
  slugify,
  stripQuotes,
  toPageId,
  toPlainText,
  toRenderMarkdown,
} from "../scripts/generate-docs-bundle-manifest-lib.mjs";
import type { DocsBundle } from "../src/main/docs-help/docs-bundle-types.js";

/**
 * ISS-5303 — behaviour tests for the docs-bundle generator's pure half, plus a
 * wiring proof that `generate-docs-bundle-manifest.mjs` actually consumes it.
 *
 * Everything filesystem-touching runs against a `mkdtemp` fixture, never the
 * checkout: the real `apps/web/content/docs` tree changes with every docs PR,
 * so a test anchored to it would assert today's content rather than the
 * generator's behaviour.
 */

const BASE64_PARTS_RE =
  /DOCS_BUNDLE_BASE64_PARTS: readonly string\[\] = (\[[\s\S]*?\]);/;

const DESKTOP_DIR = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT_SOURCE = path.join(
  DESKTOP_DIR,
  "scripts",
  "generate-docs-bundle-manifest.mjs"
);
const LIB_SOURCE = path.join(
  DESKTOP_DIR,
  "scripts",
  "generate-docs-bundle-manifest-lib.mjs"
);
const LIB_FILENAME = "generate-docs-bundle-manifest-lib.mjs";

/**
 * The generator reads a handful of fixture `.mdx` files and writes one module;
 * anything approaching this is a hang, not a slow machine. node:test's own
 * `timeout` cannot interrupt `spawnSync` (it blocks this worker's event loop),
 * so the child needs its own deadline and the case needs a larger one — the
 * `test:node` slice gates the required `desktop` check and has no retry, so a
 * wedged child must fail the case rather than sit on the runner.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

const tempDirs: string[] = [];

after(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Materialize a `{ "a/b.mdx": "…" }` map under `root`, creating parents. */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, ...relative.split("/"));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
}

function makeDocsRoot(files: Record<string, string>): string {
  const root = makeTempDir("iss5303-docs-");
  writeTree(root, files);
  return root;
}

type GeneratorFixture = {
  docsRoot: string;
  entrypoint: string;
  libPath: string;
  outFile: string;
};

/**
 * A throwaway monorepo-shaped tree the REAL entrypoint can run against. The
 * entrypoint derives every path from `import.meta.url`
 * (`scripts/../../../apps/web/content/docs`), so the only way to point it at a
 * fixture is to place a byte copy of it at the same relative position inside a
 * temp root. Both script files are copied from disk at test time, so nothing
 * here can go stale against the sources it is proving.
 */
function makeGeneratorFixture(docs: Record<string, string>): GeneratorFixture {
  const root = makeTempDir("iss5303-gen-");
  const scriptsDir = path.join(root, "apps", "desktop", "scripts");
  const outDir = path.join(root, "apps", "desktop", "src", "main", "docs-help");
  const docsRoot = path.join(root, "apps", "web", "content", "docs");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  writeTree(docsRoot, docs);
  const entrypoint = path.join(scriptsDir, "generate-docs-bundle-manifest.mjs");
  copyFileSync(ENTRYPOINT_SOURCE, entrypoint);
  return {
    docsRoot,
    entrypoint,
    libPath: path.join(scriptsDir, LIB_FILENAME),
    outFile: path.join(outDir, "docs-bundle-manifest.ts"),
  };
}

function runGenerator(entrypoint: string): string {
  const result = spawnSync(process.execPath, [entrypoint], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
  });

  // Preconditions, not assertions: `spawnSync` reports a launch failure — and a
  // `timeout` kill — on `.error` rather than throwing, so without these a
  // deadlined child surfaces as an empty stdout and a confusing null status
  // several assertions later.
  if (result.error) {
    throw new Error(
      `the docs-bundle generator did not exit on its own: ${result.error.message}`
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `the docs-bundle generator exited ${result.status}\n${result.stdout}\n${result.stderr}`
    );
  }
  return result.stdout;
}

function readEmittedBundle(outFile: string): DocsBundle {
  const emitted = readFileSync(outFile, "utf8");
  const match = emitted.match(BASE64_PARTS_RE);
  if (!match) {
    throw new Error("emitted manifest carries no base64 payload");
  }
  const parts: string[] = JSON.parse(match[1]);
  const bundle: DocsBundle = JSON.parse(
    Buffer.from(parts.join(""), "base64").toString("utf8")
  );
  return bundle;
}

describe("ISS-5303: parseFrontmatter", () => {
  test("reads simple scalars and returns the body with the block removed", () => {
    const parsed = parseFrontmatter(
      "---\ntitle: API keys\ndescription: How to rotate them\n---\n# Body\n"
    );

    assert.deepEqual(parsed.frontmatter, {
      description: "How to rotate them",
      title: "API keys",
    });
    assert.equal(parsed.body, "# Body\n");
  });

  test("quoted values lose exactly one matching quote pair", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        'double: "Sessions: an overview"',
        "single: 'Branches'",
        'empty: ""',
        "unbalanced: \"still open'",
        "bare: plain value",
        "---",
        "body",
      ].join("\n")
    );

    assert.deepEqual(parsed.frontmatter, {
      bare: "plain value",
      double: "Sessions: an overview",
      empty: "",
      single: "Branches",
      unbalanced: "\"still open'",
    });
  });

  test("a CRLF-delimited block is NOT recognized as frontmatter", () => {
    // The delimiter pattern is LF-anchored. Every page under
    // apps/web/content/docs is committed LF, so this is the documented edge:
    // a CRLF page keeps its raw frontmatter as body text and falls back to the
    // page id for its title rather than half-parsing into a wrong title.
    const raw = '---\r\ntitle: "CRLF page"\r\n---\r\nBody line\r\n';

    const parsed = parseFrontmatter(raw);

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, raw);
  });

  test("a CR-terminated key line is dropped rather than kept with the CR", () => {
    // Mixed endings (an LF-delimited block whose key lines end CRLF): the block
    // itself IS recognized, so the body is stripped correctly, but `.` never
    // matches a CR, so the key line does not match and the value is dropped.
    // Silently dropping beats admitting `"Mixed\r"` as a title — a bare CR in a
    // heading id or a search hit would be worse than falling back to the page
    // id. Asserted so a future frontmatter change has to decide deliberately.
    const parsed = parseFrontmatter("---\ntitle: Mixed\r\n---\nbody");

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, "body");
  });

  test("a page with no frontmatter block is returned untouched", () => {
    const raw = "# Just a heading\n\nSome prose.\n";

    const parsed = parseFrontmatter(raw);

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, raw);
  });

  test("an unterminated block is treated as body, not as frontmatter", () => {
    const raw = "---\ntitle: Never closed\n\nbody text\n";

    const parsed = parseFrontmatter(raw);

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, raw);
  });

  test("malformed lines inside a well-formed block are skipped", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "title: Kept",
        "this line has no colon",
        "  indented: dropped",
        "bad key: dropped",
        "---",
        "body",
      ].join("\n")
    );

    assert.deepEqual(parsed.frontmatter, { title: "Kept" });
    assert.equal(parsed.body, "body");
  });
});

describe("ISS-5303: stripQuotes", () => {
  test("leaves a mismatched or single-character value alone", () => {
    assert.equal(stripQuotes("\"mismatched'"), "\"mismatched'");
    assert.equal(stripQuotes('"'), '"');
    assert.equal(stripQuotes(""), "");
  });

  test("strips only the outermost pair", () => {
    assert.equal(stripQuotes('""nested""'), '"nested"');
  });
});

describe("ISS-5303: toPlainText", () => {
  test("flattens emphasis, inline code, and links to their text", () => {
    assert.equal(
      toPlainText("Hello **world** with `code` and [a link](https://x.test)."),
      "Hello world with code and a link."
    );
  });

  test("drops fenced code, HTML comments, images, and JSX tags", () => {
    const plain = toPlainText(
      [
        "<Callout type='info'>Read this</Callout>",
        "",
        "![diagram](https://x.test/d.png)",
        "",
        "<!-- internal note -->",
        "",
        "```js",
        "const secret = 1;",
        "```",
        "",
        "Tail.",
      ].join("\n")
    );

    assert.ok(plain.includes("Read this"), plain);
    assert.ok(plain.includes("Tail."), plain);
    assert.ok(!plain.includes("Callout"), plain);
    assert.ok(!plain.includes("diagram"), plain);
    assert.ok(!plain.includes("internal note"), plain);
    assert.ok(!plain.includes("const secret"), plain);
  });

  test("collapses runs of blank lines and trims the result", () => {
    assert.equal(toPlainText("\n\nA\n\n\n\n\nB\t \n\n"), "A\n\nB");
  });
});

describe("ISS-5303: toRenderMarkdown", () => {
  test("keeps markdown structure while removing JSX and HTML comments", () => {
    assert.equal(
      toRenderMarkdown(
        "<Callout>Note</Callout>\n\n<!-- hide -->\n\nSee [docs](https://x.test)."
      ),
      "Note\n\nSee [docs](https://x.test)."
    );
  });

  test("passes a fenced block through untouched, tags and comments included", () => {
    // A `<Tag>` inside a code sample is content, not markup: stripping it would
    // corrupt the very code the reader is meant to copy.
    const source = "Intro\n\n```tsx\n<Tag />\n<!-- kept -->\n```";

    assert.equal(toRenderMarkdown(source), source);
  });

  test("collapses runs of blank lines and trims the result", () => {
    assert.equal(toRenderMarkdown("\n\n# A\n\n\n\nB\n\n"), "# A\n\nB");
  });
});

describe("ISS-5303: slugify", () => {
  test("lowercases, drops punctuation, and hyphenates whitespace", () => {
    assert.equal(slugify("Rotating an API Key!"), "rotating-an-api-key");
    assert.equal(slugify("What's new?"), "whats-new");
    assert.equal(slugify("  Leading and trailing  "), "leading-and-trailing");
  });

  test("preserves existing hyphens and collapses repeated whitespace", () => {
    assert.equal(slugify("Pre-flight   checks"), "pre-flight-checks");
  });

  test("drops non-ASCII characters rather than transliterating them", () => {
    assert.equal(slugify("Café ☕ time"), "caf-time");
  });
});

describe("ISS-5303: extractHeadings", () => {
  test("indexes H2..H6, skips the H1, and slugs the flattened text", () => {
    const headings = extractHeadings(
      [
        "# Page title",
        "## First **section**",
        "text",
        "###### Deep `code` heading",
        "### Closing hashes ##",
      ].join("\n")
    );

    assert.deepEqual(headings, [
      { level: 2, slug: "first-section", text: "First section" },
      { level: 6, slug: "deep-code-heading", text: "Deep code heading" },
      { level: 3, slug: "closing-hashes", text: "Closing hashes" },
    ]);
  });

  test("ignores a '#' line inside a fenced code block", () => {
    const headings = extractHeadings(
      ["```sh", "## not a heading", "```", "## real heading"].join("\n")
    );

    assert.deepEqual(headings, [
      { level: 2, slug: "real-heading", text: "real heading" },
    ]);
  });

  test("skips a heading whose text flattens to nothing", () => {
    assert.deepEqual(extractHeadings("## ***"), []);
  });
});

describe("ISS-5303: toPageId", () => {
  test("drops the .mdx extension and normalizes separators to '/'", () => {
    assert.equal(
      toPageId(path.join("getting-started", "api-keys.mdx")),
      "getting-started/api-keys"
    );
    assert.equal(toPageId("index.mdx"), "index");
    assert.equal(toPageId(path.join("a", "b", "c.mdx")), "a/b/c");
  });
});

describe("ISS-5303: collectMdxFiles", () => {
  test("finds every .mdx under the root and ignores everything else", () => {
    const root = makeDocsRoot({
      "meta.json": "{}",
      "notes.md": "not mdx",
      "nested/deep/page.mdx": "x",
      "top.mdx": "x",
    });

    assert.deepEqual(collectMdxFiles(root).sort(), [
      path.join("nested", "deep", "page.mdx"),
      "top.mdx",
    ]);
  });

  test("deterministic docs ordering: the sorted set does not depend on creation order", () => {
    // The entrypoint's page order is `collectMdxFiles(docsDir).sort()` for
    // everything the nav does not reach, so the sorted set IS the shipped
    // order. Creating the files in reverse alphabetical order proves the order
    // comes from the sort and not from readdir's arrival order.
    const root = makeDocsRoot({
      "zz.mdx": "x",
      "m/n.mdx": "x",
      "m/a.mdx": "x",
      "aa.mdx": "x",
    });

    assert.deepEqual(collectMdxFiles(root).sort(), [
      "aa.mdx",
      path.join("m", "a.mdx"),
      path.join("m", "n.mdx"),
      "zz.mdx",
    ]);
  });

  test("reports paths relative to the injected root, not the scanned dir", () => {
    const root = makeDocsRoot({ "sub/page.mdx": "x" });

    assert.deepEqual(collectMdxFiles(path.join(root, "sub"), root), [
      path.join("sub", "page.mdx"),
    ]);
  });

  test("a missing directory yields no files instead of throwing", () => {
    const root = makeDocsRoot({});

    assert.deepEqual(collectMdxFiles(path.join(root, "absent")), []);
  });
});

describe("ISS-5303: readMeta", () => {
  test("parses a folder's meta.json", () => {
    const root = makeDocsRoot({
      "meta.json": '{"title":"Docs","pages":["a"]}',
    });

    assert.deepEqual(readMeta(root), { pages: ["a"], title: "Docs" });
  });

  test("returns null when meta.json is absent", () => {
    assert.equal(readMeta(makeDocsRoot({})), null);
  });

  test("returns null instead of throwing on unparseable JSON", () => {
    const root = makeDocsRoot({ "meta.json": "{ not json" });

    assert.equal(readMeta(root), null);
  });
});

describe("ISS-5303: resolveNavEntry", () => {
  test("reports page and subfolder independently", () => {
    const root = makeDocsRoot({
      "both.mdx": "x",
      "both/child.mdx": "x",
      "folder/child.mdx": "x",
      "page.mdx": "x",
    });

    assert.deepEqual(resolveNavEntry(root, "", "both"), {
      hasPage: true,
      pageId: "both",
      subDir: path.join(root, "both"),
    });
    assert.deepEqual(resolveNavEntry(root, "", "folder"), {
      hasPage: false,
      pageId: "folder",
      subDir: path.join(root, "folder"),
    });
    assert.deepEqual(resolveNavEntry(root, "", "page"), {
      hasPage: true,
      pageId: "page",
      subDir: null,
    });
    assert.deepEqual(resolveNavEntry(root, "", "ghost"), {
      hasPage: false,
      pageId: "ghost",
      subDir: null,
    });
  });

  test("prefixes the page id with the walk's relative prefix", () => {
    const root = makeDocsRoot({ "page.mdx": "x" });

    assert.equal(
      resolveNavEntry(root, "guides/", "page").pageId,
      "guides/page"
    );
  });
});

describe("ISS-5303: buildGroupIndex", () => {
  test("deterministic nav ordering: pages follow meta.json order, not the alphabet", () => {
    const root = makeDocsRoot({
      "alpha.mdx": "x",
      "meta.json": '{"title":"Docs","pages":["zeta","alpha"]}',
      "zeta.mdx": "x",
    });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    assert.deepEqual(orderedPageIds, ["zeta", "alpha"]);
    assert.deepEqual(
      [...groupByPage],
      [
        ["zeta", "Docs"],
        ["alpha", "Docs"],
      ]
    );
  });

  test("a separator relabels the group for every entry after it", () => {
    const root = makeDocsRoot({
      "meta.json": '{"title":"Docs","pages":["one","---Guides---","two"]}',
      "one.mdx": "x",
      "two.mdx": "x",
    });

    const { groupByPage } = buildGroupIndex(root);

    assert.equal(groupByPage.get("one"), "Docs");
    assert.equal(groupByPage.get("two"), "Guides");
  });

  test("a subfolder's own title wins over the inherited group", () => {
    const root = makeDocsRoot({
      "guides/deep.mdx": "x",
      "guides/meta.json": '{"title":"Guides Folder","pages":["deep"]}',
      "meta.json": '{"title":"Docs","pages":["---Guides---","guides"]}',
    });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    assert.deepEqual(orderedPageIds, ["guides/deep"]);
    assert.equal(groupByPage.get("guides/deep"), "Guides Folder");
  });

  test("an entry that is both a page and a folder is indexed once and still walked", () => {
    const root = makeDocsRoot({
      "meta.json": '{"title":"Docs","pages":["section"]}',
      "section.mdx": "x",
      "section/child.mdx": "x",
      "section/meta.json": '{"pages":["child"]}',
    });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    assert.deepEqual(orderedPageIds, ["section", "section/child"]);
    // The child folder has no title of its own, so it inherits the parent's.
    assert.equal(groupByPage.get("section/child"), "Docs");
  });

  test("duplicate and non-string nav entries do not produce duplicate pages", () => {
    const root = makeDocsRoot({
      "a.mdx": "x",
      "meta.json": '{"title":"Docs","pages":["a","a",42,null]}',
    });

    assert.deepEqual(buildGroupIndex(root).orderedPageIds, ["a"]);
  });

  test("a nav entry with no .mdx on disk is not indexed", () => {
    const root = makeDocsRoot({
      "meta.json": '{"title":"Docs","pages":["ghost"]}',
    });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    assert.deepEqual(orderedPageIds, []);
    assert.equal(groupByPage.size, 0);
  });

  test("a docs root with no meta.json degrades to an empty nav index", () => {
    const root = makeDocsRoot({ "orphan.mdx": "x" });

    const { groupByPage, orderedPageIds } = buildGroupIndex(root);

    assert.deepEqual(orderedPageIds, []);
    assert.equal(groupByPage.size, 0);
  });

  test("a nav with no title anywhere gives its pages the empty group", () => {
    const root = makeDocsRoot({
      "a.mdx": "x",
      "meta.json": '{"pages":["a"]}',
    });

    assert.equal(buildGroupIndex(root).groupByPage.get("a"), "");
  });
});

const WIRING_DOCS: Record<string, string> = {
  "api-reference/generated.mdx": [
    "---",
    "title: List sessions",
    "description: REST reference",
    "---",
    "{/* This file was generated by Fumadocs */}",
    "export default function Layout() { return null; }",
  ].join("\n"),
  "getting-started/advanced.mdx":
    "---\ntitle: Advanced\n---\n## Tuning\n\nBody.\n",
  "getting-started/install.mdx":
    "---\ntitle: Install\n---\n## Requirements\n\nUse **pnpm** and `node`.\n",
  "getting-started/meta.json":
    '{"title":"Getting Started","pages":["install","advanced"]}',
  "index.mdx": "---\ntitle: Overview\n---\nWelcome.\n",
  "meta.json":
    '{"title":"Docs","pages":["index","---Guides---","getting-started"]}',
  "orphan.mdx": "---\ntitle: Orphan\n---\nNot in the nav.\n",
  "zz-orphan.mdx": "---\ntitle: Last\n---\nAlso not in the nav.\n",
};

describe("ISS-5303: the real entrypoint's output is what the lib produces", () => {
  test("page order, grouping and per-page fields all match the lib", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const fixture = makeGeneratorFixture(WIRING_DOCS);
    copyFileSync(LIB_SOURCE, fixture.libPath);

    const stdout = runGenerator(fixture.entrypoint);
    const bundle = readEmittedBundle(fixture.outFile);

    const { groupByPage, orderedPageIds } = buildGroupIndex(fixture.docsRoot);
    const allPageIds = collectMdxFiles(fixture.docsRoot).sort().map(toPageId);
    const expectedOrder = [
      ...orderedPageIds,
      ...allPageIds.filter((id) => !orderedPageIds.includes(id)),
    ];

    // Pin the lib-derived oracle to a literal too: if buildGroupIndex silently
    // returned nothing, the comparison above would pass vacuously.
    assert.deepEqual(orderedPageIds, [
      "index",
      "getting-started/install",
      "getting-started/advanced",
    ]);
    assert.deepEqual(
      bundle.pages.map((page) => page.path),
      expectedOrder
    );
    assert.ok(stdout.includes(`wrote ${expectedOrder.length} page(s)`), stdout);

    const install = bundle.pages.find(
      (page) => page.path === "getting-started/install"
    );
    assert.ok(install, "the install page is missing from the bundle");
    const installRaw = readFileSync(
      path.join(fixture.docsRoot, "getting-started", "install.mdx"),
      "utf8"
    );
    const parsed = parseFrontmatter(installRaw);
    assert.equal(install.title, parsed.frontmatter.title);
    assert.equal(install.group, groupByPage.get("getting-started/install"));
    assert.equal(install.body, toPlainText(parsed.body));
    assert.equal(install.renderBody, toRenderMarkdown(parsed.body));
    assert.deepEqual(install.headings, extractHeadings(parsed.body));
    assert.equal(install.headings[0]?.slug, slugify("Requirements"));
  });

  test("a Fumadocs-generated page is replaced by an online pointer", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const fixture = makeGeneratorFixture(WIRING_DOCS);
    copyFileSync(LIB_SOURCE, fixture.libPath);

    runGenerator(fixture.entrypoint);
    const bundle = readEmittedBundle(fixture.outFile);
    const generated = bundle.pages.find(
      (page) => page.path === "api-reference/generated"
    );

    assert.ok(generated, "the generated page is missing from the bundle");
    assert.equal(generated.body, "");
    assert.deepEqual(generated.headings, []);
    assert.equal(
      generated.renderBody,
      `REST reference\n\n[View the full interactive reference online](${bundle.docsSiteUrl}/api-reference/generated).`
    );
  });

  test("a second run is content-stable and takes the unchanged branch", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const fixture = makeGeneratorFixture(WIRING_DOCS);
    copyFileSync(LIB_SOURCE, fixture.libPath);

    runGenerator(fixture.entrypoint);
    const first = readFileSync(fixture.outFile, "utf8");
    const stdout = runGenerator(fixture.entrypoint);

    assert.ok(stdout.includes("unchanged"), stdout);
    assert.equal(readFileSync(fixture.outFile, "utf8"), first);
  });
});

/**
 * Re-exports the real lib, tagging each export the entrypoint imports. A tag
 * that does not reach the emitted bundle means the entrypoint is not sourcing
 * that helper from `./generate-docs-bundle-manifest-lib.mjs` — which is exactly
 * the hole a lib-only test leaves open.
 */
function traceableLibSource(): string {
  const realLib = JSON.stringify(pathToFileURL(LIB_SOURCE).href);
  return [
    "import {",
    "  buildGroupIndex as realBuildGroupIndex,",
    "  collectMdxFiles as realCollectMdxFiles,",
    "  extractHeadings as realExtractHeadings,",
    "  parseFrontmatter as realParseFrontmatter,",
    "  toPageId as realToPageId,",
    "  toPlainText as realToPlainText,",
    "  toRenderMarkdown as realToRenderMarkdown,",
    `} from ${realLib};`,
    "export function collectMdxFiles(dir, docsRoot) {",
    "  return realCollectMdxFiles(dir, docsRoot).filter(",
    '    (rel) => !rel.endsWith("hidden-by-shim.mdx")',
    "  );",
    "}",
    "export function toPageId(rel) {",
    '  return "id/" + realToPageId(rel);',
    "}",
    "export function parseFrontmatter(raw) {",
    "  const parsed = realParseFrontmatter(raw);",
    "  return {",
    "    body: parsed.body,",
    "    frontmatter: {",
    "      ...parsed.frontmatter,",
    '      title: "T:" + parsed.frontmatter.title,',
    "    },",
    "  };",
    "}",
    "export function toPlainText(body) {",
    '  return "P:" + realToPlainText(body);',
    "}",
    "export function toRenderMarkdown(body) {",
    '  return "R:" + realToRenderMarkdown(body);',
    "}",
    "export function extractHeadings(body) {",
    "  return realExtractHeadings(body).map((heading) => ({",
    "    ...heading,",
    '    text: "H:" + heading.text,',
    "  }));",
    "}",
    "export function buildGroupIndex(root) {",
    "  const real = realBuildGroupIndex(root);",
    "  return {",
    "    groupByPage: new Map(",
    '      [...real.groupByPage].map(([id, group]) => ["id/" + id, "G:" + group])',
    "    ),",
    '    orderedPageIds: real.orderedPageIds.map((id) => "id/" + id),',
    "  };",
    "}",
    "",
  ].join("\n");
}

describe("ISS-5303: the entrypoint sources every helper from the lib module", () => {
  test("each traced export shows up in the field it feeds", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    const fixture = makeGeneratorFixture({
      "hidden-by-shim.mdx": "---\ntitle: Hidden\n---\nNope.\n",
      "intro.mdx": "---\ntitle: Intro\n---\n## Section One\n\nProse.\n",
      "loose.mdx": "---\ntitle: Loose\n---\nNot in the nav.\n",
      "meta.json": '{"title":"Docs","pages":["intro"]}',
    });
    writeFileSync(fixture.libPath, traceableLibSource(), "utf8");

    runGenerator(fixture.entrypoint);
    const bundle = readEmittedBundle(fixture.outFile);
    const intro = bundle.pages.find((page) => page.path === "id/intro");

    // collectMdxFiles + toPageId + buildGroupIndex all feed page identity/order.
    assert.deepEqual(
      bundle.pages.map((page) => page.path),
      ["id/intro", "id/loose"]
    );
    assert.ok(intro, "the traced intro page is missing from the bundle");
    // parseFrontmatter -> title, buildGroupIndex -> group.
    assert.equal(intro.title, "T:Intro");
    assert.equal(intro.group, "G:Docs");
    // toPlainText -> body, toRenderMarkdown -> renderBody, extractHeadings.
    assert.ok(intro.body.startsWith("P:"), intro.body);
    assert.ok(intro.renderBody?.startsWith("R:"), intro.renderBody);
    assert.equal(intro.headings[0]?.text, "H:Section One");
  });
});
