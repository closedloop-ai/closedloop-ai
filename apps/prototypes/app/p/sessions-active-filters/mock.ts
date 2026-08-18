import type { Dispatch, SetStateAction } from "react";

/**
 * Presentational stand-in for the production `SessionFacetFilters` shape — the
 * multi-select facet selections the real Sessions list mirrors into its query.
 * Mock-data only; the real surface derives these from URL params + usage reads.
 * Carries all nine production facets so the busy preset can stress the chip
 * row's wrap the way seven-to-nine active chips would on the real surface.
 */
export type FacetFilters = {
  statuses: string[];
  userIds: string[];
  repositories: string[];
  harnesses: string[];
  models: string[];
  autonomyTiers: string[];
  costBuckets: string[];
  changePresence: string[];
  prAssociation: string[];
};

export type ActiveChip = {
  key: string;
  facetLabel: string;
  valueLabel: string;
  remove: () => void;
};

/** One row of the stand-in Sessions list, enough to show the Cost column. */
export type MockSessionRow = {
  id: string;
  name: string;
  owner: string;
  repository: string;
  status: string;
  /** The rendered Cost cell — `null` is the honest "—" (missing-cost) state. */
  costUsd: number | null;
};

type FacetKey = keyof FacetFilters;

type FacetSpec = {
  key: FacetKey;
  facetLabel: string;
  labels: Record<string, string>;
};

export const EMPTY_FILTERS: FacetFilters = {
  statuses: [],
  userIds: [],
  repositories: [],
  harnesses: [],
  models: [],
  autonomyTiers: [],
  costBuckets: [],
  changePresence: [],
  prAssociation: [],
};

export const INITIAL_FILTERS: FacetFilters = {
  ...EMPTY_FILTERS,
  costBuckets: ["unknown"],
};

// The sentinel value the Cost facet uses for the missing-cost cohort (ISS-4481).
export const UNKNOWN_COST_BUCKET = "unknown";

// Mirrors the production facet→label mapping (SESSION_*_OPTIONS in
// @repo/api/src/agent-session-filters and the usage byUser/byRepository
// breakdowns) — a selection with no known label still renders its raw value so
// it stays visible and removable.
const FACET_SPECS: FacetSpec[] = [
  {
    key: "statuses",
    facetLabel: "Status",
    labels: { inactive: "Inactive", error: "Failed", active: "Active" },
  },
  {
    key: "userIds",
    facetLabel: "Owner",
    labels: { "user-ada": "Ada Lovelace", "user-grace": "Grace Hopper" },
  },
  {
    key: "autonomyTiers",
    facetLabel: "Autonomy",
    labels: { high: "High", mixed: "Mixed", guided: "Guided" },
  },
  {
    key: "harnesses",
    facetLabel: "Harness",
    labels: { claude: "claude", codex: "codex" },
  },
  {
    key: "models",
    facetLabel: "Model",
    labels: { "claude-opus-4": "claude-opus-4", "gpt-5.5": "gpt-5.5" },
  },
  {
    key: "costBuckets",
    facetLabel: "Cost",
    labels: { unknown: "Unknown", "gt-1": "> $1.00", "lt-01": "< $0.10" },
  },
  {
    key: "changePresence",
    facetLabel: "Changes",
    labels: { has_changes: "Has changes", no_changes: "No changes" },
  },
  {
    key: "prAssociation",
    facetLabel: "Pull request",
    labels: { has_pr: "Has PR", no_pr: "No PR" },
  },
  {
    key: "repositories",
    facetLabel: "Repository",
    labels: {
      "closedloop-ai/symphony-alpha": "symphony-alpha",
      "closedloop-ai/design-system": "design-system",
    },
  },
];

// A stand-in cohort where every row's Cost is the honest missing-cost "—". This
// is exactly the state the chip row exists to explain: without a chip naming the
// active Cost = Unknown facet, this column reads as broken rather than filtered.
const UNKNOWN_COST_ROWS: MockSessionRow[] = [
  {
    id: "s-1",
    name: "refactor auth bridge",
    owner: "Ada Lovelace",
    repository: "symphony-alpha",
    status: "Inactive",
    costUsd: null,
  },
  {
    id: "s-2",
    name: "sessions filter chips",
    owner: "Grace Hopper",
    repository: "design-system",
    status: "Active",
    costUsd: null,
  },
  {
    id: "s-3",
    name: "db-host clone-safe IPC",
    owner: "Ada Lovelace",
    repository: "symphony-alpha",
    status: "Inactive",
    costUsd: null,
  },
  {
    id: "s-4",
    name: "branch logic coverage",
    owner: "Grace Hopper",
    repository: "symphony-alpha",
    status: "Failed",
    costUsd: null,
  },
  {
    id: "s-5",
    name: "my tasks pagination",
    owner: "Ada Lovelace",
    repository: "design-system",
    status: "Inactive",
    costUsd: null,
  },
];

// A priced cohort so a non-Unknown Cost facet shows real figures next to chips.
const PRICED_ROWS: MockSessionRow[] = UNKNOWN_COST_ROWS.map((row, index) => ({
  ...row,
  id: `${row.id}-priced`,
  costUsd: [1.25, 0.08, 3.4, 0.92, 2.1][index] ?? 0,
}));

/**
 * The stand-in list rows for the current filter selection. Only the Cost facet
 * changes the cohort here (the prototype's point): Cost = Unknown yields the
 * all-"—" rows; any other/no Cost selection yields the priced rows.
 */
export function mockSessionRows(filters: FacetFilters): MockSessionRow[] {
  if (filters.costBuckets.includes(UNKNOWN_COST_BUCKET)) {
    return UNKNOWN_COST_ROWS;
  }
  return PRICED_ROWS;
}

/**
 * Walk the facet specs and emit one removable chip per selected value, in facet
 * order — the presentational twin of the production `deriveSessionFilterChips`.
 * `remove` toggles just that value back off its facet.
 */
export function deriveChips(
  filters: FacetFilters,
  setFilters: Dispatch<SetStateAction<FacetFilters>>
): ActiveChip[] {
  const chips: ActiveChip[] = [];
  for (const spec of FACET_SPECS) {
    for (const value of filters[spec.key]) {
      chips.push({
        key: `${spec.key}:${value}`,
        facetLabel: spec.facetLabel,
        valueLabel: spec.labels[value] ?? value,
        remove: () =>
          setFilters((prev) => ({
            ...prev,
            [spec.key]: prev[spec.key].filter((entry) => entry !== value),
          })),
      });
    }
  }
  return chips;
}
