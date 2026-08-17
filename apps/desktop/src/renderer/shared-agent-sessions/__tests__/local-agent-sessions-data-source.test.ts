import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { AgentSessionComparisonMode } from "@repo/api/src/types/agent-session-usage-comparison";
import { ReadSource } from "@repo/api/src/types/read-source";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
      ...overrides,
    },
    onDbChanged,
  };
}

describe("createLocalAgentSessionsDataSource", () => {
  it("identifies as the local scope", () => {
    expect(createLocalAgentSessionsDataSource(fakeDesktopApi()).scope).toBe(
      "local"
    );
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

    expect(api.agentSessionsApi.pageData).toHaveBeenCalledWith({
      startDate: "2026-08-04T00:00:00.000Z",
      limit: 25,
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
  ])("maps a transient db-host failure (%s) to a retryable TransientSourceError, not a fatal 500", async (rawMessage) => {
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
  });

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
