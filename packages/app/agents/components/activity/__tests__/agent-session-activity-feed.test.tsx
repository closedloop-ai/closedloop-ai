import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { populatedAgentSessionListFixtures } from "../../sessions/session-list-fixtures";
import { AgentSessionActivityFeed } from "../agent-session-activity-feed";

const ACTIVITY_API_ROUTES = [
  {
    method: "GET" as const,
    path: "/agent-sessions",
    respond: () => ({
      items: populatedAgentSessionListFixtures,
      total: populatedAgentSessionListFixtures.length,
      viewerScope: AgentSessionViewerScope.Self,
    }),
  },
];

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
                viewerScope: AgentSessionViewerScope.Self,
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

  // FEA-4051 regression: the activity title was a raw `<a href>`, a dead click
  // on the desktop renderer (its hash-store adapter does not intercept a raw
  // anchor). The surface-agnostic `@repo/navigation` `Link` drives the active
  // adapter on a plain left-click. A nested NavigationProvider (memory adapter)
  // overrides the decorator's internal one so the navigation state is
  // observable; AppCoreStoryProviders still supplies the api/query adapters the
  // list hook needs.
  it("drives the navigation adapter when a session title is clicked (not a raw anchor)", async () => {
    const nav = createMemoryNavigation({ initialPath: "/agents" });
    render(
      <AppCoreStoryProviders apiRoutes={ACTIVITY_API_ROUTES}>
        <NavigationProvider adapter={nav.adapter}>
          <AgentSessionActivityFeed
            getSessionHref={(item) => `/sessions/${item.id}`}
          />
        </NavigationProvider>
      </AppCoreStoryProviders>
    );

    const link = await screen.findByRole("link", {
      name: "Shared sessions list extraction",
    });
    fireEvent.click(link);

    expect(nav.getCurrentHref()).toBe("/sessions/session-1");
    expect(nav.getHistory()).toContain("/sessions/session-1");
  });
});
