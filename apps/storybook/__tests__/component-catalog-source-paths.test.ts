/**
 * ISS-6675 — every committed catalog entry points at a file that is really there.
 *
 * `component-catalog.ts` is the second-highest-churn file in the repo, and its
 * churn is overwhelmingly resyncs after components move or are deleted
 * (`63796383d`, `2a1c00892`). `validate:catalog` runs in CI, but it never touches
 * the filesystem for `sourcePath`: it diffs the committed file against a
 * regenerated one and then runs every title check against the REGENERATED
 * entries. A stale `sourcePath` therefore survives as long as the generator
 * would emit the same stale value — which, for the `appComponentSurfaces`
 * hand-maintained list, is exactly what happens when a component is moved.
 *
 * So this stats the files, and it stats the entry's OWN path rather than
 * globbing for something that looks like it — a glob finds a same-named sibling
 * and reports the catalog true when it is pointing somewhere else. Two further
 * traps this deliberately closes:
 *
 *  - `existsSync` is case-INSENSITIVE on macOS (APFS) while CI runs on Linux, so
 *    a wrong-case `sourcePath` passes locally and fails Storybook's own resolver
 *    in CI. EVERY segment is checked against its parent's directory listing —
 *    a basename-only check reports a miscased DIRECTORY as fine, because the
 *    miscased directory still lists correctly-cased children.
 *  - a path that resolves to a DIRECTORY is not a component source, so `isFile()`
 *    is asserted, not mere existence.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";
import { describe, expect, it } from "vitest";
import {
  appComponentCatalog,
  appCoreComponentCatalog,
  designSystemComponentCatalog,
  desktopComponentCatalog,
  type StorybookCatalogEntry,
} from "../../../packages/design-system/storybook/component-catalog";
import {
  storybookBaselineRoot,
  storybookVersionedRoot,
} from "../story-group-order";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CATALOG_SOURCE = path.join(
  REPO_ROOT,
  "packages/design-system/storybook/component-catalog.ts"
);

const CATALOGS: ReadonlyArray<
  readonly [string, readonly StorybookCatalogEntry[]]
> = [
  ["designSystemComponentCatalog", designSystemComponentCatalog],
  ["appComponentCatalog", appComponentCatalog],
  ["appCoreComponentCatalog", appCoreComponentCatalog],
  ["desktopComponentCatalog", desktopComponentCatalog],
];

/**
 * `storybookComponentCatalog` spreads the three above, so checking it as well
 * would duplicate every finding — it is covered transitively, and the guard
 * below is what stops it (or a genuinely new fifth catalog) drifting out of that
 * relationship unnoticed.
 */
const TRANSITIVELY_COVERED = "storybookComponentCatalog";

/** The one exported array literal that is not a catalog. */
const NON_CATALOG_ARRAY_EXPORT = "canonicalStorybookLevels";

const ALL_ENTRIES = CATALOGS.flatMap(([catalog, entries]) =>
  entries.map((entry) => ({ catalog, entry }))
);

describe("component-catalog sourcePath resolution", () => {
  it("covers every catalog the module exports", () => {
    // Guards the guard. Every per-entry loop below iterates a hand-named list,
    // so a catalog added to `component-catalog.ts` and not added here would get
    // ZERO coverage with the whole file still green — the same silent-omission
    // failure this file exists to close, one level up. Read from the module's
    // AST rather than restated (`scripts/lint/rules/no-raw-text-source-scan.ts`).
    const exported = exportedCatalogNames();
    const covered = new Set([
      ...CATALOGS.map(([name]) => name),
      TRANSITIVELY_COVERED,
    ]);

    expect(exported.length).toBeGreaterThan(0);
    expect(
      exported.filter((name) => !covered.has(name)),
      "add the new catalog to CATALOGS above, or explain why it is covered transitively"
    ).toEqual([]);
    expect(
      [...covered].filter((name) => !exported.includes(name)),
      "a catalog this file names no longer exists — its assertions are now checking nothing"
    ).toEqual([]);
  });

  it.each(CATALOGS)("%s is populated", (_catalog, entries) => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("resolves every sourcePath to a real file on disk", () => {
    const missing: string[] = [];

    for (const { catalog, entry } of ALL_ENTRIES) {
      const absolute = path.join(REPO_ROOT, entry.sourcePath);
      let stats: ReturnType<typeof statSync> | null = null;
      try {
        stats = statSync(absolute);
      } catch {
        missing.push(
          `${catalog}/${entry.id}: sourcePath "${entry.sourcePath}" does not exist`
        );
        continue;
      }
      if (!stats.isFile()) {
        missing.push(
          `${catalog}/${entry.id}: sourcePath "${entry.sourcePath}" is not a file`
        );
      }
    }

    expect(
      missing,
      "a catalog entry pointing at a moved or deleted component renders a dead source link in Storybook and misroutes anyone reading the catalog for where a component lives — re-run `pnpm -C apps/storybook run catalog:sync`"
    ).toEqual([]);
  });

  it("matches every sourcePath segment with exact case", () => {
    const miscased: string[] = [];

    for (const { catalog, entry } of ALL_ENTRIES) {
      const absolute = path.join(REPO_ROOT, entry.sourcePath);
      // A path that resolves NOWHERE is the test above's finding; reporting it
      // here too would double every failure. On macOS a miscased path still
      // resolves, which is precisely the gap this test exists to close; on Linux
      // it does not, and the test above is already red for it.
      if (!existsSync(absolute)) {
        continue;
      }
      // EVERY segment, not just the basename: `.../Components/ui/badge.tsx`
      // resolves on APFS and its directory listing yields the correctly-cased
      // leaf, so a basename-only check reports a miscased DIRECTORY as fine.
      const badSegment = firstMiscasedSegment(entry.sourcePath);
      if (badSegment !== null) {
        miscased.push(
          `${catalog}/${entry.id}: sourcePath "${entry.sourcePath}" differs in case from the file on disk at segment "${badSegment}"`
        );
      }
    }

    expect(
      miscased,
      "macOS resolves a wrong-case path and Linux CI does not, so a miscased sourcePath ships green from a laptop and breaks the catalog's source links in CI"
    ).toEqual([]);
  });

  it("keeps every sourcePath repo-relative and POSIX", () => {
    const malformed = ALL_ENTRIES.filter(
      ({ entry }) =>
        path.isAbsolute(entry.sourcePath) || entry.sourcePath.includes("\\")
    ).map(
      ({ catalog, entry }) => `${catalog}/${entry.id}: "${entry.sourcePath}"`
    );

    expect(
      malformed,
      "sourcePath is joined against the repo root by every consumer; an absolute or Windows-separated path escapes that join"
    ).toEqual([]);
  });
});

describe("component-catalog storyTitle composition", () => {
  it("composes every storyTitle from its own section, version and pathSegments", () => {
    const drifted: string[] = [];

    for (const { catalog, entry } of ALL_ENTRIES) {
      const root = entry.version
        ? storybookVersionedRoot(entry.level, entry.version)
        : storybookBaselineRoot(entry.level);
      // A Pattern is a page's own layout, so its title is the page's path
      // with no label (TAXONOMY.md, "The page tree").
      const composed = [
        root,
        ...entry.pathSegments,
        ...(entry.level === "Patterns" ? [] : [entry.label]),
      ].join("/");
      if (entry.storyTitle !== composed) {
        drifted.push(
          `${catalog}/${entry.id}: storyTitle "${entry.storyTitle}" but section + pathSegments + label compose "${composed}"`
        );
      }
    }

    // `validate-story-titles.mjs` compares storyTitle against the STORY FILE's
    // `meta.title`; nothing checks it against the entry's own section and
    // pathSegments, which are what the catalog UI navigates by. Drift between
    // them sends the sidebar and the source link to two different places.
    expect(drifted).toEqual([]);
  });
});

/**
 * The first path segment whose case does not match the filesystem, or null when
 * every one matches. Descends from the repo root asking each parent for its own
 * listing, because a case-insensitive filesystem answers `readdirSync` for a
 * miscased directory with the correctly-cased children — so only the segment
 * being descended INTO can be checked, one level at a time.
 */
function firstMiscasedSegment(sourcePath: string): string | null {
  let cursor = REPO_ROOT;
  for (const segment of sourcePath.split("/")) {
    let siblings: string[];
    try {
      siblings = readdirSync(cursor);
    } catch {
      // Unreadable parent: the resolution test above owns that finding.
      return null;
    }
    if (!siblings.includes(segment)) {
      return segment;
    }
    cursor = path.join(cursor, segment);
  }
  return null;
}

/**
 * Names of the exported `const`s in `component-catalog.ts` initialized with an
 * array literal — i.e. the catalogs. `canonicalStorybookLevels` is one too, and is
 * excluded by name rather than by shape: a shape sniff would also silently drop
 * a real catalog whose entries stopped matching whatever it sniffed for.
 */
function exportedCatalogNames(): string[] {
  const source = ts.createSourceFile(
    CATALOG_SOURCE,
    readFileSync(CATALOG_SOURCE, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (
      !(
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        )
      )
    ) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const initializer = unwrapAssertions(declaration.initializer);
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text !== NON_CATALOG_ARRAY_EXPORT &&
        initializer &&
        ts.isArrayLiteralExpression(initializer)
      ) {
        names.push(declaration.name.text);
      }
    }
  }
  return names;
}

/** Strips the `as const` / `satisfies …` wrappers each catalog literal carries. */
function unwrapAssertions(
  node: ts.Expression | undefined
): ts.Expression | undefined {
  let current = node;
  while (
    current &&
    (ts.isAsExpression(current) || ts.isSatisfiesExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}
