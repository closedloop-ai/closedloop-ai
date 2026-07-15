import type { AgentComponent } from "@repo/api/src/types/agent-component";
import {
  AgentComponentGroupBy,
  AgentComponentKind,
  AgentComponentSortDir,
  AgentComponentSortKey,
  Harness,
} from "@repo/api/src/types/agent-component";
import { labelize } from "@repo/api/src/utils/string";
import type { TableFilterOption } from "@repo/design-system/components/ui/table-filters";

// ---------------------------------------------------------------------------
// Group label lookup — mirrors the plural labels in component-meta.tsx
// (KIND_META[kind].plural). Defined here to keep agent-component-sort-group.ts
// free of React / JSX dependencies (it is a pure data/logic module).
// ---------------------------------------------------------------------------

const KIND_PLURAL: Record<AgentComponentKind, string> = {
  [AgentComponentKind.Subagent]: "Agents",
  [AgentComponentKind.Command]: "Commands",
  [AgentComponentKind.Skill]: "Skills",
  [AgentComponentKind.Workflow]: "Workflows",
  [AgentComponentKind.Plugin]: "Plugins",
  [AgentComponentKind.Mcp]: "MCP tools",
  [AgentComponentKind.Tool]: "Tools",
  [AgentComponentKind.Hook]: "Hooks",
  [AgentComponentKind.Config]: "Memory & config",
};

/**
 * Plural group/sort label for a component `kind`, total over arbitrary kind
 * strings. Mirrors `kindMeta().plural` in component-meta.tsx: known kinds use
 * their declared `KIND_PLURAL` label; any kind not in the enum (e.g. built-in
 * tool usage `kind: "tool"` synced from the desktop collector) falls back to a
 * labelized plural (`"tool"` → `"Tools"`).
 *
 * Without this fallback the `Type` sort key returned `undefined` for unmapped
 * kinds and `localeCompare` crashed the Agents page — the same class of bug the
 * badge fallback fixes on the render path. Reimplemented here (rather than
 * importing kindMeta) to keep this pure data/logic module free of the
 * JSX-bearing component-meta.tsx.
 */
function kindPlural(kind: string): string {
  const known = KIND_PLURAL[kind as AgentComponentKind];
  if (known) {
    return known;
  }
  const label = labelize(kind);
  return `${label}s`;
}

// The canonical display order for AgentComponentKind groups, matching
// KIND_ORDER from component-meta.tsx. Defined here to keep sort-group
// self-contained; component-meta.tsx may import this if it prefers.
const KIND_ORDER: readonly AgentComponentKind[] = [
  AgentComponentKind.Subagent,
  AgentComponentKind.Command,
  AgentComponentKind.Skill,
  AgentComponentKind.Workflow,
  AgentComponentKind.Plugin,
  AgentComponentKind.Mcp,
  AgentComponentKind.Tool,
  AgentComponentKind.Hook,
  AgentComponentKind.Config,
];

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

/**
 * Classify the active sort key so the comparator knows whether to use
 * `localeCompare` (string fields) or numeric subtraction.
 */
function isStringKey(key: AgentComponentSortKey): boolean {
  return (
    key === AgentComponentSortKey.Name ||
    key === AgentComponentSortKey.Type ||
    key === AgentComponentSortKey.Owner ||
    key === AgentComponentSortKey.Source ||
    key === AgentComponentSortKey.Harness
  );
}

/**
 * Extract the sortable scalar for a row given the active sort key.
 *
 * - String keys: return the display string used for `localeCompare`.
 * - Numeric keys: return a `number` (null metrics sort as -Infinity so they
 *   fall to the bottom of ascending order / top of descending).
 * - `Type` and `Harness` sort alphabetically by their display-friendly plural
 *   label / harness value so the table groups naturally when the user sorts
 *   by those columns.
 */
function sortValueOf(
  row: AgentComponent,
  key: AgentComponentSortKey
): string | number {
  switch (key) {
    case AgentComponentSortKey.Name:
      return row.name;
    case AgentComponentSortKey.Type:
      return kindPlural(row.kind);
    case AgentComponentSortKey.Metric:
      return row.klocPerDollar ?? Number.NEGATIVE_INFINITY;
    case AgentComponentSortKey.Owner:
      // Null owners sort last when ascending (fall behind alphabetic entries).
      return row.owner ?? "￿";
    case AgentComponentSortKey.Source:
      return row.source;
    case AgentComponentSortKey.Harness:
      return row.harness;
    case AgentComponentSortKey.Invocations:
      return row.invocations ?? Number.NEGATIVE_INFINITY;
    case AgentComponentSortKey.Sessions:
      return row.sessions ?? Number.NEGATIVE_INFINITY;
    default: {
      // Exhaustive guard — TypeScript enforces this never fires at runtime if
      // every key is handled above.
      const _exhaustive: never = key;
      return _exhaustive;
    }
  }
}

/**
 * Sort an already-filtered array of `AgentComponent` rows.
 *
 * Uses the decorate-sort-undecorate (DSU) pattern from `branch-sort-group.ts`:
 * each row's sort key is derived exactly once (O(N)) rather than being
 * recomputed on both operands of every comparison (O(N·log₂N) extra work).
 *
 * - String keys compare with `localeCompare` for locale-aware ordering.
 * - Numeric keys compare by subtraction; null metrics sort as −∞ so they
 *   appear at the bottom of ascending order.
 * - `dir: "asc"` returns smallest-first; `dir: "desc"` reverses the order.
 */
export function sortAgentComponentRows(
  rows: AgentComponent[],
  key: AgentComponentSortKey,
  dir: AgentComponentSortDir
): AgentComponent[] {
  const stringKey = isStringKey(key);
  const decorated = rows.map((row) => ({
    row,
    sortKey: sortValueOf(row, key),
  }));
  decorated.sort((a, b) => {
    const compared = stringKey
      ? (a.sortKey as string).localeCompare(b.sortKey as string)
      : (a.sortKey as number) - (b.sortKey as number);
    return dir === AgentComponentSortDir.Asc ? compared : -compared;
  });
  return decorated.map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Group helpers
// ---------------------------------------------------------------------------

/** A single group produced by `groupAgentComponentRows`. */
export type AgentComponentGroup = {
  /** Display label for the group header. Empty string when `groupBy` is None. */
  label: string;
  items: AgentComponent[];
};

/**
 * Bucket an already-sorted array of `AgentComponent` rows into labelled
 * groups for the Consolidated layout's group-by display.
 *
 * - `None` — returns a single group with an empty label (no header rendered).
 * - `Type` — one group per `AgentComponentKind` in canonical `KIND_ORDER`;
 *   labels come from `KIND_PLURAL` (mirrors `KIND_META[kind].plural`).
 *   Groups with zero items are included so the UI can show an empty state.
 * - `Owner` — one group per distinct owner, sorted alphabetically; rows with
 *   `owner === null` are placed in an "Unattributed" group at the end.
 * - `Harness` — one group per `Harness` value in definition order; groups with
 *   zero items are included.
 */
export function groupAgentComponentRows(
  rows: AgentComponent[],
  groupBy: AgentComponentGroupBy
): AgentComponentGroup[] {
  switch (groupBy) {
    case AgentComponentGroupBy.None: {
      return [{ label: "", items: rows }];
    }

    case AgentComponentGroupBy.Type: {
      // Bucket by kind, preserving KIND_ORDER and including empty groups. Any
      // kind not in the enum (e.g. synced desktop "tool" usage) is collected
      // into its own trailing group — keyed on `get()` returning undefined —
      // rather than being silently dropped, so the grouped view stays total
      // over arbitrary kind strings like the sort/badge paths.
      const byKind = new Map<string, AgentComponent[]>(
        KIND_ORDER.map((kind) => [kind, []])
      );
      const extraKinds: string[] = [];
      for (const row of rows) {
        const bucket = byKind.get(row.kind);
        if (bucket) {
          bucket.push(row);
        } else {
          byKind.set(row.kind, [row]);
          extraKinds.push(row.kind);
        }
      }
      const orderedKinds: string[] = [...KIND_ORDER, ...extraKinds];
      return orderedKinds.map((kind) => ({
        label: kindPlural(kind),
        items: byKind.get(kind) ?? [],
      }));
    }

    case AgentComponentGroupBy.Owner: {
      // Collect rows by owner name; null owner → "Unattributed" at the end.
      const byOwner = new Map<string, AgentComponent[]>();
      const unattributed: AgentComponent[] = [];
      for (const row of rows) {
        if (row.owner === null) {
          unattributed.push(row);
        } else {
          const bucket = byOwner.get(row.owner);
          if (bucket) {
            bucket.push(row);
          } else {
            byOwner.set(row.owner, [row]);
          }
        }
      }
      const groups: AgentComponentGroup[] = [...byOwner.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((owner) => ({ label: owner, items: byOwner.get(owner) ?? [] }));
      if (unattributed.length > 0) {
        groups.push({ label: "Unattributed", items: unattributed });
      }
      return groups;
    }

    case AgentComponentGroupBy.Harness: {
      // One group per Harness value in definition order; include empty groups.
      const HARNESS_ORDER: readonly Harness[] = [
        Harness.Both,
        Harness.Claude,
        Harness.Codex,
      ];
      const byHarness = new Map<Harness, AgentComponent[]>(
        HARNESS_ORDER.map((h) => [h, []])
      );
      for (const row of rows) {
        byHarness.get(row.harness)?.push(row);
      }
      const harnessLabel: Record<Harness, string> = {
        [Harness.Both]: "Claude + Codex",
        [Harness.Claude]: "Claude",
        [Harness.Codex]: "Codex",
      };
      return HARNESS_ORDER.map((h) => ({
        label: harnessLabel[h],
        items: byHarness.get(h) ?? [],
      }));
    }

    default: {
      const _exhaustive: never = groupBy;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Facet count helpers
// ---------------------------------------------------------------------------

/**
 * Active workspace filter state supplied to `countFacetValues`.
 * Mirrors the shape of `useAgentComponentsFilterState` (T-2.4).
 */
export type AgentComponentActiveFilters = {
  kinds: AgentComponentKind[];
  owners: string[];
  sources: string[];
  harnesses: Harness[];
  search: string;
};

/**
 * Per-facet-dimension options with counts, ready to pass as `options` to a
 * `FilterFacetGroup` in the `FilterPopover`.
 */
export type AgentComponentFacetCounts = {
  owners: TableFilterOption[];
  sources: TableFilterOption[];
  harnesses: TableFilterOption[];
};

/**
 * Compute per-option counts for the Owner, Source, and Harness filter facets.
 *
 * **Counting strategy**: counts are derived from `rows` (already narrowed by
 * the active type-tab and other active facets) so they reflect how many items
 * each option would add on top of the current narrowing — not the total corpus.
 * This is the same UX convention used by the Branches filter menu.
 *
 * **Zero-count options**: `allRows` provides the complete inventory so that
 * every value that could ever appear is present in the returned options, even
 * when its count drops to zero under the active narrowing. The UI renders
 * zero-count options grayed rather than hiding them.
 *
 * @param rows     Already-filtered rows (type-tab + other active facets applied).
 * @param allRows  Full inventory corpus — used to discover the complete value
 *                 universe for zero-count inclusion.
 * @param _activeFilters  Current filter state (reserved for future per-dimension
 *                 "hypothetical" counting; not used in the current implementation
 *                 because `rows` is already filtered at call-site).
 */
export function countFacetValues(
  rows: AgentComponent[],
  allRows: AgentComponent[],
  _activeFilters: AgentComponentActiveFilters
): AgentComponentFacetCounts {
  // --- Build count maps from the already-filtered `rows` ---
  const ownerCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const harnessCounts = new Map<Harness, number>();

  for (const row of rows) {
    if (row.owner !== null) {
      ownerCounts.set(row.owner, (ownerCounts.get(row.owner) ?? 0) + 1);
    }
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
    harnessCounts.set(row.harness, (harnessCounts.get(row.harness) ?? 0) + 1);
  }

  // --- Collect the complete value universe from `allRows` ---
  const allOwners = new Set<string>();
  const allSources = new Set<string>();

  for (const row of allRows) {
    if (row.owner !== null) {
      allOwners.add(row.owner);
    }
    allSources.add(row.source);
  }

  // Owner options — sorted alphabetically; zero-count values included.
  const ownerOptions: TableFilterOption[] = [...allOwners]
    .sort((a, b) => a.localeCompare(b))
    .map((owner) => ({
      id: owner,
      label: owner,
      count: ownerCounts.get(owner) ?? 0,
    }));

  // Source options — sorted alphabetically; zero-count values included.
  const sourceOptions: TableFilterOption[] = [...allSources]
    .sort((a, b) => a.localeCompare(b))
    .map((source) => ({
      id: source,
      label: source,
      count: sourceCounts.get(source) ?? 0,
    }));

  // Harness options — canonical order; all three values always included.
  const HARNESS_ORDER: readonly Harness[] = [
    Harness.Both,
    Harness.Claude,
    Harness.Codex,
  ];
  const harnessLabel: Record<Harness, string> = {
    [Harness.Both]: "Claude + Codex",
    [Harness.Claude]: "Claude",
    [Harness.Codex]: "Codex",
  };
  const harnessOptions: TableFilterOption[] = HARNESS_ORDER.map((h) => ({
    id: h,
    label: harnessLabel[h],
    count: harnessCounts.get(h) ?? 0,
  }));

  return {
    owners: ownerOptions,
    sources: sourceOptions,
    harnesses: harnessOptions,
  };
}
