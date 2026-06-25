import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
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

// Colocated App Core stories live in packages/app/<feature>/components/, outside
// `storiesDir`. The freshness check above catches title DRIFT on existing entries,
// but `buildAppCoreEntries` silently skips any colocated story whose title does not
// start with "App Core/" — so a net-new story titled "Oops/Bar" would be invisible to
// the catalog yet still render in Storybook. Assert every colocated story is
// App Core-prefixed so those net-new mistakes fail CI instead of slipping through.
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

  if (!titleMatch[1].startsWith("App Core/")) {
    console.error(
      `Colocated story ${relativePath} has title "${titleMatch[1]}" — packages/app stories must be titled "App Core/<Feature>/<Component>" to be cataloged.`
    );
    process.exitCode = 1;
  }
}

if (!process.exitCode) {
  console.log(
    `Validated ${expectedTitles.size} cataloged story titles against ${actualTitles.size} story files, plus ${appCoreStoryCount} colocated App Core stories.`
  );
}
