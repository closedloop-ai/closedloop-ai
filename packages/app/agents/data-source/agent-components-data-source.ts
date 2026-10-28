import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentFrequency,
  AgentComponentHonestSource,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import { SourceType } from "@repo/api/src/types/agent-component";
import {
  type AgentComponentSessionsPage,
  agentComponentInvocationsPageEnvelopeSchema,
  agentComponentSessionsPageEnvelopeSchema,
} from "@repo/api/src/types/agent-component-detail-page";
import type { AgentComponentInvocationReadPage } from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentVersionUsageResponse } from "@repo/api/src/types/agent-component-version-usage";
import type {
  AgentComponentPageDataRequest,
  AgentComponentPageDataResult,
} from "@repo/api/src/utils/agent-component-page-data";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar";
import { z } from "zod";
import { buildSearchParams } from "../../shared/lib/format-utils";
import { resolveComponentAuthors } from "../lib/agent-component-authors";

/**
 * Typed per-domain data-source port for the Agents workspace slice (FEA-2923).
 *
 * Mirrors `AgentSessionsDataSource` and `BranchesDataSource` exactly: the
 * shared read hooks call this port instead of speaking HTTP directly, so a
 * surface can supply a non-HTTP implementation (the desktop local DB or a
 * Phase-1 stub) without the hooks, query keys, or components changing. The
 * HTTP implementation below is the default; an `AgentComponentsDataSourceProvider`
 * may inject another.
 *
 * `subscribe` is optional: a live source (desktop local DB) implements it to
 * notify on data changes; the HTTP source omits it.
 */
export type AgentComponentsDataSource = {
  /**
   * Stable identity for the active source. Folded into React Query keys so a
   * surface that swaps sources never serves one source's rows from another's
   * cached filters. Keep values short and stable; distinct from the existing
   * AgentSessionsDataSource scope values ("http" / "local").
   *
   * HTTP source uses "agent-components:http"; the Phase-1 stub will use
   * "agent-components:stub".
   */
  scope: string;
  /**
   * ISS-6888: whether this source APPLIES the `startDate`/`endDate` bounds it is
   * handed, rather than merely accepting them.
   *
   * The Agents workspace asks two extra questions of a windowed source — the
   * preceding equivalent window (the summary cards' prior-period delta) and the
   * UNWINDOWED inventory (the facet option universe, so an owner idle in the
   * selected window stays listed as a zero-count option). Neither question has an
   * honest answer from a source that ignores the bounds: the preceding read would
   * return the SAME rows as the current one and every delta would compute a
   * FABRICATED 0%, and the "unwindowed" read would just be the windowed one
   * again. `false` is what suppresses both, and it renders NO delta rather than a
   * fake baseline.
   *
   * REQUIRED, not optional, and that is the point. This replaced a
   * `scope === "agent-components:http"` string comparison that was written when
   * the desktop local source genuinely ignored the window (FEA-3178) and was
   * never revisited after FEA-3196 taught it to apply the bounds — so desktop
   * silently lost both reads for months while the comparison stayed green. A
   * source that omits this field does not compile, so the next implementation has
   * to answer the question instead of inheriting whichever answer its scope
   * string happened to fall into.
   */
  honorsDateWindow: boolean;
  /**
   * ISS-11170: does aborting a `pageData` read tear down the work behind it?
   * Absent reads as `true`. Same contract, and same reason for existing, as
   * `AgentSessionsDataSource.cancelsInFlightReads` (ISS-9741): handing a read
   * its signal gives up query-core's in-flight dedupe on unmount, which only
   * pays where the abort reaches something that stops.
   */
  cancelsInFlightReads?: boolean;
  list(
    filters: AgentComponentQueryFilters
  ): Promise<AgentComponentListResponse>;
  /** Rejects (404 ApiError) when the slug is not found; never resolves null. */
  detail(slug: string): Promise<AgentComponentDetail>;
  /** Optional on older/local sources with no daily invocation read. */
  frequency?(
    slug: string,
    windowDays: number
  ): Promise<AgentComponentFrequency>;
  /** Optional on older sources; continuation tokens belong to this source only. */
  sessionPage?(
    slug: string,
    cursor: string
  ): Promise<AgentComponentSessionsPage>;
  invocationPage?(
    slug: string,
    cursor: string
  ): Promise<AgentComponentInvocationReadPage>;
  /**
   * ISS-6822: the BOUNDED read behind the Agents workspace — one call returning
   * the current page, the matched total, both summary aggregates, and the facet
   * universe with counts, instead of up to three full-inventory `list` calls the
   * reader then reduces itself.
   *
   * OPTIONAL, and that is the compatibility contract, not an oversight. A source
   * that does not implement it (a stub, a test double, or a desktop build whose
   * preload predates the IPC method) simply omits it, and `AgentsGroupedList`
   * keeps using the `list`-based path unchanged. Absence degrades to the old
   * read; it never fails.
   */
  pageData?(
    request: AgentComponentPageDataRequest,
    options?: AgentComponentsReadOptions
  ): Promise<AgentComponentPageDataResult>;
  /**
   * ISS-10467/ISS-10468: one or more CONTENT VERSIONS' own usage for the
   * component detail's drill-down and side-by-side compare, plus the family
   * usage no version can claim.
   *
   * OPTIONAL, and absence is a CAPABILITY answer, not a zero. A source that
   * cannot scope usage by version (a stub, a test double, a desktop preload
   * that predates the IPC channel) omits the method, and the drill-down renders
   * its "not available on this surface" state rather than a fabricated `0` —
   * the same present-vs-absent discipline `pageData` above carries, and the same
   * ISS-5363 distinction the figures inside the payload keep.
   */
  versionUsage?(
    slug: string,
    versionHashes: readonly string[]
  ): Promise<AgentComponentVersionUsageResponse>;
  subscribe?(onChange: (change: AgentComponentsChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type AgentComponentsHttpClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  /** Forwarded off the `ApiAdapter`; absent reads as the platform `fetch`. */
  honorsAbortSignal?: boolean;
};

function withQuery(path: string, filters: Record<string, unknown>): string {
  const qs = buildSearchParams(filters).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Maps a raw `AgentComponent` response row from `GET /agent-components` to the
 * `AgentComponent` render shape expected by the workspace slice.
 *
 * The real endpoint already returns fields in the canonical shape (id=uuid,
 * slug=`kind::key` identity, computeTargetIds, firstSeenAt, lastSeenAt), so this
 * function is a typed pass-through that validates the shape at the seam
 * boundary — no field guessing or unsafe casts.
 */
export function adaptAgentComponentToResponse(
  raw: AgentComponent
): AgentComponent {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    kind: raw.kind,
    sourceType: raw.sourceType,
    source: raw.source,
    harness: raw.harness,
    invocations: raw.invocations,
    sessions: raw.sessions,
    // ISS-5534/ISS-6205: the parent-pack identity the invocations de-duplication
    // matches a plugin's rollup against its children on. Omission-preserving,
    // because absence is not a default here but the version-skew PROBE: a plugin
    // row with no `packIds` means "this producer cannot report parentage", which
    // drops that rollup and marks the total inexact. Writing `packIds: undefined`
    // would be equivalent for that read but breaks the contract's present-vs-absent
    // distinction (`packages/api/src/types/agent-component.ts`: never `null`,
    // never `[]`, omitted instead) for anything probing with `in`. An empty array
    // is truthy and so still carried — "belongs to no pack" is a real answer this
    // must not collapse into "unknown".
    ...(raw.packIds ? { packIds: raw.packIds } : {}),
    // ISS-4667: LOC/$. A server that predates ISS-4667 omits the canonical
    // field and sends the KLOC-unit `klocPerDollar`; the shared resolver scales
    // it so the metric column never renders a thousand-times-too-small ~0.00.
    locPerDollar: resolveLocPerDollar(raw.locPerDollar, raw.klocPerDollar),
    // ISS-10730: WHICH operand the suppression could not cover, carried through
    // verbatim so a null ratio is not the only thing a reader gets. Omission-
    // preserving like the optional fields around it: a server that predates the
    // field sends nothing, and absence is "reason not stated" — distinct from a
    // present-but-undefined key for anything probing with `in`.
    ...(raw.locPerDollarUncoveredOperand
      ? { locPerDollarUncoveredOperand: raw.locPerDollarUncoveredOperand }
      : {}),
    trend: raw.trend,
    // FEA-4098 (Slice 3) + FEA-4247: `collaborators` is the authors people-set
    // (discoverer + editors) from the version lineage, with the server-side
    // compute-target owner fallback for legacy/unlinked rows. Derive through
    // `resolveComponentAuthors` so a version-skewed server that only sent the
    // deprecated single-`owner` compat alias still surfaces an Owner here
    // instead of the blank the FEA-4098 refactor left behind.
    collaborators: resolveComponentAuthors(raw),
    computeTargetIds: raw.computeTargetIds,
    firstSeenAt: raw.firstSeenAt,
    lastSeenAt: raw.lastSeenAt,
    // `lastInvokedAt` is optional (absent for never-invoked components); only
    // copy it when present so the "recently active" indicator (FEA-3179) keys
    // off real usage recency instead of always seeing `undefined`.
    ...(raw.lastInvokedAt ? { lastInvokedAt: raw.lastInvokedAt } : {}),
    // FEA-3982: the exact-version fingerprint and its short display badge. Carried
    // as a pair because the contract emits them as one ("present exactly when
    // `versionId` is"), and omission-preserving for the same reason as the fields
    // around it: absence is the contract's "unversioned / name-only", which a
    // present-but-undefined key would blur for anything probing with `in`.
    ...(raw.versionId ? { versionId: raw.versionId } : {}),
    ...(raw.fingerprint ? { fingerprint: raw.fingerprint } : {}),
    // FEA-4267: carry the collapsed-family version count through so the table can
    // render the quiet "N versions" signal. Optional and additive — the server
    // emits it only for a multi-version family (never `1`), and a version-skewed
    // server that predates the field simply omits it, so absence degrades to the
    // single-version case with no signal.
    ...(raw.versionCount ? { versionCount: raw.versionCount } : {}),
    // ISS-5009: the honest Source projection. This builder names every field it
    // keeps and silently drops the rest, so an additive DTO field needs an
    // explicit line here or the flag-gated Source cell never sees it and every
    // row falls back to the legacy echo. Omission-preserving like the two
    // optional fields above: a server that predates the field sends nothing, and
    // absence is the contract's "assume `source` is meaningful" — writing
    // `honestSource: undefined` instead would make the key present-but-undefined
    // and blur that distinction for anything that probes with `in` — which is
    // equally why a raw source that fails narrowing has to drop the key rather
    // than spread the `undefined` the narrower returned.
    ...honestSourceEntry(raw.honestSource),
  };
}

/**
 * The HTTP data source — the single place that builds the REST URLs/query
 * strings for the Agents workspace slice. Used by the web shell and by
 * authenticated desktop.
 *
 * `list()` calls `GET /agent-components` and returns `AgentComponentListResponse`
 * directly — the real endpoint performs org-level dedup and usage aggregation
 * server-side, so no client-side adaptation of the legacy `/agents` shape is
 * needed.
 *
 * `detail()` calls `GET /agent-components/{slug}` where `slug` is the org-level
 * identity slug (`AgentComponent.slug`, `kind::key`) — NOT the DB UUID (`id`).
 * If the server responds 404, the HTTP client throws an `ApiError` with status
 * 404, satisfying the port contract (rejects, never resolves null).
 */
export function createHttpAgentComponentsDataSource(
  apiClient: AgentComponentsHttpClient
): AgentComponentsDataSource {
  return {
    scope: "agent-components:http",

    // FEA-3160/FEA-3178: the window is enforced SERVER-SIDE by
    // `GET /agent-components`, so a preceding-window read returns a genuinely
    // different population and an unwindowed read a genuinely wider one.
    honorsDateWindow: true,

    // ISS-11170: the web `fetch` tears the request down; the desktop cloud IPC
    // bridge cannot, and its adapter says so through `honorsAbortSignal`.
    cancelsInFlightReads: apiClient.honorsAbortSignal ?? true,

    list: async (filters) => {
      const response = await apiClient.get<AgentComponentListResponse>(
        withQuery("/agent-components", filters)
      );
      return {
        items: response.items.map(adaptAgentComponentToResponse),
        total: response.total,
        hasMore: response.hasMore,
      };
    },

    // ISS-6822: the bounded page-data read. The rows come back already sorted,
    // filtered, and paged by the SAME shared reduction the client would have
    // run, so they are mapped through the identical skew adapter `list` uses —
    // a page row and a list row are the same wire shape and must not be
    // normalized two different ways.
    pageData: async (request, options) => {
      const response = await apiClient.get<AgentComponentPageDataResult>(
        withQuery("/agent-components/page-data", pageDataQuery(request)),
        options
      );
      return {
        ...response,
        items: response.items.map(adaptAgentComponentToResponse),
      };
    },

    // Encode the slug into the single path segment: org-identity slugs are
    // `${kind}::${key}` and some keys contain a slash (skills key on `/name`),
    // which would otherwise split into extra path segments and miss the
    // single-segment `[slug]` detail route — a 404 even though the row appeared
    // in the list. Next's route matcher decodes the captured segment before it
    // reaches the handler, so the encoded form round-trips to the raw slug —
    // encode exactly once here, never twice.
    detail: async (slug) => {
      const raw = await apiClient.get<AgentComponentDetail>(
        `/agent-components/${encodeURIComponent(slug)}`
      );
      return adaptAgentComponentDetailToResponse(raw);
    },
    frequency: async (slug, windowDays) => {
      const response = await apiClient.get<unknown>(
        `/agent-components/${encodeURIComponent(slug)}/frequency?${new URLSearchParams({ windowDays: String(windowDays) })}`
      );
      return parseAgentComponentFrequency(response);
    },

    sessionPage: async (slug, cursor) => {
      const response = await apiClient.get<AgentComponentSessionsPage>(
        `/agent-components/${encodeURIComponent(slug)}/sessions?${new URLSearchParams({ cursor })}`
      );
      agentComponentSessionsPageEnvelopeSchema.parse(response);
      return response;
    },
    invocationPage: async (slug, cursor) => {
      const response = await apiClient.get<AgentComponentInvocationReadPage>(
        `/agent-components/${encodeURIComponent(slug)}/invocations?${new URLSearchParams({ cursor })}`
      );
      agentComponentInvocationsPageEnvelopeSchema.parse(response);
      return response;
    },

    // ISS-10467/ISS-10468: the per-version drill-down. The slug is encoded
    // exactly once, for the same reason `detail` encodes it — an org-identity
    // slug can contain a slash (skills key on `/name`) and would otherwise split
    // into extra path segments and miss the single-segment `[slug]` route. The
    // versions ride as REPEATED `version` params, which is the shape the route's
    // shared `repeatedQueryArray` preprocessor reads.
    versionUsage: (slug, versionHashes) => {
      const query = new URLSearchParams();
      for (const hash of versionHashes) {
        query.append("version", hash);
      }
      return apiClient.get<AgentComponentVersionUsageResponse>(
        `/agent-components/${encodeURIComponent(slug)}/version-usage?${query.toString()}`
      );
    },

    // No `subscribe` — HTTP is poll-only, exactly like the Sessions HTTP source.
  };
}

/**
 * Maps a raw `AgentComponentDetail` response from `GET /agent-components/{slug}`
 * to the detail render shape, tolerating version skew the same way
 * {@link adaptAgentComponentToResponse} does for the list row.
 *
 * ISS-4667: a server that predates the rename omits the canonical `locPerDollar`
 * and sends KLOC-unit `klocPerDollar` (scaled by the shared resolver), and sends
 * the percentage lift under the unit-free `klocDelta` instead of `locDelta`.
 * Without this, a current web or cloud-desktop client opening the row against an
 * older API would render LOC/$ and its delta as unavailable even though the data
 * is present under the old names. The rest of the payload passes through
 * unchanged (it is already the canonical detail shape).
 */
export function adaptAgentComponentDetailToResponse(
  raw: AgentComponentDetail
): AgentComponentDetail {
  return {
    ...raw,
    locPerDollar: resolveLocPerDollar(raw.locPerDollar, raw.klocPerDollar),
    // A percentage lift is unit-free, so an old producer's `klocDelta` carries
    // the SAME number under the old name — a straight fallback, no scaling. Only
    // an OMITTED canonical field (`undefined`) falls back; a present `null` is the
    // producer's honest "not computable" and stays null.
    locDelta:
      raw.locDelta === undefined ? (raw.klocDelta ?? null) : raw.locDelta,
    // ISS-4798: a server that predates the cohort rollup OMITS `mergedPrs`
    // entirely. This adapter previously spread the payload unchanged, and the
    // Merged PRs card's `numOrDash` only recognizes `null`, so an `undefined`
    // reached `Intl.NumberFormat.format` and rendered the literal `NaN` — on web
    // and in desktop cloud mode alike. Normalizing omission to the contract's
    // own "not computable" value keeps the card on its honest dash instead.
    mergedPrs: raw.mergedPrs ?? null,
    // ISS-5521 (codex review, #4962): `mergedPrsTruncated` is deliberately NOT
    // normalized here — it rides through the spread above exactly as the
    // producer sent it, including as an omission.
    //
    // This one is the opposite case to `mergedPrs` right above. There, omission
    // has a true meaning on the contract ("not computable") and `null` is how
    // that meaning is spelled. Here, an older server OMITS the field while
    // having applied the very same cohort scan cap it cannot yet disclose, so
    // coercing the omission to `false` would make the card assert the count
    // covered "every session" precisely when it did not — reintroducing, under
    // version skew, the overstatement this ticket exists to remove. Omission is
    // UNKNOWN, and `componentMetrics` renders unknown as its own third state:
    // no floor marker, and no full-cohort claim either.
  };
}

/**
 * ISS-6822: flatten a page-data request into the endpoint's query params.
 *
 * The multi-select facets are emitted as REPEATED params (`buildSearchParams`
 * appends one entry per array member), which is what the route's `facetArray`
 * preprocessor reads. The two flag gates are emitted explicitly rather than
 * omitted when false: the server treats only the literal `"true"` as enabled, so
 * a spelled-out `false` and an omission mean the same thing, and spelling it out
 * keeps the request self-describing in a network log.
 *
 * Window bounds preserve omission — `buildSearchParams` skips `undefined`, so an
 * all-time view sends no `startDate` and a range with no prior period sends no
 * `prevStart`/`prevEnd`, which is exactly how the server distinguishes "no
 * baseline" from "an empty baseline".
 */
function pageDataQuery(
  request: AgentComponentPageDataRequest
): Record<string, unknown> {
  return {
    startDate: request.startDate,
    prevStart: request.prevStart,
    prevEnd: request.prevEnd,
    unwindowedFacetUniverse: request.unwindowedFacetUniverse,
    kinds: request.filters.kinds,
    collaborators: request.filters.collaborators,
    sources: request.filters.sources,
    harnesses: request.filters.harnesses,
    search: request.filters.search,
    sortBy: request.sortBy,
    sortDir: request.sortDir,
    page: request.page,
    pageSize: request.pageSize,
    honestSource: request.honestSource,
    dedupePluginRollups: request.dedupePluginRollups,
  };
}

const VALID_SOURCE_TYPES = new Set<string>(Object.values(SourceType));

function narrowHonestSource(
  raw: AgentComponentHonestSource
): AgentComponentHonestSource | undefined {
  if (raw.sourceType && !VALID_SOURCE_TYPES.has(raw.sourceType)) {
    return undefined;
  }
  return raw;
}

/**
 * The omission-preserving `honestSource` entry for the field-by-field adapter.
 * A raw source whose `sourceType` this build's enum cannot name narrows to
 * `undefined`, and spreading that would leave the key present-but-undefined —
 * the one state the ISS-5009 omission contract exists to keep off the DTO.
 */
function honestSourceEntry(raw: AgentComponentHonestSource | undefined): {
  honestSource?: AgentComponentHonestSource;
} {
  const narrowed = raw ? narrowHonestSource(raw) : undefined;
  return narrowed ? { honestSource: narrowed } : {};
}

/**
 * Per-read options for `pageData`. This port's own type, not an alias of
 * `AgentSessionsReadOptions`: a per-port copy, as that type is of
 * `BranchTraceOptions`, so either port can grow a field the other does not take.
 */
export type AgentComponentsReadOptions = {
  signal?: AbortSignal;
};

const componentFrequencySchema = z.object({
  windowDays: z.number().int().positive(),
  componentKey: z.string().optional(),
  points: z.array(
    z.object({
      day: z.iso.date(),
      invocations: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
  ),
});

/** Shared HTTP/IPC response boundary for the optional daily usage read. */
export function parseAgentComponentFrequency(
  value: unknown
): AgentComponentFrequency {
  return componentFrequencySchema.parse(value);
}
