/**
 * ISS-10399 — keeps the catalog collectors' accepted extensions tied to the
 * extensions `.storybook/main.ts` actually indexes.
 *
 * The divergence this guards was a FALSE GREEN, which is why it matters.
 * `main.ts` indexes `apps/storybook/stories/**<!-- -->/*.stories.@(js|jsx|mjs|ts|tsx)`,
 * and every collector in `scripts/sync-component-catalog.mjs` accepted a
 * hand-written `.stories.tsx?` instead. A story in any of the other three
 * extensions was rendered by Storybook, sidebar-listed, and executed by the
 * Vitest sweep, while `catalog:sync`, taxonomy classification and
 * `validate:catalog` never saw it — no error, no warning, and the catalog simply
 * did not know it existed. A story the catalog cannot see fails nothing.
 *
 * So the collectors now derive that set from `main.ts` (`scripts/story-globs.mjs`)
 * rather than restating it. That makes the "do the two sides agree" half nearly
 * true by construction, so the assertions below are BEHAVIOURAL: they run the
 * real walk over a synthetic tree and the real derivation over a synthetic
 * config, and each fails under the mutation it names. Re-narrowing the predicate
 * to `.tsx` turns "collects a story at every extension" red; hardcoding the
 * five-extension list instead of reading the config turns "reads the set out of
 * the config it is given" red.
 *
 * Sibling guards, all reading the same `stories` array: `story-glob-parity`
 * (does the Vitest sweep glob everything Storybook indexes),
 * `story-glob-doc-parity` (do the docs describe it),
 * `app-core-harness-single-mount` (does its own walk cover it).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  storyExtensionsForDirectory,
  storyFileExtensions,
  storyGlobs,
} from "../scripts/story-globs.mjs";
import {
  collectAppCoreStoryFiles,
  collectDesktopStoryFiles,
  collectRootStoryFiles,
  storyStem,
  walkStoryFiles,
} from "../scripts/sync-component-catalog.mjs";
import { storybookStoryPatterns } from "./helpers/storybook-config-source";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const STORIES_ROOT = path.join(REPO_ROOT, "apps/storybook/stories");
const APP_PACKAGE_ROOT = path.join(REPO_ROOT, "packages/app");
const DESKTOP_COMPONENTS_ROOT = path.join(
  REPO_ROOT,
  "apps/desktop/src/renderer/components"
);
/** Trailing `@(a|b|c)` group of a Storybook glob. */
const BRACE_GROUP_SUFFIX = /@\(([^)]+)\)$/;
const UNCOVERED_DIRECTORY_MESSAGE = /under no story glob/;
const EMPTY_EXTENSION_SET_MESSAGE = /empty extension set/;
const SYNTHETIC_MAIN = `const config = {
  stories: [
    "../stories/**/*.mdx",
    "../stories/**/*.stories.@(ts|tsx)",
  ],
};
export default config;
`;
/**
 * A three-glob config shaped like the real one: five extensions at the root
 * stories directory, two at each colocated root. The difference is the whole
 * point — a collector using the UNION would collect a `.stories.js` under
 * `app/` or `desktop/`, which Storybook does not index there.
 */
const COLOCATED_SYNTHETIC_MAIN = `const config = {
  stories: [
    "./root/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "./app/*/components/**/*.stories.@(ts|tsx)",
    "./desktop/components/**/*.stories.@(ts|tsx)",
  ],
};
export default config;
`;
/**
 * Two globs sharing everything before their first wildcard (`./app`) and then
 * diverging — different subtree, different extensions. Truncating each to that
 * shared prefix answers `js` for a `components/` directory Storybook indexes
 * only `.stories.ts(x)` in (review, PR #8006).
 */
const DIVERGENT_SUBTREE_SYNTHETIC_MAIN = `const config = {
  stories: [
    "./app/*/components/**/*.stories.@(ts|tsx)",
    "./app/*/examples/**/*.stories.@(js|jsx)",
  ],
};
export default config;
`;
/** Storybook's other legal entry form, which the reader must also resolve. */
const OBJECT_ENTRY_SYNTHETIC_MAIN = `const config = {
  stories: [
    { directory: "./app", files: "**/*.stories.@(ts|tsx)" },
  ],
};
export default config;
`;

let scratchDir: string;

beforeEach(() => {
  scratchDir = mkdtempSync(path.join(tmpdir(), "iss-10399-"));
});

afterEach(() => {
  rmSync(scratchDir, { force: true, recursive: true });
});

describe("story collector extension parity with .storybook/main.ts", () => {
  it("collects a story at every extension main.ts indexes, and nothing else", () => {
    const extensions = storyFileExtensions();
    const nested = path.join(scratchDir, "foundations");
    mkdirSync(nested);
    for (const extension of extensions) {
      writeFileSync(path.join(nested, `widget.stories.${extension}`), "");
    }
    // Neither is a story: the first has a story-shaped stem but an extension
    // nothing indexes, the second is a plain component beside its stories.
    writeFileSync(path.join(nested, "widget.stories.txt"), "");
    writeFileSync(path.join(nested, "widget.tsx"), "");

    const collected: string[] = walkStoryFiles(scratchDir, extensions)
      .map((file: string) => path.basename(file))
      .sort();

    expect(extensions.length).toBeGreaterThan(1);
    expect(collected).toEqual(
      extensions.map((extension) => `widget.stories.${extension}`).sort()
    );
  });

  it("strips the suffix at every indexed extension to reach the story id", () => {
    for (const extension of storyFileExtensions()) {
      expect(
        storyStem(path.join(scratchDir, `grid-table-v2.stories.${extension}`)),
        `a \`.stories.${extension}\` story's catalog id must be its stem, not its stem plus a leftover suffix`
      ).toBe("grid-table-v2");
    }
  });

  it("reads the accepted set out of the config it is given, not a copy of it", () => {
    // The mutation this kills: a collector carrying its own five-extension list.
    // Against a config that indexes two, a hardcoded list still answers five.
    const syntheticMain = path.join(scratchDir, "main.ts");
    writeFileSync(syntheticMain, SYNTHETIC_MAIN);

    expect(storyFileExtensions(syntheticMain)).toEqual(["ts", "tsx"]);
    expect(storyGlobs(syntheticMain)).toEqual([
      {
        dirSegments: path.resolve(scratchDir, "../stories/**").split(path.sep),
        extensions: ["ts", "tsx"],
      },
    ]);
  });

  it("accepts under each collector root exactly what main.ts indexes there", () => {
    const indexed = new Map<string, Set<string>>();
    for (const pattern of storybookStoryPatterns()) {
      const braceMatch = BRACE_GROUP_SUFFIX.exec(pattern);
      if (!(braceMatch && pattern.includes(".stories."))) {
        continue;
      }
      // The pattern's real directory prefix, resolved the way `main.ts` reads it.
      const absolute = path.resolve(
        REPO_ROOT,
        "apps/storybook/.storybook",
        pattern
      );
      const root = absolute.split(`${path.sep}*`)[0];
      const set = indexed.get(root) ?? new Set<string>();
      for (const extension of braceMatch[1].split("|")) {
        set.add(extension);
      }
      indexed.set(root, set);
    }

    expect(indexed.size).toBeGreaterThan(0);
    for (const [root, extensions] of indexed) {
      expect(
        storyExtensionsForDirectory(root),
        `storyExtensionsForDirectory answers a different extension set for ${path.relative(REPO_ROOT, root)} than .storybook/main.ts indexes there — a story in the difference is rendered by Storybook and invisible to catalog:sync. (Which set each collector PASSES is pinned by "narrows each colocated collector to its own root's extensions".)`
      ).toEqual([...extensions].sort());
    }
  });

  it("refuses a directory no story glob covers rather than collecting nothing", () => {
    // A collector handed an empty extension set walks the tree and returns
    // nothing, which reads exactly like a clean run.
    expect(() => storyExtensionsForDirectory(scratchDir)).toThrow(
      UNCOVERED_DIRECTORY_MESSAGE
    );
    expect(() => walkStoryFiles(scratchDir, [])).toThrow(
      EMPTY_EXTENSION_SET_MESSAGE
    );
  });

  it("narrows each colocated collector to its own root's extensions", () => {
    // The mutation this kills: either colocated collector passing the UNION
    // (`storyFileExtensions()`) or the other root's set. No `.stories.js` exists
    // under `packages/app` today, so nothing else in this suite would notice.
    const appRoot = path.join(scratchDir, "app");
    const appComponents = path.join(appRoot, "feature", "components");
    const desktopRoot = path.join(scratchDir, "desktop", "components");
    mkdirSync(appComponents, { recursive: true });
    mkdirSync(desktopRoot, { recursive: true });
    for (const dir of [appComponents, desktopRoot]) {
      writeFileSync(path.join(dir, "widget.stories.tsx"), "");
      writeFileSync(path.join(dir, "widget.stories.js"), "");
    }
    const mainPath = path.join(scratchDir, "main.ts");
    writeFileSync(mainPath, COLOCATED_SYNTHETIC_MAIN);

    expect(
      collectAppCoreStoryFiles(appRoot, mainPath).map((file: string) =>
        path.basename(file)
      )
    ).toEqual(["widget.stories.tsx"]);
    expect(
      collectDesktopStoryFiles(desktopRoot, mainPath).map((file: string) =>
        path.basename(file)
      )
    ).toEqual(["widget.stories.tsx"]);
  });

  it("keeps two globs sharing a static prefix from answering for each other", () => {
    // The mutation this kills: collapsing each glob to the path before its
    // first wildcard. Both globs below truncate to `./app`, so a prefix-only
    // matcher answers the UNION for either subtree — and the collector then
    // catalogs a `.stories.js` under `components/`, which Storybook does not
    // index there. Every other case in this suite passes under that bug.
    const mainPath = path.join(scratchDir, "main.ts");
    writeFileSync(mainPath, DIVERGENT_SUBTREE_SYNTHETIC_MAIN);
    const appRoot = path.join(scratchDir, "app");
    const components = path.join(appRoot, "feature", "components");
    const examples = path.join(appRoot, "feature", "examples");
    mkdirSync(components, { recursive: true });
    mkdirSync(examples, { recursive: true });
    for (const dir of [components, examples]) {
      writeFileSync(path.join(dir, "widget.stories.tsx"), "");
      writeFileSync(path.join(dir, "widget.stories.js"), "");
    }

    expect(storyExtensionsForDirectory(components, mainPath)).toEqual([
      "ts",
      "tsx",
    ]);
    expect(storyExtensionsForDirectory(examples, mainPath)).toEqual([
      "js",
      "jsx",
    ]);
    // The collector walks `components/`, so it must use that directory's set
    // and not the package root's union.
    expect(
      collectAppCoreStoryFiles(appRoot, mainPath).map((file: string) =>
        path.basename(file)
      )
    ).toEqual(["widget.stories.tsx"]);
  });

  it("resolves the object entry form Storybook also accepts", () => {
    const mainPath = path.join(scratchDir, "main.ts");
    writeFileSync(mainPath, OBJECT_ENTRY_SYNTHETIC_MAIN);

    expect(storyGlobs(mainPath)).toEqual([
      {
        dirSegments: path.join(scratchDir, "app", "**").split(path.sep),
        extensions: ["ts", "tsx"],
      },
    ]);
  });

  it("refuses an uncovered desktop root rather than reporting no stories", () => {
    // The desktop collector is the one wrapped in a catch, for the
    // no-renderer-tree checkout. That catch must not also absorb "the config
    // covers nothing here" — which would rewrite the catalog with every desktop
    // entry silently gone.
    expect(() => collectDesktopStoryFiles(scratchDir)).toThrow(
      UNCOVERED_DIRECTORY_MESSAGE
    );
    expect(
      collectDesktopStoryFiles(
        path.join(DESKTOP_COMPONENTS_ROOT, "absent-iss-10399")
      )
    ).toEqual([]);
  });

  it("keeps the three production collectors finding stories", () => {
    // Guards the guard: the assertions above prove the predicate, not that any
    // collector still runs. A zero here is the false green, not a pass.
    expect(collectRootStoryFiles().length).toBeGreaterThan(0);
    expect(collectAppCoreStoryFiles().length).toBeGreaterThan(0);
    expect(collectDesktopStoryFiles().length).toBeGreaterThan(0);
    expect(storyExtensionsForDirectory(STORIES_ROOT).length).toBe(5);
    expect(storyExtensionsForDirectory(APP_PACKAGE_ROOT)).toEqual([
      "ts",
      "tsx",
    ]);
    expect(storyExtensionsForDirectory(DESKTOP_COMPONENTS_ROOT)).toEqual([
      "ts",
      "tsx",
    ]);
  });
});
