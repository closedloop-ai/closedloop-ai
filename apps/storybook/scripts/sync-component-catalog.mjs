import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const catalogOutputPath = path.join(
  repoRoot,
  "packages/design-system/storybook/component-catalog.ts"
);
const storybookStoriesRoot = path.join(repoRoot, "apps/storybook/stories");

const designSystemRoot = path.join(
  repoRoot,
  "packages/design-system/components/ui"
);

// Feature-slice ("App Core") stories live colocated next to their components in
// packages/app/<feature>/components/, mirroring the Storybook glob in main.ts.
const appPackageRoot = path.join(repoRoot, "packages/app");

// Desktop renderer stories, the third root `.storybook/main.ts` globs. The
// catalog does not carry entries for these, but the title rules apply to them
// exactly as much: they sit in the same four levels as everything else.
const desktopRendererRoot = path.join(
  repoRoot,
  "apps/desktop/src/renderer/components"
);

// The catalog's sections ARE the atomic levels. They used to be "Design System"
// and "App Core", which named where a component's code lived rather than what
// the component is — the exact split the taxonomy removed. A component moving
// between packages must not change how it is catalogued.
const canonicalStorybookRoots = [
  "Start Here",
  "Foundations",
  "Primitives",
  "Composites",
  "Surfaces",
];

// Sort order INSIDE a level: the element kinds in their reading order, then the
// product domains. Mirrors `.storybook/preview.tsx`'s storySort, so the catalog
// page and the sidebar present the same sequence.
const catalogGroupOrder = [
  "Actions",
  "Inputs",
  "Data Display",
  "Charts",
  "Content",
  "Layout",
  "Navigation",
  "Overlays",
  "Feedback & Status",
  "Agents",
  "Sessions",
  "Branches",
  "Documents",
  "Packs",
  "Compute",
  "Insights",
  "My Tasks",
  "Settings",
  "Onboarding",
  "Tags",
  "App Shell",
];

// Sub-groups within a domain. Only Sessions is big enough to have them.
const catalogSubGroupOrder = ["Listing", "Detail", "Trace"];

// The four surfaces with no story of their own, so there is no meta title to
// read. Titled here rather than derived, because a synthesized title is a
// decision and it should be visible.
const catalogOnlyTitlesById = {
  "donut-slice-textures": "Primitives/Charts/Donut Slice Textures",
  "filter-range-submenu": "Primitives/Inputs/Filter Range Submenu",
  "grid-table-card": "Primitives/Data Display/Grid Table Card",
  "workflow-stat-tile": "Primitives/Data Display/Workflow Stat Tile",
};

/** Every level a story title may start with. */
export const atomicLevels = new Set([
  "Foundations",
  "Primitives",
  "Composites",
  "Surfaces",
]);

// Category per surface id, mirroring the curated story titles. Root surfaces
// without an entry default to "Primitives"; composites must be listed here.

const designSystemOverridesById = {
  resizable: {
    label: "Resizable Panel Group",
  },

  // Support components: they exist to build one specific parent, not to be
  // reached for directly. Marking them keeps them out of the catalog's
  // browsable list (see `hasStory`) while leaving their stories in the sidebar,
  // so you can still inspect one without it reading as a component to compose
  // with. Derived rather than chosen: each is imported by another design-system
  // component and by no application code.
  "filter-range-submenu": {
    internal: true,
    note: "Submenu inside the table filter menu.",
  },
  "grid-table-card": {
    internal: true,
    note: "Card row rendered by GridTable in compact mode.",
  },
  // `table-grid-header-handles` matches the same derivation but is NOT marked.
  // It has its own story, and `validate-story-titles.mjs` requires every
  // design-system story to be cataloged, which marking it internal breaks. That
  // invariant is right: giving a component a story is presenting it for review,
  // which is the opposite of "do not reach for this". So a component is either
  // reviewable or internal, not both.
};

const appComponentSurfaces = [
  {
    id: "backend-mismatch-modal",
    sourcePath: "packages/app/compute/components/backend-mismatch-modal.tsx",
    category: "Overlays",
  },
  {
    id: "confirmation-dialog",
    sourcePath: "packages/app/shared/components/confirmation-dialog.tsx",
    category: "Overlays",
  },
  {
    id: "delete-confirmation-dialog",
    sourcePath: "packages/app/shared/components/delete-confirmation-dialog.tsx",
    category: "Overlays",
  },
  {
    id: "friendly-error-alert",
    sourcePath: "packages/app/shared/components/friendly-error-alert.tsx",
    category: "Feedback & Status",
  },
  {
    id: "page-loading-spinner",
    sourcePath: "packages/app/shared/components/page-loading-spinner.tsx",
    category: "Feedback & Status",
  },
];

const designSystemPrivateSurfaceIds = new Set(["empty", "pagination"]);

// Anchor on `const meta` so the match skips any fixture/metadata array whose
// nested `title:` would otherwise match first (mirrors validate-story-titles).
// The `\n  ` is load-bearing: it pins the match to a key at the meta object's
// OWN indentation. Without it the lazy scan takes the first `title:` anywhere
// after `const meta`, which a nested one shadows — and a component with a
// `title` prop puts exactly that in `args`. `AuthTransitionPanel` does, and its
// story reported its title as "Taking you to GitHub" rather than its real
// "App Core/Onboarding/Auth Transition Panel", so the catalog check failed on a
// story whose title was correct all along.
//
// Verified against all 335 story files in the repo: this and the previous
// pattern agree on 334, and differ only on that one, where this is right.
export const metaTitleRegex = /const meta\b[\s\S]*?\n {2}title:\s*"([^"]+)"/;
const storyFileSuffixRegex = /\.stories\.tsx$/;

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function walkTsxFiles(dirPath) {
  const entries = [];

  for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
    if (dirent.isDirectory() && dirent.name === "internal") {
      continue;
    }

    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...walkTsxFiles(fullPath));
      continue;
    }

    if (
      dirent.isFile() &&
      dirent.name.endsWith(".tsx") &&
      !dirent.name.endsWith(".test.tsx") &&
      !dirent.name.endsWith(".stories.tsx")
    ) {
      entries.push(toPosixPath(path.relative(repoRoot, fullPath)));
    }
  }

  return entries;
}

function collectStoryIds() {
  return new Set(
    readdirSync(storybookStoriesRoot, { withFileTypes: true })
      .filter(
        (dirent) => dirent.isFile() && dirent.name.endsWith(".stories.tsx")
      )
      .map((dirent) => path.basename(dirent.name, ".stories.tsx"))
  );
}

function walkStoryFiles(dirPath) {
  const files = [];

  for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...walkStoryFiles(fullPath));
      continue;
    }

    if (dirent.isFile() && dirent.name.endsWith(".stories.tsx")) {
      files.push(fullPath);
    }
  }

  return files;
}

// Collect colocated stories under packages/app/<feature>/components/, matching
// the third stories glob in apps/storybook/.storybook/main.ts.
/**
 * Every story file Storybook indexes, across all three glob roots in
 * `.storybook/main.ts`.
 *
 * `collectAppCoreStoryFiles` below covers only `packages/app`, and the catalog's
 * freshness check covers only the flat `apps/storybook/stories` directory. That
 * left 33 rendered stories (the desktop renderer, plus `stories/foundations/`
 * and `stories/surfaces/`) outside every title check: they could be titled
 * anything, or duplicate an existing title, and `validate:catalog` still passed.
 */
export function collectAllStoryFiles() {
  return [
    ...walkStoryFiles(storybookStoriesRoot),
    ...collectAppCoreStoryFiles(),
    ...walkStoryFiles(desktopRendererRoot),
  ];
}

export function collectAppCoreStoryFiles() {
  const files = [];

  for (const dirent of readdirSync(appPackageRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const componentsDir = path.join(appPackageRoot, dirent.name, "components");
    let componentsEntries;
    try {
      componentsEntries = readdirSync(componentsDir, { withFileTypes: true });
    } catch {
      // Feature slice without a components/ directory — skip.
      continue;
    }

    for (const entry of componentsEntries) {
      const fullPath = path.join(componentsDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkStoryFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".stories.tsx")) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Story title per file stem, across BOTH story roots.
 *
 * The catalog used to synthesize its titles from `designSystemCategoriesById`,
 * a category map maintained alongside the story files. That is two sources of
 * truth for the same fact, and they drifted: after the atomic retitle every one
 * of the 113 design-system entries disagreed with the story it points at.
 *
 * The story's `meta.title` is now the only source. The category map survives
 * only to place the four surfaces that have no story at all.
 */
let storyTitleIndexCache;
function storyTitleIndex() {
  if (storyTitleIndexCache) {
    return storyTitleIndexCache;
  }

  const index = new Map();
  // Scoped to `apps/storybook/stories` ONLY. The index is keyed by file stem,
  // and a design-system component can share a stem with an unrelated colocated
  // one (`status-badge`, `favorite-button` both exist in each root). Including
  // both roots let the colocated title overwrite the design-system one and gave
  // two different components the same catalog title. Colocated stories never
  // need this map: `buildAppCoreEntries` reads each file's title directly.
  const files = walkStoryFiles(storybookStoriesRoot);

  for (const fullPath of files) {
    const stem = path.basename(fullPath, ".stories.tsx");
    const titleMatch = readFileSync(fullPath, "utf8").match(metaTitleRegex);
    if (titleMatch) {
      index.set(stem, titleMatch[1]);
    }
  }

  storyTitleIndexCache = index;
  return index;
}

/**
 * Split a story title into the shape the catalog stores. `label` is the leaf,
 * `section` the atomic level, `pathSegments` everything between — so
 * "Composites/Sessions/Listing/Sessions Table" yields section "Composites",
 * pathSegments ["Sessions", "Listing"], label "Sessions Table".
 */
function splitStoryTitle(storyTitle, sourceDescription) {
  const segments = storyTitle.split("/");
  const section = segments[0];

  if (!atomicLevels.has(section)) {
    throw new Error(
      `${sourceDescription} has title "${storyTitle}", which does not start with one of ${[...atomicLevels].join(", ")}. See apps/storybook/TAXONOMY.md.`
    );
  }

  if (segments.length < 2) {
    throw new Error(
      `${sourceDescription} has title "${storyTitle}" with no component name after the level.`
    );
  }

  // An empty segment means a stray or doubled slash ("Composites/Agents/" or
  // "Composites//Foo"). Left alone these produce an entry with a blank label or
  // a blank path segment, which reads as a nameless row in the catalog rather
  // than as an error.
  const blank = segments.findIndex((segment) => segment.trim() === "");
  if (blank !== -1) {
    throw new Error(
      `${sourceDescription} has title "${storyTitle}" with an empty segment at position ${blank}. Check for a doubled or trailing slash.`
    );
  }

  return {
    section,
    pathSegments: segments.slice(1, -1),
    label: segments.at(-1),
    storyTitle,
  };
}

function buildDesignSystemEntries() {
  const allEntries = walkTsxFiles(designSystemRoot);
  const rootSurfaceNames = new Set(
    allEntries
      .filter((sourcePath) => {
        const relativePath = sourcePath.replace(
          "packages/design-system/components/ui/",
          ""
        );
        return !relativePath.includes("/");
      })
      .map((sourcePath) => path.basename(sourcePath, ".tsx"))
  );

  return allEntries
    .filter((sourcePath) => {
      const fileStem = path.basename(sourcePath, ".tsx");
      return !designSystemPrivateSurfaceIds.has(fileStem);
    })
    .filter((sourcePath) => {
      const fileStem = path.basename(sourcePath, ".tsx");
      const relativePath = sourcePath.replace(
        "packages/design-system/components/ui/",
        ""
      );

      if (!relativePath.startsWith("primitives/")) {
        return true;
      }

      return !rootSurfaceNames.has(fileStem);
    })
    .map((sourcePath) => {
      const fileStem = path.basename(sourcePath, ".tsx");
      const relativePath = sourcePath.replace(
        "packages/design-system/components/ui/",
        ""
      );
      const override = designSystemOverridesById[fileStem] ?? {};
      const hasStory =
        override.storyStatus !== "catalog-only" &&
        storyTitleIndex().has(fileStem);
      const storyTitle = hasStory
        ? storyTitleIndex().get(fileStem)
        : catalogOnlyTitlesById[fileStem];

      if (!storyTitle) {
        throw new Error(
          `"${fileStem}" (${relativePath}) has no story and no entry in catalogOnlyTitlesById. Give it a story, or title it there.`
        );
      }

      const split = splitStoryTitle(
        storyTitle,
        `${fileStem} (${relativePath})`
      );

      return {
        id: fileStem,
        label: override.label ?? split.label,
        sourcePath,
        section: split.section,
        pathSegments: split.pathSegments,
        storyId: hasStory ? fileStem : undefined,
        storyStatus: hasStory ? undefined : "catalog-only",
        internal: override.internal,
        note: override.note,
        storyTitle: split.storyTitle,
      };
    })
    .sort(compareCatalogEntries);
}

/**
 * Level first (Foundations before Primitives before Composites before
 * Surfaces), then group in the curated order, then the component name.
 */
function compareCatalogEntries(left, right) {
  const levelDelta =
    canonicalStorybookRoots.indexOf(left.section) -
    canonicalStorybookRoots.indexOf(right.section);
  if (levelDelta !== 0) {
    return levelDelta;
  }

  const leftGroup = catalogGroupOrder.indexOf(left.pathSegments[0]);
  const rightGroup = catalogGroupOrder.indexOf(right.pathSegments[0]);
  if (leftGroup !== rightGroup) {
    // An unlisted group sorts after every listed one rather than before.
    return (
      (leftGroup === -1 ? catalogGroupOrder.length : leftGroup) -
      (rightGroup === -1 ? catalogGroupOrder.length : rightGroup)
    );
  }

  // Sub-groups (only Sessions has them) follow the sidebar's curated order
  // rather than sorting alphabetically, so the catalog page and the sidebar
  // present Listing, Detail, Trace in the same sequence.
  const leftSub = catalogSubGroupOrder.indexOf(left.pathSegments[1]);
  const rightSub = catalogSubGroupOrder.indexOf(right.pathSegments[1]);
  if (leftSub !== rightSub) {
    return (
      (leftSub === -1 ? catalogSubGroupOrder.length : leftSub) -
      (rightSub === -1 ? catalogSubGroupOrder.length : rightSub)
    );
  }

  const pathDelta = left.pathSegments
    .join("/")
    .localeCompare(right.pathSegments.join("/"));
  if (pathDelta !== 0) {
    return pathDelta;
  }

  return left.label.localeCompare(right.label);
}

function renderCatalogSource({
  designSystemEntries,
  appEntries,
  appCoreEntries,
}) {
  return `export const canonicalStorybookRoots = ${JSON.stringify(
    canonicalStorybookRoots
  )} as const;

export type StorybookCatalogSection = Exclude<
  (typeof canonicalStorybookRoots)[number],
  "Start Here"
>;

export type StorybookCatalogEntry = {
  id: string;
  label: string;
  sourcePath: string;
  section: StorybookCatalogSection;
  pathSegments: readonly string[];
  storyTitle: string;
  storyId?: string;
  storyStatus?: "catalog-only";
  internal?: boolean;
  note?: string;
};

export const designSystemComponentCatalog =
  ${JSON.stringify(designSystemEntries, null, 2)} as const satisfies readonly StorybookCatalogEntry[];

export const appComponentCatalog =
  ${JSON.stringify(appEntries, null, 2)} as const satisfies readonly StorybookCatalogEntry[];

export const appCoreComponentCatalog =
  ${JSON.stringify(appCoreEntries, null, 2)} as const satisfies readonly StorybookCatalogEntry[];

export const storybookComponentCatalog = [
  ...designSystemComponentCatalog,
  ...appComponentCatalog,
  ...appCoreComponentCatalog,
] as const satisfies readonly StorybookCatalogEntry[];

export function hasStory(entry: StorybookCatalogEntry) {
  return Boolean(entry.storyId) && !entry.internal;
}
`.trimEnd();
}

export function buildCatalogData() {
  const designSystemEntries = buildDesignSystemEntries();
  const appEntries = buildAppEntries();
  const appCoreEntries = buildAppCoreEntries();

  return {
    designSystemEntries,
    appEntries,
    appCoreEntries,
    source: renderCatalogSource({
      designSystemEntries,
      appEntries,
      appCoreEntries,
    }),
  };
}

// Descriptive snapshot of the feature-slice ("App Core") stories that exist in
// packages/app. Unlike the Design System catalog, this does not enforce that
// every component has a story — it mirrors the colocated stories as written.
function buildAppCoreEntries() {
  const entries = [];

  for (const fullPath of collectAppCoreStoryFiles()) {
    const source = readFileSync(fullPath, "utf8");
    const titleMatch = source.match(metaTitleRegex);
    if (!titleMatch) {
      continue;
    }

    const storyTitle = titleMatch[1];
    const relativePath = toPosixPath(path.relative(repoRoot, fullPath));
    // Every colocated story is catalogued now. The old gate skipped anything
    // not prefixed "App Core/", which after the retitle would have silently
    // dropped all 184 of them from the catalog while they kept rendering in
    // Storybook. `validate:catalog` asserts the prefix instead, so a bad title
    // fails loudly rather than disappearing.
    const { section, pathSegments, label } = splitStoryTitle(
      storyTitle,
      relativePath
    );

    // A 1:1 story derives its source by swapping `.stories.tsx → .tsx`. A
    // COMPOSITE story (one showcase for several component files, e.g.
    // branch-cell-primitives) has no matching single `.tsx`, so that swap would
    // point at a non-existent path — fall back to the story file itself, which
    // always exists and is a valid navigation reference.
    const componentSourcePath = relativePath.replace(
      storyFileSuffixRegex,
      ".tsx"
    );
    const sourcePath = existsSync(path.join(repoRoot, componentSourcePath))
      ? componentSourcePath
      : relativePath;

    entries.push({
      id: path.basename(fullPath, ".stories.tsx"),
      label,
      sourcePath,
      section,
      pathSegments,
      storyId: path.basename(fullPath, ".stories.tsx"),
      storyTitle,
    });
  }

  return entries.sort(compareCatalogEntries);
}

function buildAppEntries() {
  const availableStoryIds = collectStoryIds();

  return appComponentSurfaces
    .map(({ id, sourcePath }) => {
      const hasStory = availableStoryIds.has(id);
      const storyTitle = hasStory
        ? storyTitleIndex().get(id)
        : catalogOnlyTitlesById[id];

      if (!storyTitle) {
        throw new Error(
          `App surface "${id}" (${sourcePath}) has no readable story title and no catalogOnlyTitlesById entry.`
        );
      }

      const split = splitStoryTitle(storyTitle, `${id} (${sourcePath})`);

      return {
        id,
        label: split.label,
        sourcePath,
        section: split.section,
        pathSegments: split.pathSegments,
        storyId: hasStory ? id : undefined,
        storyStatus: hasStory ? undefined : "catalog-only",
        storyTitle: split.storyTitle,
      };
    })
    .sort(compareCatalogEntries);
}

function syncCatalogFile() {
  const { source } = buildCatalogData();
  writeFileSync(catalogOutputPath, `${source}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const currentSource = readFileSync(catalogOutputPath, "utf8");
  const { source } = buildCatalogData();

  if (process.argv.includes("--check")) {
    if (`${source}\n` !== currentSource) {
      console.error(
        "packages/design-system/storybook/component-catalog.ts is out of date."
      );
      process.exitCode = 1;
    }
  } else {
    syncCatalogFile();
  }
}
