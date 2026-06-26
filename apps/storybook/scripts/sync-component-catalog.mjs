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

const canonicalStorybookRoots = ["Catalog", "Design System", "App Core"];

const designSystemCategoryOrder = [
  "Primitives",
  "Layout",
  "Navigation & Shell",
  "Data Display",
  "Activity & Monitoring",
  "Documents & Conversation",
  "Configuration & Admin",
  "Catalog & Integrations",
];

// Category per surface id, mirroring the curated story titles. Root surfaces
// without an entry default to "Primitives"; composites must be listed here.
const designSystemCategoriesById = {
  "activity-heatmap": "Data Display/Data Visualization",
  "analytics-range-toggle": "Data Display",
  avatar: "Data Display",
  badge: "Data Display",
  breadcrumb: "Navigation & Shell",
  card: "Layout",
  chart: "Data Display",
  "collapsed-comment-row": "Documents & Conversation",
  "comment-action-menu": "Documents & Conversation",
  "comment-composer": "Documents & Conversation",
  "comment-thread": "Documents & Conversation",
  "comment-thread-action-footer": "Documents & Conversation",
  "conversation-transcript": "Documents & Conversation",
  "data-table": "Data Display",
  "donut-chart": "Data Display/Data Visualization",
  "feed-rail": "Documents & Conversation",
  graph: "Data Display/Data Visualization",
  "grid-table": "Data Display",
  "inline-edit-editor-shell": "Documents & Conversation",
  "interactive-metric-card": "Data Display",
  "judge-result-card": "Documents & Conversation",
  "line-chart": "Data Display/Data Visualization",
  "mode-toggle": "Navigation & Shell",
  "navigation-menu": "Navigation & Shell",
  "priority-badge": "Data Display",
  "priority-icon": "Data Display",
  "ranked-bar": "Data Display/Data Visualization",
  resizable: "Layout",
  "sankey-graph": "Data Display/Data Visualization",
  "scroll-area": "Layout",
  "section-header": "Layout",
  "segmented-bar": "Data Display/Data Visualization",
  separator: "Layout",
  sidebar: "Navigation & Shell",
  "sidebar-collapsible-section": "Navigation & Shell",
  "sidebar-favorites-group": "Navigation & Shell",
  "sidebar-tree-nav": "Navigation & Shell",
  sparkline: "Data Display/Data Visualization",
  "status-icon": "Data Display",
  "status-metadata-section": "Configuration & Admin",
  "status-percentage-icon": "Data Display",
  table: "Data Display",
  "table-filter-menu": "Data Display",
  "table-pagination": "Data Display",
  "table-placeholder-actions": "Data Display",
  tabs: "Navigation & Shell",
  "theme-submenu": "Navigation & Shell",
  "version-actions-toolbar": "Documents & Conversation",
  "workflow-stat-tile": "Data Display/Data Visualization",
};

const designSystemOverridesById = {
  resizable: {
    label: "Resizable Panel Group",
  },
};

const appComponentSurfaces = [
  {
    id: "backend-mismatch-modal",
    sourcePath: "packages/app/compute/components/backend-mismatch-modal.tsx",
    category: "Primitives",
  },
  {
    id: "confirmation-dialog",
    sourcePath: "packages/app/shared/components/confirmation-dialog.tsx",
    category: "Primitives",
  },
  {
    id: "delete-confirmation-dialog",
    sourcePath: "packages/app/shared/components/delete-confirmation-dialog.tsx",
    category: "Primitives",
  },
  {
    id: "friendly-error-alert",
    sourcePath: "packages/app/shared/components/friendly-error-alert.tsx",
    category: "Primitives",
  },
  {
    id: "page-loading-spinner",
    sourcePath: "packages/app/shared/components/page-loading-spinner.tsx",
    category: "Primitives",
  },
];

const designSystemPrivateSurfaceIds = new Set(["empty", "pagination"]);

const wordOverrides = {
  api: "API",
  dnd: "DnD",
  github: "GitHub",
  id: "ID",
  json: "JSON",
  jsonl: "JSONL",
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

function buildDesignSystemEntries() {
  const availableStoryIds = collectStoryIds();
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
      let category = designSystemCategoriesById[fileStem] ?? "Primitives";
      if (relativePath.startsWith("layout/")) {
        category = "Layout";
      } else if (relativePath.startsWith("composites/")) {
        category = designSystemCategoriesById[fileStem] ?? "";
      }

      if (!(category || override.internal)) {
        throw new Error(`Missing design system category for "${fileStem}"`);
      }

      const label = override.label ?? titleCaseFromStem(fileStem);

      return {
        id: fileStem,
        label,
        sourcePath,
        section: "Design System",
        pathSegments: category.split("/"),
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
        storyTitle: `Design System/${category}/${label}`,
      };
    })
    .sort((left, right) => {
      const leftCategoryIndex = designSystemCategoryOrder.indexOf(
        left.pathSegments[0]
      );
      const rightCategoryIndex = designSystemCategoryOrder.indexOf(
        right.pathSegments[0]
      );

      if (leftCategoryIndex !== rightCategoryIndex) {
        return leftCategoryIndex - rightCategoryIndex;
      }

      return left.label.localeCompare(right.label);
    });
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
  "Catalog"
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
    if (!storyTitle.startsWith("App Core/")) {
      continue;
    }

    const segments = storyTitle.split("/");
    const label = segments.at(-1);
    const pathSegments = segments.slice(1, -1);
    const relativePath = toPosixPath(path.relative(repoRoot, fullPath));

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
      section: "App Core",
      pathSegments,
      storyId: path.basename(fullPath, ".stories.tsx"),
      storyTitle,
    });
  }

  return entries.sort((left, right) => {
    const leftKey = left.pathSegments.join("/");
    const rightKey = right.pathSegments.join("/");

    if (leftKey !== rightKey) {
      return leftKey.localeCompare(rightKey);
    }

    return left.label.localeCompare(right.label);
  });
}

function buildAppEntries() {
  const availableStoryIds = collectStoryIds();

  return appComponentSurfaces.map(({ id, sourcePath, category }) => {
    const label = titleCaseFromStem(id);

    return {
      id,
      label,
      sourcePath,
      section: "Design System",
      pathSegments: category.split("/"),
      storyId: availableStoryIds.has(id) ? id : undefined,
      storyStatus: availableStoryIds.has(id) ? undefined : "catalog-only",
      storyTitle: `Design System/${category}/${label}`,
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
