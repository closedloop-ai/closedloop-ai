import type { AgentComponentListResponse } from "@repo/api/src/types/agent-component";
import type { AgentComponentPageDataResult } from "@repo/api/src/utils/agent-component-page-data";

/**
 * Local (desktop) agent-components read IPC channels (FEA-2923 / T-16.3).
 *
 * The desktop-local `AgentComponentsDataSource`
 * (renderer/shared-agent-sessions/local-agent-components-data-source.ts) reads
 * the org inventory straight from local SQLite over these two channels — no HTTP
 * envelope, no network. They mirror the shared-agent-sessions / shared-branches
 * read channels: a `list` collection read and a single `detail` read keyed by
 * the org-identity slug (`${componentKind}::${componentKey}`).
 *
 * These channels live under the `desktop:db:*` namespace (alongside the
 * FEA-2923 optimization-analytics channels) because they are backed by the same
 * `withPrisma` local-SQLite readers in
 * `agent-dashboard-design-system-runtime.ts`, and the preload exposes them on
 * `window.desktopApi.db.*` where the data source and the typed `DesktopApi`
 * surface already expect them.
 */
export const SHARED_AGENT_COMPONENTS_IPC_CHANNELS = {
  list: "desktop:db:list-agent-components",
  detail: "desktop:db:get-agent-component-detail",
  frequency: "desktop:db:get-agent-component-frequency",
  /**
   * ISS-6822: the bounded page-data read. Returns the visible page, the matched
   * total, the facet counts, and the current window's aggregate — the same
   * reduction the renderer used to run, moved beside the SQLite read so the
   * payload crossing IPC is bounded by the page size instead of by how many
   * components the machine has.
   *
   * ADDITIVE. `list` is untouched and stays the read path for a renderer that
   * has not adopted this channel; a renderer running against an older preload
   * finds no `getAgentComponentsPageData` method, its data source omits
   * `pageData`, and the shared list keeps using `list`.
   */
  pageData: "desktop:db:get-agent-components-page-data",
  /**
   * ISS-10467/ISS-10468: the component detail's per-CONTENT-VERSION usage
   * drill-down and the side-by-side compare that reads through it.
   *
   * ADDITIVE, and its absence is a CAPABILITY answer rather than a zero. A
   * renderer running against an older preload finds no
   * `getAgentComponentVersionUsage` method, its data source omits
   * `versionUsage`, and the shared panel renders its "this source cannot scope
   * usage by version" state instead of figures nobody measured.
   */
  versionUsage: "desktop:db:get-agent-component-version-usage",
} as const;

export const SHARED_AGENT_COMPONENTS_IPC_CHANNEL_LIST = [
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.frequency,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.versionUsage,
] as const;

export type SharedAgentComponentsIpcChannel =
  (typeof SHARED_AGENT_COMPONENTS_IPC_CHANNEL_LIST)[number];

/**
 * Empty canonical list response for disabled or unsupported local reads.
 * Consumed by the disabled-mode responder in `agent-dashboard-ipc-contract.ts`
 * (the `detail` channel fails closed as `null` there, so the data source raises
 * its canonical 404).
 */
export function emptyAgentComponentsListResponse(): AgentComponentListResponse {
  return {
    items: [],
    total: 0,
    hasMore: false,
  };
}

/**
 * ISS-6822: the page-data counterpart of {@link emptyAgentComponentsListResponse}
 * for a disabled or unsupported local read.
 *
 * The same neutral answer the `list` channel already gives in that state — an
 * empty population — expressed in the page-data shape: no rows, one (empty)
 * page, no facet options, and an aggregate over nothing. `previous` is OMITTED
 * rather than zeroed, so the summary cards render no delta instead of a
 * fabricated "0% vs prev".
 *
 * `locPerDollar: null` and `hasVerifiableLocPerDollar: false` are the load-
 * bearing pair: they make the LOC/$ card hide rather than publish a `0.0` for a
 * population that was never read.
 */
export function emptyAgentComponentsPageDataResponse(): AgentComponentPageDataResult {
  return {
    items: [],
    filteredTotal: 0,
    totalPages: 1,
    page: 0,
    facets: { collaborators: [], sources: [], harnesses: [] },
    current: {
      components: 0,
      invocations: 0,
      locPerDollar: null,
      locPerDollarSampleSize: 0,
      collaborators: 0,
      hasVerifiableLocPerDollar: false,
      invocationsExact: true,
      invocationsPluginCoverage: [],
    },
  };
}

/**
 * ISS-4483 (review cid 3679616172, whitlockk): the transient counterpart of the local
 * agent-components source error — a db-host restart/crash-loop mid-read that the
 * renderer should route to the quiet reconnecting surface with a bounded retry
 * rather than the hard error card. Lives in this leaf contract (not the data-source
 * module) so the renderer's `transient-source-error` classifier can import it
 * without an import cycle. Source-specific so a settled transient error names the
 * Agent Components source it came from.
 */
export const SHARED_AGENT_COMPONENTS_TRANSIENT_ERROR_CODE =
  "LOCAL_AGENT_COMPONENTS_SOURCE_TRANSIENT" as const;
