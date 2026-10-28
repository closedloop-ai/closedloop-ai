import { SessionShellActivity } from "@repo/app/agents/components/detail/session-shell-activity";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

/**
 * ISS-11004: desktop Local mode has no synced activity, so the Session Activity
 * tab shows the empty state instead of loading forever or reading the cloud.
 */
describe("Session Activity in desktop Local mode", () => {
  it("renders the empty state from the real Local source without reading", () => {
    const source = createLocalAgentSessionsDataSource({
      agentSessionsApi: {},
    } as never);

    expect(source.activityPage).toBeUndefined();

    render(
      <AppCoreStoryProviders>
        <AgentSessionsDataSourceProvider dataSource={source}>
          <SessionShellActivity
            buildCommentHref={(threadId) =>
              `/sessions/local-session?comment=${threadId}`
            }
            sessionId="local-session"
          />
        </AgentSessionsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(screen.getByText("No activity yet")).toBeTruthy();
    expect(
      screen.queryByRole("status", { name: "Loading activity" })
    ).toBeNull();
  });
});
