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
import { AGENT_COMPONENT_NO_AUTHORS_LABEL } from "./agent-component-authors";

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
  [AgentComponentKind.Mcp]: "MCPs",
  [AgentComponentKind.Tool]: "Tools",
  [AgentComponentKind.Orchestration]: "Orchestration",
  [AgentComponentKind.Hook]: "Hooks",
  [AgentComponentKind.Config]: "Memory & config",
};

// Display label for each `Harness` value. Hoisted to module scope so the
// group-by-harness branch and the harness-facet-options builder share one
// canonical map instead of re-declaring identical copies inline.
const HARNESS_LABEL: Record<Harness, string> = {
  // "Multiple harnesses", not "Claude + Codex": `resolveComponentHarness`
  // collapses ANY multi-harness usage to `Both`, now including Claude+OpenCode,
  // so naming Codex would assert a harness the component never touched (T9).
  // Kept in sync with HARNESS_META in component-meta.tsx.
  [Harness.Both]: "Multiple harnesses",
  [Harness.Claude]: "Claude",
  [Harness.Codex]: "Codex",
  [Harness.Opencode]: "OpenCode",
};

/**
 * The individual harnesses offered as selectable Harness filter options
 * (FEA-4336) — every real `Harness` value EXCEPT the synthetic `Both`
 * ("Multiple harnesses") combined value, which is not a distinct harness a user
 * would filter on. Derived from the full `Harness` value set so a newly added
 * individual harness automatically becomes a filter option, while the combined
 * `Both` sentinel stays excluded from the menu. Its counterpart on the count
 * side is `facetsForHarness`, which folds a `Both` row into EVERY individual
 * harness count.
 */
const HARNESS_FILTER_OPTION_ORDER: readonly Harness[] = Object.values(
  Harness
).filter((h) => h !== Harness.Both);

/**
 * FEA-4086 / ISS-4386: the harness facets a row's DISPLAYED harness belongs to.
 * A single harness belongs to its own facet; a `Both` row (used across MORE THAN
 * ONE harness — Claude+Codex, Claude+OpenCode, Codex+OpenCode, …) belongs to
 * EVERY individual harness facet plus `Both`, so facet counts stay in step with
 * `harnessMatchesFacet`. Hardcoding {Claude, Codex} here (the pre-OpenCode
 * shape) dropped a Claude+OpenCode component out of the OpenCode facet — the
 * empty state then read "No plugins installed for OpenCode" while the component
 * sat under Claude (T2/T10). The individual facets are exactly
 * `HARNESS_FILTER_OPTION_ORDER`.
 */
function facetsForHarness(harness: Harness): Harness[] {
  if (harness === Harness.Both) {
    return [Harness.Both, ...HARNESS_FILTER_OPTION_ORDER];
  }
  return [harness];
}

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
  AgentComponentKind.Orchestration,
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
      return row.locPerDollar ?? Number.NEGATIVE_INFINITY;
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
 * - `Collaborators` — one group per distinct author (discoverer + editors),
 *   sorted alphabetically; a component with several authors appears under each,
 *   and a component with none is placed in an "No authors" group at the end.
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

    case AgentComponentGroupBy.Collaborators: {
      // Collect rows by author (collaborator) name; a component with several
      // authors lands in each of their buckets, and one with none goes to a
      // trailing "No authors" group. FEA-4098 (Slice 3).
      const byCollaborator = new Map<string, AgentComponent[]>();
      const noAuthors: AgentComponent[] = [];
      for (const row of rows) {
        if (row.collaborators.length === 0) {
          noAuthors.push(row);
          continue;
        }
        for (const collaborator of row.collaborators) {
          const bucket = byCollaborator.get(collaborator);
          if (bucket) {
            bucket.push(row);
          } else {
            byCollaborator.set(collaborator, [row]);
          }
        }
      }
      const groups: AgentComponentGroup[] = [...byCollaborator.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map((collaborator) => ({
          label: collaborator,
          items: byCollaborator.get(collaborator) ?? [],
        }));
      if (noAuthors.length > 0) {
        groups.push({
          label: AGENT_COMPONENT_NO_AUTHORS_LABEL,
          items: noAuthors,
        });
      }
      return groups;
    }

    case AgentComponentGroupBy.Harness: {
      // One group per Harness value in definition order, EMPTY GROUPS DROPPED
      // (T11): with OpenCode added, always rendering all four headers left a
      // typical org staring at an empty OpenCode bucket next to an empty Codex
      // one — mostly chrome with no rows under it. Only harnesses that actually
      // have components get a header.
      const HARNESS_ORDER: readonly Harness[] = [
        Harness.Both,
        Harness.Claude,
        Harness.Codex,
        Harness.Opencode,
      ];
      const byHarness = new Map<Harness, AgentComponent[]>(
        HARNESS_ORDER.map((h) => [h, []])
      );
      for (const row of rows) {
        byHarness.get(row.harness)?.push(row);
      }
      return HARNESS_ORDER.filter(
        (h) => (byHarness.get(h)?.length ?? 0) > 0
      ).map((h) => ({
        label: HARNESS_LABEL[h],
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
  // FEA-4098 (Slice 3): filter by author (collaborator) display name, replacing
  // the single-owner facet.
  collaborators: string[];
  sources: string[];
  harnesses: Harness[];
  search: string;
};

/**
 * Per-facet-dimension options with counts, ready to pass as `options` to a
 * `FilterFacetGroup` in the `FilterPopover`.
 */
export type AgentComponentFacetCounts = {
  collaborators: TableFilterOption[];
  sources: TableFilterOption[];
  harnesses: TableFilterOption[];
};

/**
 * Compute per-option counts for the Collaborators, Source, and Harness filter
 * facets.
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
 * **Harness self-exclusion**: unlike Collaborators/Source, the Harness facet
 * counts from `harnessCountRows` — the corpus filtered by every OTHER active
 * facet but with the harness filter itself CLEARED — instead of from `rows`.
 * Since the individual harness options are the only union path (checking the
 * relevant boxes = the old combined "Multiple harnesses"), counting the harness
 * options off the already-harness-narrowed `rows` would zero-out an un-checked
 * harness:
 * e.g. once Claude is checked, `rows` has dropped every Codex-only component, so
 * Codex would read 0 even though checking it adds those rows back through the OR
 * predicate (wongk, FEA-4336). Counting off the harness-cleared set makes each
 * option honestly preview how many rows toggling it would surface. When the
 * caller does not supply `harnessCountRows` (harness filter inactive), the two
 * sets are identical and `rows` is used.
 *
 * @param rows     Already-filtered rows (type-tab + other active facets applied).
 * @param allRows  Full inventory corpus — used to discover the complete value
 *                 universe for zero-count inclusion.
 * @param _activeFilters  Current filter state (reserved for future per-dimension
 *                 "hypothetical" counting; not used for the collaborator/source
 *                 dimensions because `rows` is already filtered at call-site).
 * @param harnessCountRows  Rows filtered by every active facet EXCEPT harness,
 *                 used only for the harness option counts so an active harness
 *                 filter does not zero-out the other harness's union preview.
 *                 Defaults to `rows` when the caller omits it.
 * @param honestSourceEnabled  ISS-5009. When true, the Source options and counts
 *                 key on {@link sourceFacetValue} instead of the raw
 *                 `row.source`, and a row with no real provenance leaves the
 *                 Source facet entirely rather than contributing its own
 *                 identity key as a filterable "source". MUST be the same value
 *                 the membership predicate (`filterAgentComponentRows`) is given
 *                 — an option counted under one projection and matched under the
 *                 other selects zero rows. Defaults to `false` (today's
 *                 behavior) so a caller that has not adopted the flag is
 *                 unchanged.
 */
export function countFacetValues(
  rows: AgentComponent[],
  allRows: AgentComponent[],
  _activeFilters: AgentComponentActiveFilters,
  harnessCountRows: AgentComponent[] = rows,
  honestSourceEnabled = false
): AgentComponentFacetCounts {
  // --- Build count maps from the already-filtered `rows` ---
  // FEA-4098 (Slice 3): a component has a SET of authors, so each distinct
  // collaborator on a row increments once (deduped within the row).
  const collaboratorCounts = new Map<string, number>();
  const sourceCounts = new Map<string, number>();
  const harnessCounts = new Map<Harness, number>();

  for (const row of rows) {
    for (const collaborator of new Set(row.collaborators)) {
      collaboratorCounts.set(
        collaborator,
        (collaboratorCounts.get(collaborator) ?? 0) + 1
      );
    }
    // ISS-5009: count under the row's honest facet value. A `null` means the row
    // has no source worth filtering on, so it contributes to no option — the
    // count must describe the same population the membership predicate returns.
    const source = sourceFacetValue(row, honestSourceEnabled);
    if (source !== null) {
      sourceCounts.set(source, (sourceCounts.get(source) ?? 0) + 1);
    }
  }

  // Harness counts come from `harnessCountRows` (harness filter cleared) — see
  // the "Harness self-exclusion" note in the docstring — so an active harness
  // selection does not zero-out the un-checked harness's union preview.
  for (const row of harnessCountRows) {
    // FEA-4086 / ISS-4386: a `Harness.Both` row (used across MORE THAN ONE
    // harness) is a member of EVERY individual harness facet as well as `Both`,
    // mirroring the membership predicate `harnessMatchesFacet` in the filter
    // hook. Counting it only under `Both` would leave the individual options
    // showing 0 while the row would still surface when those facets are toggled
    // — a menu that lies about how many items its option covers.
    for (const facet of facetsForHarness(row.harness)) {
      harnessCounts.set(facet, (harnessCounts.get(facet) ?? 0) + 1);
    }
  }

  // --- Collect the complete value universe from `allRows` ---
  const allCollaborators = new Set<string>();
  const allSources = new Set<string>();

  for (const row of allRows) {
    for (const collaborator of row.collaborators) {
      allCollaborators.add(collaborator);
    }
    // ISS-5009: the option UNIVERSE is keyed on the same honest projection as
    // the counts, so a provenance-less row's identity-key echo never becomes a
    // selectable "source" the user can pick.
    const source = sourceFacetValue(row, honestSourceEnabled);
    if (source !== null) {
      allSources.add(source);
    }
  }

  // Collaborator options — sorted alphabetically; zero-count values included.
  const collaboratorOptions: TableFilterOption[] = [...allCollaborators]
    .sort((a, b) => a.localeCompare(b))
    .map((collaborator) => ({
      id: collaborator,
      label: collaborator,
      count: collaboratorCounts.get(collaborator) ?? 0,
    }));

  // Source options — sorted alphabetically; zero-count values included.
  const sourceOptions: TableFilterOption[] = [...allSources]
    .sort((a, b) => a.localeCompare(b))
    .map((source) => ({
      id: source,
      label: source,
      count: sourceCounts.get(source) ?? 0,
    }));

  // Harness filter options — only the individual harnesses are selectable
  // (FEA-4336). The synthetic `Both` ("Multiple harnesses") combined row is NOT
  // offered as a filter option: it is redundant with checking the individual
  // boxes, and it confusingly showed a 0 count while the individual harnesses
  // had rows. A component whose rolled-up harness is `Both` (used across more
  // than one harness) is still counted under EVERY individual option — via
  // `facetsForHarness` in the count loop above — and `harnessMatchesFacet`
  // surfaces those combined rows under any individual facet, so the union of the
  // individual harnesses covers them without a dedicated combined option.
  const harnessOptions: TableFilterOption[] = HARNESS_FILTER_OPTION_ORDER.map(
    (h) => ({
      id: h,
      label: HARNESS_LABEL[h],
      count: harnessCounts.get(h) ?? 0,
    })
  );

  return {
    collaborators: collaboratorOptions,
    sources: sourceOptions,
    harnesses: harnessOptions,
  };
}

/**
 * ISS-5009: the Source value a row participates in the Source FACET as — its
 * option id, its count key, AND the value the membership predicate compares
 * against. `null` means the row has no source worth filtering on and is excluded
 * from all three.
 *
 * One helper for all three on purpose. The honest projection and the legacy
 * `source` diverge for every row whose provenance chain wins on a branch the
 * legacy chain cannot reach, so gating only the option universe would leave the
 * flag-ON menu offering a value (`"user"`) that the membership predicate tests
 * against the legacy identity-key echo — an option with a positive count that
 * selects ZERO rows and empties the catalog. Strictly worse than the echo it
 * replaces.
 *
 * `honestEnabled` is a PARAMETER, never a hook read: this is a pure data/logic
 * module with no React dependency (mirroring `kindPlural` / `facetsForHarness`
 * above), so the React layer resolves the flag ONCE and threads the same value
 * into every consumer. With the flag off — or against a server that predates
 * `honestSource` and therefore omits it — this returns the legacy
 * `component.source` and every facet behaves byte-identically to today.
 *
 * Deliberately NOT used by `sortValueOf`: sort ordering by Source still compares
 * the legacy value. A column of em dashes ordered by a hidden key is
 * deterministic and contradicts nothing on screen, unlike a filter menu that
 * offers values no row can match, so the comparator is left alone to bound scope
 * (documented accepted risk, ISS-5009 plan rev 3).
 */
export function sourceFacetValue(
  component: AgentComponent,
  honestEnabled: boolean
): string | null {
  const honest = component.honestSource;
  if (honestEnabled && honest) {
    return honest.hasProvenance ? honest.source : null;
  }
  return component.source;
}
