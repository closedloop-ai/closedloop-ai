import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  atomicLevels,
  buildCatalogData,
  collectAllStoryFiles,
  metaTitleRegex,
} from "./sync-component-catalog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const catalogPath = path.join(
  repoRoot,
  "packages/design-system/storybook/component-catalog.ts"
);
const storiesDir = path.join(repoRoot, "apps/storybook/stories");
// Stories intentionally outside the Design System catalog:
// - sidebar-nav-link-item / sidebar-section-header: showcase fragments of sidebar.tsx
// - empty-state-app: app-artifact example built on empty-state.tsx
// - pagination: showcase of the private `pagination` primitive (designSystemPrivateSurfaceIds);
//   the cataloged surface is `table-pagination`, which composes it.
// - chart-colors: showcase of the --chart-* palette tokens; the source
//   (chart-colors.ts) is a token helper, not a .tsx component surface, so the
//   catalog (which only walks .tsx files) has no entry to map it to.
const ignoredStoryIds = new Set([
  "agent-monitor",
  "catalog",
  "chart-colors",
  "empty-state-app",
  "pagination",
  "sidebar-nav-link-item",
  "sidebar-section-header",
]);

const { designSystemEntries, appEntries, appCoreEntries } = buildCatalogData();
const expectedCatalogData = {
  designSystemEntries,
  appEntries,
  appCoreEntries,
};
const currentCatalogModule = await import(
  `${pathToFileURL(catalogPath).href}?t=${Date.now()}`
);
const currentCatalogData = {
  designSystemEntries: currentCatalogModule.designSystemComponentCatalog,
  appEntries: currentCatalogModule.appComponentCatalog,
  appCoreEntries: currentCatalogModule.appCoreComponentCatalog,
};

if (
  JSON.stringify(currentCatalogData) !== JSON.stringify(expectedCatalogData)
) {
  console.error(
    "packages/design-system/storybook/component-catalog.ts is out of date. Run `pnpm -C apps/storybook run catalog:sync`."
  );
  process.exitCode = 1;
}

const expectedTitles = new Map();

for (const entry of [...designSystemEntries, ...appEntries]) {
  if (!entry.storyId || entry.internal) {
    continue;
  }

  expectedTitles.set(entry.storyId, entry.storyTitle);
}

const actualTitles = new Map();
const storyFiles = readdirSync(storiesDir).filter((fileName) =>
  fileName.endsWith(".stories.tsx")
);

for (const fileName of storyFiles) {
  const storyId = fileName.replace(/\.stories\.tsx$/, "");
  if (ignoredStoryIds.has(storyId)) {
    continue;
  }

  const storyPath = path.join(storiesDir, fileName);
  let storySource;

  try {
    storySource = readFileSync(storyPath, "utf8");
  } catch (error) {
    console.error(
      `Unable to read ${fileName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
    continue;
  }

  // \b after "meta" so the match anchors on `const meta`, not a `const metadata`
  // data array that may precede it (whose nested title: would match first).
  const titleMatch = storySource.match(
    /const meta\b[\s\S]*?\btitle:\s*"([^"]+)"/
  );

  if (!titleMatch) {
    console.error(`Missing string-literal title in ${fileName}`);
    process.exitCode = 1;
    continue;
  }

  actualTitles.set(storyId, titleMatch[1]);
}

for (const [storyId, expectedTitle] of expectedTitles) {
  const actualTitle = actualTitles.get(storyId);

  if (!actualTitle) {
    console.error(`Missing story file for catalog entry "${storyId}"`);
    process.exitCode = 1;
    continue;
  }

  if (actualTitle !== expectedTitle) {
    console.error(
      `Title mismatch for "${storyId}": expected "${expectedTitle}", found "${actualTitle}"`
    );
    process.exitCode = 1;
  }
}

for (const [storyId, actualTitle] of actualTitles) {
  if (!expectedTitles.has(storyId)) {
    console.error(
      `Story "${storyId}" is not cataloged. Found title "${actualTitle}"`
    );
    process.exitCode = 1;
  }
}

// Every story file Storybook indexes, across all three glob roots.
//
// The freshness check above catches title DRIFT, but only on the 113 entries the
// catalog already carries, and those come from the flat `apps/storybook/stories`
// directory alone. This walks everything: `packages/app`, the desktop renderer,
// and the `stories/` subdirectories. Before it did, 33 rendered stories sat
// outside every check here and could be titled anything at all.
//
// A story whose title does not start with an atomic level cannot be placed in
// the catalog, so it would keep rendering in Storybook while being invisible to
// every consumer of the catalog. Assert the level prefix so that fails CI.
let indexedStoryCount = 0;
const storyFilesByTitle = new Map();
for (const storyFile of collectAllStoryFiles()) {
  const titleMatch = readFileSync(storyFile, "utf8").match(metaTitleRegex);
  const relativePath = path.relative(repoRoot, storyFile);

  if (!titleMatch) {
    console.error(`Missing string-literal title in ${relativePath}`);
    process.exitCode = 1;
    continue;
  }

  indexedStoryCount += 1;

  const existingClaim = storyFilesByTitle.get(titleMatch[1]) ?? [];
  existingClaim.push(relativePath);
  storyFilesByTitle.set(titleMatch[1], existingClaim);

  // `Start Here` is the landing page, which introduces the other four levels
  // rather than sitting in one. It is the only title outside them.
  const level = titleMatch[1].split("/")[0];
  if (!(atomicLevels.has(level) || level === "Start Here")) {
    console.error(
      `Story ${relativePath} has title "${titleMatch[1]}" — every story must be titled "<Level>/<Group>/<Component>" where Level is one of ${[...atomicLevels].join(", ")}. See apps/storybook/TAXONOMY.md.`
    );
    process.exitCode = 1;
  }
}

// PR #4814 review: every check above is keyed on storyId (the FILE stem), which
// is unique by construction, so none of them can see two DIFFERENT files
// claiming the same `meta.title`. That collision is silent and lossy in both
// directions: Storybook folds same-titled files into one sidebar/autodocs
// identity (one component becomes unreachable), and the catalog gains duplicate
// storyTitle keys that any title -> component lookup resolves arbitrarily.
//
// Checked over every story FILE rather than over catalog entries. The catalog
// carries no entry for the desktop renderer or the `stories/` subdirectories, so
// a check built on entries alone would not notice one of those 33 files taking a
// title the catalog already uses.
for (const [storyTitle, storyPaths] of storyFilesByTitle) {
  if (storyPaths.length > 1) {
    console.error(
      `Duplicate story title "${storyTitle}" claimed by ${storyPaths.length} story files: ${storyPaths.join(", ")}. Storybook folds same-titled files into one identity, so one of them becomes unreachable. Give each a distinct "<Level>/<Group>/<Component>" title and re-run catalog:sync.`
    );
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(
    `Validated ${expectedTitles.size} cataloged story titles against ${actualTitles.size} story files, plus ${indexedStoryCount} story files across all three glob roots, and ${storyFilesByTitle.size} unique story titles.`
  );
}
