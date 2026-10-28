import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { EMPTY_TABLE_GROUPING } from "@repo/design-system/components/ui/table-toolbar-model";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DateRange } from "../../../../shared/lib/format-utils";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { DEFAULT_SESSION_FACET_FILTERS } from "../../../lib/session-filter-adapter";
import {
  createAgentSessionListItemFixture,
  createFullyPopulatedSessionsUsageFixture,
} from "../../sessions/session-list-fixtures";
import { serializeSessionsListViewState } from "../../sessions/sessions-list-view-state-serialization";
import { makeDetail } from "../agent-component-fixtures";
import { AgentInvocationsGrid } from "../agent-invocations-grid";

describe("component invocation sessions grid", () => {
  it("restores the active saved arrangement before the first read and isolates component identities", async () => {
    const slug = "skill::saved-review";
    const key = `agent-invocations:views:org_test:user_test:${slug}`;
    globalThis.localStorage.setItem(
      key,
      JSON.stringify({
        activeViewId: "failed",
        views: [
          {
            id: "failed",
            name: "Failed reviews",
            arrangement: serializeSessionsListViewState({
              dateRange: DateRange.AllTime,
              facets: {
                ...DEFAULT_SESSION_FACET_FILTERS,
                statuses: [SESSION_STATUS.ERROR],
              },
              grouping: EMPTY_TABLE_GROUPING,
              page: 0,
              scopeUserId: null,
              sortBy: null,
              sortDir: "asc",
              visibleColumnIds: new Set(["status"]),
            }),
          },
        ],
      })
    );
    const reads = vi.fn();
    const mount = (componentSlug: string) =>
      render(
        <AppCoreStoryProviders
          apiRoutes={[
            {
              method: "GET",
              path: "/agent-sessions",
              respond: ({ searchParams }) => {
                reads(
                  searchParams.get("componentSlug"),
                  searchParams.getAll("statuses")
                );
                return {
                  componentScope: searchParams.get("componentSlug"),
                  items: [],
                  total: 0,
                  viewerScope: AgentSessionViewerScope.Organization,
                };
              },
            },
            {
              method: "GET",
              path: "/agent-sessions/usage",
              respond: ({ searchParams }) => ({
                ...createFullyPopulatedSessionsUsageFixture(),
                componentScope: searchParams.get("componentSlug"),
              }),
            },
            { method: "GET", path: "/artifacts/favorites", respond: () => [] },
          ]}
        >
          <AgentInvocationsGrid
            component={makeDetail({ slug: componentSlug })}
          />
        </AppCoreStoryProviders>
      );
    const first = mount(slug);
    await waitFor(() =>
      expect(reads).toHaveBeenCalledWith(slug, [SESSION_STATUS.ERROR])
    );
    expect(reads).not.toHaveBeenCalledWith(slug, []);
    expect(
      screen.getByRole("button", { name: "Failed reviews" })
    ).toBeInTheDocument();
    first.unmount();
    const second = mount("skill::different");
    await waitFor(() =>
      expect(reads).toHaveBeenCalledWith("skill::different", [])
    );
    second.unmount();
    const third = mount(slug);
    await waitFor(() =>
      expect(reads.mock.calls.filter((call) => call[0] === slug)).toHaveLength(
        2
      )
    );
    third.unmount();
    globalThis.localStorage.removeItem(key);
  }, 15_000);
  it("reads the component cohort, paginates on the server and writes real artifact favorites", async () => {
    const user = userEvent.setup();
    const reads = vi.fn();
    const favorite = vi.fn(() => ({}));
    const detail = makeDetail({ slug: "skill::review" });
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions",
            respond: ({ searchParams }) => {
              reads(
                searchParams.get("componentSlug"),
                searchParams.get("offset"),
                searchParams.getAll("sorts")
              );
              const offset = Number(searchParams.get("offset"));
              return {
                componentScope: detail.slug,
                items: [
                  createAgentSessionListItemFixture({
                    id: `session-${offset}`,
                    name: `Review ${offset}`,
                  }),
                ],
                total: 51,
                viewerScope: AgentSessionViewerScope.Organization,
              };
            },
          },
          {
            method: "GET",
            path: "/agent-sessions/usage",
            respond: () => ({
              ...createFullyPopulatedSessionsUsageFixture(),
              componentScope: detail.slug,
            }),
          },
          { method: "GET", path: "/artifacts/favorites", respond: () => [] },
          {
            method: "POST",
            path: "/artifacts/session-0/favorite",
            respond: favorite,
          },
        ]}
      >
        <AgentInvocationsGrid
          component={detail}
          getSessionHref={(row) => `/sessions/${row.id}`}
        />
      </AppCoreStoryProviders>
    );
    expect(
      await screen.findByRole("link", { name: "Review 0" })
    ).toHaveAttribute("href", "/sessions/session-0");
    expect(reads).toHaveBeenCalledWith(detail.slug, "0", ["updated:desc"]);
    expect(screen.getByRole("button", { name: "Views" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Group" })).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", { name: "Add Review 0 to favorites" })
    );
    await waitFor(() => expect(favorite).toHaveBeenCalled());
    await user.click(screen.getByLabelText("Go to next page"));
    expect(
      await screen.findByRole("link", { name: "Review 50" })
    ).toBeInTheDocument();
    expect(reads).toHaveBeenCalledWith(detail.slug, "50", ["updated:desc"]);
  }, 15_000);
});
