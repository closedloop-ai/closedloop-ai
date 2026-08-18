/**
 * @file agent-dashboard-component-analytics-ipc.ts
 * @description ISS-4771: the agent-component channels — the three optimization
 * analytics reads (model trend, subagent frequency, skill-loaded) and the two
 * local component inventory reads that back the desktop
 * `AgentComponentsDataSource`. Extracted verbatim out of the shrink-only
 * grandfathered `agent-dashboard-design-system-runtime.ts`; the ISS-4403
 * content-scope fingerprint semantics are unchanged.
 */
import { ipcMain } from "electron";
import { SHARED_AGENT_COMPONENTS_IPC_CHANNELS } from "../../shared/shared-agent-components-contract.js";
import type { BranchDefaultEligibilitySource } from "../branch/shared-branches-default-eligibility.js";
import {
  coerceFingerprint,
  coerceWindowDays,
} from "./agent-dashboard-ipc-coercion.js";
import type {
  WithDb,
  WithPrisma,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
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
  branchEligibilitySource: BranchDefaultEligibilitySource;
}): void {
  const { withDb, withPrisma, options, branchEligibilitySource } = deps;
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
    "desktop:db:get-component-model-trend",
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
    "desktop:db:get-subagent-frequency",
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
    "desktop:db:is-skill-loaded",
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
        agentDatabase.syncSource,
        branchEligibilitySource
      );
    })
  );
}
