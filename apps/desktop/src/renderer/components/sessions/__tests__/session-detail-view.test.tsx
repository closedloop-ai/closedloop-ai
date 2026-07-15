import {
  type AgentSessionAnalytics,
  type AgentSessionDetail,
  type AgentSessionListResponse,
  AgentSessionState,
  type AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import {
  EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
  expectExactClaudeCodePropertyLabels,
} from "@repo/app/agents/components/detail/__tests__/property-label-contract";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "../SessionDetailView";

const MERGED_PR_LINK_NAME = "1686merged";
const JUMP_TO_FAILURES_NAME = /jump to failures & limits/i;
const JUMP_TO_ACTIVITY_BUCKET_NAME = /jump to activity bucket/i;
const PERCENT_STYLE_VALUE_REGEX = /\d+(?:\.\d+)?%/;

describe("Desktop SessionDetailView wrapper", () => {
  beforeEach(() => {
    installDesktopApi();
  });

  it("guards the FEA-1928 exact property-label contract with negative controls", () => {
    expectExactClaudeCodePropertyLabels([
      ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
    ]);

    expect(() =>
      expectExactClaudeCodePropertyLabels([
        ...EXPECTED_CLAUDE_CODE_PROPERTY_LABELS,
        "Compute target",
      ])
    ).toThrow();
    expect(() =>
      expectExactClaudeCodePropertyLabels(
        EXPECTED_CLAUDE_CODE_PROPERTY_LABELS.filter((label) => label !== "Cost")
      )
    ).toThrow();
  });

  it("renders local pending and blocked details without unsupported write surfaces", async () => {
    const { rerender } = renderSessionDetail("pending-session");

    expect(await screen.findByRole("heading", { name: "Pending Session" }));
    expect(screen.getAllByText("closedloop-ai/symphony-alpha").length).toBe(1);
    expect(screen.getAllByText("$0.01").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    const propertyLabels = Array.from(
      document.querySelectorAll(".prd-prop-label"),
      (label) => label.textContent ?? ""
    );
    expectExactClaudeCodePropertyLabels(propertyLabels);
    expect(
      screen.getByText("feat/fea-1943-session-details-local-data")
    ).toBeDefined();
    expect(screen.queryByText("Compute target")).toBeNull();
    expect(screen.queryByText("Project")).toBeNull();
    expect(screen.queryByText("Worktree")).toBeNull();
    expect(screen.queryByText("Base branch")).toBeNull();
    expect(screen.queryByText("Source artifact")).toBeNull();
    expect(screen.queryByText("Source loop")).toBeNull();
    expect(screen.queryByText("Files changed")).toBeNull();
    expect(screen.queryByText("Local Desktop")).toBeNull();
    expect(screen.queryByText("/tmp/symphony-alpha")).toBeNull();
    expect(
      screen.getByRole("link", { name: MERGED_PR_LINK_NAME })
    ).toBeDefined();
    expect(screen.getByText("+12")).toBeDefined();
    expect(screen.getByText("-2")).toBeDefined();
    expect(screen.getByText("10m wall | 8m active | 2m idle")).toBeDefined();
    expect(
      screen.getByText("10 in | 20 out | 3 cache read | 4 cache write")
    ).toBeDefined();
    expect(screen.getByText("3 turns | 7 tool calls | 1 steers")).toBeDefined();
    expect(screen.getByText("High autonomy | 82/100")).toBeDefined();
    expect(document.querySelector(".sd3-cmts")).not.toBeNull();
    expect(screen.getByText("Comments")).toBeDefined();
    expect(
      screen.getByText("Select trace text to anchor the next comment.")
    ).toBeDefined();

    rerender(
      withProviders(
        <SessionDetailView backHref="/sessions" sessionId="blocked-session" />
      )
    );

    expect(await screen.findByRole("heading", { name: "Blocked Session" }));
    expect(document.querySelector(".sd3-cmts")).not.toBeNull();
    expect(screen.getByText("Comments")).toBeDefined();

    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "pending-session"
    );
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "blocked-session"
    );
  });

  it("renders a red failures and limits marker from desktop-visible throttles", async () => {
    renderSessionDetail("throttled-session");

    expect(await screen.findByRole("heading", { name: "Throttled Session" }));
    expect(screen.getByText("Session Timeline")).toBeDefined();
    expect(screen.getByText("Session Trace")).toBeDefined();

    const limitMarkers = screen.getAllByRole("button", {
      name: JUMP_TO_FAILURES_NAME,
    });
    expect(
      limitMarkers.some((marker) => marker.className.includes("d-r"))
    ).toBe(true);
    expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
      "throttled-session"
    );
  });

  it("moves the shared session timeline tracker on the first clicked bucket", async () => {
    renderSessionDetail("throttled-session");

    expect(await screen.findByRole("heading", { name: "Throttled Session" }));

    const bucketButtons = screen.getAllByRole("button", {
      name: JUMP_TO_ACTIVITY_BUCKET_NAME,
    });
    expect(bucketButtons.length).toBeGreaterThan(1);

    fireEvent.click(bucketButtons[1]!);

    expect(
      document.querySelector<HTMLElement>(".sd3-bars2-wrap .tl-here")?.style
        .left
    ).toMatch(PERCENT_STYLE_VALUE_REGEX);
  });
});

function renderSessionDetail(sessionId: string) {
  return render(
    withProviders(
      <SessionDetailView backHref="/sessions" sessionId={sessionId} />
    )
  );
}

function withProviders(ui: React.ReactElement) {
  return <DesktopAppCoreProvider>{ui}</DesktopAppCoreProvider>;
}

function installDesktopApi() {
  const details: Record<string, AgentSessionDetail> = {
    "blocked-session": sessionDetail({
      id: "blocked-session",
      name: "Blocked Session",
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
    "pending-session": sessionDetail({
      id: "pending-session",
      name: "Pending Session",
      state: AgentSessionState.PendingApproval,
      status: "active",
    }),
    "throttled-session": sessionDetail({
      id: "throttled-session",
      name: "Throttled Session",
      overrides: {
        throttles: [
          {
            durMin: 5,
            t0: "12:08:00",
            t1: "12:13:00",
            tl: 1,
            x0: 50,
          },
        ],
        turnItems: throttledTurnItems("throttled-session"),
      },
      state: AgentSessionState.Blocked,
      status: "failed",
    }),
  };

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(async () => agentSessionAnalytics()),
        detail: vi.fn(async (id: string) => details[id] ?? null),
        list: vi.fn(async () => agentSessionList()),
        usage: vi.fn(async () => agentSessionUsage()),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
      getRuntimeStatus: vi.fn(() => new Promise(() => undefined)),
    },
  });
}

function sessionDetail({
  id,
  name,
  overrides = {},
  state,
  status,
}: {
  id: string;
  name: string;
  overrides?: Partial<AgentSessionDetail>;
  state: AgentSessionState;
  status: string;
}): AgentSessionDetail {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    activeAgent: "8m",
    agentCount: 1,
    agents: [],
    attribution: {
      baseBranch: "main",
      repositoryFullName: "closedloop-ai/symphony-alpha",
      sourceArtifactId: "FEA-1943",
      sourceLoopId: null,
      worktreePath: "/tmp/symphony-alpha",
    },
    awaitingInputSince:
      state === AgentSessionState.PendingApproval ? timestamp : null,
    autonomy: 82,
    baseBranch: "main",
    branch: "feat/fea-1943-session-details-local-data",
    cache: 3,
    cacheReadTokens: 0,
    cacheWrite: 4,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cost: "$0.01",
    cwd: "/tmp/symphony-alpha",
    endedAt: null,
    errorCount: state === AgentSessionState.Blocked ? 1 : 0,
    estimatedCost: 0.01,
    events: [],
    externalSessionId: id,
    filesChanged: 1,
    harness: "codex",
    id,
    inputTokens: 10,
    lastActivityAt: timestamp,
    linesAdded: 12,
    linesRemoved: 2,
    metadata: null,
    model: "gpt-test",
    models: ["gpt-test"],
    name,
    outputTokens: 20,
    primaryModel: "gpt-test",
    project: null,
    prs: [{ num: 1686, status: "merged", title: "Complete local details" }],
    prsMerged: 1,
    repo: "closedloop-ai/symphony-alpha",
    repositoryFullName: "closedloop-ai/symphony-alpha",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: "FEA-1943",
    sourceLoopId: null,
    steeringEpisodes: 1,
    startedAt: timestamp,
    state,
    status,
    timeline: [],
    tokenUsageByModel: [],
    tokensIn: 10,
    tokensOut: 20,
    toolCallsTotal: 7,
    toolUseCount: 7,
    turnItems: [],
    turns: 3,
    updatedAt: timestamp,
    user: null,
    userColor: null,
    wallClock: "10m",
    waitingUser: state === AgentSessionState.PendingApproval ? "2m" : null,
    worktreePath: "/tmp/symphony-alpha",
    ...overrides,
  };
}

function throttledTurnItems(
  sessionId: string
): NonNullable<AgentSessionDetail["turnItems"]> {
  const agentActor = {
    color: "var(--primary)",
    harness: "codex",
    human: null,
    name: "gpt-test",
    sessionId,
  };
  const humanActor = {
    color: "hsl(210 65% 45%)",
    human: "Ada Lovelace",
    name: null,
    sessionId,
  };

  return [
    {
      _row: 0,
      actor: humanActor,
      cum: 0,
      t: "2026-01-01T00:01:00.000Z",
      tMs: Date.parse("2026-01-01T00:01:00.000Z"),
      text: "Investigate the desktop-visible throttle marker.",
      type: "prompt",
    },
    {
      _row: 1,
      actor: agentActor,
      cum: 0.01,
      model: "gpt-test",
      t: "2026-01-01T00:08:00.000Z",
      tMs: Date.parse("2026-01-01T00:08:00.000Z"),
      text: "The provider reported a temporary limit and the session resumed.",
      type: "say",
    },
    {
      text: "Session stopped after the limit evidence was captured.",
      type: "end",
    },
  ];
}

function agentSessionList(): AgentSessionListResponse {
  return {
    items: [],
    total: 0,
    viewerScope: "self",
  };
}

function agentSessionUsage(): AgentSessionUsageSummary {
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
    totalSessions: 0,
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
