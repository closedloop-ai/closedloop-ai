import {
  type AgentSessionAnalytics,
  type AgentSessionListResponse,
  type AgentSessionUsageSummary,
  AgentSessionViewerScope,
} from "@repo/api/src/types/agent-session";
import type { AgentSessionsDataSource } from "@repo/app/agents/data-source/agent-sessions-data-source";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { useQueryClient } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  agentSessionKeys,
  useAgentSessionAnalytics,
  useAgentSessionUsage,
} from "../use-agent-sessions";

const TEAM_A = "019f0fcb-8336-7c4d-9f64-528fb9520c32";
const TEAM_B = "019f0fcb-8336-7c4d-9f64-528fb9520c33";

describe("agent-session team-scope hooks", () => {
  it("disables explicit team usage queries until teamId exists", () => {
    const source = createSource();

    renderHook(
      () =>
        useAgentSessionUsage({
          viewerScope: AgentSessionViewerScope.Team,
        }),
      { wrapper: createWrapper(source) }
    );

    expect(source.usage).not.toHaveBeenCalled();
  });

  it("passes teamId through analytics queries and isolates cache keys", async () => {
    const source = createSource();

    const { rerender, result } = renderHook(
      ({ teamId }) => ({
        queryClient: useQueryClient(),
        analytics: useAgentSessionAnalytics({
          teamId,
          viewerScope: AgentSessionViewerScope.Team,
        }),
      }),
      {
        initialProps: { teamId: TEAM_A },
        wrapper: createWrapper(source),
      }
    );

    await waitFor(() =>
      expect(source.analytics).toHaveBeenCalledWith({
        teamId: TEAM_A,
        viewerScope: AgentSessionViewerScope.Team,
      })
    );

    rerender({ teamId: TEAM_B });

    await waitFor(() =>
      expect(source.analytics).toHaveBeenCalledWith({
        teamId: TEAM_B,
        viewerScope: AgentSessionViewerScope.Team,
      })
    );

    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.analytics("source", {
          teamId: TEAM_A,
          viewerScope: AgentSessionViewerScope.Team,
        })
      )
    ).toEqual({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    });
    expect(
      result.current.queryClient.getQueryData(
        agentSessionKeys.analytics("source", {
          teamId: TEAM_B,
          viewerScope: AgentSessionViewerScope.Team,
        })
      )
    ).toEqual({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    });
  });
});

function createSource(): AgentSessionsDataSource {
  return {
    scope: "source",
    list: vi.fn().mockResolvedValue({
      items: [],
      total: 0,
      viewerScope: AgentSessionViewerScope.Team,
    } satisfies AgentSessionListResponse),
    detail: vi.fn().mockRejectedValue(new Error("detail unused")),
    usage: vi.fn().mockResolvedValue({
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
      viewerScope: AgentSessionViewerScope.Team,
    } satisfies AgentSessionUsageSummary),
    analytics: vi.fn().mockResolvedValue({
      byAgentType: [],
      byProject: [],
      byRepository: [],
      byTool: [],
      viewerScope: AgentSessionViewerScope.Team,
    } satisfies AgentSessionAnalytics),
  };
}

function createWrapper(source: AgentSessionsDataSource) {
  return ({ children }: { children: ReactNode }) => (
    <AppCoreStoryProviders>
      <AgentSessionsDataSourceProvider dataSource={source}>
        {children}
      </AgentSessionsDataSourceProvider>
    </AppCoreStoryProviders>
  );
}
