import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import type {
  TraceComment,
  TraceCommentTarget,
} from "@repo/api/src/types/comment";
import {
  ThreadStatus,
  TraceCommentKind,
  TraceCommentSurface,
  TraceCommentTargetType,
} from "@repo/api/src/types/comment";
import {
  useAgentComponentsDataSource,
  useAgentSessionsDataSource,
} from "@repo/app/agents/data-source/provider";
import { useTraceCommentsDataSource } from "@repo/app/agents/data-source/trace-comments-provider";
import { agentSessionKeys } from "@repo/app/agents/hooks/use-agent-sessions";
import { useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../shared/contracts";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import { useDesktopAuth } from "../shared-agent-sessions/desktop-auth-provider";
import { DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS } from "../shared-agent-sessions/sessions-list-poll-defaults";
import type { DesktopAuthState } from "../types/desktop-api";

/**
 * PLN-1138 Phase 2 — the desktop app-core stack selects its Sessions read source
 * and freshness model by mode (auth × connectivity). Local: the SQLite source
 * (scope "local") under a pure push model (staleTime ∞ + the FEA-2187 poll
 * fallback). Cloud (authenticated + online): the shared HTTP source (scope
 * "http") over the D-G bridge under a refetch model. The QueryClient is rebuilt
 * on a mode change, so the two row sets never share a cache (AC-3.1).
 *
 * FEA-3460 / FEA-3522 extend the same selection to trace comments: Cloud mode
 * (authenticated + online) reads AND writes the org cloud API via the shared
 * HTTP source (scope "http") over the D-G bridge — FEA-3522's authenticated
 * write transport is what lets the writes land — while every other state stays
 * fully local (scope "desktop-local"). See the mutation test below, which drives
 * every Cloud-mode mutation through the HTTP source and asserts it reaches the
 * cloud bridge (not the local IPC sink).
 */

type AuthStateListener = (state: DesktopAuthState) => void;

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};
const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const LOCAL_SCOPE = "local";
/** The desktop IPC trace-comments source identity (FEA-3460). */
const TRACE_COMMENTS_LOCAL_SCOPE = "desktop-local";
/**
 * Cloud-mode trace comments now use the plain shared HTTP source (scope
 * `"http"`) for reads AND writes (FEA-3522 authenticated write transport) — the
 * former `"cloud-reads-local-writes"` composite is gone.
 */
const TRACE_COMMENTS_CLOUD_SCOPE = "http";
const HTTP_SCOPE = "http";
const COMPONENTS_LOCAL_SCOPE = "agent-components:local";
const COMPONENTS_HTTP_SCOPE = "agent-components:http";
const WEB_DEFAULT_STALE_TIME_MS = 60 * 1000;

const TRACE_TARGET: TraceCommentTarget = {
  type: TraceCommentTargetType.Session,
  id: "session-1",
};

/**
 * Minimal valid persisted comment for the local write-sink mock. The mutation
 * test only needs the promise to resolve (a working sink, no status-0 error);
 * the exact field values are immaterial, so this keeps just enough shape to
 * satisfy the {@link TraceComment} type and the hook's cache merge.
 */
function makeStoredComment(
  target: TraceCommentTarget,
  body: string,
  id = "comment-local-1"
): TraceComment {
  const now = new Date().toISOString();
  return {
    id,
    threadId: "thread-1",
    target,
    artifactId: "artifact-1",
    surface: TraceCommentSurface.SessionDetail,
    kind: TraceCommentKind.Comment,
    status: ThreadStatus.Open,
    resolvedAt: null,
    resolvedById: null,
    resolvedByName: null,
    resolvedByAvatarUrl: null,
    anchor: {
      traceId: "trace-1",
      turnId: "turn-1",
      row: 0,
      selectedText: "",
      sourceText: "",
      startOffset: 0,
      endOffset: 0,
    },
    body,
    createdAt: now,
    updatedAt: now,
    editedAt: null,
    authorId: "user-1",
    authorName: null,
    authorAvatarUrl: null,
    canEdit: true,
    canDelete: true,
    replies: [],
  };
}

/**
 * The `data` payload the cloud bridge mock returns for a given method: an empty
 * list for reads, a delete result for DELETE, and a persisted comment for the
 * other mutations.
 */
function cloudResponseData(
  method: string
): TraceComment[] | { deleted: true } | TraceComment {
  if (method === "GET") {
    return [];
  }
  if (method === "DELETE") {
    return { deleted: true };
  }
  return makeStoredComment(TRACE_TARGET, "cloud", "comment-cloud-1");
}

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

type CloudApiFetchCall = {
  path: string;
  method: string;
  body?: string;
};

function setupDesktopApi(initial: DesktopAuthState) {
  const listeners = new Set<AuthStateListener>();
  // Records what the Cloud-mode HTTP source marshals over the D-G bridge, so a
  // test can prove a write actually reached the cloud transport (FEA-3522)
  // rather than the local IPC sink. Returns a benign success envelope so the
  // shared `useApiClient` resolves each mutation.
  const cloudApiFetchCalls: CloudApiFetchCall[] = [];
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(initial)),
      onDesktopAuthStateChanged: vi.fn((cb: AuthStateListener) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      }),
      cloudApiFetch: vi.fn(
        (req: { path: string; method?: string; body?: string }) => {
          const method = (req.method ?? "GET").toUpperCase();
          cloudApiFetchCalls.push({ path: req.path, method, body: req.body });
          // The shared `useApiClient` unwraps the `{ success, data }` envelope
          // and returns `data`. GET (reads / list) returns an array; a mutation
          // returns the persisted comment (or a delete result).
          const bodyText = JSON.stringify({
            success: true,
            data: cloudResponseData(method),
          });
          return Promise.resolve({
            kind: "response" as const,
            status: 200,
            statusText: "OK",
            headers: [["content-type", "application/json"]] as [
              string,
              string,
            ][],
            bodyText,
          });
        }
      ),
      agentSessionsApi: {
        analytics: vi.fn(async () => ({
          byAgentType: [],
          byProject: [],
          byRepository: [],
          byTool: [],
          viewerScope: AgentSessionViewerScope.Self,
        })),
        detail: vi.fn(async () => null),
        list: vi.fn(async () => ({
          items: [],
          total: 0,
          viewerScope: AgentSessionViewerScope.Self,
        })),
        usage: vi.fn(async () => null),
      },
      db: {
        listAgentComponents: vi.fn(async () => ({ items: [], total: 0 })),
        getAgentComponentDetail: vi.fn(async () => null),
      },
      // The local IPC trace-comments sink — used in local mode (signed out /
      // offline). In Cloud mode reads AND writes go over the HTTP source /
      // `cloudApiFetch` bridge above (FEA-3522), NOT through this sink.
      traceCommentsApi: {
        list: vi.fn(async () => [] as TraceComment[]),
        create: vi.fn(async (target: TraceCommentTarget, draft) =>
          makeStoredComment(target, draft.body)
        ),
        reply: vi.fn(async (target: TraceCommentTarget, commentId: string) =>
          makeStoredComment(target, "reply", commentId)
        ),
        update: vi.fn(
          async (target: TraceCommentTarget, commentId: string, update) =>
            makeStoredComment(target, update.body, commentId)
        ),
        delete: vi.fn(async () => ({ deleted: true as const })),
      },
    },
  });
  return {
    push: (state: DesktopAuthState) => {
      for (const cb of listeners) {
        cb(state);
      }
    },
    cloudApiFetchCalls,
  };
}

/**
 * Force `navigator.onLine` for the connectivity leg of the mode rule. Returns a
 * restore fn; the `afterEach` below always runs it so the shadowing own-property
 * never leaks between tests (AGENTS.md — restore mutated globals).
 */
function forceOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

let restoreOnline: (() => void) | null = null;

afterEach(() => {
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function renderProbe() {
  return renderHook(
    () => ({
      client: useQueryClient(),
      auth: useDesktopAuth(),
      source: useAgentSessionsDataSource(),
      traceComments: useTraceCommentsDataSource(),
    }),
    { wrapper: DesktopAppCoreProvider }
  );
}

describe("DesktopAppCoreProvider mode selection", () => {
  it("signed out runs the local source under the push + poll-fallback model", async () => {
    setupDesktopApi(SIGNED_OUT);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(DesktopAuthStatus.SignedOut)
    );

    expect(result.current.source.scope).toBe(LOCAL_SCOPE);
    // Trace comments follow the same rule: local IPC source when signed out
    // (FEA-3460), so writes land in the local SQLite store.
    expect(result.current.traceComments.scope).toBe(TRACE_COMMENTS_LOCAL_SCOPE);
    const queries = result.current.client.getDefaultOptions().queries;
    expect(queries?.staleTime).toBe(Number.POSITIVE_INFINITY);
    // ISS-5976 flipped the shared factory's defaults to React Query's stock
    // `true`, so local must now opt OUT of BOTH triggers explicitly. These two
    // assertions are what fail if that opt-out is ever dropped: local would
    // silently start refetching on focus and reconnect on top of the push bridge
    // and the poll it already has.
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.refetchOnReconnect).toBe(false);
    // The list poll is SERVICE-AWARE, so this default is a function rather than
    // a constant: it never schedules the next read sooner than the last one
    // took. With no read observed yet it resolves to the floor, which is the
    // fixed cadence this assertion originally pinned.
    const listInterval = result.current.client.getQueryDefaults(
      agentSessionKeys.lists()
    )?.refetchInterval;
    expect(typeof listInterval).toBe("function");
    expect((listInterval as (query: unknown) => number)(undefined)).toBe(
      DESKTOP_SESSIONS_LIST_REFETCH_INTERVAL_MS
    );
  });

  it("authenticated + online runs the HTTP source under the refetch model", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );

    expect(result.current.source.scope).toBe(HTTP_SCOPE);
    // Trace comments read the org cloud API in Cloud mode (FEA-3460, reads-only)
    // so web comments are visible on desktop; the composite scope marks that its
    // reads are cloud/org while its writes stay local.
    expect(result.current.traceComments.scope).toBe(TRACE_COMMENTS_CLOUD_SCOPE);
    const queries = result.current.client.getDefaultOptions().queries;
    // Refetch model, not the local push model: focus-driven, finite staleTime,
    // and no 2 s background poll (that heals a local-bridge gap the cloud path
    // doesn't have).
    expect(queries?.refetchOnWindowFocus).toBe(true);
    // ISS-5976: reconnect stays OFF here, and now says so explicitly rather than
    // inheriting it. A reconnect in this mode changes the MODE, which rebuilds
    // this client from empty and refetches anyway, so a reconnect refetch would
    // be pure duplication.
    expect(queries?.refetchOnReconnect).toBe(false);
    expect(queries?.staleTime).toBe(WEB_DEFAULT_STALE_TIME_MS);
    expect(
      result.current.client.getQueryDefaults(agentSessionKeys.lists())
        ?.refetchInterval
    ).toBeUndefined();
  });

  it("authenticated but offline degrades to the local source (AC-3.3)", async () => {
    restoreOnline = forceOnline(false);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );

    // Own data from the local DB, not stale cloud rows — with the push model.
    expect(result.current.source.scope).toBe(LOCAL_SCOPE);
    // Authenticated-but-offline keeps trace comments on the local source too, so
    // the write path never blocks on connectivity (FEA-3460).
    expect(result.current.traceComments.scope).toBe(TRACE_COMMENTS_LOCAL_SCOPE);
    expect(result.current.client.getDefaultOptions().queries?.staleTime).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("swaps the source and the client when a sign-in flips the mode", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(SIGNED_OUT);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(DesktopAuthStatus.SignedOut)
    );
    const localClient = result.current.client;
    expect(result.current.source.scope).toBe(LOCAL_SCOPE);
    expect(result.current.traceComments.scope).toBe(TRACE_COMMENTS_LOCAL_SCOPE);

    act(() => push(AUTHENTICATED));

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );
    // A new mode means a new client (cache isolation, AC-3.1) and the cloud
    // source — not the local one carried over.
    expect(result.current.client).not.toBe(localClient);
    expect(result.current.source.scope).toBe(HTTP_SCOPE);
    // Trace comments flip to the Cloud reads-local-writes composite in lockstep
    // (FEA-3460, reads-only).
    expect(result.current.traceComments.scope).toBe(TRACE_COMMENTS_CLOUD_SCOPE);
  });

  it("a connectivity loss degrades an authenticated session to local and drops the cloud cache (AC-3.3)", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );
    expect(result.current.source.scope).toBe(HTTP_SCOPE);
    const cloudClient = result.current.client;

    // Seed a cloud-mode query so the flip's cache handling is observable: after
    // the degradation these org rows must be GONE, never served stale (AC-3.3
    // "team data absent, not stale").
    cloudClient.setQueryData(agentSessionKeys.lists(), {
      items: [{ id: "teammate-row" }],
      total: 1,
    });
    expect(cloudClient.getQueryData(agentSessionKeys.lists())).toBeDefined();

    // Lose connectivity: navigator flips offline and Chromium fires "offline",
    // which `useOnlineStatus` is subscribed to — no auth change involved.
    act(() => {
      restoreOnline?.();
      restoreOnline = forceOnline(false);
      window.dispatchEvent(new Event("offline"));
    });

    await waitFor(() => expect(result.current.source.scope).toBe(LOCAL_SCOPE));
    // A fresh client (the previous one, holding the org rows, is discarded) and
    // the local push model — own data, not stale cloud rows.
    expect(result.current.client).not.toBe(cloudClient);
    expect(
      result.current.client.getQueryData(agentSessionKeys.lists())
    ).toBeUndefined();
    expect(result.current.client.getDefaultOptions().queries?.staleTime).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("regaining connectivity returns an authenticated session to the cloud source", async () => {
    restoreOnline = forceOnline(false);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );
    // Authenticated but offline starts local (AC-3.3).
    expect(result.current.source.scope).toBe(LOCAL_SCOPE);
    const offlineClient = result.current.client;

    act(() => {
      restoreOnline?.();
      restoreOnline = forceOnline(true);
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(result.current.source.scope).toBe(HTTP_SCOPE));
    // A new client for the cloud mode — the local cache doesn't carry over.
    expect(result.current.client).not.toBe(offlineClient);
  });

  // FEA-3522: now that the cloud-api-fetch bridge carries an authenticated write
  // transport, Cloud-mode writes go over HTTP (create=POST, reply=POST /replies,
  // update=PATCH, delete=DELETE) to the org — NOT to the local IPC sink. This
  // drives every Cloud-mode mutation and asserts it reached the cloud bridge on
  // the expected route/method, and that the local sink was untouched.
  it("Cloud mode routes every trace-comment WRITE to the org over the HTTP bridge", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetchCalls } = setupDesktopApi(AUTHENTICATED);
    const { result } = renderProbe();

    await waitFor(() =>
      expect(result.current.traceComments.scope).toBe(
        TRACE_COMMENTS_CLOUD_SCOPE
      )
    );

    const localSink = (
      window.desktopApi as unknown as {
        traceCommentsApi: {
          create: ReturnType<typeof vi.fn>;
          reply: ReturnType<typeof vi.fn>;
          update: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      }
    ).traceCommentsApi;
    const source = result.current.traceComments;
    const base = "/agent-sessions/session-1/trace-comments";

    // Each mutation must resolve over the HTTP bridge, not reject.
    await expect(
      source.create(TRACE_TARGET, {
        anchor: makeStoredComment(TRACE_TARGET, "x").anchor,
        body: "hello",
      })
    ).resolves.toBeDefined();
    await expect(
      source.reply(TRACE_TARGET, "comment-1", { body: "re" })
    ).resolves.toBeDefined();
    await expect(
      source.update(TRACE_TARGET, "comment-1", { body: "edit" })
    ).resolves.toBeDefined();
    await expect(
      source.delete(TRACE_TARGET, "comment-1")
    ).resolves.toBeDefined();

    // Provably cloud: each write hit the bridge on the trace-comment route with
    // the right method, and the local IPC sink handled none of them. (Filter to
    // the mutating methods so a background list GET can't perturb the sequence.)
    const writeCalls = cloudApiFetchCalls.filter(
      (call) => call.method !== "GET"
    );
    expect(writeCalls).toEqual([
      { path: base, method: "POST", body: expect.any(String) },
      {
        path: `${base}/comment-1/replies`,
        method: "POST",
        body: expect.any(String),
      },
      {
        path: `${base}/comment-1`,
        method: "PATCH",
        body: expect.any(String),
      },
      { path: `${base}/comment-1`, method: "DELETE", body: undefined },
    ]);
    expect(localSink.create).not.toHaveBeenCalled();
    expect(localSink.reply).not.toHaveBeenCalled();
    expect(localSink.update).not.toHaveBeenCalled();
    expect(localSink.delete).not.toHaveBeenCalled();
  });
});

/**
 * FEA-3459 — the agent-components workspace must select its read source by mode
 * the same way Sessions does. Before the fix it was hardcoded to the local
 * SQLite source in both modes, so Cloud mode showed only this machine's
 * components with owner/collaborators/cohort-metrics/branches/multi-device
 * provenance blank. Cloud (authenticated + online) now reads the org-wide HTTP
 * source; every other state stays local.
 */
describe("DesktopAppCoreProvider agent-components source selection", () => {
  function renderComponentsProbe() {
    return renderHook(
      () => ({
        auth: useDesktopAuth(),
        source: useAgentComponentsDataSource(),
      }),
      { wrapper: DesktopAppCoreProvider }
    );
  }

  it("signed out reads the local agent-components source", async () => {
    setupDesktopApi(SIGNED_OUT);
    const { result } = renderComponentsProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(DesktopAuthStatus.SignedOut)
    );

    expect(result.current.source.scope).toBe(COMPONENTS_LOCAL_SCOPE);
  });

  it("authenticated + online reads the org-wide HTTP agent-components source", async () => {
    restoreOnline = forceOnline(true);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderComponentsProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );

    expect(result.current.source.scope).toBe(COMPONENTS_HTTP_SCOPE);
  });

  it("authenticated but offline degrades to the local agent-components source", async () => {
    restoreOnline = forceOnline(false);
    setupDesktopApi(AUTHENTICATED);
    const { result } = renderComponentsProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(
        DesktopAuthStatus.Authenticated
      )
    );

    expect(result.current.source.scope).toBe(COMPONENTS_LOCAL_SCOPE);
  });

  it("swaps the agent-components source when a sign-in flips the mode", async () => {
    restoreOnline = forceOnline(true);
    const { push } = setupDesktopApi(SIGNED_OUT);
    const { result } = renderComponentsProbe();

    await waitFor(() =>
      expect(result.current.auth.state.status).toBe(DesktopAuthStatus.SignedOut)
    );
    expect(result.current.source.scope).toBe(COMPONENTS_LOCAL_SCOPE);

    act(() => push(AUTHENTICATED));

    await waitFor(() =>
      expect(result.current.source.scope).toBe(COMPONENTS_HTTP_SCOPE)
    );
  });
});
