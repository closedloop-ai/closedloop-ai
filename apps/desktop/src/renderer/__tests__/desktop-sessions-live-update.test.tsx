import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LOCAL_SESSION_SOURCE_STATUSES } from "../../shared/local-session-source-status";
import { DesktopNavigationApp } from "../App";
import {
  createDesktopNavigation,
  type DesktopNavigation,
} from "../navigation/desktop-adapter";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import type { AgentMonitorUrl } from "../types/desktop-api";

type DbChangePayload = { sessionId?: string };
type ToolDetail = { detail: string; err: boolean; label: string };

const activeNavigations = new Set<DesktopNavigation>();
// Mutable fixture the IPC mock reads on every call, so a live refetch driven by
// a `desktop:db:changed` event observes the new rows/totals.
let fixtureItems: AgentSessionListItem[] = [];
let fixtureDetails = new Map<string, AgentSessionDetail | null>();
let listShouldFail = false;
let agentMonitorUrl: AgentMonitorUrl;
// The desktop provider mounts MORE than one live bridge on the same
// `desktop:db:changed` stream (AgentSessionsLiveBridge + InsightsLiveBridge), and
// production fans every event out to ALL subscribers — so the mock must too,
// rather than keeping only the last subscriber.
const dbChangeSubscribers = new Set<(payload: DbChangePayload) => void>();
const emitDbChange = (payload: DbChangePayload = {}) => {
  for (const cb of [...dbChangeSubscribers]) {
    cb(payload);
  }
};

describe.sequential("Desktop Sessions live updates (FEA-1834)", () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: false,
        media: "",
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
  });

  beforeEach(() => {
    fixtureItems = [agentSessionListItem("alpha", "Alpha Session")];
    fixtureDetails = new Map([["alpha", agentSessionDetail("alpha")]]);
    listShouldFail = false;
    agentMonitorUrl = readyAgentMonitorUrl();
    dbChangeSubscribers.clear();
    installDesktopApi();
  });

  afterEach(() => {
    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    globalThis.location.hash = "";
  });

  it("refreshes the list and summary in place on a desktop:db:changed event", async () => {
    renderDesktopApp();

    // Initial load: one session, and the summary reflects one session.
    expect(await findRendererText("Alpha Session")).toBeDefined();
    await waitFor(() => {
      expect(totalSessionsMetricValue()).toBe("1");
    });

    // New data lands in the local DB.
    fixtureItems = [
      agentSessionListItem("alpha", "Alpha Session"),
      agentSessionListItem("beta", "Beta Session"),
    ];

    act(() => {
      emitDbChange({});
    });

    // The last-good row stays rendered through the background refetch — no
    // skeleton flash and no reset to an empty/loading state.
    expect(screen.getByText("Alpha Session")).toBeDefined();

    // Both the list and the summary cards update live, with no manual refresh.
    expect(await findRendererText("Beta Session")).toBeDefined();
    await waitFor(() => {
      expect(totalSessionsMetricValue()).toBe("2");
    });
  });

  it("keeps startup reads gated until the local session source is ready", async () => {
    agentMonitorUrl = {
      ...readyAgentMonitorUrl(),
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.starting,
      ready: false,
    };
    installDesktopApi();

    renderDesktopApp();

    await waitFor(() => {
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled();
    });
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(screen.getByText("Loading sessions...")).toBeDefined();
    expect(screen.queryByText("No sessions found")).toBeNull();
    expect(totalSessionsMetricValue()).toBe("...");

    agentMonitorUrl = readyAgentMonitorUrl();
    act(() => {
      emitDbChange({});
    });

    expect(await findRendererText("Alpha Session")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(totalSessionsMetricValue()).toBe("1");
    });
  });

  it("shows the true empty state only after the local session source is ready", async () => {
    fixtureItems = [];
    installDesktopApi();

    renderDesktopApp();

    expect(await findRendererText("No sessions found")).toBeDefined();
    expect(
      screen.getByText("No synced sessions match your current filters yet.")
    ).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(totalSessionsMetricValue()).toBe("0");
    });
  });

  it.each([
    LOCAL_SESSION_SOURCE_STATUSES.disabled,
    LOCAL_SESSION_SOURCE_STATUSES.unavailable,
  ])("renders unavailable without list or usage reads when the source is %s", async (localSessionSourceStatus) => {
    agentMonitorUrl = {
      ...readyAgentMonitorUrl(),
      enabled:
        localSessionSourceStatus !== LOCAL_SESSION_SOURCE_STATUSES.disabled,
      localSessionSourceStatus,
      ready: false,
    };
    installDesktopApi();

    renderDesktopApp();

    expect(
      await findRendererText("Sessions are temporarily unavailable.")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(screen.queryByText("No sessions found")).toBeNull();
    expect(totalSessionsMetricValue()).toBe("Unavailable");
    expect(totalTokensMetricValue()).toBe("Unavailable");
  });

  it("supports legacy omitted local-session status payloads without enabling disabled reads", async () => {
    agentMonitorUrl = {
      enabled: true,
      planExtractionEnabled: true,
      ready: true,
      url: "http://127.0.0.1:0",
    } as AgentMonitorUrl;
    installDesktopApi();

    renderDesktopApp();

    expect(await findRendererText("Alpha Session")).toBeDefined();
    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledTimes(1);
      expect(window.desktopApi.agentSessionsApi.usage).toHaveBeenCalledTimes(1);
    });

    for (const navigation of activeNavigations) {
      navigation.dispose();
    }
    activeNavigations.clear();
    cleanup();

    agentMonitorUrl = {
      enabled: false,
      planExtractionEnabled: true,
      ready: false,
      url: null,
    } as AgentMonitorUrl;
    installDesktopApi();

    renderDesktopApp();

    expect(
      await findRendererText("Sessions are temporarily unavailable.")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
  });

  it("fails closed when the additive local-session status is unknown", async () => {
    agentMonitorUrl = {
      ...readyAgentMonitorUrl(),
      localSessionSourceStatus: "unexpected-ready" as never,
    };
    installDesktopApi();

    renderDesktopApp();

    await waitFor(() => {
      expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled();
    });
    expect(window.desktopApi.agentSessionsApi.list).not.toHaveBeenCalled();
    expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    expect(screen.queryByText("Alpha Session")).toBeNull();
    expect(totalSessionsMetricValue()).toBe("...");
  });

  it("does not render cached rows or usage after the local session source becomes terminal", async () => {
    renderDesktopApp();

    expect(await findRendererText("Alpha Session")).toBeDefined();
    await waitFor(() => {
      expect(totalSessionsMetricValue()).toBe("1");
    });

    agentMonitorUrl = {
      ...readyAgentMonitorUrl(),
      enabled: false,
      localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.disabled,
      ready: false,
      url: null,
    };
    act(() => {
      emitDbChange({});
    });

    expect(
      await findRendererText("Sessions are temporarily unavailable.")
    ).toBeDefined();
    expect(screen.queryByText("Alpha Session")).toBeNull();
    expect(totalSessionsMetricValue()).toBe("Unavailable");
    expect(totalTokensMetricValue()).toBe("Unavailable");
  });

  it("keeps last-good rows on a transient live refetch failure (degrades gracefully)", async () => {
    renderDesktopApp();

    expect(await findRendererText("Alpha Session")).toBeDefined();

    // The live refetch fails transiently (the local source maps it to a
    // sanitized 500, so there is no retry storm — one attempt).
    listShouldFail = true;
    act(() => {
      emitDbChange({});
    });

    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledTimes(2);
    });

    // Graceful degrade (PLN-941 §5): the last-good row stays rendered — no
    // blank/error wipe, no skeleton. Recovery on the next event is covered by
    // the bridge-level failure→recovery test.
    expect(screen.getByText("Alpha Session")).toBeDefined();
    expect(
      screen.queryByText("Sessions are temporarily unavailable.")
    ).toBeNull();
  });

  it("refetches scoped detail and rerenders Session Trace tool details on a desktop:db:changed event", async () => {
    renderDesktopApp();
    act(() => {
      globalThis.location.hash = "#/sessions/alpha";
      globalThis.dispatchEvent(new Event("hashchange"));
    });

    expect(await findRendererText("Alpha Session")).toBeDefined();
    expect(await findRendererText("pnpm test before")).toBeDefined();
    expect(screen.queryByText("pnpm test after")).toBeNull();

    fixtureDetails.set(
      "alpha",
      agentSessionDetail("alpha", [
        { detail: "pnpm test after", err: false, label: "exec_command" },
        { detail: "git diff --stat", err: false, label: "exec_command" },
      ])
    );

    act(() => {
      emitDbChange({ sessionId: "alpha" });
    });

    await waitFor(() => {
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledTimes(
        2
      );
    });
    expect(await findRendererText("pnpm test after")).toBeDefined();
    expect(await findRendererText("git diff --stat")).toBeDefined();
    expect(screen.getAllByText("exec_command")).toHaveLength(2);
    expect(screen.queryByText("pnpm test before")).toBeNull();
  });
});

// Reads the live value rendered in the "Total Sessions" metric card, which now
// carries the session-count summary that the page title/subtext used to show.
function totalSessionsMetricValue(): string | null {
  return metricValue("Total Sessions");
}

function totalTokensMetricValue(): string | null {
  return metricValue("Total Tokens");
}

function metricValue(labelText: string): string | null {
  const label = screen.getByText(labelText);
  const value = label.parentElement?.querySelector("[data-slot='card-title']");
  return value?.textContent ?? null;
}

function renderDesktopApp() {
  globalThis.location.hash = "";
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return render(
    <DesktopAppCoreProvider>
      <DesktopNavigationApp navigation={navigation} />
    </DesktopAppCoreProvider>
  );
}

function findRendererText(text: string) {
  return screen.findByText(text, undefined, { timeout: 5000 });
}

function installDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(() => Promise.resolve(agentSessionAnalytics())),
        detail: vi.fn((id: string) =>
          Promise.resolve(fixtureDetails.get(id) ?? null)
        ),
        list: vi.fn((request: { limit?: number; offset?: number } = {}) => {
          if (listShouldFail) {
            return Promise.reject(new Error("transient source failure"));
          }
          const offset = request.offset ?? 0;
          const limit = request.limit ?? fixtureItems.length;
          return Promise.resolve({
            items: fixtureItems.slice(offset, offset + limit),
            total: fixtureItems.length,
            viewerScope: "self",
          } satisfies AgentSessionListResponse);
        }),
        usage: vi.fn(() =>
          Promise.resolve(agentSessionUsage(fixtureItems.length))
        ),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
      getAgentMonitorUrl: vi.fn(() => Promise.resolve(agentMonitorUrl)),
      getAllFlags: vi.fn(() => Promise.resolve({ flags: [] })),
      onDbChanged: vi.fn((cb: (payload: DbChangePayload) => void) => {
        dbChangeSubscribers.add(cb);
        return () => {
          dbChangeSubscribers.delete(cb);
        };
      }),
    },
  });
}

function readyAgentMonitorUrl(): AgentMonitorUrl {
  return {
    enabled: true,
    localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.ready,
    planExtractionEnabled: true,
    ready: true,
    url: "http://127.0.0.1:0",
  };
}

function agentSessionListItem(id: string, name: string): AgentSessionListItem {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cwd: "/tmp/live-session",
    endedAt: timestamp,
    errorCount: 0,
    estimatedCost: 0.01,
    externalSessionId: id,
    harness: "codex",
    id,
    inputTokens: 10,
    issueId: null,
    lastActivityAt: timestamp,
    model: "gpt-test",
    name,
    outputTokens: 20,
    project: null,
    repositoryFullName: "closedloop-ai/symphony-alpha",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: timestamp,
    status: "active",
    toolUseCount: 1,
    updatedAt: timestamp,
    user: null,
    worktreePath: "/tmp/symphony-alpha",
  };
}

function agentSessionDetail(
  id: string,
  tools: readonly ToolDetail[] = [
    { detail: "pnpm test before", err: false, label: "exec_command" },
    { detail: "git status", err: false, label: "exec_command" },
  ]
): AgentSessionDetail {
  const item = agentSessionListItem(id, "Alpha Session");
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    ...item,
    activityBuckets: [],
    agents: [],
    attribution: null,
    events: [],
    markers: [],
    metadata: null,
    phases: [],
    phaseIterations: {},
    phaseLoopbacks: [],
    prs: [],
    prsMerged: 0,
    span: null,
    throttles: [],
    timeline: [],
    tokenUsageByModel: [],
    turnItems: [
      {
        _row: 0,
        actor: {
          color: "var(--primary)",
          harness: "codex",
          human: null,
          name: "gpt-test",
          sessionId: id,
        },
        cats: { tool: tools.length },
        cum: 1,
        defaultOpen: true,
        endMs: timestamp.getTime() + 1000,
        failN: tools.filter((tool) => tool.err).length,
        hasFail: tools.some((tool) => tool.err),
        items: tools.map((tool) => ({ ...tool })),
        summary: `Ran ${tools.length} tools`,
        t: timestamp.toISOString(),
        tMs: timestamp.getTime(),
        type: "tools",
      },
    ],
  };
}

function agentSessionUsage(totalSessions: number): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    latestSessionAt: null,
    lastSyncTargets: [],
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions,
    viewerScope: "self",
  };
}

function agentSessionAnalytics(): AgentSessionAnalytics {
  return {
    byAgentType: [],
    byProject: [],
    byRepository: [],
    byTool: [],
    viewerScope: "self",
  };
}
