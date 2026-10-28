/**
 * @file agent-dashboard-component-analytics-ipc.ts
 * @description ISS-4771: the agent-component channels — the three optimization
 * analytics reads (model trend, subagent frequency, skill-loaded) and the two
 * local component inventory reads that back the desktop
 * `AgentComponentsDataSource`. Extracted verbatim out of
 * `agent-dashboard-design-system-runtime.ts`; the ISS-4403
 * content-scope fingerprint semantics are unchanged.
 */

import { MAX_VERSION_USAGE_ENTRIES } from "@repo/api/src/types/agent-component-version-usage";
import { ipcMain } from "electron";
import { AgentDashboardDbIpcChannel } from "../../shared/agent-dashboard-db-ipc-channel.js";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../../shared/shared-agent-components-contract.js";
import {
  agentComponentsPageDataLocal,
  parseAgentComponentPageDataRequest,
} from "./agent-components-page-data-local.js";
import {
  coerceFingerprint,
  coerceWindowDays,
} from "./agent-dashboard-ipc-coercion.js";
import type {
  WithDb,
  WithPrisma,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { queryAgentComponentFrequencyLocal } from "./component-session-scope.js";
import { readAgentComponentVersionUsageLocal } from "./local-version-usage-read.js";
import {
  queryComponentModelTrend,
  queryIsSkillLoaded,
  querySubagentFrequency,
} from "./optimization-analytics-queries.js";
import {
  coerceAgentComponentFilters,
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "./shared-agent-components-api.js";

/** Register the optimization-analytics and agent-component read channels. */
export function registerComponentAnalyticsIpcHandlers(deps: {
  withDb: WithDb;
  withPrisma: WithPrisma;
  options: AgentDashboardDesignSystemRuntimeOptions;
}): void {
  const { withDb, withPrisma, options } = deps;
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.frequency,
    withPrisma((prisma, slug: unknown, days?: unknown) => {
      if (typeof slug !== "string" || !slug || slug.length > 4096) {
        throw new Error("Invalid component identity");
      }
      return queryAgentComponentFrequencyLocal(
        prisma,
        slug,
        coerceWindowDays(days)
      );
    })
  );
  // --- Optimization analytics (FEA-2923 / AC-022 / T-16.11) ---
  // All three handlers read from local SQLite only (agent_component_session_usage
  // + token_events/token_usage + claude_code_api_request) via withPrisma. The
  // query bodies live in optimization-analytics-queries.ts (extracted ISS-4403);
  // these handlers keep the renderer-facing argument coercion and delegate.
  //
  // ISS-4403: each handler accepts an optional trailing `fingerprint` — the FULL
  // content hash of the routed component version (the renderer threads
  // `AgentComponentDetail.versionId`, NOT the short `fingerprint` badge). When a
  // non-empty string is supplied the read is content-scoped to exactly that
  // version, so two same-name/different-content components no longer share one
  // component's optimization analytics (FEA-4335). When omitted / not a string
  // (a legacy name-level route, or a version-skewed renderer) the read stays
  // name-level, byte-identical to the pre-ISS-4403 behavior.

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetComponentModelTrend,
    withPrisma(
      (
        prisma,
        componentKind: unknown,
        componentKey: unknown,
        modelFilter?: unknown,
        days?: unknown,
        fingerprint?: unknown
      ) => {
        if (
          typeof componentKind !== "string" ||
          typeof componentKey !== "string"
        ) {
          return {
            componentKind: "",
            componentKey: "",
            windowDays: 0,
            points: [],
          };
        }
        const windowDays = coerceWindowDays(days);
        const modelArg =
          typeof modelFilter === "string" && modelFilter.length > 0
            ? modelFilter
            : null;
        return queryComponentModelTrend(
          prisma,
          componentKind,
          componentKey,
          modelArg,
          windowDays,
          coerceFingerprint(fingerprint)
        );
      }
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.GetSubagentFrequency,
    withPrisma(
      (prisma, subagentKey: unknown, days?: unknown, fingerprint?: unknown) => {
        if (typeof subagentKey !== "string") {
          return { subagentKey: "", windowDays: 0, points: [] };
        }
        return querySubagentFrequency(
          prisma,
          subagentKey,
          coerceWindowDays(days),
          coerceFingerprint(fingerprint)
        );
      }
    )
  );

  ipcMain.handle(
    AgentDashboardDbIpcChannel.IsSkillLoaded,
    withPrisma((prisma, skillKey: unknown, fingerprint?: unknown) => {
      if (typeof skillKey !== "string") {
        return {
          skillKey: "",
          existsInInventory: false,
          hasUsage: false,
          totalInvocations: 0,
          lastUsedAt: null,
        };
      }
      return queryIsSkillLoaded(
        prisma,
        skillKey,
        coerceFingerprint(fingerprint)
      );
    })
  );

  // --- Agent components local read (FEA-2923 / T-16.3) ---
  // Backs the desktop-local AgentComponentsDataSource: the renderer reads the
  // org inventory (agent_components + agent_component_session_usage, incl. the
  // plugin child-usage rollup) straight from local SQLite over these two
  // channels — no HTTP, no network. Mirrors the sessions/branches read wiring.
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.list,
    // `withDb` (not `withPrisma`) so the reader also receives the local sessions
    // sync source, letting it compute the LOC/$ column from the invoking
    // sessions' local-git LOC + cost (FEA-3090) instead of returning null.
    withDb((agentDatabase, filters: unknown) =>
      listAgentComponentsLocal(
        agentDatabase.prisma,
        coerceAgentComponentFilters(filters),
        options.getComputeTargetId?.() ?? null,
        agentDatabase.syncSource
      )
    )
  );
  // ISS-6822: the bounded page-data read. Same `withDb` wiring as `list`, but the
  // reduction runs here instead of in the renderer, so what crosses IPC is the
  // page plus compact facet and aggregate results rather than the inventory.
  // ISS-6409: it reads through `listAgentComponentsLocalWithLocPerDollarFold`
  // (via `agentComponentsPageDataLocal`) because the LOC/$ union fold needs the
  // session identities. That fold is consumed HERE and never returned — `list`
  // keeps using the stripping `listAgentComponentsLocal`, because a function on
  // an IPC payload throws `DataCloneError`.
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.pageData,
    withDb((agentDatabase, request: unknown) =>
      agentComponentsPageDataLocal(
        agentDatabase.prisma,
        parseAgentComponentPageDataRequest(request),
        options.getComputeTargetId?.() ?? null,
        agentDatabase.syncSource
      )
    )
  );
  // ISS-10467/ISS-10468: the per-content-version usage drill-down. `withDb`
  // (not `withPrisma`) for the same reason the detail read uses it — the
  // per-version LOC/$ fold needs the local sessions sync source.
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.versionUsage,
    withDb((agentDatabase, slug: unknown, versionHashes: unknown) => {
      if (typeof slug !== "string" || slug.length === 0) {
        return Promise.resolve(null);
      }
      // An IPC payload is a trust boundary, not an in-process value: keep only
      // the string members and bound the list here rather than forwarding
      // whatever the renderer sent into a SQL builder.
      const hashes = Array.isArray(versionHashes)
        ? versionHashes.filter(
            (value): value is string =>
              typeof value === "string" && value.length > 0
          )
        : [];
      // The cap is REJECTED, never clamped: silently answering fewer versions
      // than the renderer asked for drops a compare column with no signal. A
      // throw here is sanitized by the local data source into a clean error,
      // which is what the HTTP route's 400 is on the other surface.
      if (hashes.length > MAX_VERSION_USAGE_ENTRIES) {
        return Promise.reject(
          new Error(
            `At most ${MAX_VERSION_USAGE_ENTRIES} versions may be read at once.`
          )
        );
      }
      return readAgentComponentVersionUsageLocal({
        prisma: agentDatabase.prisma,
        slug,
        versionHashes: hashes,
        sessionSource: agentDatabase.syncSource,
      });
    })
  );
  ipcMain.handle(
    SHARED_AGENT_COMPONENTS_IPC_CHANNELS.detail,
    // `withDb` (not `withPrisma`) so the reader also receives the local sessions
    // sync source, letting it hydrate `sessionsTab` from the invoking sessions
    // (FEA-2923 MEDIUM soul review) instead of returning [].
    withDb((agentDatabase, slug: unknown) => {
      if (typeof slug !== "string" || slug.length === 0) {
        return null;
      }
      return getAgentComponentDetailLocal(
        agentDatabase.prisma,
        slug,
        options.getComputeTargetId?.() ?? null,
        agentDatabase.syncSource
      );
    })
  );
}
