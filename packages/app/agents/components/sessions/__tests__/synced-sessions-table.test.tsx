import { fireEvent, render, screen } from "@testing-library/react";
import {
  cloneElement,
  type HTMLAttributes,
  isValidElement,
  type ReactNode,
} from "react";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { useAgentSessions } from "../../../hooks/use-agent-sessions";
import { AgentSessionsListContent } from "../agent-sessions-list";
import {
  createAgentSessionListItemFixture,
  mixedAgentSessionListFixtures,
} from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";

const REPOSITORY_HEADER_NAME_REGEX = /Repository/i;
const GRID_EMPTY_VALUE_TEXT_REGEX = /^—$/;
// Grid children: lead (Session Name), status, autonomy, repo, branch, …
const BRANCH_COLUMN_CHILD_INDEX = 4;
const LONG_BRANCH_NAME =
  "kaiticarp/feature/some-very-long-descriptive-branch-name";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    children,
    asChild: _asChild,
    ...props
  }: {
    children: ReactNode;
    asChild?: boolean;
  } & HTMLAttributes<HTMLElement>) => {
    const triggerProps = { ...props, "data-slot": "tooltip-trigger" };
    return isValidElement(children) ? (
      cloneElement(children, triggerProps)
    ) : (
      <span {...triggerProps}>{children}</span>
    );
  },
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

describe("SyncedSessionsTable", () => {
  it("renders mixed list-field fallback precedence without leaking raw missing values", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
      />
    );

    expect(screen.getByText("Named Session")).toBeInTheDocument();
    expect(screen.getByText("external-name-fallback")).toBeInTheDocument();
    // The repository column shows the repo name, never the raw absolute path.
    expect(screen.getByText("closedloop-ai/repo-fallback")).toBeInTheDocument();
    expect(
      screen.queryByText("/worktrees/shared-list")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("/workspace/symphony-alpha")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Awaiting input")).toBeInTheDocument();
    expect(screen.getByText("Branch")).toBeInTheDocument();
    expect(screen.getAllByText("fea-2036")).not.toHaveLength(0);
    // Missing repo/model render the shared em-dash placeholder, identical to
    // the web Sessions table (no bespoke "Unknown ..." fork text).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(
      getBranchCellForSessionName("external-name-fallback")
    ).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(
      getBranchCellForSessionName("Unknown location row")
    ).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("Invalid Date");
    expect(bodyText).not.toContain("undefined");
    expect(bodyText).not.toContain("NaN");
    expect(bodyText).not.toContain("null");
  });

  it("passes org monitoring extra-column renderers and omits the column when absent", () => {
    const row = createAgentSessionListItemFixture();
    const { rerender } = render(
      <SyncedSessionsTable
        extraColumnLabel="Artifact"
        getSessionHref={(item) => `/acme/sessions/${item.id}`}
        items={[row]}
        renderExtraColumn={(item) => (
          <a href={`/acme/features/${item.id}`}>View</a>
        )}
      />
    );

    expect(screen.getByText("Artifact")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View" })).toHaveAttribute(
      "href",
      "/acme/features/session-1"
    );

    rerender(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[row]}
      />
    );

    expect(screen.queryByText("Artifact")).not.toBeInTheDocument();
  });

  it("loads list data through useAgentSessions, fixture ApiAdapter, date revival, and rendered UI", async () => {
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: "/agent-sessions",
            respond: () => ({
              items: mixedAgentSessionListFixtures,
              total: mixedAgentSessionListFixtures.length,
              viewerScope: "self",
            }),
          },
        ]}
      >
        <HookBackedListProbe />
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Named Session")).toBeInTheDocument();
    expect(screen.getByText("external-name-fallback")).toBeInTheDocument();
    expect(screen.getByText("closedloop-ai/repo-fallback")).toBeInTheDocument();
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/sessions/session-name"
    );
  });

  it("renders loading and filtered-empty list states from the shared list body", () => {
    const { rerender } = render(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading
        items={[]}
      />
    );

    expect(document.querySelector(".animate-pulse")).toBeInTheDocument();

    rerender(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={[]}
      />
    );

    expect(screen.getByText("No sessions found")).toBeInTheDocument();
    expect(
      screen.getByText("No synced sessions match your current filters yet.")
    ).toBeInTheDocument();
  });

  it("keeps the Branch column visible by default, hideable, and non-sortable", () => {
    const onSort = vi.fn();
    const { rerender } = render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        onSort={onSort}
        sortDir="asc"
      />
    );

    const branchHeader = screen.getByText("Branch");
    expect(branchHeader).toBeInTheDocument();
    expect(branchHeader.closest("button")).toBeNull();
    fireEvent.click(branchHeader);
    expect(onSort).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: REPOSITORY_HEADER_NAME_REGEX })
    );
    expect(onSort).toHaveBeenCalledWith("repo", "desc");

    rerender(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        onSort={onSort}
        sortDir="asc"
        visibleColumns={
          new Set([
            "status",
            "repo",
            "harness",
            "model",
            "duration",
            "cost",
            "started",
          ])
        }
      />
    );

    expect(screen.queryByText("Branch")).not.toBeInTheDocument();
    expect(screen.queryByText("fea-2036")).not.toBeInTheDocument();
  });

  it("shows full branch tooltip content and keeps the branch chip keyboard-focusable", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            branch: LONG_BRANCH_NAME,
            id: "long-branch-session",
            name: "Long branch session",
          }),
        ]}
      />
    );

    const branchCell = getBranchCellForSessionName("Long branch session");
    expect(branchCell).toHaveTextContent(LONG_BRANCH_NAME);
    expect(screen.getByTestId("tooltip-content")).toHaveTextContent(
      LONG_BRANCH_NAME
    );

    const branchTrigger = branchCell.querySelector(
      '[data-slot="tooltip-trigger"]'
    );
    expect(branchTrigger).toBeInstanceOf(HTMLElement);
    expect(branchTrigger).toHaveAttribute("tabindex", "0");

    (branchTrigger as HTMLElement).focus();
    expect(document.activeElement).toBe(branchTrigger);
  });

  it("keeps empty branch cells as placeholders without tooltip content", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            branch: null,
            id: "null-branch-session",
            name: "Null branch session",
          }),
          createAgentSessionListItemFixture({
            branch: "",
            id: "empty-branch-session",
            name: "Empty branch session",
          }),
        ]}
      />
    );

    expect(
      getBranchCellForSessionName("Null branch session")
    ).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(
      getBranchCellForSessionName("Empty branch session")
    ).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(screen.queryByTestId("tooltip-content")).not.toBeInTheDocument();
  });

  it("links every rendered row through the route-owned href callback", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/org-a/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures.slice(0, 2)}
      />
    );

    const firstLink = screen.getByText("Named Session").closest("a");
    expect(firstLink).not.toBeNull();
    expect(firstLink).toHaveAttribute("href", "/org-a/sessions/session-name");
  });
});

function HookBackedListProbe() {
  const query = useAgentSessions({ limit: 25, offset: 0 });

  return (
    <AgentSessionsListContent
      getSessionHref={(item) => `/sessions/${item.id}`}
      isLoading={query.isLoading}
      items={query.data?.items ?? []}
    />
  );
}

function getBranchCellForSessionName(sessionName: string): HTMLElement {
  const row = screen.getByText(sessionName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find sessions table row for ${sessionName}`);
  }
  const branchCell = row.children[BRANCH_COLUMN_CHILD_INDEX];
  if (!(branchCell instanceof HTMLElement)) {
    throw new Error(`Could not find Branch cell for ${sessionName}`);
  }
  return branchCell;
}
