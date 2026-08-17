import type {
  AgentComponent,
  AgentComponentDetail,
  AgentComponentHonestSource,
  AgentComponentListResponse,
  AgentComponentQueryFilters,
  AgentComponentsChange,
} from "@repo/api/src/types/agent-component";
import { SourceType } from "@repo/api/src/types/agent-component";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar";
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
  list(
    filters: AgentComponentQueryFilters
  ): Promise<AgentComponentListResponse>;
  /** Rejects (404 ApiError) when the slug is not found; never resolves null. */
  detail(slug: string): Promise<AgentComponentDetail>;
  subscribe?(onChange: (change: AgentComponentsChange) => void): () => void;
};

/** The slice of the API client the HTTP data source needs. */
type AgentComponentsHttpClient = {
  get<T>(path: string): Promise<T>;
};

function withQuery(path: string, filters: AgentComponentQueryFilters): string {
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
    // ISS-4667: LOC/$. A server that predates ISS-4667 omits the canonical
    // field and sends the KLOC-unit `klocPerDollar`; the shared resolver scales
    // it so the metric column never renders a thousand-times-too-small ~0.00.
    locPerDollar: resolveLocPerDollar(raw.locPerDollar, raw.klocPerDollar),
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
    // and blur that distinction for anything that probes with `in`.
    ...(raw.honestSource
      ? { honestSource: narrowHonestSource(raw.honestSource) }
      : {}),
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

    // Encode the slug into the single path segment: org-identity slugs are
    // `${kind}::${key}` and some keys contain a slash (skills key on `/name`),
    // which would otherwise split into extra path segments and miss the
    // single-segment `[slug]` detail route — a 404 even though the row appeared
    // in the list. The API route `decodeURIComponent`s the param back before
    // the org lookup, so the encoded round-trips to the raw slug.
    detail: async (slug) => {
      const raw = await apiClient.get<AgentComponentDetail>(
        `/agent-components/${encodeURIComponent(slug)}`
      );
      return adaptAgentComponentDetailToResponse(raw);
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
    // having applied the very same `COHORT_SCAN_CAP` it cannot yet disclose, so
    // coercing the omission to `false` would make the card assert the count
    // covered "every session" precisely when it did not — reintroducing, under
    // version skew, the overstatement this ticket exists to remove. Omission is
    // UNKNOWN, and `componentMetrics` renders unknown as its own third state:
    // no floor marker, and no full-cohort claim either.
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
