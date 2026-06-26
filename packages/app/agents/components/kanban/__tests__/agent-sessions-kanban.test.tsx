import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import {
  AgentSessionsKanban,
  groupKanbanSessions,
} from "../agent-sessions-kanban";

describe("AgentSessionsKanban", () => {
  it("groups active awaiting and terminal statuses into documented columns", () => {
    const awaiting = createAgentSessionListItemFixture({
      awaitingInputSince: new Date("2026-06-01T10:00:00.000Z"),
      id: "awaiting",
      status: "active",
    });
    const active = createAgentSessionListItemFixture({
      awaitingInputSince: null,
      id: "active",
      status: "active",
    });
    const completed = createAgentSessionListItemFixture({
      id: "completed",
      status: "completed",
    });
    // Both the canonical cloud "error" status and the desktop-local "failed"
    // alias must land in the Failed column.
    const failed = createAgentSessionListItemFixture({
      id: "failed",
      status: "failed",
    });
    const errored = createAgentSessionListItemFixture({
      id: "errored",
      status: "error",
    });
    const abandoned = createAgentSessionListItemFixture({
      id: "abandoned",
      status: "abandoned",
    });

    const grouped = groupKanbanSessions(
      [awaiting, active, completed, failed, errored, abandoned],
      ""
    );

    expect(grouped["awaiting-input"]).toEqual([awaiting]);
    expect(grouped.active).toEqual([active]);
    expect(grouped.completed).toEqual([completed]);
    expect(grouped.failed).toEqual([failed, errored]);
    expect(grouped.abandoned).toEqual([abandoned]);
  });

  it("renders from exact list-hook status filters without requesting a new kanban endpoint", async () => {
    const requestedQueries: Record<string, string>[] = [];
    const active = createAgentSessionListItemFixture({
      awaitingInputSince: new Date("2026-06-01T10:00:00.000Z"),
      id: "active-session",
      name: "Active session",
      status: "active",
    });
    const completed = createAgentSessionListItemFixture({
      id: "completed-session",
      name: "Completed session",
      status: "completed",
    });
    const failed = createAgentSessionListItemFixture({
      id: "failed-session",
      name: "Failed session",
      // The cloud HTTP source returns the canonical "error" status; the kanban
      // groups it into the Failed column.
      status: "error",
    });
    const abandoned = createAgentSessionListItemFixture({
      id: "abandoned-session",
      name: "Abandoned session",
      status: "abandoned",
    });
    // The kanban now queries the canonical cloud value ("error") for the Failed
    // column instead of the stale "failed" literal that matched zero cloud rows.
    const itemsByStatus = {
      abandoned: [abandoned],
      active: [active],
      completed: [completed],
      error: [failed],
    };

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
                status: searchParams.get("status") ?? "",
              });
              const status = searchParams.get(
                "status"
              ) as keyof typeof itemsByStatus;
              return {
                items: itemsByStatus[status] ?? [],
                total: itemsByStatus[status]?.length ?? 0,
                viewerScope: "self",
              };
            },
          },
        ]}
      >
        <AgentSessionsKanban
          getSessionHref={(item) => `/sessions/${item.id}`}
        />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Active session")).toBeInTheDocument();
    expect(screen.getByText("Completed session")).toBeInTheDocument();
    expect(screen.getByText("Failed session")).toBeInTheDocument();
    expect(screen.getByText("Abandoned session")).toBeInTheDocument();
    expect(requestedQueries).toEqual([
      {
        limit: "25",
        offset: "0",
        pathname: "/agent-sessions",
        status: "active",
      },
      {
        limit: "25",
        offset: "0",
        pathname: "/agent-sessions",
        status: "completed",
      },
      {
        limit: "25",
        offset: "0",
        pathname: "/agent-sessions",
        status: "error",
      },
      {
        limit: "25",
        offset: "0",
        pathname: "/agent-sessions",
        status: "abandoned",
      },
    ]);
    expect(requestedQueries.map((query) => query.pathname)).not.toContain(
      "/agent-sessions/kanban"
    );
    const activeLink = screen.getByRole("link", { name: "Active session" });
    expect(activeLink).toHaveAttribute("href", "/sessions/active-session");
    expect(activeLink.closest("button")).toBeNull();
    const activeCard = activeLink.closest("article");
    fireEvent.click(
      within(activeCard as HTMLElement).getByRole("button", {
        name: "Show details",
      })
    );
    expect(screen.getByText("Selected session details")).toBeInTheDocument();
    const awaitingColumn = screen.getByText("Awaiting Input").closest("div");
    expect(
      within(awaitingColumn as HTMLElement).getByText("1")
    ).toBeInTheDocument();
  });
});
