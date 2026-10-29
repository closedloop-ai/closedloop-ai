import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  storybookBaselineRoot,
  storybookBaselineVersion,
  storybookLifecycleTags,
  storybookNextVersion,
  storybookReleaseOfLifecycle,
  storybookVersionedLevels,
  storybookVersionedRoot,
} from "../story-group-order.ts";
import {
  storybookMainPath,
  storyExtensionsForDirectory,
  storyFileExtensions,
  storyFileSuffixPattern,
} from "./story-globs.mjs";
import {
  APP_CORE_PRIMITIVE_ELEMENT_KIND,
  APP_CORE_RECLASSIFY_LINES,
  APP_CORE_RECLASSIFY_PATTERN,
  DESKTOP_DOMAIN,
  DOMAIN_OVERRIDE_BY_ID,
  DS_SINGLE_ELEMENT_OVERRIDE,
  designSystemGroup,
  domainForFeature,
  resolveAgentsPackageDomain,
  SURFACE_OVERRIDE_BY_ID,
  V2_PLACEMENT_BY_ID,
} from "./taxonomy-classification.mjs";

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

const appPackageRoot = path.join(repoRoot, "packages/app");
const desktopComponentsRoot = path.join(
  repoRoot,
  "apps/desktop/src/renderer/components"
);

// See TAXONOMY.md. "Start Here" documents the system rather than being part
// of it and is not one of the five levels. Patterns has only a v2.0 root.
export const canonicalStorybookLevels = [
  "Foundations",
  "Primitives",
  "Composites",
  "Patterns",
  "Surfaces",
];
export const startHereRoot = "Start Here";

const designSystemOverridesById = {
  "grid-table": {
    note: "Superseded by Grid Table V2, which is the champion Gridview implementation (ISS-9289). Compose Grid Table V2 on new surfaces; the modules still rendering this one migrate on their own tickets. Its column primitives (GridTableColumn, ROW_ACTIONS_COLUMN) remain canonical and are shared by both.",
  },
  // A variant, not a second champion: reached only through Inline Scalar
  // Cell's `type="date"` (INLINE_EDIT_LEDGER, ISS-9347), so its stories live
  // on that entry and this one points there instead of carrying a duplicate.
  "inline-date-cell": {
    note: 'The date variant of Inline Scalar Cell, reached through type="date". Its stories are on Composites/Shared/Artifact List/Inline Scalar Cell: Dates, Retained Date Save Failure and Date Write Rejects.',
  },
  resizable: {
    label: "Resizable Panel Group",
  },
};

// Generic (not feature-bound) primitives that live in packages/app rather
// than packages/design-system, cataloged the same as a design-system entry
// because what they ARE doesn't depend on where the file sits (TAXONOMY.md,
// "Where the code lives does not matter"). Most use the derived v1 placement;
// entries with a current dedicated story supply explicit placement metadata.
const appComponentSurfaces = [
  {
    id: "confirmation-dialog",
    sourcePath: "packages/app/shared/components/confirmation-dialog.tsx",
    group: "Overlays",
  },
  {
    id: "delete-confirmation-dialog",
    sourcePath: "packages/app/shared/components/delete-confirmation-dialog.tsx",
    group: "Overlays",
  },
  {
    id: "page-loading-spinner",
    sourcePath: "packages/app/shared/components/page-loading-spinner.tsx",
    group: "Feedback & Status",
  },
  {
    id: "list-surface-toolbar-v2",
    label: "Filtering and Sorting Model",
    sourcePath: "packages/app/shared/components/list-surface-toolbar-v2.tsx",
    level: "Composites",
    group: "Shared/Artifact List",
    storyId: "filtering-and-sorting-model",
    storyTitle: "Composites/Shared/Artifact List/Filtering and Sorting Model",
  },
  // SidebarNavLinkItem and SidebarSectionHeader are named exports inside the
  // shared packages/design-system/components/ui/sidebar.tsx file rather than
  // their own file, so buildDesignSystemEntries()'s file-stem walk never
  // produces an entry for either id — the same "no entry from the walk" gap
  // this table exists to cover, just from a design-system file instead of a
  // packages/app one. Both already have their own story.
  {
    id: "sidebar-nav-link-item",
    sourcePath: "packages/design-system/components/ui/sidebar.tsx",
    group: "Navigation",
  },
  {
    id: "sidebar-section-header",
    sourcePath: "packages/design-system/components/ui/sidebar.tsx",
    group: "Navigation",
  },
];

// `empty` is the private base `empty-state` composes; `pagination` is the
// private base `table-pagination` composes. The three grid-table-v2 modules
// are render functions only `grid-table-v2.tsx` calls (ISS-12910). None is
// cataloged on its own.
const designSystemPrivateSurfaceIds = new Set([
  "empty",
  "pagination",
  "grid-table-v2-grouped-rows",
  "grid-table-v2-row",
  "grid-table-v2-windowed-rows",
]);

const wordOverrides = {
  api: "API",
  cli: "CLI",
  db: "DB",
  dnd: "DnD",
  github: "GitHub",
  id: "ID",
  json: "JSON",
  jsonl: "JSONL",
  kpi: "KPI",
  loc: "LOC",
  mdx: "MDX",
  otp: "OTP",
  pr: "PR",
  prd: "PRD",
  prds: "PRDs",
  repo: "Repo",
  repos: "Repos",
  rum: "RUM",
  yaml: "YAML",
};

const camelCaseBoundaryRegex = /([a-z0-9])([A-Z])/g;
const acronymBoundaryRegex = /([A-Z]+)([A-Z][a-z])/g;
const splitWordsRegex = /[-_\s]+/;
const uppercaseWordRegex = /^[A-Z0-9]+$/;
// Anchor on `const meta` so the match skips any fixture/metadata array whose
// nested `title:` would otherwise match first (mirrors validate-story-titles).
export const metaTitleRegex = /const meta\b[\s\S]*?\btitle:\s*"([^"]+)"/;
const metaStartRegex = /const meta\b/;
const metaEndRegex = /\n\}/;
const metaTagsRegex = /\btags:\s*\[([^\]]*)\]/;
const quotedTagRegex = /"([^"]+)"/g;
// Derived from `.storybook/main.ts`, never restated: a `.tsx`-only pattern here
// made a `.stories.ts` file invisible to catalog:sync AND validate:catalog while
// Storybook rendered and sidebar-listed it (review, PR #7510), and a
// hand-widened copy of the list diverges again the next time that config gains
// an extension (ISS-10399). This is the UNION across every glob, because it only
// has to recognize and strip the suffix a collected file already carries; which
// extensions are collectable UNDER A GIVEN ROOT is `storyExtensionsForDirectory`.
const storyFileSuffixRegex = storyFileSuffixPattern(storyFileExtensions());

function isStoryFileName(fileName) {
  return storyFileSuffixRegex.test(fileName);
}

/** A story file's id: its basename with the `.stories.<ext>` suffix removed. */
export function storyStem(fullPath) {
  return path.basename(fullPath).replace(storyFileSuffixRegex, "");
}
const dsAliasImportRegex =
  /@(?:repo|closedloop-ai)\/design-system\/components\/ui\/([a-z0-9-]+)/g;
// Fable review, PLN-2024 Phase B/C follow-up: the alias regex alone missed 71
// of 150 design-system components, which import siblings with a relative
// specifier (`from "./grid-table-v2-cell"`) instead of the `@repo/...` alias
// — `grid-table-v2.tsx` alone imports 7 siblings this way. Those components
// were landing as Primitives on a zero import count that was really just an
// unmatched import style, not zero reuse.
const relativeImportRegex = /from\s+["'](\.\.?\/[^"']+)["']/g;

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
      !isStoryFileName(dirent.name)
    ) {
      entries.push(toPosixPath(path.relative(repoRoot, fullPath)));
    }
  }

  return entries;
}

function titleCaseFromStem(stem) {
  return stem
    .replace(camelCaseBoundaryRegex, "$1 $2")
    .replace(acronymBoundaryRegex, "$1 $2")
    .split(splitWordsRegex)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      const override = wordOverrides[lower];

      if (override) {
        return override;
      }

      if (uppercaseWordRegex.test(part)) {
        return part;
      }

      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

function collectStoryIds() {
  // Fable review, PLN-2024 Phase B/C follow-up: this was a flat readdirSync,
  // invisible to anything under a subdirectory — including
  // stories/foundations/, where Motion already lives and where Colors/
  // Typography/Spacing/Radius are the planned follow-up. A story there was
  // reachable by Storybook's own glob (`../stories/**/*.stories.*`) but
  // untouched by catalog:sync or validate:catalog. walkStoryFiles already
  // recurses; reuse it instead of a second, narrower traversal.
  return new Set(collectRootStoryFiles().map(storyStem));
}

/**
 * The stories under `apps/storybook/stories`, at every extension `main.ts`
 * indexes there — five today, against the two its `packages/app` and
 * `apps/desktop` globs allow.
 */
export function collectRootStoryFiles() {
  return walkStoryFiles(
    storybookStoriesRoot,
    storyExtensionsForDirectory(storybookStoriesRoot)
  );
}

/**
 * Every story file under `dirPath` whose extension is in `acceptedExtensions`.
 *
 * The extension set is a REQUIRED argument rather than a default, so a caller
 * that forgets it fails loudly instead of silently inheriting a set that is
 * wrong for its root — the failure mode this walk already had, one layer down.
 */
export function walkStoryFiles(dirPath, acceptedExtensions) {
  return walkStoryFilesMatching(
    dirPath,
    storyFileSuffixPattern(acceptedExtensions)
  );
}

function walkStoryFilesMatching(dirPath, suffixPattern) {
  const files = [];

  for (const dirent of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...walkStoryFilesMatching(fullPath, suffixPattern));
      continue;
    }

    if (dirent.isFile() && suffixPattern.test(dirent.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

// Collect colocated stories under packages/app/<feature>/components/, matching
// the app-core stories globs in apps/storybook/.storybook/main.ts.
export function collectAppCoreStoryFiles(
  packageRoot = appPackageRoot,
  mainPath = storybookMainPath
) {
  const files = [];

  for (const dirent of readdirSync(packageRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }

    const featureDir = path.join(packageRoot, dirent.name);
    for (const componentsDir of [
      path.join(featureDir, "components"),
      // Versioned-slice case (settings/v2/components/): nested one level
      // deeper mid-migration.
      ...readdirSync(featureDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(featureDir, d.name, "components")),
    ]) {
      if (!isReadableDirectory(componentsDir)) {
        continue;
      }
      // Resolved for the directory actually WALKED, not for `packageRoot`. Two
      // `packages/app/*` globs can target different subtrees with different
      // extensions, and the package root's answer is the union of both — which
      // would collect, under `components/`, a file only a sibling glob indexes
      // (review, PR #8006). Resolved outside the existence check above for the
      // same reason `collectDesktopStoryFiles` resolves outside its catch.
      files.push(
        ...walkStoryFiles(
          componentsDir,
          storyExtensionsForDirectory(componentsDir, mainPath)
        )
      );
    }
  }

  return [...new Set(files)];
}

// Collect the Electron-boundary stories under apps/desktop, matching the
// third stories glob in apps/storybook/.storybook/main.ts.
export function collectDesktopStoryFiles(
  componentsRoot = desktopComponentsRoot,
  mainPath = storybookMainPath
) {
  // The extension set is resolved OUTSIDE the catch on purpose. That catch
  // exists for one thing — a checkout with no desktop renderer tree, where
  // `readdirSync` raises ENOENT — and `storyExtensionsForDirectory` throws
  // deliberately when the config covers nothing here. Letting the catch absorb
  // that throw would turn "the desktop glob was renamed, or main.ts is
  // unreadable" into "there are no desktop stories", which then rewrites the
  // catalog with all of them silently gone: the same false green this module
  // exists to close, one layer over (review, ISS-10399).
  const acceptedExtensions = storyExtensionsForDirectory(
    componentsRoot,
    mainPath
  );

  if (!existsSync(componentsRoot)) {
    return [];
  }

  return walkStoryFiles(componentsRoot, acceptedExtensions);
}

/** Whether `dirPath` is a directory this process can enumerate. */
function isReadableDirectory(dirPath) {
  try {
    readdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

function designSystemImportCount(sourcePath, selfId) {
  const src = readFileSync(sourcePath, "utf8");
  const aliasMatches = [...src.matchAll(dsAliasImportRegex)].map((m) => m[1]);

  // A relative import only counts as a design-system import if it actually
  // resolves to a file under packages/design-system/components/ui/ — this
  // function also analyzes app-core/desktop sources, where a relative import
  // almost always points at a sibling in that OTHER package, not this one.
  const dsRootWithSep = `${designSystemRoot}${path.sep}`;
  const relativeMatches = [];
  for (const match of src.matchAll(relativeImportRegex)) {
    const resolved = path.resolve(path.dirname(sourcePath), match[1]);
    if (resolved.startsWith(dsRootWithSep) && existsSync(`${resolved}.tsx`)) {
      relativeMatches.push(path.basename(resolved));
    }
  }

  const matches = [...aliasMatches, ...relativeMatches].filter(
    (id) => id !== selfId
  );
  return new Set(matches).size;
}

// A flat level (Surfaces is flat per TAXONOMY.md) has an empty pathSegments,
// so the title is "<level>/<label>", not "<level>//<label>". Shared by every
// build*Entries function so the empty-segments case can't be fixed in one
// and left broken in the others.
function buildStoryTitle(level, pathSegments, label, version) {
  const root = version
    ? storybookVersionedRoot(level, version)
    : storybookBaselineRoot(level);
  return pathSegments.length
    ? `${root}/${pathSegments.join("/")}/${label}`
    : `${root}/${label}`;
}

// The release a story file's lifecycle tag puts it in (`tags: ["stable"]`;
// story-group-order.ts, ISS-12610): the current release for Stable, Preview
// and Experimental, undefined for the Deprecated v1.0 baseline and an
// untagged file. A Primitives or Composites story in the current release is
// titled under the plain level root, a v1.0 one under "<Level> v1.0". Only the
// meta object is read: a `tags` on one story further down belongs to that
// story, not the file.
export function storyFileVersion(source) {
  const start = source.search(metaStartRegex);
  if (start === -1) {
    return;
  }
  const fromMeta = source.slice(start);
  const end = fromMeta.search(metaEndRegex);
  const meta = end === -1 ? fromMeta : fromMeta.slice(0, end);
  const tags = meta.match(metaTagsRegex)?.[1] ?? "";
  for (const [, tag] of tags.matchAll(quotedTagRegex)) {
    if (storybookLifecycleTags.includes(tag)) {
      const release = storybookReleaseOfLifecycle(tag);
      return release === storybookBaselineVersion ? undefined : release;
    }
  }
}

// A v2.0 Composite or Pattern sits in the page tree, not in its v1.0
// group: V2_PLACEMENT_BY_ID (taxonomy-classification.mjs) gives its level
// and path. A Composite is titled "<root>/<path>/<Label>"; a Pattern is the
// page's own layout, so its title is the page's path, "<root>/<path>".
// `storyVersion` is the story file's own tag, before entryVersion narrows it.
function placeV2Entry(id, storyVersion, entry) {
  if (storyVersion !== storybookNextVersion) {
    return entry;
  }
  const placement = V2_PLACEMENT_BY_ID[id];
  if (!placement) {
    if (entry.level === "Composites") {
      throw new Error(
        `Composite "${id}" (current release) has no place in the page tree. Add it to V2_PLACEMENT_BY_ID in taxonomy-classification.mjs (TAXONOMY.md, "The page tree").`
      );
    }
    return entry;
  }
  const root = storybookVersionedRoot(placement.level, storyVersion);
  const pathSegments = [...placement.path];
  const pagePath = `${root}/${pathSegments.join("/")}`;
  return {
    ...entry,
    level: placement.level,
    pathSegments,
    version: storyVersion,
    storyTitle:
      placement.level === "Patterns" ? pagePath : `${pagePath}/${entry.label}`,
  };
}

// The version an entry is titled under: a later release's tag on a level
// that has versioned roots, else undefined (the level's own v1.0 root).
function entryVersion(level, version) {
  return version && storybookVersionedLevels.includes(level)
    ? version
    : undefined;
}

function rootStoryVersions() {
  return new Map(
    collectRootStoryFiles().map((storyPath) => [
      storyStem(storyPath),
      storyFileVersion(readFileSync(storyPath, "utf8")),
    ])
  );
}

function buildDesignSystemEntries() {
  const availableStoryIds = collectStoryIds();
  const storyVersions = rootStoryVersions();
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
      // primitives/<name>.tsx is dropped when a root <name>.tsx supersedes it.
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
      const override = designSystemOverridesById[fileStem] ?? {};
      const classification = designSystemGroup(fileStem);

      if (!classification) {
        throw new Error(
          `No taxonomy classification for design-system component "${fileStem}" (${sourcePath}). Add it to taxonomy-classification.mjs.`
        );
      }

      const importCount = designSystemImportCount(
        path.join(repoRoot, sourcePath),
        fileStem
      );
      const level =
        (classification.kind === "domain" || importCount > 0) &&
        !DS_SINGLE_ELEMENT_OVERRIDE.has(fileStem)
          ? "Composites"
          : "Primitives";
      const label = override.label ?? titleCaseFromStem(fileStem);
      const version = entryVersion(level, storyVersions.get(fileStem));
      const pathSegments = classification.group.split("/");

      return placeV2Entry(fileStem, storyVersions.get(fileStem), {
        id: fileStem,
        label,
        sourcePath,
        level,
        pathSegments,
        storyId:
          override.storyStatus === "catalog-only" ||
          !availableStoryIds.has(fileStem)
            ? undefined
            : fileStem,
        storyStatus:
          override.storyStatus ??
          (availableStoryIds.has(fileStem) ? undefined : "catalog-only"),
        internal: override.internal,
        note: override.note,
        version,
        storyTitle: buildStoryTitle(level, pathSegments, label, version),
      });
    })
    .sort((left, right) => {
      const leftKey = `${left.level}/${left.pathSegments.join("/")}`;
      const rightKey = `${right.level}/${right.pathSegments.join("/")}`;

      if (leftKey !== rightKey) {
        return leftKey.localeCompare(rightKey);
      }

      return left.label.localeCompare(right.label);
    });
}

function renderCatalogSource({
  designSystemEntries,
  appEntries,
  appCoreEntries,
  desktopEntries,
}) {
  return `export const canonicalStorybookLevels = ${JSON.stringify(
    canonicalStorybookLevels
  )} as const;

export type StorybookCatalogLevel = (typeof canonicalStorybookLevels)[number];

export type StorybookCatalogEntry = {
  id: string;
  label: string;
  sourcePath: string;
  level: StorybookCatalogLevel;
  pathSegments: readonly string[];
  version?: string;
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

export const desktopComponentCatalog =
  ${JSON.stringify(desktopEntries, null, 2)} as const satisfies readonly StorybookCatalogEntry[];

export const storybookComponentCatalog = [
  ...designSystemComponentCatalog,
  ...appComponentCatalog,
  ...appCoreComponentCatalog,
  ...desktopComponentCatalog,
] as const satisfies readonly StorybookCatalogEntry[];

export function hasStory(entry: StorybookCatalogEntry) {
  return Boolean(entry.storyId) && !entry.internal;
}
`.trimEnd();
}

export function buildCatalogData() {
  const designSystemEntries = [
    ...buildDesignSystemEntries(),
    {
      id: "grid-table-v2-narrow-list",
      label: "Grid Table Grouped Sections",
      sourcePath: "packages/design-system/components/ui/grid-table-v2.tsx",
      level: "Composites",
      pathSegments: ["Shared", "Artifact List"],
      storyId: "grid-table-grouped-sections",
      version: "v2.0",
      storyTitle: buildStoryTitle(
        "Composites",
        ["Shared", "Artifact List"],
        "Grid Table Grouped Sections",
        "v2.0"
      ),
    },
    // The Figma Avatar (Nerys, 2026-10-22): `PersonAvatar`, the avatar every
    // person gets, titled Avatar (was "Person Avatar"), beside the v1.0
    // baseline entry `avatar.stories.tsx` keeps until the baseline is retired.
    {
      id: "avatar-primitive",
      label: "Avatar",
      sourcePath: "packages/design-system/components/ui/person-avatar.tsx",
      level: "Primitives",
      pathSegments: ["Data Display"],
      storyId: "avatar-primitive",
      version: "v2.0",
      storyTitle: buildStoryTitle(
        "Primitives",
        ["Data Display"],
        "Avatar",
        "v2.0"
      ),
    },
  ].sort((left, right) => {
    const leftKey = `${left.level}/${left.pathSegments.join("/")}`;
    const rightKey = `${right.level}/${right.pathSegments.join("/")}`;

    if (leftKey !== rightKey) {
      return leftKey.localeCompare(rightKey);
    }

    return left.label.localeCompare(right.label);
  });
  const appEntries = buildAppEntries();
  const appCoreEntries = buildFeatureEntries({
    storyFiles: collectAppCoreStoryFiles(),
    resolveDomain: (relativePath, id) => {
      if (DOMAIN_OVERRIDE_BY_ID[id]) {
        return DOMAIN_OVERRIDE_BY_ID[id];
      }
      const feature = relativePath.split("/")[2]; // packages/app/<feature>/...
      const domain = domainForFeature(feature);
      if (domain === "Agents") {
        return resolveAgentsPackageDomain(relativePath);
      }
      return [domain];
    },
  });
  const desktopEntries = buildFeatureEntries({
    storyFiles: collectDesktopStoryFiles(),
    resolveDomain: () => [DESKTOP_DOMAIN],
    // Every desktop renderer component is Electron-boundary-specific with no
    // web equivalent, so the whole surface is one domain (DESKTOP_DOMAIN in
    // taxonomy-classification.mjs) rather than something the App Core
    // import-count/line-count heuristic gets to classify. Without this, a
    // desktop story whose sibling `.tsx` happens to import no design-system
    // component and stays under the line threshold falls through that
    // heuristic to `Primitives/Data Display` instead of `Desktop Shell`
    // (PR #7280 review, whitlockk). No entry moves today — all 21 already land in
    // Desktop Shell — this closes the hole the next short wrapper would open.
    alwaysComposite: true,
  });

  return {
    designSystemEntries,
    appEntries,
    appCoreEntries,
    desktopEntries,
    source: renderCatalogSource({
      designSystemEntries,
      appEntries,
      appCoreEntries,
      desktopEntries,
    }),
  };
}

// Level + pathSegments for one App Core / desktop component. Split out of
// buildFeatureEntries so that function's own branching stays within biome's
// cognitive-complexity budget.
function classifyFeatureComponent({
  id,
  componentSourcePath,
  resolveDomain,
  relativePath,
  alwaysComposite,
}) {
  // Checked first: a Surface promotion overrides whatever level the import
  // graph would otherwise compute. Surfaces is a hand-curated list, not a
  // derived result (TAXONOMY.md) — see SURFACE_OVERRIDE_BY_ID.
  const surfaceOverride = SURFACE_OVERRIDE_BY_ID[id];
  if (surfaceOverride) {
    const [group, label] = Array.isArray(surfaceOverride)
      ? surfaceOverride
      : [undefined, surfaceOverride];
    return {
      level: "Surfaces",
      pathSegments: group ? [group] : [],
      label,
    };
  }

  if (alwaysComposite) {
    return {
      level: "Composites",
      pathSegments: resolveDomain(relativePath, id),
    };
  }

  const isPrimitiveOverride = APP_CORE_PRIMITIVE_ELEMENT_KIND[id];
  if (isPrimitiveOverride) {
    return {
      level: "Primitives",
      pathSegments: isPrimitiveOverride.split("/"),
    };
  }

  // Measure the component itself (sibling .tsx), not the story file — the
  // classification thresholds in taxonomy-classification.mjs were derived
  // against component source.
  const measuredPath = path.join(repoRoot, componentSourcePath);
  const hasSiblingComponent = existsSync(measuredPath);

  if (!hasSiblingComponent) {
    // Fable review, PLN-2024 Phase B/C follow-up: a story with no `.tsx`
    // matching its OWN filename either renders a component under a different
    // name (`sidebar-account-footer.stories.tsx` renders `Sidebar` from
    // `./Sidebar.tsx`) or is a genuine composite showcase for
    // several files (`branch-cell-primitives.stories.tsx`). Measuring the
    // story file's own line count/imports in this case was measuring the
    // wrong file and defaulted two real desktop composites to
    // Primitives/Data Display. Every actual primitive that lacks a
    // same-named sibling is already named in
    // APP_CORE_PRIMITIVE_ELEMENT_KIND above and returned before reaching
    // here, so the safe default for everything else that gets this far is
    // Composite.
    return {
      level: "Composites",
      pathSegments: resolveDomain(relativePath, id),
    };
  }

  const measuredSource = readFileSync(measuredPath, "utf8");
  const dsImports = designSystemImportCount(measuredPath, null);
  const lines = measuredSource.split("\n").length;
  const isComposite =
    dsImports > 0 ||
    lines > APP_CORE_RECLASSIFY_LINES ||
    APP_CORE_RECLASSIFY_PATTERN.test(id);

  return {
    level: isComposite ? "Composites" : "Primitives",
    pathSegments: isComposite
      ? resolveDomain(relativePath, id)
      : ["Data Display"], // rare fallback; every real case is in the override table above
  };
}

// Descriptive snapshot of the feature-slice stories that exist in
// packages/app or apps/desktop. Unlike the Design System catalog, this does
// not enforce that every component has a story — it mirrors the colocated
// stories as written, classified into Primitive/element-kind or
// Composite/domain per taxonomy-classification.mjs.
function buildFeatureEntries({ storyFiles, resolveDomain, alwaysComposite }) {
  const entries = [];

  for (const fullPath of storyFiles) {
    const source = readFileSync(fullPath, "utf8");
    const titleMatch = source.match(metaTitleRegex);
    if (!titleMatch) {
      continue;
    }

    // The title is COMPUTED here, not read from the file — this is the
    // classifier, so a story's own on-disk `title:` is only ever CHECKED
    // against this output (validate-story-titles.mjs), never trusted. The
    // label is generated the same mechanical way a design-system entry's is,
    // rather than parsed from whatever title a previous author hand-wrote,
    // so a story doesn't need an already-correct title to be classified
    // correctly.
    const id = storyStem(fullPath);
    const relativePath = toPosixPath(path.relative(repoRoot, fullPath));

    // A 1:1 story derives its source by swapping `.stories.<ext> → .tsx`. A
    // COMPOSITE story (one showcase for several component files, e.g.
    // branch-cell-primitives) has no matching single `.tsx`, so that swap
    // would point at a non-existent path — fall back to the story file
    // itself, which always exists and is a valid navigation reference.
    const componentSourcePath = relativePath.replace(
      storyFileSuffixRegex,
      ".tsx"
    );
    const sourcePath = existsSync(path.join(repoRoot, componentSourcePath))
      ? componentSourcePath
      : relativePath;

    const classification = classifyFeatureComponent({
      id,
      componentSourcePath,
      resolveDomain,
      relativePath,
      alwaysComposite,
    });
    const { level, pathSegments } = classification;
    // Same mechanical derivation a design-system entry's label gets, unless
    // the classifier supplied one (a Surface promotion's curated name, e.g.
    // "branch-comments-workspace" -> "Comments Workspace" rather than the
    // literal "Branch Comments Workspace").
    const label = classification.label ?? titleCaseFromStem(id);
    const storyVersion = storyFileVersion(source);
    const version = entryVersion(level, storyVersion);
    const storyTitle = buildStoryTitle(level, pathSegments, label, version);

    entries.push(
      placeV2Entry(id, storyVersion, {
        id,
        label,
        sourcePath,
        level,
        pathSegments,
        storyId: id,
        version,
        storyTitle,
      })
    );
  }

  return entries.sort((left, right) => {
    const leftKey = `${left.level}/${left.pathSegments.join("/")}`;
    const rightKey = `${right.level}/${right.pathSegments.join("/")}`;

    if (leftKey !== rightKey) {
      return leftKey.localeCompare(rightKey);
    }

    return left.label.localeCompare(right.label);
  });
}

function buildAppEntries() {
  const availableStoryIds = collectStoryIds();
  const storyVersions = rootStoryVersions();

  return appComponentSurfaces.map((entry) => {
    const { id, sourcePath, group } = entry;
    const label = entry.label ?? titleCaseFromStem(id);
    const pathSegments = group.split("/");
    const level = entry.level ?? "Primitives";
    const storyId = entry.storyId ?? id;
    const hasStory = availableStoryIds.has(storyId);
    const version = entryVersion(level, storyVersions.get(storyId));

    return {
      id,
      label,
      sourcePath,
      level,
      pathSegments,
      storyId: hasStory ? storyId : undefined,
      storyStatus: hasStory ? undefined : "catalog-only",
      version,
      storyTitle:
        entry.storyTitle ??
        buildStoryTitle(level, pathSegments, label, version),
    };
  });
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
