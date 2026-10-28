import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  StorybookLifecycle,
  storybookBaselineRoot,
  storybookBaselineVersion,
  storybookCompositesV2Order,
  storybookLevelGroupOrder,
  storybookLifecycleTags,
  storybookNextVersion,
  storybookPatternsV2Order,
  storybookPatternsV2Root,
  storybookSurfacesV2Root,
  storybookSurfacesV2RootOrder,
  storybookV2PageTreeOrder,
  storybookVersionedRoot,
  storySortOrderPaths,
} from "../story-group-order.ts";
import {
  storybookMainPath,
  storyExtensionsForDirectory,
} from "./story-globs.mjs";
import { checkStateOrder } from "./story-state-order.mjs";
import {
  buildCatalogData,
  canonicalStorybookLevels,
  collectAppCoreStoryFiles,
  collectDesktopStoryFiles,
  collectRootStoryFiles,
  metaTitleRegex,
  startHereRoot,
  storyStem,
} from "./sync-component-catalog.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const catalogPath = path.join(
  repoRoot,
  "packages/design-system/storybook/component-catalog.ts"
);
const storiesDir = path.join(repoRoot, "apps/storybook/stories");
const storyExtensions = storyExtensionsForDirectory(
  storiesDir,
  storybookMainPath
);
// Stories intentionally outside the generated catalog:
// - sidebar-nav-link-item / sidebar-section-header: showcase fragments of sidebar.tsx
// - empty-state-app: app-artifact example built on empty-state.tsx
// - start-here-introduction / catalog / start-here-version-history: the three
//   "Start Here" pages themselves,
//   not levels of the taxonomy they document.
// - pagination: showcase of the private `pagination` primitive
//   (designSystemPrivateSurfaceIds in sync-component-catalog.mjs); the
//   cataloged surface is `table-pagination`, which composes it.
//
// `chart-colors.stories.tsx`, the earlier placeholder for the chart-token half
// of Foundations/Colors, is retired now that that page exists and folds it in
// (its own "Chart series order" section).
//
// The Foundations and Surfaces pages are ALSO outside the catalog, but they
// are title-checked rather than skipped — see `uncatalogedExpectedTitles`.
const ignoredStoryIds = new Set([
  "catalog",
  "empty-state-app",
  "pagination",
  "start-here-introduction",
  "start-here-version-history",
]);

// The five Foundations pages and the four hand-composed Surfaces pages. Each
// documents a live token set read out of globals.css at runtime, or assembles
// several real components plus realistic fixtures into a full page; there is
// no single `.tsx` any of them "is" the way there is for a promoted composite
// (see SURFACE_OVERRIDE_BY_ID in taxonomy-classification.mjs for those), so
// the generated catalog — which only walks `.tsx` under packages/design-system
// — has no entry to map them to.
//
// They used to sit in `ignoredStoryIds` alongside the showcase fragments and
// were skipped OUTRIGHT (review on PR #7288, whitlockk): `validate:catalog` stayed
// green if one of them was retitled or collided with another story's title.
// Being outside the CATALOG is not a reason to be outside the TITLE check, so
// their expected titles are pinned here instead. A new page under
// stories/foundations/ or stories/surfaces/ fails below as uncataloged until
// it is added to this map, which is the intended prompt.
const uncatalogedExpectedTitles = new Map([
  ["colors", "Foundations v1.0/Colors"],
  ["dashboard", "Surfaces v1.0/Dashboard"],
  ["document-detail", "Surfaces v1.0/Documents/Document Detail"],
  ["documents-listing", "Surfaces v1.0/Documents/Listing"],
  [
    "grid-table-v2-card-list",
    "Composites v1.0/Data Display/Tables/Grid Table V2 Card List",
  ],
  [
    "implementation-plan-detail",
    "Surfaces v1.0/Implementation Plans/Plan Detail",
  ],
  ["issue-detail", "Surfaces v1.0/Issues/Issue Detail"],
  ["login", "Surfaces v1.0/Login"],
  ["motion", "Foundations v1.0/Motion"],
  ["onboarding", "Surfaces v1.0/Onboarding"],
  ["prd-detail", "Surfaces v1.0/PRDs/PRD Detail"],
  ["projects-detail", "Surfaces v1.0/Projects/Project Detail"],
  ["projects-listing", "Surfaces v1.0/Projects/Listing"],
  ["radius-elevation", "Foundations v1.0/Radius & Elevation"],
  ["settings", "Surfaces v1.0/Settings"],
  ["spacing", "Foundations v1.0/Spacing"],
  ["typography", "Foundations v1.0/Typography"],
]);

const {
  designSystemEntries,
  appEntries,
  appCoreEntries,
  desktopEntries,
  source: expectedCatalogSource,
} = buildCatalogData();
const expectedCatalogData = {
  designSystemEntries,
  appEntries,
  appCoreEntries,
  desktopEntries,
};
const currentCatalogModule = await import(
  `${pathToFileURL(catalogPath).href}?t=${Date.now()}`
);
const currentCatalogData = {
  designSystemEntries: currentCatalogModule.designSystemComponentCatalog,
  appEntries: currentCatalogModule.appComponentCatalog,
  appCoreEntries: currentCatalogModule.appCoreComponentCatalog,
  desktopEntries: currentCatalogModule.desktopComponentCatalog,
};

if (
  JSON.stringify(currentCatalogData) !== JSON.stringify(expectedCatalogData)
) {
  console.error(
    "packages/design-system/storybook/component-catalog.ts is out of date. Run `pnpm -C apps/storybook run catalog:sync`."
  );
  process.exitCode = 1;
}

// The four entry arrays above are only PART of the generated file. Everything
// else `renderCatalogSource` emits — the `storybookComponentCatalog`
// aggregate, the canonical-level export, `hasStory`, the type boilerplate —
// was unchecked, so a stale copy of any of it merged green while this
// validator reported the entries as fresh (PR #7280 review, davetho). This
// is the same byte-for-byte comparison `catalog:sync --check` does, run here
// so the one CI gate covers the whole generated file rather than a slice.
if (`${expectedCatalogSource}\n` !== readFileSync(catalogPath, "utf8")) {
  console.error(
    "packages/design-system/storybook/component-catalog.ts does not match its generated source (entries may agree while the rest of the file is stale). Run `pnpm -C apps/storybook run catalog:sync`."
  );
  process.exitCode = 1;
}

const expectedTitles = new Map(uncatalogedExpectedTitles);

for (const entry of [...designSystemEntries, ...appEntries]) {
  if (!entry.storyId || entry.internal) {
    continue;
  }

  expectedTitles.set(entry.storyId, entry.storyTitle);
}

const actualTitles = new Map();
// Recursive — was a flat readdirSync, invisible to anything under a
// subdirectory (Fable review, PLN-2024 Phase B/C follow-up). Foundations
// pages live in stories/foundations/ today (Motion) and that's where the
// planned Colors/Typography/Spacing/Radius pages go too; a flat scan meant
// none of them were ever checked by this script even though Storybook's own
// glob (`../stories/**/*.stories.*`) indexes them fine.
const storyFiles = collectRootStoryFiles();
const lifecycleMetaRegex = /const meta\b[\s\S]*?\n\}/;
const lifecycleTagsRegex = /\btags:\s*\[([^\]]*)\]/;
const lifecycleQuotedRegex = /"([^"]+)"/g;
// Keyed so the Start Here re-read at the bottom can find a page's real file
// rather than rebuilding a `.stories.tsx` filename, which would miss a page
// written in any other extension `.storybook/main.ts` indexes (ISS-10399).
const storyPathsById = new Map();
// Surfaces (ISS-11361) re-arranges existing stories into the target page
// tree, so its files are not components and have no catalog entry. They get
// their own check below instead. Patterns (page shells and layouts) is
// the same kind of versioned root and gets the same check.
const surfacesV2Dir = `surfaces-v2${path.sep}`;
const surfacesV2Files = [];
const patternsV2Dir = `patterns-v2${path.sep}`;
const patternsV2Files = [];
// Composites's components are cataloged and placed by
// V2_PLACEMENT_BY_ID. This directory holds its uncataloged pages: the Overview
// and v2.0 copies of v1.0 stories (named v2-<name> so their stem never
// matches the v1.0 component's), titled "<page-tree path>/<Name>".
const compositesV2Dir = `composites-v2${path.sep}`;
const compositesV2Files = [];
// Foundations copies the uncataloged Foundations pages under the same
// file names, so it is checked the same way rather than by story id.
const foundationsV2Dir = `foundations-v2${path.sep}`;
const foundationsV2Files = [];

for (const storyPath of storyFiles) {
  const fileName = path.relative(storiesDir, storyPath);
  const storyId = storyStem(storyPath);
  if (fileName.startsWith(surfacesV2Dir)) {
    surfacesV2Files.push(storyPath);
    continue;
  }
  if (fileName.startsWith(patternsV2Dir)) {
    patternsV2Files.push(storyPath);
    continue;
  }
  if (fileName.startsWith(compositesV2Dir) && !expectedTitles.has(storyId)) {
    compositesV2Files.push(storyPath);
    const storyId = storyStem(storyPath);
    if (expectedTitles.has(storyId)) {
      const storySource = readFileSync(storyPath, "utf8");
      const titleMatch = storySource.match(metaTitleRegex);
      if (titleMatch) {
        actualTitles.set(storyId, titleMatch[1]);
      }
    }
    continue;
  }
  if (fileName.startsWith(foundationsV2Dir)) {
    foundationsV2Files.push(storyPath);
    continue;
  }
  storyPathsById.set(storyId, storyPath);
  if (ignoredStoryIds.has(storyId)) {
    continue;
  }

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

  const titleMatch = storySource.match(metaTitleRegex);

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

// Colocated App Core / desktop stories live outside `storiesDir`. Unlike a
// design-system entry, the catalog builder COMPUTES their title from the
// classifier rather than reading it off the story file — so the freshness
// check above (which diffs the committed catalog against a regenerated one)
// cannot see a story whose on-disk `title:` disagrees with what the
// classifier would produce; the catalog itself is silently correct either
// way. This is the check that actually reads the file and catches that
// drift: a wrong on-disk title (missing a level prefix, or a stale value
// left over from a previous classification) fails here even though it would
// never fail catalog:sync.
// Every level's current root ("Composites"), plus the Deprecated "<level>
// v1.0" root of every level but Patterns (Patterns has no v1.0 root).
const levelRoots = [
  ...canonicalStorybookLevels,
  ...canonicalStorybookLevels
    .filter((level) => level !== storybookPatternsV2Root)
    .map((level) => storybookBaselineRoot(level)),
];

// The page tree (TAXONOMY.md): every v2.0 Composite and Pattern sits at
// a node of it. catalog:sync computes the titles from V2_PLACEMENT_BY_ID;
// this catches a placement whose path names a page the tree does not have.
const v2PageTreePaths = storySortOrderPaths(storybookV2PageTreeOrder);
let v2PlacementCount = 0;
for (const entry of [...designSystemEntries, ...appEntries]) {
  checkV2Placement(entry);
}

function checkV2Placement(entry) {
  if (entry.version !== storybookNextVersion) {
    return;
  }
  if (entry.level !== "Composites" && entry.level !== "Patterns") {
    return;
  }
  v2PlacementCount += 1;
  const pagePath = entry.pathSegments.join("/");
  if (!v2PageTreePaths.has(pagePath)) {
    console.error(
      `v2.0 ${entry.level} "${entry.id}" is placed at "${pagePath}", which is not a node of the page tree (storybookV2PageTreeOrder in story-group-order.ts). Fix its V2_PLACEMENT_BY_ID entry.`
    );
    process.exitCode = 1;
  }
}

function checkColocatedStories(files, kindLabel) {
  let count = 0;
  const byId = new Map(
    [...appCoreEntries, ...desktopEntries].map((entry) => [
      entry.storyId,
      entry.storyTitle,
    ])
  );

  for (const storyFile of files) {
    const titleMatch = readFileSync(storyFile, "utf8").match(metaTitleRegex);
    const relativePath = path.relative(repoRoot, storyFile);
    const storyId = storyStem(storyFile);

    if (!titleMatch) {
      console.error(`Missing string-literal title in ${relativePath}`);
      process.exitCode = 1;
      continue;
    }

    count += 1;
    const title = titleMatch[1];
    const startsWithLevel = levelRoots.some((root) =>
      title.startsWith(`${root}/`)
    );

    if (!startsWithLevel) {
      console.error(
        `${kindLabel} story ${relativePath} has title "${title}" — must start with one of ${levelRoots.join(", ")}. See TAXONOMY.md.`
      );
      process.exitCode = 1;
      continue;
    }

    const expected = byId.get(storyId);
    if (expected && expected !== title) {
      console.error(
        `Title mismatch for ${kindLabel.toLowerCase()} story "${storyId}": expected "${expected}" (from taxonomy-classification.mjs), found "${title}" in ${relativePath}`
      );
      process.exitCode = 1;
    }
  }

  return count;
}

for (const entry of [...appCoreEntries, ...desktopEntries]) {
  checkV2Placement(entry);
}

const appCoreStoryCount = checkColocatedStories(
  collectAppCoreStoryFiles(),
  "App Core"
);
const desktopStoryCount = checkColocatedStories(
  collectDesktopStoryFiles(),
  "Desktop"
);

// PR #4814 review: every check above is keyed on storyId (the FILE stem), which
// is unique by construction, so none of them can see two DIFFERENT files
// claiming the same `meta.title`. That collision is silent and lossy in both
// directions: Storybook folds same-titled files into one sidebar/autodocs
// identity (one component becomes unreachable), and the catalog builder copies
// `storyTitle` verbatim, so the generated catalog gains duplicate storyTitle
// keys that any title -> component lookup resolves arbitrarily. Assert titles are
// unique across the whole catalog so the next one fails CI instead of shipping.
const sourcePathsByTitle = new Map();
for (const entry of [
  ...designSystemEntries,
  ...appEntries,
  ...appCoreEntries,
  ...desktopEntries,
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
      `Duplicate story title "${storyTitle}" claimed by ${sourcePaths.length} components: ${sourcePaths.join(", ")}. Story titles must be unique — give each a distinct "<Level>/<Group>/<Component>" title (see TAXONOMY.md) and re-run catalog:sync.`
    );
    process.exitCode = 1;
  }
}

// Three "Start Here" pages document the system rather than being part of it
// (see TAXONOMY.md) — assert they exist and are titled correctly, since
// nothing else here checks them.
for (const [storyId, expectedTitle] of [
  ["start-here-introduction", `${startHereRoot}/Introduction`],
  ["catalog", `${startHereRoot}/Catalog`],
  ["start-here-version-history", `${startHereRoot}/Version History`],
]) {
  const actualTitle = actualTitles.get(storyId) ?? null;
  if (actualTitle === null) {
    // Titles for ignored ids weren't recorded above; re-read directly.
    const filePath = storyPathsById.get(storyId);
    if (!filePath) {
      // Name the file to CREATE, not the bare id: the page may legally carry
      // any extension `.storybook/main.ts` indexes here, so list them rather
      // than asserting `.tsx` (review, ISS-10399).
      console.error(
        `Missing required Start Here page: ${storyId}.stories.{${storyExtensions.join(",")}}`
      );
      process.exitCode = 1;
      continue;
    }
    const fileName = path.relative(storiesDir, filePath);
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      console.error(`Unable to read required Start Here page: ${fileName}`);
      process.exitCode = 1;
      continue;
    }
    const titleMatch = source.match(metaTitleRegex);
    if (!titleMatch || titleMatch[1] !== expectedTitle) {
      console.error(
        `${fileName} must be titled "${expectedTitle}", found "${titleMatch?.[1] ?? "(no title)"}"`
      );
      process.exitCode = 1;
    }
  }
}

const surfacesV2TitleCount = checkV2Stories(surfacesV2Files, {
  root: storybookSurfacesV2Root,
  order: storybookSurfacesV2RootOrder,
  orderName: "storybookSurfacesV2RootOrder",
  dir: "stories/surfaces-v2/",
});
const foundationsV2TitleCount = checkV2Stories(foundationsV2Files, {
  root: storybookVersionedRoot("Foundations", storybookNextVersion),
  order: storybookLevelGroupOrder.Foundations.map((group) => group.name),
  orderName: "storybookLevelGroupOrder.Foundations",
  dir: "stories/foundations-v2/",
});
const patternsV2TitleCount = checkV2Stories(patternsV2Files, {
  root: storybookPatternsV2Root,
  order: storybookPatternsV2Order,
  orderName: "storybookPatternsV2Order",
  dir: "stories/patterns-v2/",
});
const compositesV2PageCount = checkV2Stories(compositesV2Files, {
  root: storybookVersionedRoot("Composites", storybookNextVersion),
  order: storybookCompositesV2Order,
  orderName: "storybookCompositesV2Order",
  dir: "stories/composites-v2/",
  labelled: true,
});

// Every entry in the page tree lists Default, then the shared states in
// one fixed order, then everything else (ISS-12332; story-state-order.mjs).
const stateOrder = checkStateOrder([
  ...storyFiles,
  ...collectAppCoreStoryFiles(),
  ...collectDesktopStoryFiles(),
]);
for (const message of stateOrder.errors) {
  console.error(message);
  process.exitCode = 1;
}

// ISS-12610: every story file's meta carries exactly one lifecycle tag, and
// the tag agrees with the root: Deprecated stories, and only they, sit under a
// "<Level> v1.0" root. The tag is written in the file's own meta; the static
// indexer drops tags that arrive through a spread.
const lifecycleCount = checkLifecycleTags([
  ...storyFiles,
  ...collectAppCoreStoryFiles(),
  ...collectDesktopStoryFiles(),
]);

function checkLifecycleTags(files) {
  let count = 0;
  for (const storyFile of files) {
    const source = readFileSync(storyFile, "utf8");
    const titleMatch = source.match(metaTitleRegex);
    if (!titleMatch) {
      continue;
    }
    count += 1;
    const relativePath = path.relative(repoRoot, storyFile);
    const meta = source.match(lifecycleMetaRegex)?.[0] ?? "";
    const tags = [
      ...(meta.match(lifecycleTagsRegex)?.[1] ?? "").matchAll(
        lifecycleQuotedRegex
      ),
    ].map((match) => match[1]);
    const lifecycle = tags.filter((tag) =>
      storybookLifecycleTags.includes(tag)
    );
    if (lifecycle.length !== 1) {
      console.error(
        `${relativePath} must carry exactly one lifecycle tag in its meta (${storybookLifecycleTags.join(", ")}); found ${lifecycle.length ? lifecycle.join(", ") : "none"}. See TAXONOMY.md, "Lifecycle".`
      );
      process.exitCode = 1;
      continue;
    }
    const root = titleMatch[1].split("/")[0];
    const isBaselineRoot = root.endsWith(` ${storybookBaselineVersion}`);
    const isDeprecated = lifecycle[0] === StorybookLifecycle.Deprecated;
    if (isBaselineRoot !== isDeprecated) {
      console.error(
        `${relativePath} is tagged "${lifecycle[0]}" under "${root}": Deprecated stories, and only they, sit under a "<Level> ${storybookBaselineVersion}" root. See TAXONOMY.md, "Lifecycle".`
      );
      process.exitCode = 1;
    }
  }
  return count;
}

if (!process.exitCode) {
  console.log(
    `Validated ${expectedTitles.size} cataloged story titles against ${actualTitles.size} story files, plus ${appCoreStoryCount} colocated App Core stories, ${desktopStoryCount} desktop stories, ${sourcePathsByTitle.size} unique story titles, ${foundationsV2TitleCount} Foundations titles, ${v2PlacementCount} page-tree placements, ${compositesV2PageCount} Composites pages and copies, ${patternsV2TitleCount} Patterns titles, ${surfacesV2TitleCount} Surfaces titles, the state order of ${stateOrder.checked} page-tree entries, and the lifecycle tag of ${lifecycleCount} story files.`
  );
}

// Every title under a v2 root (Surfaces, Patterns) starts with that
// root, is at most four levels deep (ISS-11361, Nesting depth: never 5), is
// unique, and is listed in the root's order. A title missing from the order
// would still render, but sorted alphabetically after the listed ones.
// A labelled root (Composites) names a component under its page, so its
// titles are "<ordered path>/<Name>" and may be five levels deep.
function checkV2Stories(files, { root, order, orderName, dir, labelled }) {
  const orderedPaths = new Set();
  const collect = (nodes, prefix) => {
    let last = null;
    for (const node of nodes) {
      if (typeof node === "string") {
        last = [...prefix, node];
        orderedPaths.add(last.join("/"));
      } else if (last) {
        collect(node, last);
      }
    }
  };
  collect(order, []);

  const seen = new Map();
  for (const storyFile of files) {
    const relativePath = path.relative(repoRoot, storyFile);
    const titleMatch = readFileSync(storyFile, "utf8").match(metaTitleRegex);
    if (!titleMatch) {
      console.error(`Missing string-literal title in ${relativePath}`);
      process.exitCode = 1;
      continue;
    }

    const title = titleMatch[1];
    const rootPrefix = `${root}/`;
    if (!title.startsWith(rootPrefix)) {
      console.error(
        `${relativePath} has title "${title}" — every story under ${dir} must start with "${rootPrefix}".`
      );
      process.exitCode = 1;
      continue;
    }

    const maxDepth = labelled ? 5 : 4;
    if (title.split("/").length > maxDepth) {
      console.error(
        `${relativePath} has title "${title}" — more than ${maxDepth} levels deep (ISS-11361; TAXONOMY.md, "The page tree").`
      );
      process.exitCode = 1;
    }

    const titlePath = title.slice(rootPrefix.length);
    const pagePath = titlePath.split("/").slice(0, -1).join("/");
    if (
      !(orderedPaths.has(titlePath) || (labelled && orderedPaths.has(pagePath)))
    ) {
      console.error(
        `${relativePath} has title "${title}", which is not listed in ${orderName} (story-group-order.ts). Add it there and regenerate preview.tsx.`
      );
      process.exitCode = 1;
    }

    const earlier = seen.get(title);
    if (earlier) {
      console.error(
        `Duplicate ${root} title "${title}" in ${earlier} and ${relativePath}.`
      );
      process.exitCode = 1;
    }
    seen.set(title, relativePath);
  }

  return seen.size;
}
