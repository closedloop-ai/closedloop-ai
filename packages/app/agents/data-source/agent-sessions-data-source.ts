import type { SessionQuality } from "@repo/api/src/agent-session-filters";
import type {
  AgentComponentInvocationSessionTreePage,
  AgentComponentInvocationSessionTreeRequest,
} from "@repo/api/src/types/agent-component-invocation-session-tree";
import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionsPageData,
  AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type {
  AgentSessionEventsPage,
  AgentSessionEventsPageRequest,
} from "@repo/api/src/types/agent-session-events-page";
import type { RenameAgentSessionRequest } from "@repo/api/src/types/agent-session-field-mutation";
import { AgentSessionUsageAttribution } from "@repo/api/src/types/agent-session-usage-attribution";
import type { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import type { ArtifactActivityFeedResult } from "@repo/api/src/types/artifact-activity-feed";
import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
} from "@repo/api/src/types/artifact-collaborators";
import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import { buildSessionListQueryUrlParams } from "@repo/api/src/types/list-query-client-requests";
import type { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { ReadSource } from "@repo/api/src/types/read-source";
import { ApiError } from "../../shared/api/api-error";
import { readArtifactCollaborators } from "../../shared/lib/artifact-collaborators";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { withReadSource } from "../../shared/lib/read-source";
import { reflectToSettled } from "../../shared/lib/reflect-settled";
import {
  type AgentSessionCustomFieldValuesRead,
  httpAgentSessionCustomFieldValuesRead,
} from "./agent-session-custom-field-values";

/**
 * Query filters shared by the agent-session reads. Canonical home for the type
 * (re-exported from `../hooks/use-agent-sessions` for backward compatibility).
 */
export type AgentSessionQueryFilters = {
  /** Canonical component family scope, applied before list/usage aggregation. */
  componentSlug?: string;
  startDate?: string;
  endDate?: string;
  /**
   * FEA-3009: completion-time lower bound — keep only sessions that COMPLETED
   * (reached a terminal `endedAt`/`sessionEndedAt`) at or after this ISO
   * instant. Distinct from `startDate`, which the list route filters on
   * `lastActivityAt` (cloud) / `startedAt` (desktop): a long-running session
   * that started before this instant but finished after it IS counted, and one
   * that finished before it is not. Sessions with no completion timestamp
   * (still running) are excluded. Both surfaces filter the same completion
   * field so the "completed since I last looked" badge counts identically
   * across web and desktop.
   */
  completedAfter?: string;
  harness?: string;
  /** Single-value back-compat filters (e.g. the user-scoped deep link). */
  status?: string;
  userId?: string;
  /** Multi-select Filter facets, serialized as repeated query params. */
  statuses?: string[];
  userIds?: string[];
  repositories?: string[];
  /** Multi-select harness/model facets (options derived from the usage summary). */
  harnesses?: string[];
  models?: string[];
  /** Autonomy-tier ids ("high"/"mixed"/"guided"/"unknown") and cost-bucket ids. */
  autonomyTiers?: string[];
  costBuckets?: string[];
  /** Change-presence ids ("has_changes"/"no_changes") and PR-association ids ("has_pr"/"no_pr"). */
  changePresence?: string[];
  prAssociation?: string[];
  /**
   * FEA-3284/FEA-3345/FEA-4145 session quality: `substantive` (idle/phantom rows
   * hidden), `idle` (only idle/phantom rows), or `all` (both). Absent = the
   * fail-open `all` default (`DEFAULT_SESSION_QUALITY`), matching the server.
   */
  quality?: SessionQuality;
  search?: string;
  /**
   * PRD-721 / ISS-13035: the free-text term the cloud list route applies, sent
   * as its `search`. Distinct from the desktop-local `search` hint above, which
   * the cloud routes never receive, so only a host that shows the toolbar's
   * search sets it.
   */
  listSearch?: string;
  viewerScope?: AgentSessionViewerScope;
  teamId?: string;
  projectId?: string;
  /**
   * ISS-5355: multi-select Project facet — sessions that LINKED a document in
   * the selected project(s) (ISS-5236's "linked artifacts"). A different
   * dimension from the singular `projectId` scope above, which matches the
   * session artifact's own parent project; when both are present they AND.
   */
  projectIds?: string[];
  /**
   * FEA-4142: a projection hint for count-only readers (the Agents sidebar
   * activity badge) that need `total` but discard the rows. The desktop-local
   * source honors it by answering with a single SQL `COUNT(*)` — never
   * hydrating the session corpus into JS (the FEA-2038 db-host OOM) — and
   * returning an empty `items`. It is a local-DB optimization only: the cloud
   * list route already computes the identical `total` with a cheap
   * `db.sessionDetail.count()` and hydrates just the requested page, so the HTTP
   * source strips this hint rather than sending an unmodeled query param.
   */
  countOnly?: boolean;
  limit?: number;
  offset?: number;
  /** Column-header sort: column id + direction (server-ordered). */
  sortBy?: string;
  sortDir?: "asc" | "desc";
  /**
   * ISS-8335: the ORDERED multi-rule spelling of the same axis, one
   * `<column>:<dir>` entry per rule (build it with `toSessionSortRuleParams`).
   *
   * Additive and optional. When present the cloud route orders by every rule and
   * ignores `sortBy`/`sortDir`, which still ride along as the lead rule's
   * back-compat echo for any reader — or any older server — that knows only the
   * scalar pair.
   *
   * CLOUD-ONLY IN PRACTICE, and deliberately not silently so. Only the web v2
   * Sessions host stacks rules, and only the HTTP source serves it; the desktop
   * SQLite source orders in its own query and has no multi-rule path, so a
   * caller that could reach it must not send this. It is on the shared filter
   * type because the shared query key is built from that type — a field the key
   * did not carry would let two different orders share one cache entry.
   */
  sorts?: string[];
};

/**
 * The filters of the reads that can carry a usage summary: the shared shape PLUS
 * the ISS-5809 opt-in to the server-computed period-over-period comparison. Used
 * by `usage()` and — since ISS-6041 — by the combined `pageData()`, whose usage
 * half is the same read.
 *
 * Deliberately a SEPARATE type rather than an optional field on the shared one.
 * The list, analytics and export routes parse the strict base schema and model no
 * comparison, so a `comparison` reaching any of them is a 400 — and the first cut
 * of ISS-5809 put the field on the shared type and stripped it only in
 * `withListQuery`, leaving `analytics()` (which builds its URL with
 * `withBaseQuery`) free to forward it. Keeping the opt-in off the shared type
 * makes that unrepresentable rather than relying on every builder remembering.
 */
export type AgentSessionUsageQueryFilters = AgentSessionQueryFilters & {
  comparison?: AgentSessionComparisonMode;
};

/** A change notification surfaced by a live-capable data source. */
export type AgentSessionsChange = { sessionId?: string };

/**
 * Per-read options for the summary reads (ISS-7852). Mirrors
 * `BranchTraceOptions` rather than introducing a second convention.
 *
 * `signal` is TanStack Query's own per-query `AbortSignal`, which it aborts when
 * a read is superseded (the Sessions range switching 7d → 30d → 90d) or its
 * observer unmounts. Nothing rendered wrongly without it — `agentSessionKeys`
 * carries the filters, so a superseded answer already lands in its own cache
 * entry — it exists because the summary read is the heaviest one on the page.
 *
 * ISS-9806 — the port does NOT promise cancellation, and the three transports
 * that fill it mean three different things by accepting a signal. Do not fold
 * them; {@link AgentSessionsDataSource.cancelsInFlightReads} is the machine-
 * readable half of this, and these are the behaviors behind that boolean.
 *
 * - HTTP over the platform `fetch` (the web shell): the signal reaches `fetch`,
 *   which tears the request down mid-flight. The only real cancellation, and
 *   the only one of the three reporting `cancelsInFlightReads: true`.
 * - Desktop LOCAL (`createLocalAgentSessionsDataSource`): an `AbortSignal` is
 *   still not structured-cloneable, so ISS-9802 sends what CAN cross instead — a
 *   cancellation token stamped on the request and relayed main → db-host child →
 *   store thread, where the op observes it at its `yieldDbHostLoop()`
 *   checkpoints. A read superseded before it is ISSUED is still skipped; one
 *   already running now abandons its REMAINING statements instead of being paid
 *   for in full. The granularity is the statement boundary and no finer: a
 *   statement already executing inside the synchronous libSQL driver runs to
 *   completion. The source reports `cancelsInFlightReads: true` only when the
 *   preload actually exposes the cancel bridge, so an older installed build
 *   answers `false` and behaves exactly as it did before.
 * - Authenticated DESKTOP, which builds the SAME HTTP source below over
 *   `createCloudIpcFetch`: the weakest of the three, and the one that looks
 *   like the first. The signal rides the init and the bridge never reads it,
 *   and the source adds no pre-check of its own — so once the request is on the
 *   bridge an abort reaches nothing: it runs to completion in the main process
 *   and RESOLVES with a full answer that only query-core discards. (The shared
 *   client races the signal against its pre-request auth wait, so a read
 *   superseded in that window does still reject; the transport call itself is
 *   not raced. That window, not a bridge check, is the whole of what desktop
 *   cloud mode skips.) `honorsAbortSignal: false` on the desktop cloud adapter
 *   is what carries this through to `cancelsInFlightReads`.
 *
 * Optional so an injected source that predates it (a story, a test double)
 * still satisfies the port.
 */
export type AgentSessionsReadOptions = {
  signal?: AbortSignal;
  /**
   * ISS-12039: transport metadata a source may forward and must never treat as
   * a filter. Absent from a caller that predates it.
   */
  readInitiator?: ReadInitiator;
};

/** Optional per-session operations a source can truthfully serve. */
export const AgentSessionCapability = {
  ActivityPage: "activityPage",
  Collaborators: "collaborators",
  CustomFieldValues: "customFieldValues",
  EventsPage: "eventsPage",
  LinkedArtifacts: "linkedArtifacts",
  Rename: "renameSession",
  SessionInvocationTree: "sessionInvocationTree",
  UpdatePriority: "updatePriority",
} as const;
export type AgentSessionCapability =
  (typeof AgentSessionCapability)[keyof typeof AgentSessionCapability];

/** Capability projection for one selected Session row/detail source. */
export type AgentSessionCapabilities = Readonly<
  Record<AgentSessionCapability, boolean>
>;

/**
 * Typed per-domain data-source port for agent sessions (FEA-1834 / PLN-941).
 *
 * The shared read hooks call this port instead of speaking HTTP directly, so a
 * surface can supply a non-HTTP implementation (e.g. the desktop local DB over
 * IPC) without the hooks, query keys, or components changing. The HTTP
 * implementation below is the default; a `DataSourceProvider` may inject another.
 *
 * `subscribe` is optional: a live source (desktop local DB) implements it to
 * notify on data changes; the HTTP source omits it.
 */
export type AgentSessionsDataSource = AgentSessionCustomFieldValuesRead & {
  /** Absent on older/local sources that cannot constrain the component cohort. */
  supportsComponentScope?: boolean;
  /**
   * Stable identity for the active source. It is folded into the filter-based
   * React Query keys (see `agentSessionKeys`) so that a surface which can swap
   * sources — e.g. desktop moving between its local DB and the authenticated
   * backend — never serves one source's rows from another's cached filters.
   * Keep values short and stable (the HTTP source uses `"http"`).
   */
  scope: string;
  /**
   * ISS-9741: when this source's read is handed an `AbortSignal` and that signal
   * fires, is the work behind the read actually torn down? Absent is read as
   * `true` — the platform `fetch`'s behavior, and what a bare test double should
   * mean.
   *
   * It exists because query-core makes a BEHAVIORAL trade on the strength of a
   * `queryFn` touching `signal`. Consuming it opts the query out of the
   * keep-running-and-cache path on unmount (`Query#removeObserver` takes
   * `cancel({ revert: true })` instead of `cancelRetry()`), which is a clear win
   * when the abort really stops the work and a clear loss when it does not: the
   * unstoppable read runs to completion with its answer discarded, and the
   * remount that would have deduplicated against it starts a second one. On the
   * desktop-local source that second read is another whole-corpus
   * `aggregateAnalytics` on the bounded-read lane, measured at 27.1s.
   *
   * So this is not decoration. A caller deciding whether to hand a signal down
   * must ask here first; see `useAgentSessionAnalytics`.
   */
  cancelsInFlightReads?: boolean;
  /**
   * Returns the operations supported by the source selected for this Session.
   * Composite sources must answer per id; a union of their child capabilities
   * is not safe because it can advertise a control that its selected row cannot
   * commit or read.
   */
  capabilitiesForSession?(id: string): AgentSessionCapabilities;
  list(
    filters: AgentSessionQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionListResponse>;
  detail(
    id: string,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionDetail>;
  /** Optional for older adapters; null means the cloud endpoint is unavailable. */
  collaborators?(
    artifactIds: readonly string[]
  ): Promise<ArtifactCollaboratorBatchResponse | null>;
  usage(
    filters: AgentSessionUsageQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionUsageSummary>;
  /**
   * ISS-9741: signalled like its `usage` sibling. The Sessions Repository-facet
   * fallback re-reads this aggregate on every live-bridge flush (ISS-9553
   * classified `analyticsRoot` as `Always`), and it is the most expensive read
   * on the surface — 27.1s of `syncSource.aggregateAnalytics` on a 4,285-session
   * desktop corpus — so an unsignalled supersession stacks whole discarded scans.
   *
   * What the signal buys is per-implementation, and the difference decides
   * whether the caller passes one at all. Only a source over a transport that
   * tears the work down earns it — see
   * {@link AgentSessionsDataSource.cancelsInFlightReads}. A source that merely
   * CHECKS the signal does not: the work runs to completion regardless, so
   * accepting the signal would buy a discarded answer at the price of the
   * unmount-time dedupe that spares the reader a second 27s scan. `options` is
   * therefore genuinely optional here — absent is the desktop CLOUD case, and
   * since ISS-9802 the desktop-LOCAL source earns a signal whenever its preload
   * exposes the cancel bridge it needs to honour one.
   */
  analytics(
    filters: AgentSessionQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionAnalytics>;
  /**
   * Combined list + usage read (FEA-4157). The Sessions screen mounts the table
   * and its prop-driven summary cards together on every load; callers that need
   * both should prefer this over separate `list`/`usage` calls so an
   * implementation can serve them from one shared read — on desktop that is the
   * paginated list plus the metadata-only SQL usage aggregate — instead of two
   * independent scans of the same underlying rows. Mirrors
   * `BranchesDataSource.pageData`.
   *
   * ISS-6041: takes the USAGE filter shape, because its usage half is the same
   * read `usage()` issues and therefore accepts the same ISS-5809 `comparison`
   * opt-in. Without it the desktop Sessions view — which reads through this port,
   * over the very same HTTP source the web page uses when it is in Cloud mode —
   * had no way to ask for the period-over-period figures the API can already
   * serve, so one shared summary-card component chipped its deltas on web and
   * showed nothing on desktop. An implementation whose producer cannot compare
   * windows (the desktop-local SQLite source) drops the opt-in and answers with
   * no `comparison`, which every consumer already reads as "no chip".
   */
  pageData(
    filters: AgentSessionUsageQueryFilters,
    options?: AgentSessionsReadOptions
  ): Promise<AgentSessionsPageData>;
  /**
   * ISS-9857: one keyset page of a session's raw event stream past the detail
   * read's prefix (`AgentSessionDetail.eventsTruncated`). The cloud serves it
   * from `GET /agent-sessions/[id]/events`, the desktop-local source over its
   * IPC twin — same `(createdAt, externalEventId)` order, same page shape.
   *
   * Optional for the same reason `subscribe` is: the test doubles that build
   * this port by hand stay assignable, and a source that cannot page (none of
   * the shipped ones) simply offers no continuation — the transcript panel then
   * keeps its end-of-read note and no "load more" control.
   */
  eventsPage?(
    request: AgentSessionEventsPageRequest
  ): Promise<AgentSessionEventsPage>;
  /**
   * ISS-10737: every agent-component invocation of one session, as one tree.
   *
   * SESSION-scoped, not component-scoped, and deliberately NOT the 500-row
   * `AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS` read: clipping a tree orphans
   * every descendant of a dropped row, so its ancestry chain comes back WRONG
   * rather than short. Which is why the page bound is FOLLOWABLE rather than a
   * ceiling: the response carries `items`, the population `total`, and a
   * `nextCursor` that is omitted only at exhaustion. No bound and no dropped
   * count ride the wire — the WALKER derives both, because only it knows how
   * many pages it was willing to read (`agentComponentInvocationSessionTreeBound`).
   *
   * Optional for the same reason `eventsPage` is: a hand-built test double stays
   * assignable, and a source that cannot serve a tree (a mirrored renderer on an
   * installed build whose preload predates the channel) offers no method at all.
   * The Trace tab reads that absence as "this source cannot serve a tree", which
   * is a different sentence from an empty one.
   */
  sessionInvocationTree?(
    request: AgentComponentInvocationSessionTreeRequest
  ): Promise<AgentComponentInvocationSessionTreePage>;
  /**
   * ISS-11004: one newest-first page of a session's Activity feed, from
   * `GET /agent-sessions/[id]/activity` (ISS-10994). Optional because desktop
   * Local mode has no synced activity; the Activity tab reads that absence as
   * the empty state (ISS-11004 scope).
   */
  activityPage?(
    request: SessionActivityPageRequest
  ): Promise<ArtifactActivityFeedResult>;
  subscribe?(onChange: (change: AgentSessionsChange) => void): () => void;
  /**
   * ISS-10332 / PLN-2086 Milestone 2: set or clear one session's priority.
   *
   * The WRITE half of the port, and the seam the Priority cell's mutation reads
   * through, so a surface can supply a non-HTTP implementation (the desktop
   * local store, Milestone 3) without the hook, the cell or the grid changing.
   * Optional for the same reason `subscribe` is: a source that cannot write
   * (an older Desktop build's local source, a bare test double) offers no
   * method, and the host reads that absence as "do not mount the editor" — a
   * control that cannot commit must not be offered.
   *
   * `expectedPriority` is the optimistic guard; the cloud route refuses a stale
   * one with `stale_priority` and the hook rolls the row back.
   */
  updatePriority?(
    id: string,
    input: UpdateArtifactPriorityRequest
  ): Promise<void>;
  /**
   * ISS-8718: rename one session.
   *
   * The second WRITE verb on this port, and the seam the rename mutation reads
   * through, so the desktop local store supplies its own implementation without
   * the hook, the lead cell or the detail title changing. Optional for the same
   * reason `updatePriority` is: a source that cannot write (an older Desktop
   * build whose preload predates the channel, a bare test double) offers no
   * method, and the host reads that absence as "do not mount the editor" — a
   * control that cannot commit must not be offered.
   *
   * `expectedName` is the optimistic guard, compared server-side with the
   * RENDERED name (`nameOverride ?? artifacts.name`); the cloud route refuses a
   * stale one with `stale_name` and the hook rolls the row back. Omitted is
   * unguarded, which is the honest request when the producer does not know what
   * the reader was shown.
   */
  renameSession?(id: string, input: RenameAgentSessionInput): Promise<void>;
};

/**
 * ISS-8718: the rename write's input, the subset of
 * {@link AgentSessionUpdateRequest} the route accepts for a rename ALONE — it
 * refuses a body that pairs `name` with a priority or a grouping field
 * (PLN-2086 Milestone 1), so the two write verbs on this port cannot be
 * collapsed into one.
 */
export type RenameAgentSessionInput = RenameAgentSessionRequest;

/** The slice of the API client the HTTP data source needs. */
type AgentSessionsHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  /**
   * ISS-10332: the write verb `updatePriority` rides. Optional so a read-only
   * test double stays assignable; without it the built source offers no
   * `updatePriority` at all, which is what keeps "cannot write" a fact about
   * the transport rather than a runtime throw.
   */
  patch?<T>(path: string, body: unknown): Promise<T>;
  /**
   * ISS-9741: the transport capability `useApiClient` forwards off the
   * `ApiAdapter`. Optional so a narrow test double stays assignable; absent is
   * read as the platform `fetch`'s behavior (see
   * {@link AgentSessionsDataSource.cancelsInFlightReads}).
   */
  honorsAbortSignal?: boolean;
};

/**
 * ISS-10737: the tree page URL. The cursor is the ONLY query param, and it is
 * omitted rather than sent blank — `?cursor=` is a malformed token the route
 * refuses, which is deliberate (a walker silently restarted at the head never
 * terminates).
 */
function sessionInvocationTreePath(
  request: AgentComponentInvocationSessionTreeRequest
): string {
  const path = `/agent-sessions/${request.sessionId}/invocation-tree`;
  return request.cursor === undefined || request.cursor.length === 0
    ? path
    : `${path}?cursor=${encodeURIComponent(request.cursor)}`;
}

function withListQuery(
  path: string,
  filters: AgentSessionUsageQueryFilters
): string {
  // `countOnly` and `search` are desktop-local hints the cloud routes don't
  // model — strip them so the strict server schema accepts the request. Since
  // ISS-6041 the combined `pageData` filters can also carry the usage-only
  // `comparison` opt-in, which the list route's strict schema rejects with a 400;
  // strip it here so the ONE builder that serves every list URL cannot forward it.
  const {
    countOnly: _countOnly,
    search: _search,
    listSearch,
    comparison: _comparison,
    ...cloudFilters
  } = filters;
  const listFilters = listSearch
    ? { ...cloudFilters, search: listSearch }
    : cloudFilters;
  // PRD-721: filter and sort travel as `listQuery`; legacy params only when no
  // expression says the same thing.
  const qs = buildSearchParams(
    buildSessionListQueryUrlParams(listFilters) ?? listFilters
  ).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The filter fields the non-list routes — usage included — do NOT receive:
 * pagination, sort, and the desktop-local hints the cloud routes do not model.
 *
 * Exported because it is a CONTRACT, not an implementation detail: a field the
 * usage request never carries cannot move the usage aggregate, and consumers
 * reason about that. The desktop Sessions view's ISS-6041 comparison scope is
 * built by dropping exactly this set, so teaching the usage route to honor one of
 * these later must delete it here — which updates that consumer in the same edit
 * instead of leaving it grading a stale scope. `usage-query-contract.test.ts`
 * pins that the built usage URL really omits every key listed here.
 */
export const USAGE_STRIPPED_FILTER_KEYS = [
  "countOnly",
  "limit",
  "listSearch",
  "offset",
  "search",
  "sortBy",
  "sortDir",
  "sorts",
] as const;

/**
 * The base-schema field set: pagination, sort, and the desktop-local hints
 * removed. Shared by every non-list route so one builder cannot start forwarding
 * a field the others strip.
 *
 * Destructured rather than looped over {@link USAGE_STRIPPED_FILTER_KEYS} so the
 * removal stays type-checked against `AgentSessionQueryFilters`; the test named
 * above is what keeps the two statements of the set honest with each other.
 */
function toBaseFilters(
  filters: AgentSessionQueryFilters
): AgentSessionQueryFilters {
  const {
    countOnly: _countOnly,
    search: _search,
    listSearch: _listSearch,
    limit: _limit,
    offset: _offset,
    sortBy: _sortBy,
    sortDir: _sortDir,
    sorts: _sorts,
    ...baseFilters
  } = filters;
  return baseFilters;
}

function withBaseQuery(
  path: string,
  filters: AgentSessionQueryFilters
): string {
  // Non-list routes (usage, analytics, export) share the base schema, which does
  // not model pagination or sort. `AgentSessionQueryFilters` carries no
  // `comparison`, so analytics and export cannot forward the usage-only opt-in
  // that their strict schema rejects — the split is enforced by the TYPE rather
  // than by remembering to strip it in each builder (review of ISS-5809 found
  // exactly that omission here).
  const qs = buildSearchParams(toBaseFilters(filters)).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * FEA-4217: the CSV export URL for the CURRENT view.
 *
 * Built through the same `withBaseQuery` the analytics read uses, rather than a
 * second serializer beside it — the export route parses `baseAgentSessionQuerySchema`,
 * which is `.strict()`, so a hand-rolled query string that spelled one facet the
 * browser-URL way (`owner`, `repo`) or added a `format` the schema does not model
 * would 400 the whole download. Reusing the builder is what makes "export
 * respects the active filters + date range" true by construction.
 */
export function sessionsExportPath(filters: AgentSessionQueryFilters): string {
  return withBaseQuery("/agent-sessions/export", filters);
}

/** The base query PLUS the usage-only comparison opt-in. */
function withUsageQuery(
  path: string,
  filters: AgentSessionUsageQueryFilters
): string {
  const { comparison, ...rest } = filters;
  const qs = buildSearchParams({
    ...toBaseFilters(rest),
    ...(comparison ? { comparison } : {}),
    // The Sessions listing renders neither optional attribution lens. Request
    // only the totals/facets it consumes rather than hydrating every PR link.
    attribution: AgentSessionUsageAttribution.Omit,
  }).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings. Used by the web shell and by authenticated desktop. Behavior is
 * byte-identical to the former inline `queryFn` bodies in `use-agent-sessions`.
 */
export function createHttpAgentSessionsDataSource(
  api: AgentSessionsHttpClient
): AgentSessionsDataSource {
  const patch = api.patch;
  const capabilities = {
    ...HTTP_AGENT_SESSION_CAPABILITIES,
    [AgentSessionCapability.Rename]: patch !== undefined,
    [AgentSessionCapability.UpdatePriority]: patch !== undefined,
  } satisfies AgentSessionCapabilities;
  return {
    scope: HTTP_DATA_SOURCE_SCOPE,
    capabilitiesForSession: () => capabilities,
    supportsComponentScope: true,
    // ISS-9741: "HTTP" names the URL builder, not the wire. `apps/app` fills the
    // transport port with the platform `fetch`, but desktop cloud mode fills it
    // with an IPC bridge that accepts a signal and cannot act on it, so this
    // cannot be hardcoded true — it is whatever the adapter underneath reports.
    cancelsInFlightReads: api.honorsAbortSignal ?? true,
    // FEA-3120: stamp the read-source at the boundary. The HTTP source always
    // reads synced cloud state, so it is `cloud` unless the backend already
    // annotated the envelope with a more specific source — we never overwrite an
    // explicit server value.
    list: async (filters) =>
      withReadSource(
        requireComponentScope(
          await api.get<AgentSessionListResponse>(
            withListQuery("/agent-sessions", filters)
          ),
          filters
        ),
        ReadSource.Cloud
      ),
    detail: (id) => api.get<AgentSessionDetail>(`/agent-sessions/${id}`),
    collaborators: (artifactIds) =>
      readArtifactCollaborators(
        api,
        CollaboratorArtifactType.Session,
        artifactIds
      ),
    eventsPage: (request) =>
      api.get<AgentSessionEventsPage>(sessionEventsPagePath(request)),
    // ISS-10737: `GET /agent-sessions/[id]/invocation-tree`, one keyset page.
    sessionInvocationTree: (request) =>
      api.get<AgentComponentInvocationSessionTreePage>(
        sessionInvocationTreePath(request)
      ),
    activityPage: (request) =>
      api.get<ArtifactActivityFeedResult>(sessionActivityPagePath(request)),
    ...httpAgentSessionCustomFieldValuesRead(api),
    // ISS-10332: `PATCH /agent-sessions/[id]` with the priority keys ALONE —
    // the route refuses a body that pairs them with a rename or a grouping
    // field (PLN-2086 Milestone 1). The response row is not read back: the
    // hook re-reads the list once the write settles.
    ...(patch
      ? {
          updatePriority: async (
            id: string,
            input: UpdateArtifactPriorityRequest
          ) => {
            await patch(`/agent-sessions/${id}`, input);
          },
        }
      : {}),
    // ISS-8718: `PATCH /agent-sessions/[id]` with the rename keys ALONE, for the
    // same reason the priority write sends its own — the route refuses a body
    // that pairs them. The response row is not read back: the hook re-reads the
    // list once the write settles.
    ...(patch
      ? {
          renameSession: async (id: string, input: RenameAgentSessionInput) => {
            await patch(`/agent-sessions/${id}`, input);
          },
        }
      : {}),
    usage: (filters, options) =>
      readUsageSummary(api, filters, options?.signal),
    analytics: (filters, options) =>
      api.get<AgentSessionAnalytics>(
        withBaseQuery("/agent-sessions/analytics", filters),
        requestInitFor(options?.signal)
      ),
    // FEA-4157: no combined REST route yet — the redundant-read cost this exists
    // to avoid is a desktop-local (SQLite/IPC) concern; apps/api has no analogous
    // doubled scan today. Fetching both concurrently still saves one round trip's
    // worth of wall-clock time versus sequential awaits. Mirrors the Branches
    // HTTP `pageData`.
    //
    // FEA-4177 — independent failure domains: these are two separate requests, so
    // `Promise.all` would give them ONE failure domain (a usage failure would
    // reject the whole read and blank the table). The list is the required half
    // (rethrow its rejection so the table shows a real error), but a usage
    // rejection degrades ONLY the summary cards (`usage` omitted,
    // `usageError: true`) while the list still renders.
    //
    // whitlockk review: don't `await Promise.allSettled([list, usage])` — that makes
    // the required list WAIT for the optional usage request, so a list that has
    // already failed while usage stalls never surfaces its rejection and the page
    // hangs on loading. Reflect the usage promise to a settled result
    // IMMEDIATELY, await the list DIRECTLY (its rejection propagates the instant
    // it lands), then inspect usage only after the list resolves.
    pageData: async (filters, options) => {
      // ISS-7852: BOTH halves carry the query's signal — each is a separate
      // request, so threading only one leaves the other running. ISS-9806:
      // authenticated DESKTOP also reads through this source, and its cloud
      // bridge drops `init.signal`, so there an abort cancels only the QUERY:
      // both requests run to completion in the main process, answers discarded.
      const signal = options?.signal;
      // Start BOTH reads before awaiting so they run concurrently.
      const listPromise = api.get<AgentSessionListResponse>(
        withListQuery("/agent-sessions", filters),
        requestInitFor(signal)
      );
      // ISS-6041: the same usage read `usage()` issues, opt-in and deploy-skew
      // fallback included — a desktop reader in Cloud mode asks this one combined
      // read for the comparison the web page asks the standalone read for.
      const usageResultPromise = reflectToSettled(
        readUsageSummary(api, filters, signal)
      );
      // Await the required list directly — a list rejection throws here without
      // waiting on the optional usage read.
      const list = withReadSource(
        requireComponentScope(await listPromise, filters),
        ReadSource.Cloud
      );
      const usageResult = await usageResultPromise;
      if (usageResult.status === "rejected") {
        return { list, usageError: true };
      }
      return { list, usage: usageResult.value };
    },
  };
}

/**
 * The HTTP usage read, with the ISS-5809 comparison opt-in's deploy-skew
 * fallback.
 *
 * Shared by `usage()` and the combined `pageData()` (ISS-6041) so the two cannot
 * drift into disagreeing about what asking for a comparison costs when the API
 * does not know the param yet.
 */
async function readUsageSummary(
  api: AgentSessionsHttpClient,
  filters: AgentSessionUsageQueryFilters,
  signal?: AbortSignal
): Promise<AgentSessionUsageSummary> {
  const read = () =>
    api.get<AgentSessionUsageSummary>(
      withUsageQuery("/agent-sessions/usage", filters),
      requestInitFor(signal)
    );
  try {
    return requireComponentScope(await read(), filters);
  } catch (error) {
    // ISS-7852 — cancellation outranks the fallback below. The retry is a
    // SECOND network read, and the desktop cloud bridge deliberately does not
    // forward the signal, so issuing it after the query was superseded really
    // does put an obsolete usage read on the wire (a web `fetch` would at least
    // reject it immediately). Report the cancellation instead of retrying.
    signal?.throwIfAborted();
    // Independently deployed APIs can reject either usage-only option. Retry
    // the legacy shape only on a schema disagreement, never a timeout, auth
    // rejection, or server failure. The current listing does not consume the
    // restored attribution lenses, and comparison remains optional.
    if (!(error instanceof ApiError && error.status === 400)) {
      throw error;
    }
    const { comparison: _comparison, ...withoutComparison } = filters;
    try {
      return requireComponentScope(
        await api.get<AgentSessionUsageSummary>(
          withBaseQuery("/agent-sessions/usage", withoutComparison),
          requestInitFor(signal)
        ),
        filters
      );
    } catch {
      // whitlockk review: a 400 does not say WHICH part of the request the API
      // rejected, so this fallback also fires for a request that is simply bad
      // — a malformed window, an out-of-range page. When that happens the
      // legacy shape is rejected for the SAME underlying reason, and surfacing
      // the fallback's error would hand the caller the second complaint about a
      // request it never made. Report the original rejection; it is the one
      // that describes what the caller actually asked for.
      signal?.throwIfAborted();
      throw error;
    }
  }
}

/**
 * `scope` of the default HTTP source. Named so a caller that keys a cache by the
 * active source can name the default without re-typing the literal.
 */
export const HTTP_DATA_SOURCE_SCOPE = "http";

const HTTP_AGENT_SESSION_CAPABILITIES: AgentSessionCapabilities = {
  [AgentSessionCapability.ActivityPage]: true,
  [AgentSessionCapability.Collaborators]: true,
  [AgentSessionCapability.CustomFieldValues]: true,
  [AgentSessionCapability.EventsPage]: true,
  [AgentSessionCapability.LinkedArtifacts]: true,
  [AgentSessionCapability.Rename]: true,
  [AgentSessionCapability.SessionInvocationTree]: true,
  [AgentSessionCapability.UpdatePriority]: true,
};

/**
 * Resolves one per-session capability, preserving compatibility with sources
 * that predate the explicit projection.
 */
export function agentSessionSourceSupports(
  source: AgentSessionsDataSource,
  id: string,
  capability: AgentSessionCapability
): boolean {
  const projected = source.capabilitiesForSession?.(id);
  if (projected) {
    return projected[capability];
  }
  switch (capability) {
    case AgentSessionCapability.ActivityPage:
      return source.activityPage !== undefined;
    case AgentSessionCapability.Collaborators:
      return source.collaborators !== undefined;
    case AgentSessionCapability.CustomFieldValues:
      return source.customFieldValues !== undefined;
    case AgentSessionCapability.EventsPage:
      return source.eventsPage !== undefined;
    case AgentSessionCapability.LinkedArtifacts:
      return false;
    case AgentSessionCapability.Rename:
      return source.renameSession !== undefined;
    case AgentSessionCapability.SessionInvocationTree:
      return source.sessionInvocationTree !== undefined;
    case AgentSessionCapability.UpdatePriority:
      return source.updatePriority !== undefined;
    default: {
      const exhaustive: never = capability;
      return exhaustive;
    }
  }
}

/**
 * The request init carrying the query's `AbortSignal`, or nothing when there is
 * no signal to carry (ISS-7852).
 *
 * Returns `undefined` rather than `{ signal: undefined }` so a read issued
 * without a signal calls `api.get(path)` with the exact arity it always had —
 * the shared client would ignore the empty init either way, but every existing
 * caller-shape assertion in the suites stays a statement about the URL alone.
 */
function requestInitFor(
  signal: AbortSignal | undefined
): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

/**
 * The events-page URL. `cursor` and `limit` are sent only when the caller set
 * them, so the first page after the prefix and a default-sized page carry no
 * query string at all — the server applies its own defaults.
 */
export function sessionEventsPagePath(
  request: AgentSessionEventsPageRequest
): string {
  const params = new URLSearchParams();
  if (request.cursor) {
    params.set("cursor", request.cursor);
  }
  if (request.limit !== undefined) {
    params.set("limit", String(request.limit));
  }
  const qs = params.toString();
  return `/agent-sessions/${encodeURIComponent(request.id)}/events${qs ? `?${qs}` : ""}`;
}

export type SessionActivityPageRequest = {
  sessionId: string;
  /** The previous page's `nextCursor`; omitted for the first page. */
  cursor?: string;
  limit: number;
};

function sessionActivityPagePath(request: SessionActivityPageRequest): string {
  const params = new URLSearchParams({ limit: String(request.limit) });
  if (request.cursor) {
    params.set("cursor", request.cursor);
  }
  return `/agent-sessions/${encodeURIComponent(request.sessionId)}/activity?${params.toString()}`;
}

export function requireComponentScope<T extends { componentScope?: string }>(
  result: T,
  filters: AgentSessionQueryFilters
): T {
  if (
    filters.componentSlug &&
    result.componentScope !== filters.componentSlug
  ) {
    throw new Error("Component-scoped sessions unavailable");
  }
  return result;
}
