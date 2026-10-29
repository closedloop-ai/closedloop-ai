/**
 * @file agent-dashboard-shared-read-ipc.ts
 * @description ISS-4771: the shared Sessions and Branches read channels — the
 * desktop-local implementations of the same list/detail/usage/analytics/pageData
 * contracts the cloud serves over HTTP, including the FEA-1997 IPC perf
 * instrumentation and the org-directory warm-up owner attribution depends on.
 * Extracted verbatim out of
 * `agent-dashboard-design-system-runtime.ts`; the registrar is still the SOLE
 * registrar of these channels (a duplicate `ipcMain.handle` throws).
 */

import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { runWithReadCancellationToken } from "../../shared/db-host-read-cancellation.js";
import { readCancellationTokenOf } from "../../shared/read-cancellation-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionsCancelReadResult,
} from "../../shared/shared-agent-sessions-contract.js";
import { SHARED_BRANCHES_IPC_CHANNELS } from "../../shared/shared-branches-contract.js";
import { getSharedBranchAnalytics } from "../branch/branch-analytics-read.js";
import { getSharedBranchCohortAnalytics } from "../branch/branch-cohort-analytics.js";
import { getSharedBranchTrace } from "../branch/shared-branch-trace.js";
import {
  getSharedBranchDetail,
  getSharedBranches,
  getSharedBranchesPageData,
  getSharedBranchUsage,
} from "../branch/shared-branches-api.js";
import { parseBranchListSnapshot } from "../database/branch-list-snapshot-read.js";
import { ensureOrgDirectory } from "../session/org-directory-cache.js";
import { getSharedAgentSessionDetail } from "../session/shared-agent-session-detail-read.js";
import { getSharedAgentSessionEventsPage } from "../session/shared-agent-session-events-page-read.js";
import { getSharedAgentSessionInvocationTree } from "../session/shared-agent-session-invocation-tree-read.js";
import {
  getSharedAgentSessionAnalytics,
  getSharedAgentSessionUsage,
} from "../session/shared-agent-sessions-api.js";
import { getSharedAgentSessionsPageData } from "../session/shared-agent-sessions-page-data.js";
import { DesktopIpcOperation } from "../telemetry/app-otel-runtime-ipc.js";
import {
  coerceSharedAgentSessionsListRequest,
  coerceSharedAgentSessionsQuery,
  coerceSharedBranchDetailRequest,
  coerceSharedBranchesQuery,
  coerceSharedQuery,
  toBranchSyncSource,
} from "./agent-dashboard-ipc-coercion.js";
import {
  DB_HOST_EXIT_REDRIVE_READ,
  type WithDb,
} from "./agent-dashboard-ipc-handler-wrappers.js";
import { instrumentIpcPerf } from "./agent-dashboard-ipc-perf.js";
import type {
  AgentDashboardDesignSystemRuntimeOptions,
  InvokeStoreOp,
} from "./agent-dashboard-runtime-options.js";
import { resolveIngestStateDir } from "./agent-dashboard-runtime-paths.js";
import { readAgentDashboardSessionList } from "./agent-dashboard-session-list-projection.js";
import { resolveLocalTranscriptSummaries } from "./local-transcript-detail-gate.js";
import { buildSharedAgentSessionsListOptions } from "./rebuild-sync-compute-target.js";

/** Register the shared Sessions and Branches read channels. */
export function registerSharedSessionAndBranchIpcHandlers(deps: {
  withDb: WithDb;
  options: AgentDashboardDesignSystemRuntimeOptions;
  invokeStoreOp: InvokeStoreOp;
  /**
   * ISS-9802 — forward a renderer cancellation token to the db-host child, which
   * relays it to the store thread where the work actually is. Injected rather
   * than reached through `agentDatabase`, because the db-host PROXY only speaks
   * dotted op paths and a cancellation is not an op.
   */
  cancelDbHostRead: (token: string) => void;
}): void {
  const { withDb, options, invokeStoreOp, cancelDbHostRead } = deps;
  // FEA-2211: surface a failed perf `session_count` COUNT (best-effort; answers
  // unknown) so the dropped wide event is observable in the desktop log.
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
  const orgDirectoryFetchOptions =
    options.getAccountAdmission && options.getAccessToken
      ? {
          getApiOrigin: () => options.getApiOrigin?.(),
          getAccountAdmission: options.getAccountAdmission,
          getAccessToken: options.getAccessToken,
          isAuthoritativelySignedOut: options.isDesktopSessionSignedOut,
        }
      : {
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
          return readAgentDashboardSessionList(
            agentDatabase,
            options,
            coerceSharedAgentSessionsListRequest(request)
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
            ...buildSharedAgentSessionsListOptions(agentDatabase, options),
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
        (agentDatabase, request: unknown) =>
          // ISS-9802: everything this read awaits runs under the renderer's
          // token, so `DbHostClient.invoke` can stamp it on the request and a
          // later cancel can reach the scan itself.
          runWithReadCancellationToken(
            readCancellationTokenOf(request),
            async () => {
              await ensureOrgDirectory(orgDirectoryFetchOptions);
              return getSharedAgentSessionUsage(
                agentDatabase.syncSource,
                coerceSharedAgentSessionsQuery(request)
              );
            }
          ),
        ipcPerfOptions
      ),
      // ISS-8773: this is the channel `agent-dashboard-ipc-handler-wrappers.ts`
      // names as the one that spammed `Error occurred in handler for …` when the
      // db-host died under it, and it is a pure read, so it is exactly what
      // ISS-5808's redrive was built for. Parking on `DbHostClient.ready` and
      // resuming on the replacement child answers the summary cards instead of
      // round-tripping a transport error to the renderer.
      DB_HOST_EXIT_REDRIVE_READ
    )
  );
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      // ISS-9802: the heaviest read on the Sessions surface, and the one the
      // token exists for — `aggregateAnalytics` yields between its statements,
      // so a cancel lands at the next one instead of after the whole scan.
      runWithReadCancellationToken(readCancellationTokenOf(request), () =>
        getSharedAgentSessionAnalytics(
          agentDatabase.syncSource,
          coerceSharedAgentSessionsListRequest(request)
        )
      )
    )
  );
  // ISS-9802: the renderer's abort, as a message that CAN cross the bridge.
  //
  // Deliberately NOT through `withDb`, unlike every read beside it. That wrapper
  // awaits `getAgentDatabase()`, which parks on `DbHostClient.ready` for the
  // whole crash-ladder backoff — so a cancel would block on the very condition
  // the user is aborting — and on success it reports a RENDERER READ
  // (`onRendererDbRead`), which would hold the DATA_REVISION rebuild's adaptive
  // write pause open for a call that reads nothing. It takes the identical
  // sender-trust gate directly instead: a cancellation acts on another caller's
  // in-flight work, so an untrusted frame must never reach it.
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.cancelRead,
    (event: IpcMainInvokeEvent, request: unknown) => {
      if (!options.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      const token = readCancellationTokenOf(request);
      if (!token) {
        // A missing or malformed token names no read. Answering `false` rather
        // than throwing keeps a best-effort cancel from ever costing the caller
        // anything, and reports admission honestly instead of claiming a
        // cancellation that reached nothing.
        return {
          requested: false,
        } satisfies SharedAgentSessionsCancelReadResult;
      }
      cancelDbHostRead(token);
      // `true` means FORWARDED, never "the read stopped": only the store thread
      // knows whether the op was still running, and it answers nothing here.
      return { requested: true } satisfies SharedAgentSessionsCancelReadResult;
    }
  );
  // ISS-9857: one keyset page of raw events past the detail's bounded prefix.
  // Deliberately NOT wrapped in `instrumentIpcPerf`: `DesktopIpcOperation` is a
  // closed OTel contract, and widening it for this read is a telemetry change
  // ISS-9857 does not own — `analytics` above is the precedent.
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.events,
    withDb((agentDatabase, request: unknown) =>
      getSharedAgentSessionEventsPage(
        agentDatabase.syncSource,
        coerceSharedQuery(request)
      )
    )
  );
  // ISS-10737: the session's whole invocation tree for the Trace tab. Not
  // wrapped in `instrumentIpcPerf` for the same reason its `events` sibling is
  // not: `DesktopIpcOperation` is a closed OTel contract, and widening it for
  // this read is a telemetry change ISS-10737 does not own.
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.invocationTree,
    withDb((agentDatabase, request: unknown) =>
      getSharedAgentSessionInvocationTree(
        agentDatabase.syncSource,
        coerceSharedQuery(request)
      )
    )
  );
  // FEA-4157: combined list + usage read so the Sessions table + summary cards
  // share one IPC call (mirrors the branches `pageData` handler above). Warm the
  // org directory first for the list half's owner attribution, exactly as the
  // standalone list handler does.
  ipcMain.handle(
    SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData,
    withDb(
      // ISS-12039: the read the Sessions page takes its rows from, so its
      // user-initiated reads are the dead-end rate's `page_data` operations.
      instrumentIpcPerf(
        DesktopIpcOperation.PageData,
        options.emitIpcPerf,
        (agentDatabase, request: unknown) =>
          runWithReadCancellationToken(
            readCancellationTokenOf(request),
            async () => {
              await ensureOrgDirectory(orgDirectoryFetchOptions);
              // ISS-4556: the page-data adapter brackets list, usage and facet
              // reads with the DB-host writer revision before returning them.
              const parsedRequest =
                coerceSharedAgentSessionsListRequest(request);
              return getSharedAgentSessionsPageData(
                agentDatabase.syncSource,
                parsedRequest,
                // PRD-536 E6 (FEA-4157) / ISS-4647: thread the SAME options the
                // standalone list handler passes. `SessionsView` reads through THIS
                // channel, so anything only the standalone handler passes is invisible on
                // the actual Sessions page — that is how FEA-4157's missing compute
                // target mislabelled every pending-upload row as `synced`. The shared
                // builder is why the two handlers cannot drift again.
                buildSharedAgentSessionsListOptions(agentDatabase, options),
                () =>
                  readAgentDashboardSessionList(
                    agentDatabase,
                    options,
                    parsedRequest
                  )
              );
            }
          ),
        ipcPerfOptions
      ),
      DB_HOST_EXIT_REDRIVE_READ
    )
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
      if (!isLocalBranchRead(request)) {
        await ensureOrgDirectory(orgDirectoryFetchOptions);
      }
      return getSharedBranches(
        toBranchSyncSource(agentDatabase),
        coerceSharedBranchesQuery(request)
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
        request ?? {}
      );
    })
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.trace,
    // The cloud-mode trace uses REST; this IPC channel is the local adapter.
    withDb((agentDatabase, id: unknown) =>
      getSharedBranchTrace(toBranchSyncSource(agentDatabase), id)
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.usage,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchUsage(
        toBranchSyncSource(agentDatabase),
        coerceSharedBranchesQuery(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.analytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchAnalytics(
        toBranchSyncSource(agentDatabase),
        coerceSharedBranchesQuery(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics,
    withDb((agentDatabase, request: unknown) =>
      getSharedBranchCohortAnalytics(
        toBranchSyncSource(agentDatabase),
        withoutLocalBranchReadHint(request)
      )
    )
  );
  ipcMain.handle(
    SHARED_BRANCHES_IPC_CHANNELS.pageData,
    withDb(async (agentDatabase, request: unknown) => {
      if (!isLocalBranchRead(request)) {
        await ensureOrgDirectory(orgDirectoryFetchOptions);
      }
      return getSharedBranchesPageData(
        toBranchSyncSource(agentDatabase),
        coerceSharedBranchesQuery(request),
        async (snapshotRequest) =>
          parseBranchListSnapshot(
            await invokeStoreOp("branches.listSnapshot", [snapshotRequest])
          )
      );
    }, DB_HOST_EXIT_REDRIVE_READ)
  );
}

function isLocalBranchRead(request: unknown): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    !Array.isArray(request) &&
    Object.hasOwn(request, "skipCloudHydration") &&
    Reflect.get(request, "skipCloudHydration") === true
  );
}

function withoutLocalBranchReadHint(request: unknown): unknown {
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request) ||
    !Object.hasOwn(request, "skipCloudHydration")
  ) {
    return request;
  }
  const fields = request as Record<string, unknown>;
  if (typeof fields.skipCloudHydration !== "boolean") {
    return request;
  }
  const { skipCloudHydration: _skipCloudHydration, ...cohortRequest } = fields;
  return cohortRequest;
}
