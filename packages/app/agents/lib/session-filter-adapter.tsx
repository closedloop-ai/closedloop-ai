import {
  SESSION_CHANGE_PRESENCE_OPTIONS,
  SESSION_COST_FILTER_OPTIONS,
  SESSION_PR_ASSOCIATION_OPTIONS,
} from "@repo/api/src/agent-session-filters";
import { SESSION_AUTONOMY_TIER_FILTER_OPTIONS } from "@repo/api/src/session-autonomy-tiers";
import type { AgentSessionUsageSummary } from "@repo/api/src/types/agent-session";
import type {
  FilterFacetGroup,
  TableFilterOption,
} from "@repo/design-system/components/ui/table-filters";
import {
  CircleDollarSignIcon,
  CircleDotIcon,
  CpuIcon,
  FolderGitIcon,
  FolderKanbanIcon,
  GaugeIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  TerminalIcon,
  UserIcon,
} from "lucide-react";
// Branches owns repo-name formatting; the sessions filter reuses the canonical branch-row shortRepoName to avoid a duplicate implementation.
import { shortRepoName } from "../../branches/lib/branch-row";
import { toggleFacetValue } from "../../shared/lib/facet-filter";
import {
  type FacetFilterParamMap,
  parseFacetFilterParams,
  writeFacetFilterParams,
} from "../../shared/lib/facet-filter-params";
import {
  resolveOwnerChipLabel,
  resolveProjectChipLabel,
  type SessionOwnerNameResolver,
  type SessionProjectNameResolver,
} from "./session-active-filter-chips";
import {
  dedupeSessionStatusFacetValues,
  SESSION_STATUS_FILTER_OPTIONS,
} from "./session-status-filters";

/** Multi-select Sessions filter selections (mirror the server query arrays). */
export type SessionFacetFilters = {
  statuses: string[];
  userIds: string[];
  repositories: string[];
  harnesses: string[];
  models: string[];
  autonomyTiers: string[];
  costBuckets: string[];
  changePresence: string[];
  prAssociation: string[];
  /** ISS-5355: Project facet. Web-only — see {@link SessionFilterFacetOptions}. */
  projectIds: string[];
};

export const DEFAULT_SESSION_FACET_FILTERS: SessionFacetFilters = {
  statuses: [],
  userIds: [],
  repositories: [],
  harnesses: [],
  models: [],
  autonomyTiers: [],
  costBuckets: [],
  changePresence: [],
  prAssociation: [],
  projectIds: [],
};

/**
 * URL param name per Sessions facet (FEA-3560). The list URL mirrors the
 * active facet selections so a detail→back (or reload/shared link) restores
 * the filtered view instead of page N of the unfiltered set. `page`, `search`,
 * and `userId` are owned by the page-level param writers, so the names here
 * must stay disjoint from those.
 */
export const SESSION_FACET_FILTER_PARAMS = {
  statuses: "status",
  userIds: "owner",
  repositories: "repo",
  harnesses: "harness",
  models: "model",
  autonomyTiers: "autonomy",
  costBuckets: "cost",
  changePresence: "changes",
  prAssociation: "pr",
  projectIds: "project",
} as const satisfies FacetFilterParamMap<SessionFacetFilters>;

/**
 * Parses the Sessions facet selections from list-URL search params. Returns
 * `DEFAULT_SESSION_FACET_FILTERS` (the same object) when no facet param is
 * present.
 *
 * ISS-4654 (review, #4651): a bookmark, a shared link, or a saved view can carry
 * a status this build does not offer. It resolves no facet option, so the chip
 * falls back to the raw wire string over an empty list, because the server has
 * no predicate for it either.
 *
 * ISS-5592 removed the fold that used to repair that for the two retired
 * spellings; nothing is folded now and the name says so (wongk/thadeusb,
 * #5075). What remains is deduping, done at the ONE place BOTH surfaces read
 * the URL (web
 * `sessions/page.tsx` and the desktop `SessionsView`), so they cannot diverge on
 * it. See {@link dedupeSessionStatusFacetValues}.
 */
export function parseSessionFacetFilterParams(
  params: Pick<URLSearchParams, "getAll">
): SessionFacetFilters {
  const parsed = parseFacetFilterParams(
    params,
    DEFAULT_SESSION_FACET_FILTERS,
    SESSION_FACET_FILTER_PARAMS
  );
  if (parsed.statuses.length === 0) {
    // Includes the nothing-to-restore case, where `parsed` IS
    // `DEFAULT_SESSION_FACET_FILTERS` — callers rely on that referential
    // identity to detect it, so it must not be spread away.
    return parsed;
  }
  return {
    ...parsed,
    statuses: dedupeSessionStatusFacetValues(parsed.statuses),
  };
}

/**
 * Writes the Sessions facet selections into `params` (deleting params for
 * empty facets so the default view keeps a clean URL).
 */
export function writeSessionFacetFilterParams(
  params: URLSearchParams,
  filters: SessionFacetFilters
): void {
  writeFacetFilterParams(params, filters, SESSION_FACET_FILTER_PARAMS);
}

/** Options for {@link sessionFilterFacetGroups}. */
export type SessionFilterFacetOptions = {
  /**
   * Include the Changes and Pull request facets (FEA-2505). Gated by the
   * `sessions-change-pr-filters` flag at the call site so the two facets roll
   * out independently of the always-on facets.
   */
  includeChangePrFilters?: boolean;
  /**
   * ISS-5355: include the Project facet. Web-only by design — a session's
   * project comes from its cloud artifact, and the desktop local producer
   * "cannot resolve cloud projects" (`shared-agent-sessions-api.ts`), so the
   * desktop omits it rather than render a facet that is permanently empty.
   */
  includeProjectFilter?: boolean;
  /**
   * ISS-4974: resolves an Owner display name off the org member list for a
   * selected user with no usage row in the active date window. Omitted when the
   * roster is unavailable, in which case the label falls through to the raw id —
   * a name is never guessed.
   */
  resolveOwnerName?: SessionOwnerNameResolver;
  /**
   * ISS-5355: resolves a Project display name off the org project list for a
   * selected project with no usage row in the active date window — the ordinary
   * case for a link arriving from the project-detail strip, which counts over an
   * unbounded window. Omitted when the list is unavailable, in which case the
   * label falls through to the raw id.
   */
  resolveProjectName?: SessionProjectNameResolver;
};

// Fixed status options use the canonical filter contract, so every surface sends
// the same cross-runtime values while preserving the existing Failed label for
// the ERROR status.
const STATUS_OPTIONS: TableFilterOption[] = SESSION_STATUS_FILTER_OPTIONS.map(
  ({ value, label }) => ({ id: value, label })
);

// Autonomy tiers and cost buckets are fixed threshold contracts (SSOT in
// @repo/api), mirroring the fixed Status facet — no data derivation needed.
const AUTONOMY_OPTIONS: TableFilterOption[] =
  SESSION_AUTONOMY_TIER_FILTER_OPTIONS.map(({ value, label }) => ({
    id: value,
    label,
  }));

// ISS-4481: renders the full Cost vocabulary (numeric buckets plus Unknown), so
// every displayed cost state is selectable (see SESSION_COST_FILTER_OPTIONS).
const COST_OPTIONS: TableFilterOption[] = SESSION_COST_FILTER_OPTIONS.map(
  ({ id, label }) => ({ id, label })
);

// Changes / Pull request are fixed presence contracts (SSOT in @repo/api),
// mirroring the fixed Status/Autonomy/Cost facets — no data derivation needed.
const CHANGE_PRESENCE_OPTIONS: TableFilterOption[] =
  SESSION_CHANGE_PRESENCE_OPTIONS.map(({ id, label }) => ({ id, label }));

const PR_ASSOCIATION_OPTIONS: TableFilterOption[] =
  SESSION_PR_ASSOCIATION_OPTIONS.map(({ id, label }) => ({ id, label }));

// Owner facet options (FEA-3330) derived from the usage `byUser` breakdown (the
// full corpus, not the current page), keyed by user id so the toggle threads the
// canonical `userIds` server filter; the label is the user's display name and
// email is searchable so typing either narrows the list.
// Ensure every currently-selected value has an option, so an out-of-range
// selection (its usage row dropped out of the window) still renders a labelled,
// removable chip instead of falling back to the raw wire value in the chip row.
// `formatFallbackLabel` turns a value with no usage row into a human label
// (e.g. `shortRepoName` for Repository); when the value's own label already IS
// the value (Harness/Model) the fallback is the identity.
function withSelectedValuesPresent(
  options: TableFilterOption[],
  selectedValues: readonly string[],
  formatFallbackLabel: (value: string) => string
): TableFilterOption[] {
  const present = new Set(options.map((option) => option.id));
  const withSelected = [...options];
  for (const value of selectedValues) {
    if (!present.has(value)) {
      withSelected.push({
        id: value,
        label: formatFallbackLabel(value),
        searchText: value,
      });
      present.add(value);
    }
  }
  return withSelected;
}

function ownerOptions(
  usage: AgentSessionUsageSummary | undefined,
  selectedUserIds: readonly string[],
  resolveOrgMemberName?: SessionOwnerNameResolver
): TableFilterOption[] {
  const options = (usage?.byUser ?? []).map((entry) => ({
    id: entry.userId,
    label: entry.userName,
    count: entry.sessionCount,
    searchText: `${entry.userName} ${entry.userEmail}`,
  }));
  // ISS-4974: a dropped-out-of-range owner has no usage row, so its label comes
  // from the org roster when one is available — and from the raw id when it is
  // not. `resolveOwnerChipLabel` is the SAME rule the `?userId=` scope chip
  // applies, so the two Owner paths cannot answer "we don't know this name" two
  // different ways. `inWindowLabel` is undefined here by construction: this
  // formatter only runs for a value with no option.
  return withSelectedValuesPresent(options, selectedUserIds, (value) =>
    resolveOwnerChipLabel(value, undefined, resolveOrgMemberName)
  );
}

function repositoryOptions(
  usage: AgentSessionUsageSummary | undefined,
  selectedRepositories: readonly string[]
): TableFilterOption[] {
  const options = (usage?.byRepository ?? []).map((entry) => ({
    id: entry.repositoryFullName,
    label: shortRepoName(entry.repositoryFullName),
    count: entry.sessionCount,
    searchText: entry.repositoryFullName,
  }));
  // An out-of-range repo still shortens to the canonical branch-row repo name
  // rather than leaking the full `org/repo` into the chip.
  return withSelectedValuesPresent(
    options,
    selectedRepositories,
    shortRepoName
  );
}

// Identity-labeled facet options from a usage breakdown (Harness/Model): the
// options are derived from the full corpus (not the current page), so the facet
// reflects the actual available data and stays correct under server-side
// pagination — the same contract the Repository facet uses (which stays separate
// because it shortens the label).
function breakdownOptions<T extends { sessionCount: number }>(
  entries: readonly T[] | undefined,
  getValue: (entry: T) => string
): TableFilterOption[] {
  return (entries ?? []).map((entry) => {
    const value = getValue(entry);
    return {
      id: value,
      label: value,
      count: entry.sessionCount,
      searchText: value,
    };
  });
}

// FEA-4303: Model facet options sourced from the PRIMARY-model rollup
// (`modelFilterOptions`), with every currently-selected model guaranteed present
// even when it is out of the visible range/window. Without this, an active
// `model=` selection whose option dropped out of range becomes a filter nobody
// can uncheck (the Filter badge still counts it, but there is no row to toggle
// and the toolbar renders no active-filter chips) — so a selection stays
// uncheckable from where it is shown. A selected value with no count still
// renders (count omitted) so it can be turned off.
function modelFacetOptions(
  usage: AgentSessionUsageSummary | undefined,
  selectedModels: readonly string[]
): TableFilterOption[] {
  const options = breakdownOptions(
    usage?.modelFilterOptions,
    (entry) => entry.model
  );
  // The Model label IS the value, so an out-of-range selection's fallback label
  // is the value itself (shared with Owner/Repository via the same helper).
  return withSelectedValuesPresent(options, selectedModels, (value) => value);
}

// ISS-5355: Project facet options from the usage `byProject` breakdown (the
// full corpus, not the current page), matching the Repository/Harness contract.
// A selected project that dropped out of the active window keeps its option so
// the selection stays uncheckable-from-where-it-is-shown, and its label comes
// from the org project list when one is available — NOT the raw uuid. That
// fallback matters more here than anywhere else: the project-detail strip links
// in with an unbounded window, so the selected project routinely has no usage
// row in the recipient's window, and `Project: 019f8008-19…` names nothing a
// reader can act on. `resolveProjectChipLabel` is the SAME rule the chip row
// applies (the chips derive from these options), so the facet and the chip
// cannot answer "we don't know this name" two different ways. `inWindowLabel`
// is undefined here by construction: this formatter only runs for a value with
// no option.
function projectOptions(
  usage: AgentSessionUsageSummary | undefined,
  selectedProjectIds: readonly string[],
  resolveOrgProjectName?: SessionProjectNameResolver
): TableFilterOption[] {
  const options = (usage?.byProject ?? []).map((entry) => ({
    id: entry.projectId,
    label: entry.projectName,
    count: entry.sessionCount,
    searchText: entry.projectName,
  }));
  return withSelectedValuesPresent(options, selectedProjectIds, (value) =>
    resolveProjectChipLabel(value, undefined, resolveOrgProjectName)
  );
}

/**
 * Map the Sessions filter selections to the generic `FilterPopover` facet groups
 * (Status / Autonomy / Harness / Model / Cost / Repository). Categorical options
 * (harness, model, repository) come from the usage summary breakdowns (the full
 * corpus, not the current page), so the facets stay correct under server-side
 * pagination; autonomy tiers and cost buckets are fixed threshold contracts.
 * Every group toggles into `SessionFacetFilters`, which the frontend hooks thread
 * to the API sessions route → service so filtering is applied to the query (and
 * combines with AND semantics across dimensions), not just client-side.
 */
export function sessionFilterFacetGroups(
  filters: SessionFacetFilters,
  onChange: (next: SessionFacetFilters) => void,
  usage?: AgentSessionUsageSummary,
  options?: SessionFilterFacetOptions
): FilterFacetGroup[] {
  const groups: FilterFacetGroup[] = [
    {
      id: "status",
      label: "Status",
      icon: <CircleDotIcon className="size-4" />,
      options: STATUS_OPTIONS,
      selectedValues: filters.statuses,
      onToggle: (value) =>
        onChange({
          ...filters,
          statuses: toggleFacetValue(filters.statuses, value),
        }),
    },
    // FEA-3330 / FEA-3725: Owner is always present, sitting right after Status
    // with the primary triage facets. Options are sourced from the usage
    // `byUser` breakdown (org-scoped); an empty selection applies no filter.
    {
      id: "owner",
      label: "Owner",
      icon: <UserIcon className="size-4" />,
      options: ownerOptions(usage, filters.userIds, options?.resolveOwnerName),
      selectedValues: filters.userIds,
      onToggle: (value) =>
        onChange({
          ...filters,
          userIds: toggleFacetValue(filters.userIds, value),
        }),
    },
    {
      id: "autonomy",
      label: "Autonomy",
      icon: <GaugeIcon className="size-4" />,
      options: AUTONOMY_OPTIONS,
      selectedValues: filters.autonomyTiers,
      onToggle: (value) =>
        onChange({
          ...filters,
          autonomyTiers: toggleFacetValue(filters.autonomyTiers, value),
        }),
    },
    {
      id: "harness",
      label: "Harness",
      icon: <TerminalIcon className="size-4" />,
      options: breakdownOptions(usage?.byHarness, (entry) => entry.harness),
      selectedValues: filters.harnesses,
      onToggle: (value) =>
        onChange({
          ...filters,
          harnesses: toggleFacetValue(filters.harnesses, value),
        }),
    },
    {
      id: "model",
      label: "Model",
      icon: <CpuIcon className="size-4" />,
      // FEA-4303: source the Model facet options from `modelFilterOptions`
      // (grouped by the PRIMARY displayed model), NOT `byModel` (which spans
      // secondary/subagent models). The filter predicate matches the primary
      // model too, so every selectable option corresponds to a value the table's
      // Model column can actually show. `modelFacetOptions` also keeps every
      // currently-selected model present so a selection is always uncheckable.
      // Older payloads without the field fall back to no options (rather than the
      // mismatched `byModel` list), and the empty facet shows a plain disabled
      // row instead of a bare search box.
      options: modelFacetOptions(usage, filters.models),
      emptyLabel: "No models in range",
      selectedValues: filters.models,
      onToggle: (value) =>
        onChange({
          ...filters,
          models: toggleFacetValue(filters.models, value),
        }),
    },
    {
      id: "cost",
      label: "Cost",
      icon: <CircleDollarSignIcon className="size-4" />,
      options: COST_OPTIONS,
      selectedValues: filters.costBuckets,
      onToggle: (value) =>
        onChange({
          ...filters,
          costBuckets: toggleFacetValue(filters.costBuckets, value),
        }),
    },
    {
      id: "repo",
      label: "Repository",
      icon: <FolderGitIcon className="size-4" />,
      options: repositoryOptions(usage, filters.repositories),
      selectedValues: filters.repositories,
      onToggle: (value) =>
        onChange({
          ...filters,
          repositories: toggleFacetValue(filters.repositories, value),
        }),
    },
  ];

  // Changes / Pull request roll out behind the sessions-change-pr-filters flag
  // (FEA-2505); when off they are omitted entirely so the selections stay empty
  // and no filter is applied. Inserted before Repository to keep the
  // session-shape facets (changes, PR) adjacent to the other session facets.
  if (options?.includeChangePrFilters) {
    groups.splice(groups.length - 1, 0, {
      id: "changes",
      label: "Changes",
      icon: <GitCompareIcon className="size-4" />,
      options: CHANGE_PRESENCE_OPTIONS,
      selectedValues: filters.changePresence,
      onToggle: (value) =>
        onChange({
          ...filters,
          changePresence: toggleFacetValue(filters.changePresence, value),
        }),
    });
    groups.splice(groups.length - 1, 0, {
      id: "pr",
      label: "Pull request",
      icon: <GitPullRequestIcon className="size-4" />,
      options: PR_ASSOCIATION_OPTIONS,
      selectedValues: filters.prAssociation,
      onToggle: (value) =>
        onChange({
          ...filters,
          prAssociation: toggleFacetValue(filters.prAssociation, value),
        }),
    });
  }

  // ISS-5355: Project is appended LAST — after the Changes/PR splices, which
  // insert relative to `groups.length - 1` and would otherwise reorder the
  // existing facets around it. Omitted entirely on surfaces that cannot resolve
  // projects, which keeps `projectIds` empty and applies no filter there.
  if (options?.includeProjectFilter) {
    groups.push({
      id: "project",
      label: "Project",
      icon: <FolderKanbanIcon className="size-4" />,
      options: projectOptions(
        usage,
        filters.projectIds,
        options.resolveProjectName
      ),
      emptyLabel: "No projects in range",
      selectedValues: filters.projectIds,
      onToggle: (value) =>
        onChange({
          ...filters,
          projectIds: toggleFacetValue(filters.projectIds, value),
        }),
    });
  }

  return groups;
}

/**
 * FEA-4177 — is any Sessions facet actively narrowing the set? Used to decide
 * whether the facet-unfiltered option read and the faceted summary read describe
 * the SAME scope: with no facet active they do, so the two can share one usage
 * read instead of issuing a duplicate no-facet aggregate.
 */
export function hasActiveSessionFacet(filters: SessionFacetFilters): boolean {
  return (
    filters.statuses.length > 0 ||
    filters.userIds.length > 0 ||
    filters.repositories.length > 0 ||
    filters.harnesses.length > 0 ||
    filters.models.length > 0 ||
    filters.autonomyTiers.length > 0 ||
    filters.costBuckets.length > 0 ||
    filters.changePresence.length > 0 ||
    filters.prAssociation.length > 0 ||
    filters.projectIds.length > 0
  );
}

/**
 * FEA-4181: whether any Sessions facet selection is active — used by the honest
 * empty state to tell a filtered-away scope (offer "clear filters") from a
 * genuinely-empty one. A facet counts as active when it has at least one
 * selected value; `DEFAULT_SESSION_FACET_FILTERS` (all empty arrays) is inactive.
 * The date-window and quality-segment filters are tracked separately by the
 * host, so this covers only the facet-popover selections.
 */
export function hasAnyActiveSessionFacet(
  filters: SessionFacetFilters
): boolean {
  return hasActiveSessionFacet(filters);
}

/**
 * ISS-4728: the Sessions facet filters with `userId` dropped from the Owner
 * facet, leaving every other facet untouched.
 *
 * Exists so the active-filter chip row can hand its host ONE next-filters value
 * to write together with the `?userId=` param strip when the scoped user is also
 * a selected Owner facet value. Removing the merged chip has to be a single URL
 * write — two writes both copy the same pre-click search-params snapshot, so the
 * second silently restores what the first removed (review cid 3701353686).
 *
 * Returns the same shape (a fresh object) whether or not the value was present,
 * so the un-merged case is simply "write these filters unchanged".
 */
export function withoutOwnerFacetValue(
  filters: SessionFacetFilters,
  userId: string
): SessionFacetFilters {
  return {
    ...filters,
    userIds: filters.userIds.filter((id) => id !== userId),
  };
}
