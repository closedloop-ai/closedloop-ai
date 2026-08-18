/**
 * ISS-5697 — the app-core harness is mounted exactly once, by the preview.
 *
 * ISS-5665 (#4686) moved `AppCoreStoryProviders` into `.storybook/preview.tsx`
 * and handed it ONE navigation adapter, so every story — design-system and
 * app-core alike — resolves paths through the same port. A story that also
 * wraps itself defeats that: `AppCoreStoryProviders` called without
 * `navigationAdapter` builds its own `createMemoryNavigation({ orgSlug:
 * "org-test" })`, so the inner harness silently swaps the port out from under
 * the preview, and gets a second QueryClient, auth adapter and API adapter with
 * it. That reads as harmless nesting and is not.
 *
 * The failure mode this guards is copy-paste: 48 story files carried that
 * wrapper before ISS-5697 removed them, so the pattern is all over this repo's
 * git history and a new story cloned from an old one reintroduces it silently —
 * nothing else fails, the story just renders against a different port than
 * every other story. Per-story configuration belongs on
 * `parameters.appCore` ({@link https://storybook.js.org/docs/writing-stories/parameters}),
 * which the preview's global decorator reads.
 *
 * Read from the AST rather than regex-scanned: `no-raw-text-source-scan` bans
 * text-scanning implementation source and points at `ts.createSourceFile`,
 * which is also what the sibling `story-glob-parity.test.ts` guard uses. It
 * matters here beyond compliance — a prose mention of the component in a
 * docstring is exactly what a text scan would false-positive on, and two story
 * files legitimately name it in their comments.
 *
 * ## Two ways this guard could narrow silently (wongk, #4712 review)
 *
 * 1. Its {@link STORY_ROOTS} list is hand-maintained and, before this revision,
 *    nothing tied it to `.storybook/main.ts`. A fourth indexed root would have
 *    been swept by Storybook and skipped here, with the suite green. The
 *    "covers every root" case below reads `main.ts`'s own `stories` array
 *    through the shared `./helpers/storybook-config-source` reader and fails
 *    until the new root is listed.
 * 2. Its detector matched the literal JSX tag name, so
 *    `import { AppCoreStoryProviders as Providers }` mounted the exact same
 *    second harness and passed. {@link rendersHarness} now resolves the
 *    IMPORTED BINDING — named, aliased, or namespaced — and is itself pinned by
 *    synthetic fixtures in both directions, because a detector that regressed
 *    to always-false would report a clean corpus forever.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  STORYBOOK_DIR,
  storybookStoryPatterns,
} from "./helpers/storybook-config-source";

const HARNESS_COMPONENT = "AppCoreStoryProviders";
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORY_FILE = /\.stories\.(?:js|jsx|mjs|ts|tsx)$/;

/**
 * The module that exports the harness, extensionless. A story file reaches it
 * either by workspace specifier or by a relative path, and the detector accepts
 * ONLY those — a locally-defined component that happens to share the name is
 * not this one.
 */
const HARNESS_MODULE_PATH = path.join(
  REPO_ROOT,
  "packages/app/shared/storybook/decorators"
);
const HARNESS_MODULE_SPECIFIER = "@repo/app/shared/storybook/decorators";

// The roots Storybook indexes stories from (`.storybook/main.ts`). Walked whole
// rather than glob-matched, so a story in a new subdirectory under any of them
// is covered without editing a pattern; the "covers every root" case below is
// what keeps THIS list tied to `main.ts`.
const STORY_ROOTS = [
  "apps/storybook/stories",
  "packages/app",
  "apps/desktop/src/renderer/components",
];

describe("the app-core story harness is mounted once, globally", () => {
  // Walked once and shared: each root is a deep recursive scan, so the
  // per-root case below reuses this rather than re-walking the corpus.
  const storiesByRoot = new Map(
    STORY_ROOTS.map((root) => [
      root,
      collectStoryFiles(path.join(REPO_ROOT, root)),
    ])
  );
  const storyFiles = [...storiesByRoot.values()].flat().sort();

  it("finds the story corpus at all", () => {
    // Without this the assertion below passes vacuously if the patterns rot.
    expect(storyFiles.length).toBeGreaterThan(100);
  });

  it("finds stories under every root, not just one", () => {
    // The corpus count above is dominated by `packages/app`, so a root that
    // rotted to a directory holding no stories would not move it. Each root
    // must contribute, or this guard has quietly stopped covering a surface.
    const empty = [...storiesByRoot.entries()]
      .filter(([, files]) => files.length === 0)
      .map(([root]) => root);
    expect(empty, "story roots contributing no story files").toEqual([]);
  });

  it("covers every story root `.storybook/main.ts` indexes", () => {
    const patterns = storybookStoryPatterns();
    // Guards the guard: an AST shape change that parsed nothing would make the
    // containment assertion below pass over an empty list.
    expect(
      patterns.length,
      "no `stories` patterns parsed out of .storybook/main.ts"
    ).toBeGreaterThan(0);

    const roots = STORY_ROOTS.map((root) => path.join(REPO_ROOT, root));
    const uncovered = patterns.filter((pattern) => {
      const absolute = path.resolve(STORYBOOK_DIR, pattern);
      return !roots.some(
        (root) => absolute === root || absolute.startsWith(`${root}${path.sep}`)
      );
    });

    expect(
      uncovered,
      `.storybook/main.ts indexes ${uncovered.join(", ")}, which no entry in STORY_ROOTS contains — stories under it would be swept by Storybook and skipped by this guard while the suite stayed green. Add the root to STORY_ROOTS.`
    ).toEqual([]);
  });

  it(`no story renders its own <${HARNESS_COMPONENT}>`, () => {
    const offenders = storyFiles
      .filter((file) => rendersHarness(readFileSync(file, "utf8"), file))
      .map((file) => path.relative(REPO_ROOT, file));

    expect(
      offenders,
      `These stories mount a second ${HARNESS_COMPONENT}, which replaces the preview's shared navigation port with a private "org-test" one. Delete the wrapper and move any queryData/apiRoutes/enabledFlags to parameters.appCore.`
    ).toEqual([]);
  });
});

/**
 * The detector, pinned in BOTH directions. A guard whose subject has no
 * offenders left cannot demonstrate it still works from the corpus alone — if
 * `rendersHarness` regressed to `return false` every case above would still be
 * green. These are the cases that would go red.
 */
describe("rendersHarness", () => {
  /** A path a real app-core story lives at, for relative-specifier resolution. */
  const STORY_PATH = path.join(
    REPO_ROOT,
    "packages/app/agents/components/sessions/example.stories.tsx"
  );
  /** The specifier that story file would use — and did, before ISS-5697. */
  const RELATIVE_SPECIFIER = "../../../shared/storybook/decorators";

  it("resolves against a harness module that actually exists", () => {
    // If the decorators module moves, every specifier check below stops
    // matching and the detector silently answers "no offenders" forever.
    const resolved = [".tsx", ".ts"].some((extension) =>
      existsSync(`${HARNESS_MODULE_PATH}${extension}`)
    );
    expect(resolved, `${HARNESS_MODULE_PATH} does not exist`).toBe(true);
  });

  it("detects a plain named import mounted as JSX", () => {
    const source = `
      import { ${HARNESS_COMPONENT} } from "${HARNESS_MODULE_SPECIFIER}";
      export const Story = { render: () => <${HARNESS_COMPONENT}><div /></${HARNESS_COMPONENT}> };
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(true);
  });

  it("detects an ALIASED import mounted under its local name", () => {
    // The hole wongk found: same second harness, different tag name.
    const source = `
      import { ${HARNESS_COMPONENT} as Providers } from "${HARNESS_MODULE_SPECIFIER}";
      export const Story = { render: () => <Providers><div /></Providers> };
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(true);
  });

  it("detects a namespace import mounted as a qualified tag", () => {
    const source = `
      import * as decorators from "${HARNESS_MODULE_SPECIFIER}";
      export const Story = {
        render: () => <decorators.${HARNESS_COMPONENT}><div /></decorators.${HARNESS_COMPONENT}>,
      };
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(true);
  });

  it("detects it through a RELATIVE specifier too", () => {
    const source = `
      import { ${HARNESS_COMPONENT} } from "${RELATIVE_SPECIFIER}";
      export const Story = { render: () => <${HARNESS_COMPONENT} /> };
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(true);
  });

  it("does NOT fire on a prose-only mention", () => {
    // Two story files legitimately name the component in their docstrings; a
    // text scan would fail them both.
    const source = `
      /**
       * ${HARNESS_COMPONENT} is mounted by the preview, not here. Do not wrap
       * this story in <${HARNESS_COMPONENT}> — pin parameters.appCore instead.
       */
      export const Story = { render: () => <div /> }; // ${HARNESS_COMPONENT}
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(false);
  });

  it("does NOT fire on a same-named component from another module", () => {
    const source = `
      import { ${HARNESS_COMPONENT} } from "./local-lookalike";
      export const Story = { render: () => <${HARNESS_COMPONENT} /> };
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(false);
  });

  it("does NOT fire on an import that is never mounted", () => {
    const source = `
      import { ${HARNESS_COMPONENT} } from "${HARNESS_MODULE_SPECIFIER}";
      export type Props = Parameters<typeof ${HARNESS_COMPONENT}>[0];
    `;
    expect(rendersHarness(source, STORY_PATH)).toBe(false);
  });
});

/** Every `*.stories.*` file under `root`, recursively. */
function collectStoryFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile() && STORY_FILE.test(entry.name)) {
      found.push(path.join(entry.parentPath, entry.name));
    }
  }
  return found;
}

/**
 * True when `source` RENDERS the harness, as opposed to merely naming it.
 *
 * Takes the text rather than reading it, so the fixtures above can exercise it
 * without writing files into the story corpus it walks.
 */
function rendersHarness(source: string, filePath: string): boolean {
  const file = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TSX
  );

  const { componentBindings, namespaceBindings } = harnessBindings(
    file,
    filePath
  );
  if (componentBindings.size === 0 && namespaceBindings.size === 0) {
    return false;
  }

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) {
      return;
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      isHarnessTag(node.tagName, componentBindings, namespaceBindings)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/**
 * The LOCAL names the harness is reachable by in this file: bindings of the
 * component itself (`import { X }`, `import { X as Y }`) and namespace bindings
 * it hangs off (`import * as ns` → `<ns.X>`).
 */
function harnessBindings(
  file: ts.SourceFile,
  filePath: string
): { componentBindings: Set<string>; namespaceBindings: Set<string> } {
  const componentBindings = new Set<string>();
  const namespaceBindings = new Set<string>();

  for (const statement of file.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        isHarnessModule(statement.moduleSpecifier.text, filePath)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaceBindings.add(bindings.name.text);
      continue;
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        if (imported === HARNESS_COMPONENT) {
          componentBindings.add(element.name.text);
        }
      }
    }
  }

  return { componentBindings, namespaceBindings };
}

/** Whether an import specifier points at the decorators module. */
function isHarnessModule(specifier: string, fromFile: string): boolean {
  if (specifier.startsWith(".")) {
    return (
      path.resolve(path.dirname(fromFile), specifier) === HARNESS_MODULE_PATH
    );
  }
  return specifier === HARNESS_MODULE_SPECIFIER;
}

/** Whether a JSX tag resolves to one of the harness bindings. */
function isHarnessTag(
  tagName: ts.JsxTagNameExpression,
  componentBindings: ReadonlySet<string>,
  namespaceBindings: ReadonlySet<string>
): boolean {
  if (ts.isIdentifier(tagName)) {
    return componentBindings.has(tagName.text);
  }
  return (
    ts.isPropertyAccessExpression(tagName) &&
    ts.isIdentifier(tagName.expression) &&
    namespaceBindings.has(tagName.expression.text) &&
    tagName.name.text === HARNESS_COMPONENT
  );
}
