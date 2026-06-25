import type {
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
} from "@repo/api/src/types/agent-session";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import {
  SubAgentsView,
  ToolsView,
  WorkflowsView,
} from "../desktop-derived-telemetry-view";

describe("DesktopDerivedTelemetryView", () => {
  beforeAll(() => {
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  beforeEach(() => {
    installDesktopApi();
  });

  it("loads the first page through agentSessionsApi without eager detail work", async () => {
    renderWithProvider(<WorkflowsView />);

    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 0,
      })
    );
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Select a session from the current page to inspect derived telemetry."
      )
    ).toBeDefined();

    await selectSession("Workflows", "Telemetry Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "telemetry-session"
      )
    );
    expect(
      (await screen.findByRole("tab", { name: "Orchestration" })).getAttribute(
        "aria-selected"
      )
    ).toBe("true");
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });

  it("renders an empty telemetry state after selecting a plain session", async () => {
    installDesktopApi({
      items: [
        sessionListItem({
          agentCount: 0,
          id: "plain-session",
          name: "Plain Session",
          toolUseCount: 0,
        }),
      ],
    });

    renderWithProvider(<WorkflowsView />);

    expect(
      await screen.findByText(
        "Select a session from the current page to inspect derived telemetry."
      )
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();

    await selectSession("Workflows", "Plain Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "plain-session"
      )
    );
    expect(
      await screen.findByText(
        "No agent-derived views are available for this session."
      )
    ).toBeDefined();
  });

  it("can page the selector to telemetry-bearing sessions beyond the first page", async () => {
    installDesktopApi({
      items: [
        ...Array.from({ length: 25 }, (_, index) =>
          sessionListItem({
            agentCount: 0,
            id: `plain-session-${index}`,
            name: `Plain Session ${index + 1}`,
            toolUseCount: 0,
          })
        ),
        sessionListItem({
          agentCount: 1,
          id: "older-telemetry-session",
          name: "Older Telemetry Session",
          toolUseCount: 1,
        }),
      ],
    });

    renderWithProvider(<ToolsView />);

    expect(await screen.findByText("1-25 of 26")).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Next"));

    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
        limit: 25,
        offset: 25,
      })
    );
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();

    await selectSession("Tools", "Older Telemetry Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "older-telemetry-session"
      )
    );
    expect((await screen.findAllByText("Older Telemetry Session")).length).toBe(
      2
    );
  });

  it("refreshes the selected session detail alongside the session list", async () => {
    renderWithProvider(<ToolsView />);

    await selectSession("Tools", "Telemetry Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "telemetry-session"
      )
    );
    const detailMock = vi.mocked(window.desktopApi.agentSessionsApi.detail);
    const listMock = vi.mocked(window.desktopApi.agentSessionsApi.list);

    // The refresh button is disabled while either query is fetching; wait for
    // it to settle before clicking so the click is not dropped on a disabled
    // control.
    const refreshButton = screen.getByRole("button", {
      name: "Refresh Tools sessions",
    });
    await waitFor(() =>
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    );
    const initialDetailCalls = detailMock.mock.calls.length;
    const initialListCalls = listMock.mock.calls.length;

    fireEvent.click(refreshButton);

    await waitFor(() =>
      expect(listMock.mock.calls.length).toBeGreaterThan(initialListCalls)
    );
    await waitFor(() =>
      expect(detailMock.mock.calls.length).toBeGreaterThan(initialDetailCalls)
    );
    expect(detailMock).toHaveBeenLastCalledWith("telemetry-session");
  });

  it("reconciles selection to a current row when the selected session disappears after refetch", async () => {
    const firstRows = [
      sessionListItem({
        agentCount: 0,
        id: "plain-session",
        name: "Plain Session",
        toolUseCount: 0,
      }),
      sessionListItem({
        agentCount: 1,
        id: "telemetry-session",
        name: "Telemetry Session",
        toolUseCount: 1,
      }),
    ];
    const secondRows = [
      sessionListItem({
        agentCount: 0,
        id: "fallback-session",
        name: "Fallback Session",
        toolUseCount: 0,
      }),
    ];
    const desktopApi = installDesktopApi({ items: firstRows });

    renderWithProvider(<ToolsView />);

    await selectSession("Tools", "Telemetry Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "telemetry-session"
      )
    );
    desktopApi.setItems(secondRows);

    // Wait for the refresh button to settle (queries idle) before clicking so
    // the click is not dropped on a disabled control.
    const refreshButton = screen.getByRole("button", {
      name: "Refresh Tools sessions",
    });
    await waitFor(() =>
      expect((refreshButton as HTMLButtonElement).disabled).toBe(false)
    );
    fireEvent.click(refreshButton);

    await waitFor(() =>
      expect(
        screen.getByText(
          "Select a session from the current page to inspect derived telemetry."
        )
      ).toBeDefined()
    );
    expect(
      vi
        .mocked(window.desktopApi.agentSessionsApi.detail)
        .mock.calls.filter(([id]) => id === "fallback-session")
    ).toHaveLength(0);
    expect(
      screen.getByRole("combobox", { name: "Tools session" }).textContent
    ).toContain("Select a session");
  });

  it("opens route-specific default tabs for tools and subagents", async () => {
    const { unmount } = renderWithProvider(<ToolsView />);

    await selectSession("Tools", "Telemetry Session");
    expect(
      (await screen.findByRole("tab", { name: "Tool Flow" })).getAttribute(
        "aria-selected"
      )
    ).toBe("true");

    unmount();
    renderWithProvider(<SubAgentsView />);

    await selectSession("SubAgents", "Telemetry Session");
    expect(
      (await screen.findByRole("tab", { name: "Effectiveness" })).getAttribute(
        "aria-selected"
      )
    ).toBe("true");
  });

  it("renders list loading without detail or aggregate fallbacks", async () => {
    installDesktopApi({ listPending: true });
    const { container } = renderWithProvider(<WorkflowsView />);

    expect(await screen.findByText("Loading sessions...")).toBeDefined();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBe(3);
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });

  it("renders list source failures without detail or aggregate fallbacks", async () => {
    installDesktopApi({ listError: new Error("list source failed") });
    renderWithProvider(<ToolsView />);

    expect(await screen.findByText("Sessions unavailable")).toBeDefined();
    expect(
      await screen.findByText(
        "Agent-derived views are temporarily unavailable."
      )
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });

  it("handles empty lists and detail not-found states without aggregate fallbacks", async () => {
    installDesktopApi({ items: [] });
    const { unmount } = renderWithProvider(<WorkflowsView />);

    expect(
      await screen.findByText("No sessions are captured yet.")
    ).toBeDefined();
    expect(window.desktopApi.agentSessionsApi.detail).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();

    unmount();
    installDesktopApi({ detail: null });
    renderWithProvider(<WorkflowsView />);

    await selectSession("Workflows", "Telemetry Session");
    expect(
      await screen.findByText(
        "Agent-derived views are temporarily unavailable."
      )
    ).toBeDefined();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
  });

  it("renders detail source failures without aggregate fallbacks", async () => {
    installDesktopApi({ detailError: new Error("detail source failed") });
    renderWithProvider(<SubAgentsView />);

    await selectSession("SubAgents", "Telemetry Session");
    await waitFor(() =>
      expect(window.desktopApi.agentSessionsApi.detail).toHaveBeenCalledWith(
        "telemetry-session"
      )
    );
    expect(
      await screen.findByText(
        "Agent-derived views are temporarily unavailable."
      )
    ).toBeDefined();
    expect(window.desktopApi.db.getWorkflowData).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getTools).not.toHaveBeenCalled();
    expect(window.desktopApi.db.getSubAgents).not.toHaveBeenCalled();
  });
});

function renderWithProvider(ui: React.ReactElement) {
  return render(<DesktopAppCoreProvider>{ui}</DesktopAppCoreProvider>);
}

async function selectSession(routeLabel: string, sessionName: string) {
  await screen.findByText(
    "Select a session from the current page to inspect derived telemetry."
  );
  fireEvent.click(
    screen.getByRole("combobox", { name: `${routeLabel} session` })
  );
  fireEvent.click(await screen.findByRole("option", { name: sessionName }));
}

function installDesktopApi(
  options: {
    detail?: AgentSessionDetail | null;
    detailError?: Error;
    items?: AgentSessionListItem[];
    listError?: Error;
    listPending?: boolean;
  } = {}
) {
  let currentItems = options.items ?? [
    sessionListItem({
      agentCount: 0,
      id: "plain-session",
      name: "Plain Session",
      toolUseCount: 0,
    }),
    sessionListItem({
      agentCount: 1,
      id: "telemetry-session",
      name: "Telemetry Session",
      toolUseCount: 1,
    }),
  ];

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: vi.fn(),
        detail: vi.fn((id: string) => {
          if (options.detailError) {
            return Promise.reject(options.detailError);
          }
          if (options.detail === null) {
            return Promise.resolve(null);
          }
          const item = currentItems.find((session) => session.id === id);
          return Promise.resolve(item ? sessionDetail(item) : null);
        }),
        list: vi.fn(
          (
            request: { limit?: number; offset?: number } = {}
          ): Promise<AgentSessionListResponse> => {
            if (options.listError) {
              return Promise.reject(options.listError);
            }
            if (options.listPending) {
              return new Promise<AgentSessionListResponse>(() => undefined);
            }
            const offset = request.offset ?? 0;
            const limit = request.limit ?? currentItems.length;
            return Promise.resolve({
              items: currentItems.slice(offset, offset + limit),
              total: currentItems.length,
              viewerScope: "self",
            });
          }
        ),
        usage: vi.fn(),
      },
      db: {
        getSubAgents: vi.fn(),
        getTools: vi.fn(),
        getWorkflowData: vi.fn(),
      },
    },
  });

  return {
    setItems(items: AgentSessionListItem[]) {
      currentItems = items;
    },
  };
}

function sessionListItem({
  agentCount,
  id,
  name,
  toolUseCount,
}: {
  agentCount: number;
  id: string;
  name: string;
  toolUseCount: number;
}): AgentSessionListItem {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    agentCount,
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
    cwd: "/repo",
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
    status: "completed",
    toolUseCount,
    updatedAt: timestamp,
    user: null,
    worktreePath: "/repo",
  };
}

function sessionDetail(item: AgentSessionListItem): AgentSessionDetail {
  return {
    ...item,
    agents:
      item.agentCount > 0
        ? [
            {
              endedAt: item.endedAt?.toISOString() ?? null,
              externalAgentId: `${item.id}-agent`,
              name: "Main",
              startedAt: item.startedAt.toISOString(),
              status: "completed",
              task: "Inspect route telemetry",
              type: "main",
              updatedAt: item.updatedAt.toISOString(),
            },
          ]
        : [],
    attribution: null,
    events:
      item.toolUseCount > 0
        ? [
            {
              agentExternalId: `${item.id}-agent`,
              createdAt: item.updatedAt.toISOString(),
              eventType: "tool_use",
              externalEventId: `${item.id}-event`,
              summary: "Ran test command",
              toolName: "pnpm",
            },
          ]
        : [],
    metadata: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    tokenUsageByModel: [],
  };
}
