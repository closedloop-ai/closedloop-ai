import type {
  AgentSessionAnalytics,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { populatedAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "./SessionDetailView";

const STORY_SESSION_ID = "desktop-session-detail-story";
type SessionDetailViewStoryArgs = Parameters<typeof SessionDetailView>[0];

const meta = {
  title: "Desktop/Sessions/Session Detail",
  component: SessionDetailView,
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;

export const TraceCommentBoundary = {
  args: {
    backHref: "/sessions",
    sessionId: STORY_SESSION_ID,
  },
  render: (args: SessionDetailViewStoryArgs) => {
    installDesktopApiFixture();

    return (
      <DesktopAppCoreProvider>
        <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-background">
          <SessionDetailView {...args} />
        </div>
      </DesktopAppCoreProvider>
    );
  },
};

/**
 * Installs the narrow preload API slice that the real Electron SessionDetailView
 * provider reads. Storybook can then render the desktop wrapper boundary without
 * a running Electron process or local SQLite database.
 */
function installDesktopApiFixture() {
  const session = {
    ...populatedAgentSessionDetailFixture,
    id: STORY_SESSION_ID,
    externalSessionId: STORY_SESSION_ID,
    name: "Desktop trace comment boundary",
  };

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      agentSessionsApi: {
        analytics: async () => agentSessionAnalytics(),
        detail: async (id: string) =>
          id === STORY_SESSION_ID ? session : null,
        list: async () => agentSessionList(),
        usage: async () => agentSessionUsage(),
      },
      dispatchGateway: async () => ({
        body: { error: "Storybook desktop gateway fixture has no routes." },
        headers: { "content-type": "application/json" },
        status: 404,
      }),
      onDbChanged: () => () => undefined,
    },
  });
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
