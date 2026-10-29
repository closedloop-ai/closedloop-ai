import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import {
  type OfferedSearchEntityType,
  SearchEntityType,
} from "@repo/api/src/types/search-entity-kind";
import {
  type ParsedSearchQuery,
  PriorityFilterKind,
  priorityOrdinal,
  SearchFilterOperator,
} from "@repo/api/src/types/search-query";
import {
  SEARCH_ENTITY_TYPE_ICONS,
  SEARCH_ENTITY_TYPE_LABELS,
} from "../lib/search-display";
import type { SearchSurfaceResult } from "../lib/search-surface-model";

/**
 * ISS-10345 — static, believable fixtures for `SearchSurfaceV2PageDemo`.
 * Presentational only (no DB/API/auth), but every `type:` value below is the
 * REAL wire kind the parser accepts (`type:agent_session`, not a
 * prototype-only shorthand like the old local mock's `type:session`) — the
 * same honesty bar `SearchEmptyOnRamp`'s own example queries hold themselves
 * to, and one the prior local mock in this prototype did not clear.
 */

/** A demo hit: the real `SearchSurfaceResult` shape, plus the entity kind the
 * demo's Type control filters on (the real shape carries no kind field of its
 * own — a host's `key`/`kindLabel`/`icon` are already resolved by the time
 * they reach the surface). */
export type SearchDemoHit = SearchSurfaceResult & {
  readonly entityType: OfferedSearchEntityType;
  /**
   * The projected `status`/`priority` the real `search_document` row carries,
   * so a committed `status:`/`priority` filter narrows THIS corpus instead of
   * being parsed and then ignored. Required rather than optional: a hit added
   * without them fails `tsc` here instead of silently matching every filter.
   * `priority: null` is the unset artifact `priority:none` finds.
   */
  readonly status: string;
  readonly priority: Priority | null;
};

function demoHit(
  entityType: OfferedSearchEntityType,
  fields: Omit<SearchDemoHit, "entityType" | "icon" | "kindLabel">
): SearchDemoHit {
  return {
    entityType,
    icon: SEARCH_ENTITY_TYPE_ICONS[entityType],
    kindLabel: SEARCH_ENTITY_TYPE_LABELS[entityType],
    ...fields,
  };
}

// Several hits per type for the busiest kinds (Document, Pull Request, Agent
// Session) so toggling the Type control visibly narrows a long list instead
// of leaving a single row.
export const SEARCH_DEMO_HITS: readonly SearchDemoHit[] = [
  demoHit(SearchEntityType.Document, {
    key: "document:prd-512",
    priority: Priority.High,
    status: DocumentStatus.Approved,
    title: "PRD 512 - Agent session collector hardening",
    snippet:
      "The collector must fold multi-turn <b>agent</b> transcripts into a single normalized session before the parser…",
    destination: "/documents/prd-512",
    meta: "Updated 2 hours ago",
  }),
  demoHit(SearchEntityType.Document, {
    key: "document:pln-1495",
    priority: Priority.Urgent,
    status: DocumentStatus.InReview,
    title: "PLN 1495 - Search results redesign implementation plan",
    snippet:
      "Fold the kind-pill strip into the query grammar so an <b>agent</b> can compose type filters inline…",
    destination: "/documents/pln-1495",
    meta: "Updated 4 hours ago",
  }),
  demoHit(SearchEntityType.Document, {
    key: "document:fea-4031",
    priority: Priority.High,
    status: IssueStatus.Blocked,
    title: "FEA 4031 - JQL-look query bar",
    snippet:
      "A first-class editable query bar with filter tokens and a suggestion popover, driven by an <b>agent</b>…",
    destination: "/documents/fea-4031",
    meta: "Updated 6 hours ago",
  }),
  demoHit(SearchEntityType.Document, {
    key: "document:prd-498",
    priority: Priority.Low,
    status: DocumentStatus.Draft,
    title: "PRD 498 - Containerized e2e for the agent runner",
    snippet:
      "Run the Playwright suite against the <b>agent</b> stack inside docker-in-Dagger for shift-left parity…",
    destination: "/documents/prd-498",
    meta: "Updated 1 day ago",
  }),
  demoHit(SearchEntityType.PullRequest, {
    key: "pull_request:fea-3877",
    priority: Priority.Medium,
    status: IssueStatus.InReview,
    title: "FEA-3877: VCS neutrality provider registry",
    snippet:
      "Introduces a provider registry so the <b>agent</b> runner resolves git vs. non-git backends at spawn time…",
    // A PR is a GitHub artifact this app has no in-app detail route for — a
    // real host would resolve the branch/document it is attached to, not
    // invent a route the product does not have.
    destination: null,
    meta: "Updated 5 hours ago",
  }),
  demoHit(SearchEntityType.PullRequest, {
    key: "pull_request:fea-4031",
    priority: Priority.High,
    status: IssueStatus.InReview,
    title: "FEA-4031: search-results prototype",
    snippet:
      "Adds the presentational search redesign prototype the <b>agent</b> team reviews before the production build…",
    destination: null,
    meta: "Updated 7 hours ago",
  }),
  demoHit(SearchEntityType.PullRequest, {
    key: "pull_request:fea-3944",
    priority: Priority.Low,
    status: IssueStatus.Done,
    title: "FEA-3944: Fullscreen dashboard widgets fill height",
    snippet:
      "Dismiss frozen tooltips on expand and let the <b>agent</b> dashboard widgets fill the viewport height…",
    destination: null,
    meta: "Updated 10 hours ago",
  }),
  demoHit(SearchEntityType.AgentSession, {
    key: "agent_session:night-crew-0724",
    priority: null,
    status: IssueStatus.Done,
    title: "claude/night-crew · 2026-07-24 03:12",
    snippet:
      "Spawned <b>agent</b> to triage the desktop chunk-load regression; ran typecheck, patched the GPU overlay…",
    destination: "/sessions/night-crew-0724",
    meta: "Updated 8 hours ago",
  }),
  demoHit(SearchEntityType.AgentSession, {
    key: "agent_session:produce-0724",
    priority: null,
    status: IssueStatus.InProgress,
    title: "codex/produce · 2026-07-24 01:40",
    snippet:
      "Produce loop dispatched a ready FEAT to a codex <b>agent</b>; opened a green fix PR and moved it to review…",
    destination: "/sessions/produce-0724",
    meta: "Updated 11 hours ago",
  }),
  demoHit(SearchEntityType.Branch, {
    key: "branch:fix-desktop-chunk-load",
    priority: Priority.Urgent,
    status: IssueStatus.Blocked,
    title: "fix/desktop-chunk-load-and-gpu-overlay",
    snippet:
      "Branch off main carrying the <b>agent</b>-authored fix for the renderer chunk-load failure on cold start…",
    destination: "/branches/fix-desktop-chunk-load-and-gpu-overlay",
    meta: "Updated 9 hours ago",
  }),
  demoHit(SearchEntityType.Comment, {
    key: "comment:fea-4031-1",
    priority: null,
    status: IssueStatus.Todo,
    title: "Comment on FEA-4031",
    snippet:
      "Pascoe: the kind-pill strip is horrible UX — fold it into the query model so the <b>agent</b> results read as one…",
    destination: "/documents/fea-4031#comment-1",
    meta: "Updated 1 day ago",
  }),
  demoHit(SearchEntityType.AgentComponent, {
    key: "agent_component:night-crew-triage",
    priority: Priority.Medium,
    status: IssueStatus.InProgress,
    title: "night-crew-triage",
    snippet:
      "An <b>agent</b> component that sweeps the inbox each night, opens PRs for green fixes, and defers the rest…",
    destination: "/agents/night-crew-triage",
    meta: "Updated 1 day ago",
  }),
  demoHit(SearchEntityType.Project, {
    key: "project:mikes-workspace",
    priority: null,
    status: ProjectStatus.InProgress,
    title: "Marisol's Workspace",
    snippet:
      "Workspace project holding the <b>agent</b> monitoring sprints and the search redesign track…",
    destination: "/projects/mikes-workspace",
    meta: "Updated 3 days ago",
  }),
];

// ---------------------------------------------------------------------------
// Demo state switcher — lets a reviewer see every `SearchSurfaceReadState`
// the real surface renders without a backend. This control is prototype-only
// and has no counterpart in the real `/search` page, where the ladder is
// derived from a real query result rather than picked.
// ---------------------------------------------------------------------------

export const SearchDemoState = {
  Results: "results",
  Empty: "empty",
  Loading: "loading",
  LoadError: "load-error",
  FilterError: "filter-error",
  NoResults: "no-results",
  TooMany: "too-many",
} as const;
export type SearchDemoState =
  (typeof SearchDemoState)[keyof typeof SearchDemoState];

export type SearchDemoStateMeta = {
  state: SearchDemoState;
  label: string;
  /** The query the bar shows when this state is selected. */
  query: string;
};

export const SEARCH_DEMO_STATES: readonly SearchDemoStateMeta[] = [
  { label: "Results", query: "agent", state: SearchDemoState.Results },
  { label: "Empty", query: "", state: SearchDemoState.Empty },
  {
    label: "Loading",
    query: "agent type:agent_session",
    state: SearchDemoState.Loading,
  },
  {
    label: "Load error",
    query: "agent type:agent_session",
    state: SearchDemoState.LoadError,
  },
  {
    label: "Filter error",
    query: "agent status:huge",
    state: SearchDemoState.FilterError,
  },
  {
    label: "No results",
    query: "quarterly-revenue-forecast type:branch",
    state: SearchDemoState.NoResults,
  },
  { label: "Too many", query: "agent", state: SearchDemoState.TooMany },
];

// ---------------------------------------------------------------------------
// Query evaluation over the fixture corpus
// ---------------------------------------------------------------------------

/**
 * Whether one fixture hit satisfies a COMMITTED query, evaluated against the
 * canonical {@link parseSearchQuery} output rather than a second grammar of the
 * demo's own — so the Type control, the on-ramp's example queries and anything
 * hand-typed into the bar all narrow this corpus the way the real route
 * narrows the real one. Without this the bar parsed a query and then showed
 * the whole corpus regardless, which is the control not driving the data it
 * presents (#7344 review).
 *
 * `project`, `updated` and `@owner` are parsed by the canonical grammar and do
 * NOT narrow here: these fixtures project no such column, and a predicate over
 * a field the corpus does not carry would decide by invention. A query using
 * one is still parsed (and still errors if malformed) — it simply adds no
 * constraint this mock can honor.
 */
export function matchesSearchDemoQuery(
  hit: SearchDemoHit,
  parsed: ParsedSearchQuery
): boolean {
  return (
    matchesTypeFilter(hit, parsed) &&
    matchesStatusFilter(hit, parsed) &&
    matchesPriorityFilter(hit, parsed) &&
    matchesFreeText(hit, parsed.text)
  );
}

function matchesTypeFilter(
  hit: SearchDemoHit,
  parsed: ParsedSearchQuery
): boolean {
  const kinds = parsed.filters.type?.kinds;
  if (kinds === undefined || kinds.length === 0) {
    return true;
  }
  return kinds.includes(hit.entityType);
}

function matchesStatusFilter(
  hit: SearchDemoHit,
  parsed: ParsedSearchQuery
): boolean {
  const filter = parsed.filters.status;
  if (filter === undefined) {
    return true;
  }
  const equal = hit.status === filter.value;
  return filter.operator === SearchFilterOperator.Neq ? !equal : equal;
}

function matchesPriorityFilter(
  hit: SearchDemoHit,
  parsed: ParsedSearchQuery
): boolean {
  const filter = parsed.filters.priority;
  if (filter === undefined) {
    return true;
  }

  if (filter.kind === PriorityFilterKind.Unset) {
    const isUnset = hit.priority === null;
    return filter.operator === SearchFilterOperator.Neq ? !isUnset : isUnset;
  }

  // An artifact with no priority is not a point on the LOW<…<URGENT line, so
  // every ordinal comparison excludes it — the same NULL semantics the query
  // service's SQL has, and the reason `priority:none` exists as its own arm.
  if (hit.priority === null) {
    return false;
  }
  const left = priorityOrdinal(hit.priority);
  const right = priorityOrdinal(filter.value);
  if (left === undefined || right === undefined) {
    return false;
  }
  return compareOrdinal(left, filter.operator, right);
}

// Exhaustive by construction: an operator added to SearchFilterOperator fails
// `tsc` here instead of silently falling through to a default that matches.
const ORDINAL_COMPARATORS: Readonly<
  Record<SearchFilterOperator, (left: number, right: number) => boolean>
> = {
  [SearchFilterOperator.Eq]: (left, right) => left === right,
  [SearchFilterOperator.Neq]: (left, right) => left !== right,
  [SearchFilterOperator.Gt]: (left, right) => left > right,
  [SearchFilterOperator.Lt]: (left, right) => left < right,
  [SearchFilterOperator.Gte]: (left, right) => left >= right,
  [SearchFilterOperator.Lte]: (left, right) => left <= right,
};

function compareOrdinal(
  left: number,
  operator: SearchFilterOperator,
  right: number
): boolean {
  return ORDINAL_COMPARATORS[operator](left, right);
}

const DEMO_TEXT_SEPARATOR = /\s+/;
const DEMO_SNIPPET_MARKUP = /<[^>]+>/g;

/**
 * The mock stand-in for the projection's full-text match: every term in the
 * parsed free text must appear in the hit's title or snippet, case-insensitively
 * and AND-ed, which is the dimension `zzzz` has to fail on.
 */
function matchesFreeText(hit: SearchDemoHit, text: string): boolean {
  const terms = text
    .toLowerCase()
    .split(DEMO_TEXT_SEPARATOR)
    .filter((term) => term.length > 0);
  if (terms.length === 0) {
    return true;
  }
  const haystack =
    `${hit.title} ${hit.snippet.replace(DEMO_SNIPPET_MARKUP, "")}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
