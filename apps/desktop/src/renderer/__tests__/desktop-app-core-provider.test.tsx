import type {
  AgentSessionDetail,
  AgentSessionListItem,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";

describe("DesktopAppCoreProvider", () => {
  beforeEach(() => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        agentSessionsApi: {
          analytics: vi.fn(async () => ({
            byAgentType: [],
            byProject: [],
            byRepository: [],
            byTool: [],
            viewerScope: "self",
          })),
          detail: vi.fn(async () => null as AgentSessionDetail | null),
          list: vi.fn(async () => agentSessionList()),
          usage: vi.fn(async () => agentSessionUsage()),
        },
      },
    });
  });

  it("mounts shared hooks against the desktop local Agent Sessions adapter", async () => {
    const hook = renderHook(() => useAgentSessions({ limit: 1, offset: 0 }), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    expect(window.desktopApi.agentSessionsApi.list).toHaveBeenCalledWith({
      limit: 1,
      offset: 0,
    });
    expect(hook.result.current.data?.items[0]?.name).toBe(
      "Provider-wired session"
    );
  });

  it("preserves Date fields end-to-end (IPC structured clone, no transport revival)", async () => {
    const hook = renderHook(() => useAgentSessions(), {
      wrapper: DesktopAppCoreProvider,
    });

    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true));

    const item = hook.result.current.data?.items[0];
    expect(item?.startedAt).toBeInstanceOf(Date);
    expect(item?.updatedAt).toBeInstanceOf(Date);
    expect(item?.endedAt).toBeInstanceOf(Date);
    expect(item?.awaitingInputSince).toBeInstanceOf(Date);
    expect(item?.computeTarget.lastSeenAt).toBeInstanceOf(Date);
  });
});

function agentSessionList(): AgentSessionListResponse {
  return {
    items: [agentSessionListItem()],
    total: 1,
    viewerScope: "self",
  };
}

function agentSessionListItem(): AgentSessionListItem {
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    agentCount: 0,
    awaitingInputSince: timestamp,
    baseBranch: null,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "local-desktop",
      isOnline: true,
      lastSeenAt: timestamp,
      machineName: "Local Desktop",
    },
    cwd: "/tmp/provider-session",
    endedAt: timestamp,
    errorCount: 0,
    estimatedCost: 0,
    externalSessionId: "provider-session",
    harness: "claude",
    id: "provider-session",
    inputTokens: 0,
    issueId: null,
    lastActivityAt: timestamp,
    model: "gpt-test",
    name: "Provider-wired session",
    outputTokens: 0,
    project: null,
    repositoryFullName: null,
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: timestamp,
    status: "completed",
    toolUseCount: 0,
    updatedAt: timestamp,
    user: null,
    worktreePath: null,
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
    totalSessions: 1,
    viewerScope: "self",
  };
}
