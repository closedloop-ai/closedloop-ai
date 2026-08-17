/**
 * @file agent-dashboard-shared-read-ipc.ts
 * @description ISS-4771: the shared Sessions and Branches read channels — the
 * desktop-local implementations of the same list/detail/usage/analytics/pageData
 * contracts the cloud serves over HTTP, including the FEA-1997 IPC perf
 * instrumentation and the org-directory warm-up owner attribution depends on.
 * Extracted verbatim out of the shrink-only grandfathered
 * `agent-dashboard-design-system-runtime.ts`; the registrar is still the SOLE
 * registrar of these channels (a duplicate `ipcMain.handle` throws).
 */

import { ipcMain } from "electron";
import { SHARED_AGENT_SESSIONS_IPC_CHANNELS } from "../../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNELS } from "../../shared/shared-branches-contract.js";
import { getSharedBranchAnalytics } from "../branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../branch/branch-cohort-analytics.js";
import { getSharedBranchTrace } from "../branch/shared-branch-trace.js";
import {
  type BranchCloudHydrationSource,
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../branch/shared-branches-api.js";
import { FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE } from "../branch/shared-branches-cloud-hydration.js";
import { withDisplayedStatusParityScope } from "../session/displayed-status-parity-gate.js";
import { ensureOrgDirectory } from "../session/org-directory-cache.js";
import { getSharedAgentSessionDetail } from "../session/shared-agent-session-detail-read.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessions,
  getSharedAgentSessionUsage,
} from "../session/shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "../session/shared-agent-sessions-page-data.js";
import { DesktopIpcOperation } from "../telemetry/app-otel-runtime.js";
import {
  coerceSharedBranchDetailRequest,
  coerceSharedQuery,
  toBranchSyncSource,
} from "./agent-dashboard-ipc-coercion.js";
import {
  DB_HOST_EXIT_REDRIVE_READ,
  type WithDb,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import { instrumentIpcPerf } from "./agent-dashboard-ipc-perf.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "./agent-dashboard-runtime-options.js";
import { resolveIngestStateDir } from "./agent-dashboard-runtime-paths.js";
import { resolveLocalTranscriptSummaries } from "./local-transcript-detail-gate.js";
import { buildSharedAgentSessionsListOptions } from "./rebuild-sync-compute-target.js";

/** Register the shared Sessions and Branches read channels. */
export function registerSharedSessionAndBranchIpcHandlers(deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
  cloudHydration: BranchCloudHydrationSource | undefined;
}): void {
  const { withDb, options, cloudHydration } = deps;
  const branchEligibilitySource =
    cloudHydration ?? FAIL_CLOSED_BRANCH_CLOUD_HYDRATION_SOURCE;
  // FEA-2211: surface a failed perf `session_count` COUNT (best-effort; falls
  // back to 0) so a silent zero is observable in the desktop log.
  const onSessionCountError = (error: unknown): void =>
    options.log?.(
      "agent-dashboard",
      `ipc perf session_count query failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  const ipcPerfOptions = { onSessionCountError };
  // Owner attribution: warm the cloud org directory (canonical identity SoT)
  // before session reads so the local `user_id`s resolve to display identities.
  // TTL-guarded and awaited only on a cold cache, so steady-state reads are
  // unaffected; missing key/origin resolves owners to null (unattributed).
  const orgDirectoryFetchOptions = {
    getApiOrigin: () => options.getApiOrigin?.(),
    getApiKey: () => options.getApiKey?.(),
  };
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.list,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.List,
        options.emitIpcPerf,
        async (agentDatabase, request: unknown) => {
          await ensureOrgDirectory(orgDirectoryFetchOptions);
          // ISS-4556: see `withDisplayedStatusParityScope` — one read, one gate
          // decision, so the rows, the facet, and the sort cannot disagree.
          return withDisplayedStatusParityScope(() =>
            getSharedAgentSessions(
              agentDatabase.syncSource,
              coerceSharedQuery(request),
              buildSharedAgentSessionsListOptions(agentDatabase, options)
            )
          );
        },
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.Detail,
        options.emitIpcPerf,
        (agentDatabase, id: unknown) =>
          getSharedAgentSessionDetail(agentDatabase.syncSource, id, {
            branchEligibilitySource,
            resolveLocalTranscripts: (externalSessionId) =>
              resolveLocalTranscriptSummaries(
                agentDatabase.transcriptSync,
                externalSessionId,
                resolveIngestStateDir(options.userDataPath)
              ),
          }),
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage,
    withDb(
      instrumentIpcPerf(
        DesktopIpcOperation.Usage,
        options.emitIpcPerf,
        async (agentDatabase, request: unknown) => {
          await ensureOrgDirectory(orgDirectoryFetchOptions);
          return withDisplayedStatusParityScope(() =>
            getSharedAgentSessionUsage(
              agentDatabase.syncSource,
              coerceSharedQuery(request)
            )
          );
        },
        ipcPerfOptions
      )
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      withDisplayedStatusParityScope(() =>
        getSharedAgentSessionAnalytics(
          agentDatabase.syncSource,
          coerceSharedQuery(request)
        )
      )
    )
  );
  // FEA-4157: combined list + usage read so the Sessions table + summary cards
  // share one IPC call (mirrors the branches `pageData` handler above). Warm the
  // org directory first for the list half's owner attribution, exactly as the
  // standalone list handler does.
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
    withDb(async (agentDatabase, request: unknown) => {
      await ensureOrgDirectory(orgDirectoryFetchOptions);
      // ISS-4556: the widest cohort of all — this one call resolves the list, the
      // usage aggregate, and the facet-scoped counts for a single screen, in
      // separate modules that would otherwise each resolve the gate on their own.
      return withDisplayedStatusParityScope(() =>
        getSharedAgentSessionsPageData(
          agentDatabase.syncSource,
          coerceSharedQuery(request),
          // PRD-536 E6 (FEA-4157) / ISS-4647: thread the SAME options the
          // standalone list handler passes. `SessionsView` reads through THIS
          // channel, so anything only the standalone handler passes is invisible on
          // the actual Sessions page — that is how FEA-4157's missing compute
          // target mislabelled every pending-upload row as `synced`. The shared
          // builder is why the two handlers cannot drift again.
          buildSharedAgentSessionsListOptions(agentDatabase, options)
        )
      );
    }, DB_HOST_EXIT_REDRIVE_READ)
  );

  // Branches (PLN-983 / Epic A) — A2 is the SOLE registrar of these four
  // channels. Downstream chunks (B1 list, D1 detail, A3 usage/analytics, B6
  // analytics extras) flesh out only the handler bodies in shared-branches-api.ts
  // and MUST NOT re-register here (a duplicate ipcMain.handle throws). The branch
  // serving reads through the same SQLite handle the sessions handlers use.
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.list,
    withDb(async (agentDatabase, request: unknown) => {
      // Owner attribution: warm the cloud org directory so each branch's
      // dominant linked-session owner resolves to a display name.
      await ensureOrgDirectory(orgDirectoryFetchOptions);
      return getSharedBranches(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        branchEligibilitySource
      );
    })
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.detail,
    withDb((agentDatabase, value: unknown) => {
      const request = coerceSharedBranchDetailRequest(value);
      return getSharedBranchDetail(
        toBranchSyncSource(agentDatabase),
        request?.id ?? null,
        branchEligibilitySource,
        request ?? {}
      );
    })
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.trace,
    withDb((agentDatabase, id: unknown) =>
      getSharedBranchTrace(
        toBranchSyncSource(agentDatabase),
        id,
        branchEligibilitySource
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.usage,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchUsage(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        branchEligibilitySource
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchAnalytics(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        branchEligibilitySource
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchCohortAnalytics(
        toBranchSyncSource(agentDatabase),
        request,
        branchEligibilitySource
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.pageData,
    withDb(async (agentDatabase, request: unknown) => {
      await ensureOrgDirectory(orgDirectoryFetchOptions);
      return getSharedBranchesPageData(
        toBranchSyncSource(agentDatabase),
        coerceSharedQuery(request),
        branchEligibilitySource
      );
    }, DB_HOST_EXIT_REDRIVE_READ)
  );
}
