import type { AgentComponentInvocationSessionTreeRequest } from "@repo/api/src/types/agent-component-invocation-session-tree";
import type { AgentSessionEventsPageRequest } from "@repo/api/src/types/agent-session-events-page";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaboratorBatchResponse,
} from "@repo/api/src/types/artifact-collaborators";
import type { UpdateArtifactPriorityRequest } from "@repo/api/src/types/artifact-priority-mutation";
import { buildSessionListQueryIpcRequest } from "@repo/api/src/types/list-query-client-requests";
import type { ListQueryExpression } from "@repo/api/src/types/list-query-expression";
import { ReadSource } from "@repo/api/src/types/read-source";
import {
  type AgentSessionCapabilities,
  AgentSessionCapability,
  type AgentSessionsChange,
  type AgentSessionsDataSource,
  requireComponentScope,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { withReadSource } from "@repo/app/shared/lib/read-source";
import { withReadInitiator } from "../../shared/read-initiator-contract";
import {
  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
  SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
  SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE,
} from "../../shared/shared-agent-sessions-contract";
import { resolveLocalPriorityWrite } from "../shared/local-priority-write";
import { runSource } from "../shared/run-source";
import type { DesktopApi } from "../types/desktop-api";

/**
 * The slice of the desktop preload API the local data source needs.
 * `onDbChanged` is optional: the live subscription is best-effort, and a preload
 * without it simply yields a source with no `subscribe`.
 */
type DesktopLocalAgentSessionsApi = Pick<DesktopApi, "agentSessionsApi"> &
  Partial<Pick<DesktopApi, "onDbChanged">>;

/**
 * The desktop-local `AgentSessionsDataSource` (FEA-1834 / PLN-941 Phase 3). It
 * routes the shared `@repo/app` read hooks straight to
 * `window.desktopApi.agentSessionsApi` over Electron IPC — no fake HTTP envelope
 * and no network — and exposes the local DB's `desktop:db:changed` push stream
 * as `subscribe` so the live bridge can refresh the Sessions views.
 *
 * Error contract (matches the former fake-HTTP transport so hook/component
 * behavior is unchanged): a missing detail rejects with a 404 `ApiError`
 * (`SHARED_AGENT_SESSIONS_NOT_FOUND_CODE`) rather than resolving `null`, and any
 * underlying source failure rejects with a sanitized 500 `ApiError`
 * (`SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE`) — the raw error is discarded so no
 * local filesystem/SQL detail leaks to the renderer. Throwing `ApiError` (vs a
 * bare `Error`) preserves the HTTP path's retry semantics: the shared query
 * client skips retries for an `ApiError` carrying an HTTP status (ISS-5083), so
 * both the 404 (client error) and the 500 (server error) opt out of retry —
 * whereas a bare `Error` would be retried up to `MAX_TRANSIENT_QUERY_RETRIES`
 * times as transient network instability.
 */
export function createLocalAgentSessionsDataSource(
  desktopApi: DesktopLocalAgentSessionsApi
): AgentSessionsDataSource {
  const onDbChanged = desktopApi.onDbChanged;
  // Probed at construction, because the KEY must be present or absent on the
  // source (the panel reads `dataSource.eventsPage !== undefined`). Optional
  // through `agentSessionsApi` too: the other reads touch it only when called,
  // and renderer suites mount this provider over a partial preload stub that
  // never calls them.
  const eventsPage = desktopApi.agentSessionsApi?.eventsPage?.bind(
    desktopApi.agentSessionsApi
  );
  // ISS-9802: probed at construction for the same reason `eventsPage` is — the
  // preload may predate the bridge on a mirrored renderer running against an
  // older installed build. Its presence is what the source reports as
  // `cancelsInFlightReads`, so an older build answers `false` and the shared
  // hook withholds the signal exactly as it does today.
  const cancelRead = desktopApi.agentSessionsApi?.cancelRead?.bind(
    desktopApi.agentSessionsApi
  );
  // ISS-10737: probed at construction for the same reason `eventsPage` is — the
  // KEY must be present or absent on the source, because the Trace tab reads
  // `dataSource.sessionInvocationTree === undefined` as "this source cannot
  // serve a tree" and says so, rather than drawing an empty one.
  const invocationTree = desktopApi.agentSessionsApi?.invocationTree?.bind(
    desktopApi.agentSessionsApi
  );
  // ISS-10332: probed for the same version-skew reason. Its presence is the
  // whole signal the Sessions host keys the Priority column, facet and
  // grouping on (`updatePriority !== undefined`), so an older preload keeps
  // today's read-only list rather than offering an editor that cannot commit.
  const updatePriority = desktopApi.agentSessionsApi?.updatePriority?.bind(
    desktopApi.agentSessionsApi
  );
  const capabilities: AgentSessionCapabilities = {
    [AgentSessionCapability.ActivityPage]: false,
    [AgentSessionCapability.Collaborators]: true,
    [AgentSessionCapability.CustomFieldValues]: false,
    [AgentSessionCapability.EventsPage]: eventsPage !== undefined,
    [AgentSessionCapability.LinkedArtifacts]: false,
    [AgentSessionCapability.Rename]: false,
    [AgentSessionCapability.SessionInvocationTree]:
      invocationTree !== undefined,
    [AgentSessionCapability.UpdatePriority]: updatePriority !== undefined,
  };
  const sanitize = <T>(run: () => Promise<T>) =>
    runSource(
      run,
      "Agent sessions source failed.",
      SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
      SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE
    );

  return {
    scope: "local",
    capabilitiesForSession: () => capabilities,
    supportsComponentScope:
      desktopApi.agentSessionsApi?.componentScopeVersion === 1,
    // ISS-9802: an `AbortSignal` still cannot cross the IPC bridge, but a TOKEN
    // can. When the preload exposes the cancel bridge, an abort is relayed main →
    // db-host child → store thread, where the op abandons its remaining work at
    // its next `yieldDbHostLoop()` checkpoint — so the claim this boolean makes
    // is true, at STATEMENT-BOUNDARY granularity (a statement already inside the
    // synchronous libSQL driver finishes first; nothing at that layer can
    // interrupt it). Without the bridge it is the pre-ISS-9802 answer: the
    // renderer checks the signal, the scan runs on, and the hook is told not to
    // trade query-core's in-flight dedupe for a cancellation that never happens.
    cancelsInFlightReads: cancelRead !== undefined,
    // FEA-3120: rows come straight from the desktop's local SQLite over IPC, so
    // stamp `local` at the read boundary (never overwriting an explicit value the
    // IPC layer already reported).
    list: async (filters, options) => {
      const response = await sanitize(() =>
        desktopApi.agentSessionsApi.list(
          withReadInitiator(withListQuery(filters), options?.readInitiator)
        )
      );
      return withReadSource(
        requireComponentScope(response, filters),
        ReadSource.Local
      );
    },
    detail: async (id, options) => {
      const readInitiator = options?.readInitiator;
      const data = await sanitize(() =>
        readInitiator === undefined
          ? desktopApi.agentSessionsApi.detail(id)
          : desktopApi.agentSessionsApi.detail(id, { readInitiator })
      );
      if (!data) {
        throw new ApiError(
          "Agent session not found.",
          404,
          SHARED_AGENT_SESSIONS_NOT_FOUND_CODE
        );
      }
      return data;
    },
    collaborators: async (artifactIds) =>
      unavailableArtifactCollaboratorBatchResponse(
        CollaboratorArtifactType.Session,
        artifactIds
      ),
    /**
     * ISS-7852 — the summary reads honor the query's `AbortSignal` on the ONE
     * side of the bridge that can. An `AbortSignal` is not structured-cloneable,
     * so it cannot be handed to `agentSessionsApi` and the local SQLite read
     * cannot be cancelled once it is running; a version-skewed preload that
     * knows nothing about cancellation is therefore untouched by this and keeps
     * behaving exactly as before. What the renderer CAN do is check the signal
     * either side of the call — an already-superseded range never reaches the
     * bridge at all, and one superseded mid-read rejects as a cancellation
     * instead of delivering an answer nobody is waiting for. Mirrors the
     * branches local source's `trace`; no listener is registered, so an aborted
     * read leaves nothing attached to clean up.
     */
    usage: (filters, options) =>
      readHonoringSignal(
        (token) =>
          sanitize(() =>
            desktopApi.agentSessionsApi.usage(
              withReadInitiator(
                withCancellationToken(filters, token),
                options?.readInitiator
              )
            )
          ),
        options?.signal,
        cancelRead
      ),
    // ISS-9802: the read the token exists for. `aggregateAnalytics` yields
    // between its statements, so a cancel reaches the scan itself rather than
    // only the promise awaiting it — which is what lets this source report
    // `cancelsInFlightReads` and be handed a signal at all.
    analytics: (filters, options) =>
      readHonoringSignal(
        (token) =>
          sanitize(() =>
            desktopApi.agentSessionsApi.analytics(
              withCancellationToken(filters, token)
            )
          ),
        options?.signal,
        cancelRead
      ),
    // FEA-4157: combined list + usage read over ONE IPC call so the Sessions
    // table + summary cards share one raw scan. Same FEA-3120 stamp as `list`,
    // applied to the nested list so the combined read still carries local
    // provenance for the ReadSourceBadge (mirrors the branches local pageData).
    pageData: async (filters, options) => {
      // ISS-6041: the port carries the ISS-5809 `comparison` opt-in for the
      // sources that can honor it. This one cannot — the local SQLite producer
      // aggregates the requested window only and has no prior-window read — so
      // drop it at the boundary rather than send the IPC contract a field it does
      // not model. The response then carries no `comparison`, which the summary
      // cards already read as "no chip", never as a zero.
      const { comparison: _comparison, ...localFilters } = filters;
      const response = await readHonoringSignal(
        (token) =>
          sanitize(() =>
            desktopApi.agentSessionsApi.pageData(
              withReadInitiator(
                withCancellationToken(withListQuery(localFilters), token),
                options?.readInitiator
              )
            )
          ),
        options?.signal,
        cancelRead
      );
      return {
        ...response,
        list: withReadSource(
          requireComponentScope(response.list, filters),
          ReadSource.Local
        ),
      };
    },
    // ISS-9857: a keyset page past the detail's bounded prefix. `null` is the
    // producer's one fail-closed answer — unknown session, a source that cannot
    // page, or a cursor that does not decode — and it is mapped to the same 404
    // `detail` uses. So on the desktop a malformed cursor reads as not-found
    // where the cloud answers 400; acceptable because the client only replays
    // producer-minted cursors, and the panel treats either status as "no
    // continuation" rather than as something to retry. A preload that predates
    // the channel (a mirrored renderer on an older installed build) leaves the
    // key ABSENT, which the panel reads as "cannot page" — not as a read that
    // fails.
    ...(eventsPage
      ? {
          eventsPage: async (request: AgentSessionEventsPageRequest) => {
            const page = await sanitize(() => eventsPage(request));
            if (!page) {
              throw new ApiError(
                "Agent session not found.",
                404,
                SHARED_AGENT_SESSIONS_NOT_FOUND_CODE
              );
            }
            return page;
          },
        }
      : {}),
    // ISS-10737: `null` is the producer's one fail-closed answer — an unknown
    // session, or a source that cannot serve the tree — and is mapped to the
    // same 404 `detail` uses. A KNOWN session with no invocations comes back as
    // a real page with `total: 0`, which the tab renders as "no components ran",
    // never as an error.
    ...(invocationTree
      ? {
          sessionInvocationTree: async (
            request: AgentComponentInvocationSessionTreeRequest
          ) => {
            const page = await sanitize(() => invocationTree(request));
            if (!page) {
              throw new ApiError(
                "Agent session not found.",
                404,
                SHARED_AGENT_SESSIONS_NOT_FOUND_CODE
              );
            }
            return page;
          },
        }
      : {}),
    subscribe: onDbChanged
      ? (onChange: (change: AgentSessionsChange) => void) =>
          onDbChanged((payload) => onChange(payload))
      : undefined,
    // ISS-10332 / PLN-2086 Milestone 3: the local-mode priority write. This
    // source is selected exactly where local reads are (signed out, offline, or
    // sync off), so in cloud mode the local row is never edited.
    ...(updatePriority
      ? {
          updatePriority: async (
            id: string,
            input: UpdateArtifactPriorityRequest
          ) => {
            const result = await sanitize(() =>
              updatePriority({ ...input, id })
            );
            resolveLocalPriorityWrite(
              result,
              () =>
                new ApiError(
                  "Agent session not found.",
                  404,
                  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE
                )
            );
          },
        }
      : {}),
  };
}

/**
 * ISS-7852 / ISS-9802 — run one local summary read with the query's
 * `AbortSignal` checked on both sides, given precedence over whatever the read
 * itself threw, AND — the part ISS-9802 adds — relayed to the work.
 *
 * The catch is the part that is not obvious. `runSource` sanitizes ANY rejection
 * into the generic 500 `ApiError`, so an IPC failure landing after the query was
 * superseded would propagate as a hard source error and the post-read check
 * would never run — the user would get an error card for a read they themself
 * superseded. Checking the signal first in the catch reports the cancellation
 * instead, matching the branches local `trace`. That also covers the new case:
 * a read the store thread ABANDONED comes back as a sanitized failure, and the
 * caller who aborted it is told it was cancelled rather than shown an error.
 *
 * A rejection with the signal still un-aborted is rethrown untouched, so a
 * genuine source failure keeps its sanitized shape.
 *
 * A token is minted only when there is both a signal to honour and a bridge to
 * honour it on; otherwise `run` is handed `undefined` and sends no token, which
 * is the byte-identical pre-ISS-9802 request. The abort listener is registered
 * `once` and removed in `finally`, so a settled read leaves nothing attached and
 * a later legitimate read can never be cancelled by a stale listener.
 */
async function readHonoringSignal<T>(
  run: (cancellationToken: string | undefined) => Promise<T>,
  signal: AbortSignal | undefined,
  cancelRead: DesktopReadCancelBridge | undefined
): Promise<T> {
  signal?.throwIfAborted();
  const token = signal && cancelRead ? nextReadCancellationToken() : undefined;
  let releaseAbortListener: (() => void) | undefined;
  if (signal && cancelRead && token) {
    const onAbort = (): void => {
      // Best-effort and never awaited: the read's own rejection is what the
      // caller sees, and a cancel that cannot be delivered (an older main with
      // no handler for the channel, a runtime that has since been disabled)
      // must not turn into an unhandled rejection or replace the real error.
      cancelRead(token).catch(() => {
        // Ignored on purpose — see above.
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    releaseAbortListener = () => {
      signal.removeEventListener("abort", onAbort);
    };
  }
  try {
    const result = await run(token);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    releaseAbortListener?.();
  }
}

/** The preload's cancel bridge, as this module needs it. */
type DesktopReadCancelBridge = (token?: string) => Promise<unknown>;

/**
 * A token unique to this renderer instance.
 *
 * The per-instance PREFIX is the load-bearing half, not the counter: main holds
 * one registry for every window, so two renderers each counting from 1 would
 * mint the same token and one window's abort would cancel the other window's
 * read. The counter alone makes it unique WITHIN a renderer; the prefix makes it
 * unique ACROSS them.
 */
let readCancellationSequence = 0;
const READ_CANCELLATION_TOKEN_PREFIX = `${Date.now().toString(36)}-${Math.random()
  .toString(36)
  .slice(2, 10)}`;

function nextReadCancellationToken(): string {
  readCancellationSequence += 1;
  return `${READ_CANCELLATION_TOKEN_PREFIX}-${readCancellationSequence}`;
}

/**
 * Stamp the token on a read request, or hand back the request untouched.
 *
 * OMISSION, never `null` or an explicit `undefined` key: an uncancellable read
 * must send the request it always sent, so an older main process is handed
 * nothing new — and the request schema, which does not model this key, strips it
 * on the way to `sanitizeQuery` either way. The token is transport metadata, not
 * a filter.
 */
function withCancellationToken<TRequest extends object>(
  request: TRequest,
  token: string | undefined
): TRequest {
  if (token === undefined) {
    return request;
  }
  return { ...request, cancellationToken: token };
}

/**
 * PRD-721 / ISS-9346: the list read's filter and sort as the canonical
 * `listQuery` expression, which main compiles back to the same legacy params
 * (`compileSessionListQueryRequest`). Renderer and main ship in one Electron
 * build, so the main receiving this always has that compiler. A request the
 * expression cannot state (an unmodeled bound such as `completedAfter`, a
 * value the desktop capability refuses) keeps its legacy params.
 */
function withListQuery<TFilters extends Readonly<Record<string, unknown>>>(
  filters: TFilters
): TFilters | (Partial<TFilters> & { listQuery: ListQueryExpression }) {
  return buildSessionListQueryIpcRequest(filters) ?? filters;
}
