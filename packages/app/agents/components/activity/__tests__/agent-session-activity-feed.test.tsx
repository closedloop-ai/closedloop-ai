import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { populatedAgentSessionListFixtures } from "../../sessions/session-list-fixtures";
import { AgentSessionActivityFeed } from "../agent-session-activity-feed";

describe("AgentSessionActivityFeed", () => {
  it("renders activity from the real list hook and no activity endpoint", async () => {
    const requestedQueries: Record<string, string>[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions",
            respond: ({ pathname, searchParams }) => {
              requestedQueries.push({
                limit: searchParams.get("limit") ?? "",
                offset: searchParams.get("offset") ?? "",
                pathname,
              });
              return {
                items: populatedAgentSessionListFixtures,
                total: populatedAgentSessionListFixtures.length,
                viewerScope: "self",
              };
            },
          },
        ]}
      >
        <AgentSessionActivityFeed
          getSessionHref={(item) => `/sessions/${item.id}`}
        />
      </AppCoreStoryProviders>
    );

    expect(
      await screen.findByText("Shared sessions list extraction")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Shared sessions list extraction" })
    ).toHaveAttribute("href", "/sessions/session-1");
    expect(requestedQueries).toEqual([
      { limit: "50", offset: "0", pathname: "/agent-sessions" },
    ]);
    expect(requestedQueries.map((query) => query.pathname)).not.toContain(
      "/agent-sessions/activity"
    );
  });
});
