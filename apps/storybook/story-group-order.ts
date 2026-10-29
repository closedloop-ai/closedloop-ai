// The deliberate sidebar order of every group inside each of the four
// taxonomy levels (see TAXONOMY.md). ONE declaration, consumed twice: the
// Storybook sidebar builds `options.storySort.order` from it in
// `.storybook/preview.tsx`, and the Start Here/Catalog page sorts its own
// sections by it in `stories/catalog.stories.tsx`.
//
// Before PR #7280's review (whitlockk, davetho) these were two separate facts:
// `preview.tsx` carried an order that listed only the Composites FEATURE
// domains, and the Catalog page did not order groups at all — it preserved
// the generated arrays' lexical order, so the page taught Charts before
// Inputs and Documents before Agents while the sidebar taught the opposite.
// A group missing from this file still renders; it just sorts after
// everything listed, in both places, which is the documented fallback.

export type StorybookGroupOrderEntry = {
  readonly name: string;
  readonly subgroups?: readonly string[];
};

// Element kinds, in the order the taxonomy teaches them (TAXONOMY.md,
// "Element kinds"). Primitives and Composites share this vocabulary — a
// design-system Composite is grouped by element kind exactly as a Primitive
// is — so both levels order it the same way.
const ELEMENT_KIND_ORDER: readonly StorybookGroupOrderEntry[] = [
  { name: "Actions" },
  { name: "Inputs" },
  { name: "Data Display", subgroups: ["Tables"] },
  { name: "Charts" },
  { name: "Content" },
  { name: "Layout" },
  { name: "Navigation" },
  { name: "Overlays" },
  { name: "Feedback & Status" },
];

// Feature domains, alphabetical, with the sub-families of the one oversized
// domain spelled out. Sessions is its own domain rather than an Agents
// sub-family despite its code living under
// packages/app/agents/components/sessions/ — see TAXONOMY.md.
const FEATURE_DOMAIN_ORDER: readonly StorybookGroupOrderEntry[] = [
  { name: "Agents", subgroups: ["Detail", "Workspace", "General"] },
  { name: "App Shell" },
  { name: "Branches" },
  { name: "Compute" },
  { name: "Custom Fields" },
  { name: "Desktop Shell" },
  { name: "Diagnostics" },
  { name: "Documents" },
  { name: "Help" },
  { name: "Inbox" },
  { name: "Insights" },
  { name: "My Tasks" },
  { name: "Onboarding" },
  { name: "Organizations" },
  { name: "Packs" },
  { name: "Projects" },
  { name: "Search" },
  { name: "Session Limits" },
  { name: "Sessions" },
  { name: "Settings" },
  { name: "Tags" },
];

// "Start Here" documents the system rather than being one of its levels, so
// it is ordered here but is not a canonical level.
export const storybookStartHereGroupOrder: readonly StorybookGroupOrderEntry[] =
  [{ name: "Introduction" }, { name: "Catalog" }, { name: "Version History" }];

// Composites carries BOTH vocabularies: the generic element-kind groups (a
// design-system component that composes other design-system components) and
// the feature domains (anything bound to a product feature). The generic
// groups lead, in the same order Primitives teaches them, so the two levels
// read as the same shelf twice; the product domains follow.
export const storybookLevelGroupOrder: Readonly<
  Record<string, readonly StorybookGroupOrderEntry[]>
> = {
  Foundations: [
    { name: "Colors" },
    { name: "Typography" },
    { name: "Spacing" },
    { name: "Radius & Elevation" },
    { name: "Motion" },
  ],
  Primitives: ELEMENT_KIND_ORDER,
  Composites: [...ELEMENT_KIND_ORDER, ...FEATURE_DOMAIN_ORDER],
  // Grouped 2026-09-16 (Ottilie, today's walkthrough): a Surface is one
  // artifact type's list screen + single-artifact screen together, not a
  // flat list of unrelated pages — see SURFACE_OVERRIDE_BY_ID in
  // taxonomy-classification.mjs for the promotion rule this enforces.
  // Dashboard, Login, Settings and Onboarding are
  // deliberately absent: none are an artifact type with a list/detail pair,
  // so they stay flat and sort after the named groups. Data Sync Tab and
  // Withheld Section aren't Surfaces at all (un-promoted 2026-09-18, Mordecai,
  // storybook review) — they're Composites/Desktop Shell and
  // Composites/Diagnostics respectively, sections of a larger page rather
  // than pages of their own.
  Surfaces: [
    { name: "Sessions" },
    { name: "Branches" },
    { name: "Agents" },
    { name: "Packs" },
    { name: "Documents" },
    { name: "Projects" },
    { name: "PRDs" },
    { name: "Implementation Plans" },
  ],
};

// Rank of a group within its level: listed groups keep their declared order,
// an unlisted one sorts after every listed one (Storybook's own behavior for
// a group missing from `storySort.order`).
export function storybookGroupRank(level: string, groupName: string) {
  const groups = storybookLevelGroupOrder[level] ?? [];
  const index = groups.findIndex((group) => group.name === groupName);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// Rank of a subgroup path ("Tables", "Detail", …) within its group. Same
// unlisted-sorts-last rule.
export function storybookSubgroupRank(
  level: string,
  groupName: string,
  subgroupName: string
) {
  if (!subgroupName) {
    return -1;
  }

  const groups = storybookLevelGroupOrder[level] ?? [];
  const subgroups =
    groups.find((group) => group.name === groupName)?.subgroups ?? [];
  const index = subgroups.indexOf(subgroupName);
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

// `options.storySort.order` shape: a group name, optionally followed by an
// array of its ordered children.
export type StorySortOrderNode = string | readonly StorySortOrderNode[];

// Patterns: the page shells and page layouts Surfaces pages are
// built inside, with no content in them. It sorts directly before Surfaces
// v2.0 and follows the page tree (below), so a page's pattern sits at
// the same path as the page (operator request 2026-10-01, rules 2026-10-06).
export const storybookPatternsV2Root = "Patterns";

// Every story carries exactly one feature lifecycle tag (ISS-12610, Nerys,
// 2026-10-16), in Storybook's own vocabulary
// (https://storybook.js.org/docs/releases/features): Experimental, Preview,
// Stable, Deprecated. The sidebar shows it as the badge (.storybook/manager.ts).
// - Stable: done and matching the live app.
// - Preview: built and nearly final, still being reviewed (Labs).
// - Experimental: design-only or exploratory (Not In The Live App, design
//   previews of pages the app has not shipped).
// - Deprecated: the v1.0 baseline, frozen and on its way out.
export const StorybookLifecycle = {
  Experimental: "experimental",
  Preview: "preview",
  Stable: "stable",
  Deprecated: "deprecated",
} as const;
export type StorybookLifecycle =
  (typeof StorybookLifecycle)[keyof typeof StorybookLifecycle];

export const storybookLifecycleTags: readonly StorybookLifecycle[] =
  Object.values(StorybookLifecycle);

// Two releases share the sidebar. The current one (every stage but
// Deprecated) has the plain level roots: "Composites", "Surfaces". The v1.0
// baseline is Deprecated and keeps its version in its roots: "Composites
// v1.0". Foundations, Primitives and Composites carry both; for Primitives and
// Composites the catalog script computes the title from the story's tag; the
// Foundations pages are not cataloged, so the current Foundations lives in
// stories/foundations-v2/ and validate:catalog checks its titles against the
// Foundations groups. The current roots sort above every v1.0 root (see
// buildStorySortOrder).
export const storybookVersionedLevels: readonly string[] = [
  "Foundations",
  "Primitives",
  "Composites",
];

/** The v1.0 baseline: Deprecated, titled under "<Level> v1.0". */
export const storybookBaselineVersion = "v1.0";

/** The current release: titled under the plain "<Level>" root. */
export const storybookNextVersion = "v2.0";

/** The release a story's lifecycle tag puts it in. */
export function storybookReleaseOfLifecycle(
  lifecycle: StorybookLifecycle
): string {
  return lifecycle === StorybookLifecycle.Deprecated
    ? storybookBaselineVersion
    : storybookNextVersion;
}

// The one order every entry in the page tree lists its stories in
// (Nerys, ISS-12332, 2026-10-09): the Default story first, then the shared
// states below in this order, then the states only that page has, then
// variants (tabs, views, flag arms, Dark, Narrow, desktop). A state an entry
// does not have is skipped. Surfaces, Patterns and Composites
// all follow it, because a page's Surface is built from its Pattern and
// Composites. A story named after a shared state plus more words ("Loading
// Dark", "Error With Retry") counts as that state and sits with it.
// validate:catalog checks it (scripts/story-state-order.mjs); TAXONOMY.md,
// "The page tree", explains it.
export const storybookDefaultStoryName = "Default";

export const storybookSharedStateOrder: readonly string[] = [
  "Loading",
  "Syncing",
  "Empty",
  "No Matches",
  "Error",
  "Not Found",
  "No Permission",
  "Unavailable",
  "Stale",
];

// Older names for a shared state, mapped so the check orders them as that
// state. Matched like the states themselves: the name alone, or the name plus
// more words ("Permission Dark"). Keep this short; a new story uses the shared
// name instead (TAXONOMY.md, "The page tree").
export const storybookStateSynonyms: Readonly<Record<string, string>> = {
  Permission: "No Permission",
  "No Sessions": "Empty",
  "Failed Retrieval": "Error",
  "Load Failed": "Error",
  "Failed Load": "Error",
};

// The roots whose entries the state order is checked in: the page tree.
// v1.0 stays as it was.
export const storybookStateOrderRoots: readonly string[] = [
  "Composites",
  "Patterns",
  "Surfaces",
];

/** A level's root in a release: plain for the current one, suffixed for v1.0. */
export function storybookVersionedRoot(level: string, version: string) {
  return version === storybookNextVersion ? level : `${level} ${version}`;
}

/** A level's v1.0 (Deprecated) root: "Composites v1.0". */
export function storybookBaselineRoot(level: string) {
  return storybookVersionedRoot(level, storybookBaselineVersion);
}

// Surfaces: the page tree ISS-11361 targets (Target sidebar, v15), in
// the live app's sidebar order and then the sections outside it. It is its
// own root beside Surfaces, which stays as v1.0. It is the last v2.0 root,
// so it sorts above Foundations, the first v1.0 one (Nerys, 2026-10-06). Every
// "Surfaces/..." title must be listed here; validate:catalog fails when
// one is not.
export const storybookSurfacesV2Root = "Surfaces";

export const storybookSurfacesV2Order: readonly StorySortOrderNode[] = [
  "Dashboard",
  "Artifacts",
  [
    "Sessions",
    ["Sessions List", "Session Detail"],
    "Branches",
    ["Branches List", "Branch Detail"],
  ],
  "Labs",
  [
    "Search",
    "Inbox",
    "My Tasks",
    "Documents",
    ["Documents List", "Document Detail"],
    // Beside Documents: worked on with it (Nerys, 2026-10-16).
    "Issues",
    ["Issues List", "Issue Detail"],
    "Agents",
    ["Agents List", "Agent Detail"],
    "Insights",
    "Lost work",
    "TokenOps waste",
    "Packs",
    ["Packs List", "Pack Detail"],
  ],
  "Your Teams",
  ["Projects List", "Project Detail", "Archived Projects"],
  "Workspace Menu",
  [
    "Settings",
    [
      "Profile",
      "Connected Devices",
      "Plugins",
      "General",
      "Members",
      "Custom Fields",
      "Tags",
      "Compliance",
      "API Keys",
      "Desktop App",
      "Other Labs Settings",
      "Desktop Authorize",
      "Desktop Connect",
    ],
    "Diagnostics",
  ],
  "Other Pages",
  [
    "PRDs",
    ["PRDs List", "PRD Detail"],
    "Implementation Plans",
    ["Plans List", "Plan Detail"],
    "Users",
    ["User Profile"],
    "Help",
  ],
  "Not In The Live App",
  ["Judges", ["Judges", "Judge Detail"]],
  "Desktop Only",
  ["Plans", "Approvals", "Requests"],
  "Sign In",
  ["Sign In", "Sign Up", "SSO Callback", "GitHub Connect", "GitHub Link"],
  "Onboarding",
  "System States",
  [
    "Page Not Found",
    "Route Error",
    "Page Unavailable",
    "Workspace Access Failed",
    "API Unreachable",
  ],
];

// The sidebar leads with Start Here, then every v2.0 root, then every v1.0
// root, each half in level order: Foundations, Primitives, Composites,
// Patterns, Surfaces (Nerys, 2026-10-06). Patterns has only a v2.0 root.
// The page tree (Nerys, 2026-10-06). Composites and Patterns
// are grouped exactly like Surfaces: a composite is a section of a page
// and sits under that page's path, a pattern is a page's shell or layout and
// sits AT that page's path. A part used by pages in more than one section
// sits under Shared, in a group named for the kind of page it belongs to.
// TAXONOMY.md has the full rules; V2_PLACEMENT_BY_ID in
// taxonomy-classification.mjs places each v2.0 component.
export const storybookV2SharedGroup = "Shared";

export const storybookV2SharedOrder: readonly StorySortOrderNode[] = [
  // The grouped list sections every artifact list shares (PRD-720): the
  // Documents View and the grid's grouped sections (ISS-12462), and the list
  // band layout, card list and bulk tag picker (ISS-12305).
  "Artifact List",
  "Navigation",
  "Artifact Detail",
  // The Activity tab's timeline, row and comment box (ISS-12117).
  "Activity",
  // The data controls onboarding and Settings share (PRD-796): the data-sync
  // level card (ISS-12522) and the directory scope list (ISS-12520), with
  // and without its add control (ISS-12521).
  "Data Sync",
  // The data-controls parts every data-controls page shares (PRD-796):
  // the policy status indicator (ISS-12526), the deletion scope review
  // (ISS-12537), the deletion request tracker (ISS-12538), the uploads
  // pause control (ISS-12528), the scope editor (ISS-12527), the
  // deletion entry point (ISS-12539) and the upload queue view (ISS-12529).
  "Data Controls",
  // Reviewer tooling the prototypes mount (ISS-12518), not a section of a
  // product page.
  "Prototype Tools",
];

export const storybookV2PageTreeOrder: readonly StorySortOrderNode[] = [
  storybookV2SharedGroup,
  storybookV2SharedOrder,
  ...storybookSurfacesV2Order,
];

// Composites, Patterns and Surfaces each open with an
// Overview page saying what the root holds and how the three link (Nerys,
// 2026-10-06).
export const storybookV2OverviewPage = "Overview";

/** Composites: its Overview page, then the page tree. */
export const storybookCompositesV2Order: readonly StorySortOrderNode[] = [
  storybookV2OverviewPage,
  ...storybookV2PageTreeOrder,
];

/** Patterns: its Overview page, then the page tree. */
export const storybookPatternsV2Order: readonly StorySortOrderNode[] = [
  storybookV2OverviewPage,
  ...storybookV2PageTreeOrder,
];

/** Surfaces: its Overview page, then its page tree. */
export const storybookSurfacesV2RootOrder: readonly StorySortOrderNode[] = [
  storybookV2OverviewPage,
  ...storybookSurfacesV2Order,
];

/** The levels whose v2.0 root is grouped by the page tree. */
export const storybookPageTreeLevels: readonly string[] = ["Composites"];

/**
 * Every path in an order tree, as "Group/Subgroup/…" strings: the nodes a
 * title may sit under.
 */
export function storySortOrderPaths(
  order: readonly StorySortOrderNode[]
): ReadonlySet<string> {
  const paths = new Set<string>();
  const collect = (nodes: readonly StorySortOrderNode[], prefix: string[]) => {
    let last: string[] | null = null;
    for (const node of nodes) {
      if (typeof node === "string") {
        last = [...prefix, node];
        paths.add(last.join("/"));
      } else if (last) {
        collect(node, last);
      }
    }
  };
  collect(order, []);
  return paths;
}

export function buildStorySortOrder(): readonly StorySortOrderNode[] {
  const nextVersion: StorySortOrderNode[] = [];
  const baseline: StorySortOrderNode[] = [];

  for (const level of Object.keys(storybookLevelGroupOrder)) {
    if (level === "Surfaces") {
      nextVersion.push(
        storybookPatternsV2Root,
        storybookPatternsV2Order,
        storybookSurfacesV2Root,
        storybookSurfacesV2RootOrder
      );
    }
    const groups = storybookLevelGroupOrder[level] ?? [];
    if (groups.length === 0) {
      baseline.push(storybookBaselineRoot(level));
      continue;
    }

    const children: StorySortOrderNode[] = [];
    for (const group of groups) {
      children.push(group.name);
      if (group.subgroups?.length) {
        // Storybook reads a nested array as the children of the name that
        // precedes it, so a subgroup list rides directly behind its group.
        children.push(group.subgroups);
      }
    }
    if (storybookVersionedLevels.includes(level)) {
      nextVersion.push(
        storybookVersionedRoot(level, storybookNextVersion),
        storybookPageTreeLevels.includes(level)
          ? storybookCompositesV2Order
          : children
      );
    }
    baseline.push(storybookBaselineRoot(level), children);
  }

  return [
    "Start Here",
    storybookStartHereGroupOrder.map((group) => group.name),
    ...nextVersion,
    ...baseline,
  ];
}
