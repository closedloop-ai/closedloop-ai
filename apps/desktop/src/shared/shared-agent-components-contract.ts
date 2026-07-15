import type { AgentComponentListResponse } from "@repo/api/src/types/agent-component";

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
} as const;

export const SHARED_AGENT_COMPONENTS_IPC_CHANNEL_LIST = [
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
  SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
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
