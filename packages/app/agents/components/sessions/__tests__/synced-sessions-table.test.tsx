import { SessionPrLifecycleStatus } from "@repo/api/src/types/agent-session";
import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import {
  A11yTheme,
  expectElementContrast,
  themeBackground,
} from "@repo/app/test/a11y/contrast";
import { A11yThemeRoot } from "@repo/app/test/a11y/react";
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
const MULTI_OPEN_PR_TOOLTIP_REGEX = /#19 open · Wire PR list/;
const MULTI_MERGED_PR_TOOLTIP_REGEX = /#20 merged · Merge trusted lifecycle/;
// Grid children: lead (Session Name), status, autonomy, repo, branch, …
const BRANCH_COLUMN_CHILD_INDEX = 4;
const LONG_BRANCH_NAME =
  "kaiticarp/feature/some-very-long-descriptive-branch-name";
const A11Y_THEMES = [A11yTheme.Light, A11yTheme.Dark] as const;

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

  it.each([
    A11yTheme.Light,
    A11yTheme.Dark,
  ])("keeps shared sessions table critical a11y and contrast clean in %s theme", async (theme) => {
    const { container } = render(
      <A11yThemeRoot theme={theme}>
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={mixedAgentSessionListFixtures}
        />
      </A11yThemeRoot>
    );

    await expectCriticalAxeClean(container);
    expectElementContrast(screen.getByText("Session Name"), {
      background: themeBackground(theme),
      label: `sessions row label ${theme}`,
    });
  });

  it.each([
    [
      "loading",
      () => (
        <AgentSessionsListContent
          getSessionHref={(item) => `/sessions/${item.id}`}
          isLoading
          items={[]}
        />
      ),
      () => document.querySelector(".animate-pulse"),
    ],
    [
      "filtered-empty",
      () => (
        <AgentSessionsListContent
          getSessionHref={(item) => `/sessions/${item.id}`}
          isLoading={false}
          items={[]}
        />
      ),
      () => screen.getByText("No sessions found"),
    ],
    [
      "status-chip-row",
      () => (
        <SyncedSessionsTable
          getSessionHref={(item) => `/sessions/${item.id}`}
          items={mixedAgentSessionListFixtures}
        />
      ),
      () => screen.getByText("Awaiting input"),
    ],
  ])("keeps shared sessions %s state a11y and contrast clean", async (_state, renderElement, getTarget) => {
    for (const theme of A11Y_THEMES) {
      const { container, unmount } = render(
        <A11yThemeRoot theme={theme}>{renderElement()}</A11yThemeRoot>
      );

      const target = getTarget();
      expect(target).toBeInstanceOf(Element);
      await expectCriticalAxeClean(container);
      expectElementContrast(target as Element, {
        background: themeBackground(theme),
        label: `shared sessions ${_state} ${theme}`,
      });
      unmount();
    }
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

  it("renders PR and Merge columns for empty, open, merged, and multiple PR states", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            id: "no-pr-session",
            name: "No PR session",
            prs: [],
            prsMerged: 0,
          }),
          createAgentSessionListItemFixture({
            id: "open-pr-session",
            name: "Open PR session",
            prs: [
              {
                num: 17,
                title: "Add PR column",
                status: SessionPrLifecycleStatus.Open,
              },
            ],
            prsMerged: 0,
          }),
          createAgentSessionListItemFixture({
            id: "merged-pr-session",
            name: "Merged PR session",
            prs: [
              {
                num: 18,
                title: "Merge session projection",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            prsMerged: 1,
          }),
          createAgentSessionListItemFixture({
            id: "unknown-pr-session",
            name: "Unknown PR session",
            prs: [
              {
                num: 21,
                title: "Legacy merged claim",
                status: SessionPrLifecycleStatus.Unknown,
              },
            ],
            prsMerged: 0,
          }),
          createAgentSessionListItemFixture({
            id: "multi-pr-session",
            name: "Multiple PR session",
            prs: [
              {
                num: 19,
                title: "Wire PR list",
                status: SessionPrLifecycleStatus.Open,
              },
              {
                num: 20,
                title: "Merge trusted lifecycle",
                status: SessionPrLifecycleStatus.Merged,
              },
            ],
            prsMerged: 1,
          }),
        ]}
      />
    );

    expect(screen.getByText("PR")).toBeInTheDocument();
    expect(screen.getByText("Merge")).toBeInTheDocument();
    expect(getPrCellForSessionName("No PR session")).toHaveTextContent(
      GRID_EMPTY_VALUE_TEXT_REGEX
    );
    expect(getMergeCellForSessionName("No PR session")).toHaveTextContent(
      GRID_EMPTY_VALUE_TEXT_REGEX
    );
    expect(getPrCellForSessionName("Open PR session")).toHaveTextContent(
      "#17 open"
    );
    expect(getMergeCellForSessionName("Open PR session")).toHaveTextContent(
      "Not merged"
    );
    expect(getPrCellForSessionName("Merged PR session")).toHaveTextContent(
      "#18 merged"
    );
    expect(getMergeCellForSessionName("Merged PR session")).toHaveTextContent(
      "Merged"
    );
    expect(getPrCellForSessionName("Unknown PR session")).toHaveTextContent(
      "#21 unknown"
    );
    expect(getMergeCellForSessionName("Unknown PR session")).toHaveTextContent(
      "Unknown"
    );
    expect(getPrCellForSessionName("Multiple PR session")).toHaveTextContent(
      "2 PRs"
    );
    expect(getMergeCellForSessionName("Multiple PR session")).toHaveTextContent(
      "1/2 merged"
    );
    expect(screen.getByText(MULTI_OPEN_PR_TOOLTIP_REGEX)).toBeInTheDocument();
    expect(screen.getByText(MULTI_MERGED_PR_TOOLTIP_REGEX)).toBeInTheDocument();
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
            prs: [],
            prsMerged: 0,
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
            prs: [],
            prsMerged: 0,
          }),
          createAgentSessionListItemFixture({
            branch: "",
            id: "empty-branch-session",
            name: "Empty branch session",
            prs: [],
            prsMerged: 0,
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

  it("exposes a labelled overflow-menu trigger on every data row when enabled (FEA-2507)", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        showRowActions
      />
    );

    expect(
      screen.getAllByRole("button", { name: "Session actions" })
    ).toHaveLength(mixedAgentSessionListFixtures.length);
  });

  it("omits the overflow menu by default so embedding surfaces opt in (FEA-2507)", () => {
    render(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).not.toBeInTheDocument();
  });

  it("shows the overflow menu by default on the primary sessions list body (FEA-2507)", () => {
    render(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={mixedAgentSessionListFixtures}
      />
    );

    expect(
      screen.getAllByRole("button", { name: "Session actions" })
    ).toHaveLength(mixedAgentSessionListFixtures.length);
  });

  it("renders no overflow-menu trigger in the loading or empty states", () => {
    const { rerender } = render(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading
        items={[]}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).not.toBeInTheDocument();

    rerender(
      <AgentSessionsListContent
        getSessionHref={(item) => `/sessions/${item.id}`}
        isLoading={false}
        items={[]}
      />
    );

    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).not.toBeInTheDocument();
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
  return getGridCellForSessionName(sessionName, BRANCH_COLUMN_CHILD_INDEX);
}

function getPrCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, 5);
}

function getMergeCellForSessionName(sessionName: string): HTMLElement {
  return getGridCellForSessionName(sessionName, 6);
}

function getGridCellForSessionName(
  sessionName: string,
  childIndex: number
): HTMLElement {
  const row = screen.getByText(sessionName).closest(".group.grid");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Could not find sessions table row for ${sessionName}`);
  }
  const cell = row.children[childIndex];
  if (!(cell instanceof HTMLElement)) {
    throw new Error(`Could not find cell ${childIndex} for ${sessionName}`);
  }
  return cell;
}
