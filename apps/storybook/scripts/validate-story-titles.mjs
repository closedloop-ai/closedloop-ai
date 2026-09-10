import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  atomicLevels,
  buildCatalogData,
  collectAppCoreStoryFiles,
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

// Colocated stories live in packages/app/<feature>/components/, outside
// `storiesDir`. The freshness check above catches title DRIFT on existing
// entries, but a story whose title does not start with an atomic level cannot be
// placed in the catalog at all — it would still render in Storybook while being
// invisible to every consumer of the catalog. Assert the level prefix so that
// mistake fails CI instead of slipping through.
let appCoreStoryCount = 0;
for (const storyFile of collectAppCoreStoryFiles()) {
  const titleMatch = readFileSync(storyFile, "utf8").match(metaTitleRegex);
  const relativePath = path.relative(repoRoot, storyFile);

  if (!titleMatch) {
    console.error(`Missing string-literal title in ${relativePath}`);
    process.exitCode = 1;
    continue;
  }

  appCoreStoryCount += 1;

  if (!atomicLevels.has(titleMatch[1].split("/")[0])) {
    console.error(
      `Colocated story ${relativePath} has title "${titleMatch[1]}" — every story must be titled "<Level>/<Group>/<Component>" where Level is one of ${[...atomicLevels].join(", ")}. See apps/storybook/TAXONOMY.md.`
    );
    process.exitCode = 1;
  }
}

// PR #4814 review: every check above is keyed on storyId (the FILE stem), which
// is unique by construction, so none of them can see two DIFFERENT files
// claiming the same `meta.title`. That collision is silent and lossy in both
// directions: Storybook folds same-titled files into one sidebar/autodocs
// identity (one component becomes unreachable), and `buildAppCoreEntries` copies
// `storyTitle` verbatim, so the generated catalog gains duplicate storyTitle
// keys that any title -> component lookup resolves arbitrarily. Assert titles are
// unique across the whole catalog so the next one fails CI instead of shipping.
const sourcePathsByTitle = new Map();
for (const entry of [
  ...designSystemEntries,
  ...appEntries,
  ...appCoreEntries,
]) {
  if (!entry.storyTitle) {
    continue;
  }

  const existing = sourcePathsByTitle.get(entry.storyTitle);
  if (existing) {
    existing.push(entry.sourcePath);
    continue;
  }

  sourcePathsByTitle.set(entry.storyTitle, [entry.sourcePath]);
}

for (const [storyTitle, sourcePaths] of sourcePathsByTitle) {
  if (sourcePaths.length > 1) {
    console.error(
      `Duplicate story title "${storyTitle}" claimed by ${sourcePaths.length} components: ${sourcePaths.join(", ")}. Story titles must be unique — give each a distinct "<Level>/<Group>/<Component>" title and re-run catalog:sync.`
    );
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(
    `Validated ${expectedTitles.size} cataloged story titles against ${actualTitles.size} story files, plus ${appCoreStoryCount} colocated App Core stories, and ${sourcePathsByTitle.size} unique story titles.`
  );
}
