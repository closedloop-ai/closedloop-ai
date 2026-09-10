import type {
  AgentSessionAnalytics,
  AgentSessionListResponse,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { encodeBranchId } from "@repo/api/src/types/branch";
import { populatedAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { DesktopAuthStatus } from "../../../shared/contracts";
import { DesktopAppCoreProvider } from "../../shared-agent-sessions/desktop-app-core-provider";
import { SessionDetailView } from "./SessionDetailView";

const STORY_SESSION_ID = "desktop-session-detail-story";
const STORY_REPO_FULL_NAME = "closedloop-ai/symphony-alpha";
const STORY_BRANCH_NAME = "fea-1707";
/** The route id the desktop main process resolves for this branch (ISS-5567). */
const STORY_BRANCH_ID = encodeBranchId({
  branchName: STORY_BRANCH_NAME,
  repoFullName: STORY_REPO_FULL_NAME,
});
type SessionDetailViewStoryArgs = Parameters<typeof SessionDetailView>[0];

const meta = {
  title: "Surfaces/Session Detail (Desktop Shell)",
  component: SessionDetailView,
  tags: ["autodocs"],
  argTypes: {
    backHref: {
      control: "text",
      description: "Where the detail's back affordance returns to.",
    },
    sessionId: {
      control: "text",
      description:
        "The session the detail reads. Only the fixture id resolves on this canvas.",
    },
  },
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
    pinConnectivity(true);

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
 * ISS-5567, pole 1 — the Branch row LINKED. Signed out and online, so Sessions
 * and Branches both read the local SQLite source: the `encodeBranchId` composite
 * the detail read mints is exactly the id `/branches/:id` will decode, and the
 * value becomes an in-app link.
 *
 * Open the Properties disclosure to see the row.
 */
export const BranchRowLinked = {
  args: {
    backHref: "/sessions",
    sessionId: STORY_SESSION_ID,
  },
  render: (args: SessionDetailViewStoryArgs) => {
    installDesktopApiFixture({ branchArtifactId: STORY_BRANCH_ID });
    pinConnectivity(true);

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
 * ISS-5567, pole 2 — the Branch row WITHHELD, on the identical payload.
 *
 * Authenticated but offline: Sessions still reads the local store (so the id in
 * the payload is a local composite) while `/branches/:id` would be served by the
 * CLOUD source, which does not answer to that id. The link is withheld rather
 * than offered and landing on "not found", so the row renders exactly the plain
 * mono text it did before this feature.
 *
 * The only way to LOOK at this state is to contrive the split, which is what this
 * story is for (stage review on #4650) — the two stories differ ONLY in the
 * auth/connectivity state, so any visual difference between them is the gate.
 */
export const BranchRowWithheldOffline = {
  args: {
    backHref: "/sessions",
    sessionId: STORY_SESSION_ID,
  },
  render: (args: SessionDetailViewStoryArgs) => {
    installDesktopApiFixture({
      authenticated: true,
      branchArtifactId: STORY_BRANCH_ID,
    });
    pinConnectivity(false);

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
 * Pin `navigator.onLine` for the story about to render. The app-core mode reads
 * it through `useOnlineStatus`, and Storybook shares one window across stories,
 * so each story states its own connectivity rather than inheriting the previous
 * story's. Redefined (not assigned) because `onLine` is a prototype getter.
 */
function pinConnectivity(isOnline: boolean) {
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => isOnline,
  });
}

/**
 * Installs the narrow preload API slice that the real Electron SessionDetailView
 * provider reads. Storybook can then render the desktop wrapper boundary without
 * a running Electron process or local SQLite database.
 */
function installDesktopApiFixture(
  options: { authenticated?: boolean; branchArtifactId?: string } = {}
) {
  const session = {
    ...populatedAgentSessionDetailFixture,
    id: STORY_SESSION_ID,
    externalSessionId: STORY_SESSION_ID,
    name: "Desktop trace comment boundary",
    // ISS-5567: the route token the Branch row links to. Absent → the shared
    // pane's gate keeps the row plain text no matter what the shell supplies.
    ...(options.branchArtifactId
      ? { branchArtifactId: options.branchArtifactId }
      : {}),
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
      // The Branches read source keys on a canonical cloud identity, so the
      // authenticated stub is half of the ISS-5567 split; the other half is
      // `pinConnectivity(false)`, which keeps Sessions on the local store.
      getDesktopAuthState: async () =>
        options.authenticated
          ? {
              organizationId: "story-org",
              status: DesktopAuthStatus.Authenticated,
              userId: "story-user",
            }
          : {
              organizationId: null,
              status: DesktopAuthStatus.SignedOut,
              userId: null,
            },
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
