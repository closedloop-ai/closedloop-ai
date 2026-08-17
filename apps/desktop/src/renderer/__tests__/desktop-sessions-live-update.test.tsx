import type {
  AgentSessionAnalytics,
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionsPageData,
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
const rendererTextTimeoutMs = 10_000;
const rendererTestTimeoutMs = 15_000;
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
    cleanup();
    globalThis.location.hash = "";
  });

  it(
    "refreshes the list and summary in place on a desktop:db:changed event",
    async () => {
      renderDesktopApp("#/sessions");

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
    },
    rendererTestTimeoutMs
  );

  it(
    "keeps startup reads gated until the local session source is ready",
    async () => {
      agentMonitorUrl = {
        ...readyAgentMonitorUrl(),
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.starting,
        ready: false,
      };
      installDesktopApi();

      renderDesktopApp("#/sessions");

      await waitFor(() => {
        expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled();
      });
      // FEA-4157: the org view reads list + summary through the combined
      // `pageData` IPC call, so that is the read gated on source readiness.
      expect(
        window.desktopApi.agentSessionsApi.pageData
      ).not.toHaveBeenCalled();
      expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
      expect(screen.getByText("Loading sessions...")).toBeDefined();
      expect(screen.queryByText("No sessions found")).toBeNull();
      expect(summaryCardsAreLoading()).toBe(true);

      agentMonitorUrl = readyAgentMonitorUrl();
      act(() => {
        emitDbChange({});
      });

      expect(await findRendererText("Alpha Session")).toBeDefined();
      await waitFor(() => {
        expect(window.desktopApi.agentSessionsApi.pageData).toHaveBeenCalled();
      });
      await waitFor(() => {
        expect(totalSessionsMetricValue()).toBe("1");
      });
    },
    rendererTestTimeoutMs
  );

  it(
    "shows the true empty state only after the local session source is ready",
    async () => {
      fixtureItems = [];
      installDesktopApi();

      renderDesktopApp("#/sessions");

      // FEA-4181: a hydrated, unfiltered, zero-row source is the genuine
      // "No sessions yet" onboarding zero-state (not the old "No sessions found"
      // that couldn't tell a filtered-away scope from a genuinely-empty one).
      expect(await findRendererText("No sessions yet")).toBeDefined();
      expect(
        screen.getByText(
          "Sessions appear here once your connected compute targets sync their agent history."
        )
      ).toBeDefined();
      await waitFor(() => {
        expect(
          window.desktopApi.agentSessionsApi.pageData
        ).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(totalSessionsMetricValue()).toBe("0");
      });
    },
    rendererTestTimeoutMs
  );

  it(
    "renders unavailable without list or usage reads when the source is unavailable",
    async () => {
      agentMonitorUrl = {
        ...readyAgentMonitorUrl(),
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.unavailable,
        ready: false,
      };
      installDesktopApi();

      renderDesktopApp("#/sessions");

      // FEA-4181 (review cid 3653690775): a not-yet-hydrated local source is
      // syncing, not broken — the quiet holding message, no error chrome/Retry.
      expect(
        await findRendererText("Getting your sessions ready")
      ).toBeDefined();
      expect(
        window.desktopApi.agentSessionsApi.pageData
      ).not.toHaveBeenCalled();
      expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
      expect(screen.queryByText("No sessions yet")).toBeNull();
      // FEA-3937: the source-unavailable state renders the shared bar's error
      // placeholder — every card value is "—", not the desktop's prior
      // "Unavailable" headline.
      expect(totalSessionsMetricValue()).toBe("—");
      expect(totalTokensMetricValue()).toBe("—");
    },
    rendererTestTimeoutMs
  );

  it(
    "supports legacy omitted local-session status payloads by mapping ready→reads",
    async () => {
      agentMonitorUrl = {
        planExtractionEnabled: true,
        ready: true,
        url: "http://127.0.0.1:0",
      } as AgentMonitorUrl;
      installDesktopApi();

      renderDesktopApp("#/sessions");

      expect(await findRendererText("Alpha Session")).toBeDefined();
      await waitFor(() => {
        // FEA-4157: the combined list + summary read is `pageData`.
        expect(
          window.desktopApi.agentSessionsApi.pageData
        ).toHaveBeenCalledTimes(1);
      });
      // FEA-4177: on the no-facet / all-quality default path the standalone
      // facet-option `usage` read is deduped — its scope equals the combined
      // read's facet-unfiltered `pageData.usage`, so the toolbar reuses that
      // half and the separate read stays disabled. It only fires once a facet
      // goes active or quality narrows the set (covered elsewhere). Assert the
      // deduped default: `pageData` settles the view, `usage` never fires.
      expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
    },
    rendererTestTimeoutMs
  );

  it(
    "fails closed when the additive local-session status is unknown",
    async () => {
      agentMonitorUrl = {
        ...readyAgentMonitorUrl(),
        localSessionSourceStatus: "unexpected-ready" as never,
      };
      installDesktopApi();

      renderDesktopApp("#/sessions");

      await waitFor(() => {
        expect(window.desktopApi.getAgentMonitorUrl).toHaveBeenCalled();
      });
      expect(
        window.desktopApi.agentSessionsApi.pageData
      ).not.toHaveBeenCalled();
      expect(window.desktopApi.agentSessionsApi.usage).not.toHaveBeenCalled();
      expect(screen.queryByText("Alpha Session")).toBeNull();
      expect(summaryCardsAreLoading()).toBe(true);
    },
    rendererTestTimeoutMs
  );

  it(
    "does not render cached rows or usage after the local session source becomes terminal",
    async () => {
      renderDesktopApp("#/sessions");

      expect(await findRendererText("Alpha Session")).toBeDefined();
      await waitFor(() => {
        expect(totalSessionsMetricValue()).toBe("1");
      });

      agentMonitorUrl = {
        ...readyAgentMonitorUrl(),
        localSessionSourceStatus: LOCAL_SESSION_SOURCE_STATUSES.unavailable,
        ready: false,
        url: null,
      };
      act(() => {
        emitDbChange({});
      });

      // FEA-4181 (review cid 3653690775): terminal-unavailable local source is
      // syncing (not errored) — the quiet holding message, no cached rows.
      expect(
        await findRendererText("Getting your sessions ready")
      ).toBeDefined();
      expect(screen.queryByText("Alpha Session")).toBeNull();
      // FEA-3937: terminal-unavailable renders the shared bar's error
      // placeholder ("—") rather than the desktop's prior "Unavailable" text.
      expect(totalSessionsMetricValue()).toBe("—");
      expect(totalTokensMetricValue()).toBe("—");
    },
    rendererTestTimeoutMs
  );

  it(
    "keeps last-good rows on a transient live refetch failure (degrades gracefully)",
    async () => {
      renderDesktopApp("#/sessions");

      expect(await findRendererText("Alpha Session")).toBeDefined();

      // The live refetch fails transiently (the local source maps it to a
      // sanitized 500, so there is no retry storm — one attempt). The failing
      // read is now the combined `pageData` scan.
      listShouldFail = true;
      act(() => {
        emitDbChange({});
      });

      await waitFor(() => {
        expect(
          window.desktopApi.agentSessionsApi.pageData
        ).toHaveBeenCalledTimes(2);
      });

      // Graceful degrade (PLN-941 §5): the last-good row stays rendered — no
      // blank/error wipe, no skeleton. Recovery on the next event is covered by
      // the bridge-level failure→recovery test.
      expect(screen.getByText("Alpha Session")).toBeDefined();
      expect(
        screen.queryByText("Sessions are temporarily unavailable.")
      ).toBeNull();
    },
    rendererTestTimeoutMs
  );

  it(
    "refetches scoped synced detail and rerenders the shared Session Details boundary on a desktop:db:changed event",
    async () => {
      renderDesktopApp("#/sessions/alpha");

      expect(await findRendererText("pnpm test before")).toBeDefined();
      expect(screen.getAllByText("Alpha Session").length).toBeGreaterThan(0);
      expect(screen.queryByText("pnpm test after")).toBeNull();

      fixtureDetails.set(
        "alpha",
        agentSessionDetail(
          "alpha",
          [
            { detail: "pnpm test after", err: false, label: "exec_command" },
            { detail: "git diff --stat", err: false, label: "exec_command" },
          ],
          {
            branch: "fea-1944",
            estimatedCost: 4.82,
            inputTokens: 12_000,
            model: "gpt-5.5",
            name: "Uploaded Cloud Session Detail",
            outputTokens: 3200,
            repositoryFullName: "closedloop-ai/symphony-alpha",
            tokenUsageByModel: [
              {
                cacheReadTokens: 900,
                cacheWriteTokens: 400,
                estimatedCostUsd: 4.82,
                inputTokens: 12_000,
                model: "gpt-5.5",
                outputTokens: 3200,
              },
            ],
          }
        )
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
      await waitFor(() => {
        expect(
          screen.getAllByText("Uploaded Cloud Session Detail")
        ).toHaveLength(2);
      });
      expect(
        screen.getAllByText("closedloop-ai/symphony-alpha").length
      ).toBeGreaterThan(0);
      expect(screen.getAllByText("exec_command")).toHaveLength(2);
      expect(screen.queryByText("pnpm test before")).toBeNull();
    },
    rendererTestTimeoutMs
  );
});

// Reads the live value rendered in the shared summary bar's "Sessions" metric
// card (FEA-3937: the hoisted composite renamed the desktop's "Total Sessions"
// card to the ratified "Sessions" label).
function totalSessionsMetricValue(): string | null {
  return metricValue("Sessions");
}

function totalTokensMetricValue(): string | null {
  return metricValue("Total Tokens");
}

// True while the shared summary bar is in its whole-row loading state.
//
// ISS-5366: this used to be "the Sessions card label is absent", which held
// while the loading strip painted five bare `Skeleton` slabs carrying no labels
// at all. Those slabs reserved a hardcoded height that did not track the card's
// real one, so the strip settled when the data landed; the loading slots are now
// real `MetricCard` shells, which DO render their labels. An absent label
// therefore no longer means "pending" — it means the strip has not mounted.
//
// What still separates pending from settled is the VALUE: `MetricCard loading`
// renders a Skeleton in the value slot, so the card title carries no text, where
// a settled card reads "1" and a failed read reads the em-dash. Both of those
// are non-empty, so this stays a real discriminator rather than a check that
// passes on any render.
function summaryCardsAreLoading(): boolean {
  if (findMetricCardLabel("Sessions") === null) {
    return true;
  }
  return (metricValue("Sessions") ?? "").trim() === "";
}

// Finds the MetricCard `card-description` element whose text matches the given
// summary-card label. The "Sessions" and "Total Tokens" strings also appear in
// the desktop sidebar nav, so match strictly within a metric card header
// (`[data-slot='card-description']`) rather than anywhere in the document.
function findMetricCardLabel(labelText: string): Element | null {
  const descriptions = Array.from(
    document.querySelectorAll("[data-slot='card-description']")
  );
  return (
    descriptions.find(
      (description) => description.textContent?.trim() === labelText
    ) ?? null
  );
}

function metricValue(labelText: string): string | null {
  const label = findMetricCardLabel(labelText);
  const value = label
    ?.closest("[data-slot='card-header']")
    ?.querySelector("[data-slot='card-title']");
  return value?.textContent ?? null;
}

function renderDesktopApp(initialHash = "") {
  globalThis.location.hash = initialHash;
  const navigation = createDesktopNavigation();
  activeNavigations.add(navigation);
  return render(
    <DesktopAppCoreProvider>
      <DesktopNavigationApp navigation={navigation} />
    </DesktopAppCoreProvider>
  );
}

function findRendererText(text: string) {
  return screen.findByText(text, undefined, {
    timeout: rendererTextTimeoutMs,
  });
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
        list: vi.fn((request: { limit?: number; offset?: number } = {}) =>
          listResponseFor(request)
        ),
        // FEA-4157: the org Sessions view reads the list + summary through ONE
        // combined `pageData` IPC call. Serve it from the same mutable fixture as
        // `list`, paired with the usage aggregate, so a live refetch reflects new
        // rows/totals in both the table and the cards. The list-only `list`
        // method stays for the self page + active-runs panel.
        pageData: vi.fn((request: { limit?: number; offset?: number } = {}) => {
          if (listShouldFail) {
            return Promise.reject(new Error("transient source failure"));
          }
          return Promise.resolve({
            list: listPageFor(request),
            usage: agentSessionUsage(fixtureItems.length),
          } satisfies AgentSessionsPageData);
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
      lastAgentSessionSyncAt: timestamp,
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
    lastActivityAt: timestamp,
    lastSyncedAt: timestamp,
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
  ],
  overrides: Partial<AgentSessionDetail> = {}
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
    ...overrides,
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

// The paginated list slice the `list` and `pageData` mocks both serve from the
// mutable fixture, so a live refetch observes new rows/totals through either.
function listPageFor(request: {
  limit?: number;
  offset?: number;
}): AgentSessionListResponse {
  const offset = request.offset ?? 0;
  const limit = request.limit ?? fixtureItems.length;
  return {
    items: fixtureItems.slice(offset, offset + limit),
    total: fixtureItems.length,
    viewerScope: "self",
  };
}

function listResponseFor(request: {
  limit?: number;
  offset?: number;
}): Promise<AgentSessionListResponse> {
  if (listShouldFail) {
    return Promise.reject(new Error("transient source failure"));
  }
  return Promise.resolve(listPageFor(request));
}
