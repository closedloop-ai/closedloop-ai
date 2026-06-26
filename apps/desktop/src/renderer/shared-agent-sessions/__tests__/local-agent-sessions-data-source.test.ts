import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { ApiError } from "@repo/app/shared/api/api-error";
import { describe, expect, it, vi } from "vitest";
import {
  SHARED_AGENT_SESSIONS_NOT_FOUND_CODE,
  SHARED_AGENT_SESSIONS_SOURCE_ERROR_CODE,
} from "../../../shared/shared-agent-sessions-contract";
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

    await expect(
      source.list({ harness: "claude", search: "session" })
    ).resolves.toBe(LIST);
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
