import {
  type BranchDataState,
  type BranchProvenance,
  type BranchPrState,
  BranchSessionPresence,
  type BranchTagAvailability,
  type BranchTagPermissions,
} from "@repo/api/src/types/branch";
import type { ChecksStatus } from "@repo/api/src/types/branch-checks";
import {
  BranchListFilterFacet,
  BranchListLastActiveRange,
  BranchListPullRequestPresence,
} from "@repo/api/src/types/branch-list-contract";
import type { Priority } from "@repo/api/src/types/common";
import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import {
  matchesPriorityFilter,
  PRIORITY_FILTER_VALUES,
  type PriorityFilterValue,
} from "@repo/api/src/types/priority-filter";
import type { DisplayedSessionStatus } from "@repo/api/src/types/session-status";
import type { TagSummary } from "@repo/api/src/types/tag";
import type { TableFilterOption } from "@repo/design-system/components/ui/table-filters";

export const BranchRowStatus = {
  Open: "open",
  Review: "review",
  Merged: "merged",
  Draft: "draft",
  Blocked: "blocked",
  Closed: "closed",
} as const;
export type BranchRowStatus =
  (typeof BranchRowStatus)[keyof typeof BranchRowStatus];

/** Render placeholder for a NULL string-valued enrichment column (repo/base). */
export const RENDER_MISSING = "—";
/** Render fallback for a NULL branch owner (no actor capture in v1). */
export const RENDER_UNATTRIBUTED = "unattributed";

export type BranchRow = {
  id: string;
  branchName: string;
  /**
   * Cloud list freshness projected for shared web/Desktop rendering. Optional
   * so legacy producers remain compatible; only `AwaitingSync` changes the row
   * treatment, while missing or newer values keep the ordinary branch lead.
   */
  dataState?: BranchDataState;
  baseBranch: string;
  repo: string;
  owner: string;
  /** Stable owner identity for filtering/deduplication; display name is separate. */
  ownerKey?: string;
  /** Existing Owner photo projected for both web and Desktop cells. */
  ownerAvatarUrl?: string;
  collaborators?: BranchRowPerson[];
  tags?: TagSummary[];
  tagAvailability?: BranchTagAvailability;
  tagPermissions?: BranchTagPermissions;
  /** Canonical cloud Artifact UUID required by generic tag mutations. */
  artifactId?: string;
  /** Owning project id; omitted producer-wide when the producer has no project concept. */
  projectId?: string | null;
  /** Owning project's display name; omitted alongside `projectId` (ISS-12453). */
  projectName?: string | null;
  /**
   * ISS-12663: the Branch artifact's org custom-field values, carried from the
   * wire row unchanged. Omitted when the producer did not load them (local and
   * older producers); `[]` is a loaded row with no values.
   */
  customFields?: readonly CustomFieldValueDetail[];
  /**
   * ISS-10332: the branch artifact's priority. `null` is "no priority"; ABSENT
   * is "this producer does not know" (an older API or Desktop build) and
   * renders as unavailable, never as unset.
   */
  priority?: Priority | null;
  status: BranchRowStatus;
  /** Raw producer evidence retained for the universal status fold. */
  rawStatus?: string | null;
  prNumber: number | null;
  prTitle: string | null;
  prUrl: string | null;
  /** Any associated PR exists, even when no single selected PR is renderable. */
  hasPullRequest?: boolean;
  /** Full repository identity used with `prNumber` for deterministic PR sort. */
  prRepo?: string | null;
  /**
   * PR lifecycle for the badge color. NULL when there is no linked PR, and
   * (ISS-8422) also when there IS one whose state nobody observed — `prNumber`
   * separates the two, and `BranchPRBadge` renders them differently.
   */
  prState: BranchPrState | null;
  checksPassed: number | null;
  checksTotal: number | null;
  /** Checks rollup; NULL = enrichment absent (rendered as empty, NOT passing). */
  checksStatus: ChecksStatus | null;
  /** NULL = unavailable/gated — rendered as the empty-value affordance, NOT 0. */
  behind: number | null;
  ahead: number | null;
  /** NULL = enrichment unavailable (`lines_added`/`removed`) — NOT 0. */
  additions: number | null;
  deletions: number | null;
  /** Count of sessions linked to the branch (0 → empty-value affordance). */
  sessionCount: number;
  /** Canonical Wrote-membership identities, omitted by legacy/local producers. */
  sessions?: readonly BranchRowSession[];
  /** PR comment count (soft Epic F3 consumer); NULL until that lands. */
  commentCount: number | null;
  /**
   * Name-derived branch origin (`human` | `agent` | `bot`). Optional so
   * hand-built fixtures may omit it (treated as `human`); the wire→render adapter
   * always populates it via the shared `classifyBranchProvenance` SSOT. Drives the
   * informational `Agent`/`Bot` lead chip (FEA-4004 removed the provenance
   * default-hide; every branch always renders).
   */
  provenance?: BranchProvenance;
  lastActivityLabel: string;
  /**
   * PLN-1034: raw ISO genuine-activity timestamp — the sortable source
   * `lastActivityLabel` is formatted from. Optional so hand-built fixtures may
   * omit it, but the wire→render adapter always populates it, so every live row
   * sorts deterministically by recency regardless of the order the data source
   * returns rows in.
   */
  lastActivityAt?: string;
  /** Stable identity used as the final tie-breaker for every sortable column. */
  canonicalIdentity?: string;
};

/** Prefer preserved producer evidence without making legacy fixtures provide it. */
export function branchStatusEvidence(
  row: Pick<BranchRow, "rawStatus" | "status">
): string | null {
  return row.rawStatus === undefined ? row.status : row.rawStatus;
}

export type BranchRowPerson = {
  key: string;
  name: string;
  avatarUrl?: string;
  profileUrl?: string;
};

/**
 * ISS-8972 / ISS-10816 — one canonical linked Session as the Branch list chip
 * renders it, adapted from `canonicalProjection.common.membership.sessions`.
 *
 * Every field is REQUIRED so a row that reaches this type can always be
 * rendered without inventing a value. `ownerName` is nullable for a genuinely
 * ownerless Session; `ownerUnavailable` distinguishes an owner whose identity
 * could not be resolved.
 */
export type BranchRowSession = {
  /** Session artifact id — the chip's stable React key and reference id. */
  id: string;
  /** Display identity (slug when the Session has one, else its name or the untitled label). */
  slug: string;
  /** Surface-neutral route reference; each shell builds its own href from it. */
  navigableRef: string;
  /** Resolved owner display name, or null when no display identity is available. */
  ownerName: string | null;
  /** An owner exists but its display identity could not be resolved. */
  ownerUnavailable?: boolean;
  ownerAvatarUrl?: string;
  /** Presentation-only fold — `stale`/`waiting` can appear here, never in a column. */
  status: DisplayedSessionStatus;
  /** Producer-owned lifecycle evidence retained beside the display fold. */
  rawStatus?: string | null;
  /** How this Session participates in the Branch membership population. */
  relationshipLabel: string;
  /** ISO-8601 instant of the session's most recent contributing interaction on this branch. */
  occurredAt: string;
};

type BranchStatusVariant =
  | "info"
  | "warning"
  | "success"
  | "muted"
  | "destructive";

export const BRANCH_STATUS_CONFIG: Record<
  BranchRowStatus,
  { label: string; variant: BranchStatusVariant }
> = {
  [BranchRowStatus.Open]: { label: "Open", variant: "info" },
  [BranchRowStatus.Review]: { label: "In review", variant: "warning" },
  [BranchRowStatus.Merged]: { label: "Merged", variant: "success" },
  [BranchRowStatus.Draft]: { label: "Draft", variant: "muted" },
  [BranchRowStatus.Blocked]: {
    label: "Changes requested",
    variant: "destructive",
  },
  [BranchRowStatus.Closed]: { label: "Closed", variant: "muted" },
};

export type BranchFilters = {
  names: string[];
  statuses: string[];
  owners: string[];
  collaborators: string[];
  repos: string[];
  pullRequests: string[];
  lastActiveRanges: string[];
  tags: string[];
  /**
   * ISS-10332: priority members plus the unset token, the vocabulary
   * `PRIORITY_FILTER_VALUES` declares. Held as strings like every other facet
   * here (a URL and a saved view hand back strings) and narrowed through
   * {@link selectedPriorityFilterValues} at the two places that read it. A row
   * whose priority this producer never served satisfies no arm of an active
   * selection (`matchesPriorityFilter`).
   */
  priorities: string[];
  /** Legacy-only compatibility state; approved List controls never expose it. */
  sessionPresence: string[];
  /**
   * FEA-4003 — inclusive LOC-change lower/upper bounds over a row's
   * `additions + deletions`. `undefined` = that bound is open. A row whose LOC
   * is unavailable (both counts null) is EXCLUDED once either bound is set,
   * mirroring the date-window null-exclusion convention.
   */
  locMin?: number;
  locMax?: number;
  /**
   * PRD-721: the toolbar's free-text term over branch name and repository, the
   * fields the server page and Desktop both match. Absent and `""` mean none.
   */
  search?: string;
};

export const DEFAULT_BRANCH_FILTERS: BranchFilters = {
  names: [],
  statuses: [],
  owners: [],
  collaborators: [],
  repos: [],
  pullRequests: [],
  lastActiveRanges: [],
  tags: [],
  priorities: [],
  sessionPresence: [],
};

export function shortRepoName(repo: string): string {
  const segments = repo.split("/").filter(Boolean);
  return segments.at(-1) ?? repo;
}

/** Status facet options (all defined statuses, with per-status counts). */
export function branchStatusFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const counts = new Map<BranchRowStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return Object.values(BranchRowStatus).map((status) => ({
    id: status,
    label: BRANCH_STATUS_CONFIG[status].label,
    count: counts.get(status) ?? 0,
  }));
}

/** Repository facet options derived from the rows in view, with counts. */
export function branchRepoFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const repo = shortRepoName(row.repo);
    counts.set(repo, (counts.get(repo) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((repo) => ({
    id: repo,
    label: repo,
    count: counts.get(repo) ?? 0,
  }));
}

/** Legacy linked-session presence options retained while the approved List is gated. */
export function branchSessionPresenceFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  let has = 0;
  let none = 0;
  for (const row of rows) {
    if (rowHasLinkedSession(row)) {
      has += 1;
    } else {
      none += 1;
    }
  }
  return [
    { id: BranchSessionPresence.Has, label: "Has session", count: has },
    { id: BranchSessionPresence.None, label: "No session", count: none },
  ];
}

/** Whether a row has at least one linked session. */
export function rowHasLinkedSession(row: BranchRow): boolean {
  return row.sessionCount > 0;
}

/** Owner facet options derived from the rows in view, with counts. */
export function branchOwnerFilterOptions(
  rows: BranchRow[]
): TableFilterOption[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.owner, (counts.get(row.owner) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((owner) => ({
    id: owner,
    label: owner,
    count: counts.get(owner) ?? 0,
  }));
}

/**
 * A row's total LOC change (`additions + deletions`), or `null` when the LOC
 * enrichment is unavailable (BOTH counts null) — the null-exclusion signal the
 * range filter uses. A single available count is treated as present (the other
 * contributes 0), matching the server's `getBranchFileChangeTotals` fold.
 */
export function rowLocChange(row: BranchRow): number | null {
  if (row.additions === null && row.deletions === null) {
    return null;
  }
  return (row.additions ?? 0) + (row.deletions ?? 0);
}

/**
 * Normalizes a raw LOC-range selection to the stored/queried shape (FEA-4003):
 * drops non-finite bounds (`undefined`/`NaN`/`Infinity`) to `undefined`, floors
 * every finite bound at 0 (a negative `min` OR `max` clamps UP to 0, never
 * dropped — a `max: -5` becomes `max: 0`, matching the empty-corpus intent), and
 * — when both bounds are set but inverted (`min > max`) — clamps `min` down to
 * `max` so the range is never empty. Shared by the toolbar adapter (before
 * writing state) and any consumer that needs the same invariant the server
 * enforces.
 */
export function clampBranchLocRange(range: { min?: number; max?: number }): {
  min?: number;
  max?: number;
} {
  const min = normalizeLocBound(range.min);
  const max = normalizeLocBound(range.max);
  if (min !== undefined && max !== undefined && min > max) {
    return { min: max, max };
  }
  return { min, max };
}

function normalizeLocBound(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return;
  }
  // Floor at 0: a negative LOC bound is meaningless, so clamp up rather than drop.
  return Math.max(0, Math.floor(value));
}

/**
 * Whether the LOC-range bounds (if any) admit `row`. Rows with unavailable LOC
 * are EXCLUDED once either bound is set (mirroring the date-window
 * null-exclusion convention); with no bound set, every row passes.
 */
function matchesLocRange(
  row: BranchRow,
  min: number | undefined,
  max: number | undefined
): boolean {
  if (min === undefined && max === undefined) {
    return true;
  }
  const loc = rowLocChange(row);
  if (loc === null) {
    return false;
  }
  if (min !== undefined && loc < min) {
    return false;
  }
  return !(max !== undefined && loc > max);
}

export function filterBranchRows(
  rows: BranchRow[],
  filters: BranchFilters,
  options: {
    now?: number;
    omitFacet?: BranchFilterFacet;
    approved?: boolean;
  } = {}
): BranchRow[] {
  const now = options.now ?? Date.now();
  return rows.filter((row) =>
    matchesBranchFilters(
      row,
      filters,
      now,
      options.omitFacet,
      options.approved ?? false
    )
  );
}

export const BranchFilterFacet = BranchListFilterFacet;
export type BranchFilterFacet =
  (typeof BranchFilterFacet)[keyof typeof BranchFilterFacet];

/**
 * ISS-10332: the priority arm of {@link matchesBranchFilters}. An omitted row
 * priority satisfies no arm of an active selection (`matchesPriorityFilter`).
 */
function matchesPriorityFacet(
  row: BranchRow,
  filters: BranchFilters,
  omitFacet: BranchFilterFacet | undefined
): boolean {
  return (
    omitFacet === BranchFilterFacet.Priority ||
    matchesPriorityFilter(
      row.priority,
      selectedPriorityFilterValues(filters.priorities)
    )
  );
}

/**
 * ISS-10332: the priority facet's selection narrowed to the vocabulary the
 * producer accepts. A value outside it — a hand-edited URL, a saved view from a
 * build with a wider vocabulary — is dropped here rather than sent, because the
 * server page schema is a closed enum that would refuse the whole page for it.
 */
export function selectedPriorityFilterValues(
  values: readonly string[]
): PriorityFilterValue[] {
  return values.filter(isPriorityFilterValue);
}

function isPriorityFilterValue(value: string): value is PriorityFilterValue {
  return (PRIORITY_FILTER_VALUES as readonly string[]).includes(value);
}

export const BranchPullRequestPresence = BranchListPullRequestPresence;

export const BranchLastActiveRange = BranchListLastActiveRange;

function matchesBranchFilters(
  row: BranchRow,
  filters: BranchFilters,
  now: number,
  omitFacet: BranchFilterFacet | undefined,
  approved: boolean
): boolean {
  return (
    (omitFacet === BranchFilterFacet.Name ||
      filters.names.length === 0 ||
      filters.names.includes(row.branchName)) &&
    (omitFacet === BranchFilterFacet.Owner ||
      filters.owners.length === 0 ||
      filters.owners.includes(
        approved ? (row.ownerKey ?? row.owner) : row.owner
      )) &&
    (omitFacet === BranchFilterFacet.Collaborators ||
      filters.collaborators.length === 0 ||
      (row.collaborators ?? []).some((person) =>
        filters.collaborators.includes(person.key)
      )) &&
    (omitFacet === BranchFilterFacet.Status ||
      filters.statuses.length === 0 ||
      filters.statuses.includes(row.status)) &&
    (omitFacet === BranchFilterFacet.Repository ||
      filters.repos.length === 0 ||
      filters.repos.includes(approved ? row.repo : shortRepoName(row.repo))) &&
    (omitFacet === BranchFilterFacet.PullRequest ||
      filters.pullRequests.length === 0 ||
      filters.pullRequests.includes(
        row.hasPullRequest || row.prNumber !== null
          ? BranchPullRequestPresence.Linked
          : BranchPullRequestPresence.None
      )) &&
    (omitFacet === BranchFilterFacet.LastActive ||
      filters.lastActiveRanges.length === 0 ||
      filters.lastActiveRanges.includes(
        lastActiveRange(row.lastActivityAt, now) ?? ""
      )) &&
    (omitFacet === BranchFilterFacet.Tags ||
      filters.tags.length === 0 ||
      (row.tags ?? []).some((tag) => filters.tags.includes(tag.id))) &&
    matchesPriorityFacet(row, filters, omitFacet) &&
    (approved ||
      filters.sessionPresence.length === 0 ||
      filters.sessionPresence.includes(
        row.sessionCount > 0
          ? BranchSessionPresence.Has
          : BranchSessionPresence.None
      )) &&
    (omitFacet === BranchFilterFacet.Changes ||
      matchesLocRange(row, filters.locMin, filters.locMax)) &&
    matchesBranchSearch(row, filters.search)
  );
}

function matchesBranchSearch(row: BranchRow, search: string | undefined) {
  const term = search?.trim().toLocaleLowerCase();
  if (!term) {
    return true;
  }
  return (
    row.branchName.toLocaleLowerCase().includes(term) ||
    row.repo.toLocaleLowerCase().includes(term)
  );
}

/** Approved half-open Last-active bucket, or null for unavailable/anomalous time. */
export function lastActiveRange(
  value: string | undefined,
  now: number
): (typeof BranchLastActiveRange)[keyof typeof BranchLastActiveRange] | null {
  if (!value) {
    return null;
  }
  const occurredAt = Date.parse(value);
  const age = now - occurredAt;
  if (Number.isNaN(occurredAt) || age < 0) {
    return null;
  }
  if (age < 60 * 60 * 1000) {
    return BranchLastActiveRange.WithinLastHour;
  }
  if (age < 7 * 60 * 60 * 1000) {
    return BranchLastActiveRange.OneToSixHours;
  }
  if (age < 24 * 60 * 60 * 1000) {
    return BranchLastActiveRange.SevenToTwentyFourHours;
  }
  return BranchLastActiveRange.OneDayOrMore;
}
