import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionEventsPage } from "@repo/api/src/types/agent-session-events-page";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import {
  LIST_QUERY_EXPRESSION_PARAM,
  LIST_QUERY_EXPRESSION_VERSION,
  ListFilterOperator,
  ListSortDirection,
} from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { ReadInitiator } from "@repo/api/src/types/read-initiator";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  AgentSessionCapability,
  agentSessionSourceSupports,
} from "@repo/app/agents/data-source/agent-sessions-data-source";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
  SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
  SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE,
} from "../../../shared/shared-agent-sessions-contract";
import { isTransientSourceError } from "../../shared/transient-source-error";
import type { DesktopApi } from "../../types/desktop-api";
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

const LIST: AgentSessionListResponse = {
  items: [],
  total: 3,
  viewerScope: "self",
};
const USAGE = { totalSessions: 3 } as unknown as AgentSessionUsageSummary;
const ANALYTICS = { viewerScope: "self" } as unknown as AgentSessionAnalytics;
const DETAIL = { id: "session-1" } as unknown as AgentSessionDetail;
const EVENTS_PAGE: AgentSessionEventsPage = {
  events: [
    {
      externalEventId: "10001",
      agentExternalId: null,
      eventType: "PostToolUse",
      toolName: "Bash",
      summary: "past the prefix",
      createdAt: "2026-07-10T00:00:10.001Z",
    },
  ],
  nextCursor: "opaque-next",
};

type AgentSessionsApi = DesktopApi["agentSessionsApi"];

function fakeDesktopApi(
  overrides: Partial<AgentSessionsApi> = {},
  onDbChanged?: DesktopApi["onDbChanged"]
): Parameters<typeof createLocalAgentSessionsDataSource>[0] {
  return {
    agentSessionsApi: {
      list: vi.fn(async () => LIST),
      detail: vi.fn(async () => DETAIL),
      usage: vi.fn(async () => USAGE),
      analytics: vi.fn(async () => ANALYTICS),
      pageData: vi.fn(async () => ({ list: LIST, usage: USAGE })),
      eventsPage: vi.fn(async () => EVENTS_PAGE),
      ...overrides,
    },
    onDbChanged,
  };
}

describe("createLocalAgentSessionsDataSource", () => {
  it("negotiates component scope and forwards the canonical scope through page data", async () => {
    const older = createLocalAgentSessionsDataSource(fakeDesktopApi());
    expect(older.supportsComponentScope).toBe(false);
    const api = fakeDesktopApi({
      componentScopeVersion: 1,
      pageData: vi.fn(async () => ({
        list: { ...LIST, componentScope: "skill::review" },
        usage: { ...USAGE, componentScope: "skill::review" },
      })),
    });
    const source = createLocalAgentSessionsDataSource(api);
    expect(source.supportsComponentScope).toBe(true);
    await source.pageData({
      componentSlug: "skill::review",
      offset: 50,
      limit: 50,
    });
    expect(api.agentSessionsApi.pageData).toHaveBeenCalledWith(
      expect.objectContaining({
        componentSlug: "skill::review",
        offset: 50,
        limit: 50,
      })
    );
  });
  it("identifies as the local scope", () => {
    expect(createLocalAgentSessionsDataSource(fakeDesktopApi()).scope).toBe(
      "local"
    );
  });

  it("reports an older preload without priority as read-only per session", () => {
    const api = fakeDesktopApi();
    const { updatePriority: _updatePriority, ...olderAgentSessionsApi } =
      api.agentSessionsApi;
    const source = createLocalAgentSessionsDataSource({
      ...api,
      agentSessionsApi: olderAgentSessionsApi,
    });

    expect(
      agentSessionSourceSupports(
        source,
        "session-1",
        AgentSessionCapability.UpdatePriority
      )
    ).toBe(false);
  });

  it("forwards filters to the IPC reads and returns their payloads", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);

    // FEA-3120: the local source stamps `readSource: local` at the boundary, so
    // the returned envelope carries the local rows *plus* the source tag.
    await expect(
      source.list({ harness: "claude", search: "session" })
    ).resolves.toEqual({ ...LIST, readSource: ReadSource.Local });
    await expect(source.usage({ status: "active" })).resolves.toBe(USAGE);
    await expect(source.analytics({})).resolves.toBe(ANALYTICS);

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith({
      harness: "claude",
      search: "session",
    });
    expect(api.agentSessionsApi.usage).toHaveBeenCalledWith({
      status: "active",
    });
    expect(api.agentSessionsApi.analytics).toHaveBeenCalledWith({});
  });

  it("stamps the read initiator on each instrumented IPC read, omitting it when absent (ISS-12039)", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const user = { readInitiator: ReadInitiator.User };
    const background = { readInitiator: ReadInitiator.Background };

    await source.list({ limit: 25 }, user);
    await source.usage({ status: "active" }, background);
    await source.pageData({ limit: 25 }, user);
    await source.detail("session-1", user);
    await source.detail("session-2");

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith({
      limit: 25,
      readInitiator: ReadInitiator.User,
    });
    expect(api.agentSessionsApi.usage).toHaveBeenCalledWith({
      status: "active",
      readInitiator: ReadInitiator.Background,
    });
    expect(api.agentSessionsApi.pageData).toHaveBeenCalledWith({
      limit: 25,
      readInitiator: ReadInitiator.User,
    });
    expect(vi.mocked(api.agentSessionsApi.detail).mock.calls).toEqual([
      ["session-1", { readInitiator: ReadInitiator.User }],
      ["session-2"],
    ]);
  });

  it("forwards multi-status filters unchanged to every aggregate IPC read", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const filters = {
      statuses: [SESSION_STATUS.ACTIVE, "completed", "abandoned"],
    };

    await source.list(filters);
    await source.usage(filters);
    await source.analytics(filters);

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith(filters);
    expect(api.agentSessionsApi.usage).toHaveBeenCalledWith(filters);
    expect(api.agentSessionsApi.analytics).toHaveBeenCalledWith(filters);
  });

  // ISS-8679: the ISS-8335 `sorts` rule list is NOT dropped at this boundary the
  // way `comparison` is below. This is the seam that arms the divergence — the
  // shared filter type carries `sorts`, so a v2 Sessions host mounted on desktop
  // reaches the local SQLite source with a stacked rule list. Forwarding it is
  // what lets `sanitizeQuery` refuse it; swallowing it here would restore the
  // silent single-rule order this ticket exists to remove.
  it("forwards a multi-rule sorts list to the IPC reads rather than dropping it", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const filters = {
      sortBy: "harness",
      sortDir: "asc" as const,
      sorts: ["harness:asc", "repo:asc"],
    };

    await source.list(filters);
    await source.pageData(filters);

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith(filters);
    expect(api.agentSessionsApi.pageData).toHaveBeenCalledWith(filters);
  });

  // ISS-6041: the port now carries the ISS-5809 `comparison` opt-in so a Cloud-
  // mode reader can ask the HTTP source for the prior window. This producer has
  // no prior-window read and the IPC contract does not model the field, so it is
  // dropped at the boundary rather than sent through. The rest of the filters
  // must reach the IPC read untouched.
  it("drops the usage comparison opt-in before the pageData IPC read", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);

    const page = await source.pageData({
      startDate: "2026-08-04T00:00:00.000Z",
      limit: 25,
      comparison: AgentSessionComparisonMode.Prior,
    });

    // PRD-721: the window travels as the `listQuery` expression main
    // compiles back to `startDate`; paging stays beside it.
    expect(api.agentSessionsApi.pageData).toHaveBeenCalledWith({
      limit: 25,
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.LastActivity,
            operator: ListFilterOperator.IsBetween,
            min: "2026-08-04T00:00:00.000Z",
          },
        ],
      },
    });
    // No comparison in, none out — the cards read that as "no chip", never a zero.
    expect(page.usage?.comparison).toBeUndefined();
  });

  // FEA-3120: an explicit source the IPC layer already reported wins — the
  // boundary never clobbers it back to `local`.
  it("preserves an explicit readSource from the IPC list payload", async () => {
    const api = fakeDesktopApi({
      list: vi.fn(async () => ({ ...LIST, readSource: ReadSource.Fallback })),
    });
    const source = createLocalAgentSessionsDataSource(api);

    await expect(source.list({})).resolves.toMatchObject({
      readSource: ReadSource.Fallback,
    });
  });

  it("returns a present detail unchanged", async () => {
    const source = createLocalAgentSessionsDataSource(fakeDesktopApi());
    await expect(source.detail("session-1")).resolves.toBe(DETAIL);
  });

  it("rejects a missing detail as a 404 ApiError instead of resolving null", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({ detail: vi.fn(async () => null) })
    );

    const error = await source.detail("missing").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_NOT_FOUND_CODE);
  });

  it("maps a source failure to a sanitized 500 ApiError without leaking the raw error", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({
        list: vi.fn(() =>
          Promise.reject(new Error("sql error reading /Users/secret/cwd"))
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE);
    expect(error.message).toBe("Agent sessions source failed.");
    expect(error.message).not.toContain("secret");
  });

  // ISS-4483: a TRANSIENT db-host-restart failure (the child crash-looping /
  // restarting mid-backfill) must NOT become a fatal 500 ApiError — that fails fast
  // and dumps the user on the hard "something went wrong" card. It becomes a
  // retryable TransientSourceError carrying the transient code, so the shared query
  // client auto-retries it and the renderer routes it to the reconnecting surface.
  it.each([
    "db-host exited (code: 5)",
    "db-host is not running (op: list)",
    "db-host is closed (op: pageData)",
    // The Electron IPC boundary wraps the original message with a prefix; the
    // classifier still matches the lifecycle signature inside it.
    "Error invoking remote method 'shared:agent-sessions:list': Error: db-host exited (code: 11)",
  ])(
    "maps a transient db-host failure (%s) to a retryable TransientSourceError, not a fatal 500",
    async (rawMessage) => {
      const source = createLocalAgentSessionsDataSource(
        fakeDesktopApi({
          list: vi.fn(() => Promise.reject(new Error(rawMessage))),
        })
      );

      const error = await source.list({}).catch((caught) => caught);
      // Not an ApiError, so it is not response-backed and stays eligible for the
      // shared query client's bounded transient retry (vs a fatal 500 that fails
      // fast). Carries the transient code so the renderer routes to reconnecting.
      expect(error).not.toBeInstanceOf(ApiError);
      expect(isTransientSourceError(error)).toBe(true);
      expect(error.code).toBe(SHARED_AGENT_SESSIONS_TRANSIENT_ERROR_CODE);
      // The raw underlying message is still discarded — no leak, same as the fatal
      // path.
      expect(error.message).toBe("Agent sessions source failed.");
      expect(error.message).not.toContain("op:");
      expect(error.message).not.toContain("code:");
    }
  );

  // A genuine (non-lifecycle) failure stays a fatal 500 ApiError so the hard error
  // + Retry still surfaces immediately for a real breakage.
  it("keeps a non-transient failure a fatal 500 ApiError (not classified transient)", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({
        list: vi.fn(() =>
          Promise.reject(
            new Error("SQLITE_CORRUPT: database disk image is malformed")
          )
        ),
      })
    );

    const error = await source.list({}).catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(isTransientSourceError(error)).toBe(false);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE);
  });

  it("maps a detail source failure to a 500 (not a 404)", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({
        detail: vi.fn(() => Promise.reject(new Error("boom"))),
      })
    );

    const error = await source.detail("x").catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE);
  });

  // ISS-9857: the events page rides the same IPC-to-port mapping `detail` does.
  it("forwards an events page request and returns the page unchanged", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const request = { id: "session-1", cursor: "opaque-first", limit: 500 };

    await expect(source.eventsPage?.(request)).resolves.toBe(EVENTS_PAGE);
    expect(api.agentSessionsApi.eventsPage).toHaveBeenCalledWith(request);
  });

  // The producer's ONE fail-closed answer is `null` — an unknown session, a
  // source that cannot page, or a cursor that does not decode all collapse onto
  // it — and it maps to the same 404 `detail` uses. So on the desktop a
  // MALFORMED CURSOR reads as not-found where the cloud route answers 400.
  // Acceptable because the client only replays producer-minted cursors, and
  // deliberate so `null` stays the one refusal the renderer has to learn.
  it("rejects a null events page as a 404 ApiError instead of resolving null", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({ eventsPage: vi.fn(async () => null) })
    );

    const error = await source
      .eventsPage?.({ id: "session-1", cursor: "not-a-cursor" })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_NOT_FOUND_CODE);
  });

  it("omits eventsPage when the preload predates the channel, so the panel sees no continuation", () => {
    // A mirrored renderer on an older installed build: the bridge projects
    // every read the host has and leaves this one out. The panel reads an
    // absent `eventsPage` as "cannot page" and keeps its end-of-read note; a
    // present method that threw would instead render as a failed read.
    const api = fakeDesktopApi();
    const { eventsPage: _eventsPage, ...olderApi } = api.agentSessionsApi;
    const source = createLocalAgentSessionsDataSource({
      ...api,
      agentSessionsApi: olderApi,
    });

    expect(Object.hasOwn(source, "eventsPage")).toBe(false);
  });

  it("maps an events page source failure to a sanitized 500 (not a 404)", async () => {
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({
        eventsPage: vi.fn(() =>
          Promise.reject(new Error("sql error reading /Users/secret/events"))
        ),
      })
    );

    const error = await source
      .eventsPage?.({ id: "session-1" })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.code).toBe(SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE);
    expect(error.message).not.toContain("secret");
  });

  it("wires subscribe to onDbChanged and forwards the payload + unsubscribe", () => {
    const unsubscribe = vi.fn();
    const onDbChanged = vi.fn(
      (_cb: (payload: { sessionId?: string }) => void) => unsubscribe
    );
    const source = createLocalAgentSessionsDataSource(
      fakeDesktopApi({}, onDbChanged)
    );

    const onChange = vi.fn();
    const stop = source.subscribe?.(onChange);
    expect(onDbChanged).toHaveBeenCalledTimes(1);

    // The wrapper handed to onDbChanged forwards the DB-change payload through.
    const forward = onDbChanged.mock.calls[0]?.[0];
    forward?.({ sessionId: "session-9" });
    expect(onChange).toHaveBeenCalledWith({ sessionId: "session-9" });

    stop?.();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("omits subscribe when the preload exposes no onDbChanged", () => {
    const source = createLocalAgentSessionsDataSource(fakeDesktopApi());
    expect(source.subscribe).toBeUndefined();
  });
});

// PRD-721 / ISS-9346: the list read sends its filter and sort as the canonical
// `listQuery` expression, which main compiles back to the legacy params.
describe("createLocalAgentSessionsDataSource listQuery", () => {
  it("sends the list read's facets and sort as one expression", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);

    await source.list({
      repositories: ["acme/web"],
      sortBy: SessionListField.Started,
      sortDir: ListSortDirection.Asc,
      limit: 25,
      offset: 0,
    });

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      [LIST_QUERY_EXPRESSION_PARAM]: {
        version: LIST_QUERY_EXPRESSION_VERSION,
        filters: [
          {
            field: SessionListField.Repo,
            operator: ListFilterOperator.IsAnyOf,
            values: ["acme/web"],
          },
        ],
        sorts: [
          { field: SessionListField.Started, direction: ListSortDirection.Asc },
        ],
      },
    });
  });

  // `completedAfter` is a bound no column renders, so no expression states it.
  it("keeps the legacy params for a request the expression cannot state", async () => {
    const api = fakeDesktopApi();
    const source = createLocalAgentSessionsDataSource(api);
    const filters = {
      repositories: ["acme/web"],
      completedAfter: "2026-08-04T00:00:00.000Z",
    };

    await source.list(filters);

    expect(api.agentSessionsApi.list).toHaveBeenCalledWith(filters);
  });
});
