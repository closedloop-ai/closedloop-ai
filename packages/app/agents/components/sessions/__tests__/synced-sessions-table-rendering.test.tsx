import { SessionPrLifecycleStatus } from "@repo/api/src/types/agent-session";
import {
  IdleConcept,
  idleConceptLabel,
} from "@repo/api/src/types/idle-concepts";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionListItemFixture,
  mixedAgentSessionListFixtures,
} from "../session-list-fixtures";
import { SyncedSessionsTable } from "../synced-sessions-table";
import {
  GRID_EMPTY_VALUE_TEXT_REGEX,
  getBranchCellForSessionName,
  getGridCellForSessionName,
  getMergeCellForSessionName,
  getOwnerCellForSessionName,
  getPrCellForSessionName,
  getRepoCellForSessionName,
  LONG_BRANCH_NAME,
  MULTI_MERGED_PR_TOOLTIP_REGEX,
  MULTI_OPEN_PR_TOOLTIP_REGEX,
  OWNER_HEADER_NAME_REGEX,
  REPOSITORY_HEADER_NAME_REGEX,
  renderWithNav,
} from "./synced-sessions-table.test-helpers";

vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

describe("SyncedSessionsTable — rendering, columns, and chips", () => {
  it("renders mixed list-field fallback precedence without leaking raw missing values", () => {
    renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
      />
    );

    expect(screen.getByText("Named Session")).toBeInTheDocument();
    expect(screen.getByText("external-name-fallback")).toBeInTheDocument();
    // The repository column shows the repo name, never the raw absolute path.
    // FEA-3644: the repo chip now also carries a truncation tooltip, so the
    // value renders in both the chip label and the (mocked) tooltip content.
    expect(
      screen.getAllByText("closedloop-ai/repo-fallback").length
    ).toBeGreaterThan(0);
    expect(
      screen.queryByText("/worktrees/shared-list")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("/workspace/symphony-alpha")
    ).not.toBeInTheDocument();
    // ISS-5770: `Awaiting input` was a qualifier chip in the removed `Signals`
    // column. The fact is not lost — the API projects it into Status as
    // `Waiting` (`session-status-projection.ts`, FEA-4301) — so this asserts it
    // at its surviving home rather than dropping the coverage.
    expect(screen.getAllByText("Waiting").length).toBeGreaterThan(0);
    expect(screen.getByText("Linked branches")).toBeInTheDocument();
    expect(screen.getAllByText("fea-2036")).not.toHaveLength(0);
    // FEA-4274: an unresolved repository never fabricates a cwd folder name — a
    // numbered worktree dir must not surface "3" or the raw path as a repo.
    // ISS-4996 (ungated by ISS-5366) then took the last step: an absent
    // repository renders the SAME shared empty sentinel every other optional
    // column uses, rather than this column's own bespoke word "Unknown". The
    // absent-vs-malformed distinction is pinned in
    // `synced-sessions-table-honest-unknown.test.tsx`.
    expect(
      getRepoCellForSessionName("Unknown location row").textContent?.trim()
    ).toMatch(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(
      getRepoCellForSessionName(
        "Unresolved remote, numbered worktree"
      ).textContent?.trim()
    ).toMatch(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(screen.queryByText("Repository 3")).not.toBeInTheDocument();
    expect(
      screen.queryByText("/Users/chris.chenault/Code/3")
    ).not.toBeInTheDocument();
    // Other missing optional columns (e.g. model) still render the shared
    // em-dash placeholder.
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
    const { rerender } = renderWithNav(
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

  it("keeps the Branch column visible by default, hideable, and non-sortable", () => {
    const onSort = vi.fn();
    const { rerender } = renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        onSort={onSort}
        sortDir="asc"
      />
    );

    const branchHeader = screen.getByText("Linked branches");
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

    expect(screen.queryByText("Linked branches")).not.toBeInTheDocument();
    expect(screen.queryByText("fea-2036")).not.toBeInTheDocument();
  });

  it("FEA-4300: an Owner header click emits the server sort key `user`, and a `user` sort lights the Owner header", () => {
    const onSort = vi.fn();
    const { rerender } = renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        onSort={onSort}
        sortDir="asc"
      />
    );

    // The Owner column id is `owner`, but the header click must round-trip the
    // server sort key `user` (the API rejects `owner`) — this is the mapping that
    // makes FEA-4300 reachable from the table.
    fireEvent.click(
      screen.getByRole("button", { name: OWNER_HEADER_NAME_REGEX })
    );
    expect(onSort).toHaveBeenCalledWith("user", "desc");

    // The inverse: an active `user` sort must be recognized on the OWNER header
    // (not a phantom `user` column). With `user`/asc active on Owner, a click
    // TOGGLES to desc — proving the mapping lights the Owner header as active.
    onSort.mockClear();
    rerender(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures}
        onSort={onSort}
        sortBy="user"
        sortDir="asc"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: OWNER_HEADER_NAME_REGEX })
    );
    // Active (asc) → toggles to desc; if the Owner header were treated as
    // inactive this would be `asc` (the default first-click direction).
    expect(onSort).toHaveBeenCalledWith("user", "desc");
  });

  it("FEA-4006: renders the Owner column by default and remains hideable, with an em-dash for owner-less rows", () => {
    const ownedItem = createAgentSessionListItemFixture({
      id: "owned-session",
      name: "Owned session",
    });
    const ownerlessItem = createAgentSessionListItemFixture({
      id: "ownerless-session",
      name: "Ownerless session",
      user: null,
    });

    const { rerender } = renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[ownedItem, ownerlessItem]}
      />
    );

    // FEA-4006: Owner is a shown-by-default column (matching the agent-detail
    // mock), so a table with no `visibleColumns` renders it.
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Daniel Ochoa")).toBeInTheDocument();
    // Owner-less session (its user outlived deletion, FEA-1699) shows the shared
    // em-dash placeholder rather than leaking a raw missing value.
    expect(getOwnerCellForSessionName("Ownerless session")).toHaveTextContent(
      GRID_EMPTY_VALUE_TEXT_REGEX
    );

    // Hideable via the View menu: a `visibleColumns` set that omits owner drops
    // the column and its cells.
    rerender(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[ownedItem, ownerlessItem]}
        visibleColumns={new Set(["status", "repo"])}
      />
    );
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByText("Daniel Ochoa")).not.toBeInTheDocument();
  });

  it("renders PR and Merge columns for empty, open, merged, and multiple PR states", () => {
    renderWithNav(
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
    renderWithNav(
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
    expect(
      branchCell.querySelector('[data-testid="tooltip-content"]')
    ).toHaveTextContent(LONG_BRANCH_NAME);

    const branchTrigger = branchCell.querySelector(
      '[data-slot="tooltip-trigger"]'
    );
    expect(branchTrigger).toBeInstanceOf(HTMLElement);
    expect(branchTrigger).toHaveAttribute("tabindex", "0");

    (branchTrigger as HTMLElement).focus();
    expect(document.activeElement).toBe(branchTrigger);
  });

  it("FEA-3644: truncates the repo chip and exposes the full value on hover", () => {
    const longRepo =
      "closedloop-ai/a-very-long-monorepo-repository-name-overflow";
    renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            id: "long-repo-session",
            name: "Long repo session",
            repositoryFullName: longRepo,
          }),
        ]}
      />
    );

    const repoCell = getGridCellForSessionName(
      "Long repo session",
      "Repository"
    );
    // The visible chip label truncates (ellipsis), so the container never
    // overflows; the full value is carried by the styled tooltip on hover.
    expect(repoCell.querySelector(".truncate")).toHaveTextContent(longRepo);
    expect(
      repoCell.querySelector('[data-testid="tooltip-content"]')
    ).toHaveTextContent(longRepo);
  });

  it("FEA-3644: truncates the model chip and exposes the full value on hover", () => {
    const longModel = "claude-opus-4-8-1m-extra-long-model-identifier-overflow";
    renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[
          createAgentSessionListItemFixture({
            id: "long-model-session",
            model: longModel,
            name: "Long model session",
          }),
        ]}
      />
    );

    const modelCell = getGridCellForSessionName("Long model session", "Model");
    expect(modelCell.querySelector(".truncate")).toHaveTextContent(longModel);
    expect(
      modelCell.querySelector('[data-testid="tooltip-content"]')
    ).toHaveTextContent(longModel);
  });

  it("keeps empty branch cells as placeholders without tooltip content", () => {
    renderWithNav(
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

    const nullBranchCell = getBranchCellForSessionName("Null branch session");
    const emptyBranchCell = getBranchCellForSessionName("Empty branch session");
    expect(nullBranchCell).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);
    expect(emptyBranchCell).toHaveTextContent(GRID_EMPTY_VALUE_TEXT_REGEX);
    // Empty branch cells render the em-dash placeholder with no branch tooltip
    // (the repo/model chips carry their own tooltips elsewhere in the row).
    expect(
      nullBranchCell.querySelector('[data-testid="tooltip-content"]')
    ).toBeNull();
    expect(
      emptyBranchCell.querySelector('[data-testid="tooltip-content"]')
    ).toBeNull();
  });

  it("links every rendered row through the route-owned href callback", () => {
    renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/org-a/sessions/${item.id}`}
        items={mixedAgentSessionListFixtures.slice(0, 2)}
      />
    );

    const firstLink = screen.getByText("Named Session").closest("a");
    expect(firstLink).not.toBeNull();
    expect(firstLink).toHaveAttribute("href", "/org-a/sessions/session-name");
  });

  it("ISS-5770: the idle phantom-session chip no longer renders on the list, and the lead cell stays name-only", () => {
    const idleItem = createAgentSessionListItemFixture({
      id: "idle-session",
      name: "Phantom Row",
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolUseCount: 0,
    });
    const substantiveItem = createAgentSessionListItemFixture({
      id: "live-session",
      name: "Live Session",
    });

    renderWithNav(
      <SyncedSessionsTable
        getSessionHref={(item) => `/sessions/${item.id}`}
        items={[idleItem, substantiveItem]}
      />
    );

    // ISS-5770 removed the `Signals` column this chip had moved into, so the
    // phantom marker renders NOWHERE on the Sessions list. That is a deliberate
    // loss and the weakest of the qualifiers — a phantom row's remaining tell is
    // its empty Cost cell — but it is asserted rather than assumed, so the chip
    // reappearing anywhere on this surface is a test failure and not a surprise.
    //
    // The label is still read from the canonical IDLE_CONCEPTS map rather than
    // hardcoded, so this keeps failing correctly if that copy changes.
    const idleLabel = idleConceptLabel(IdleConcept.PhantomSession);
    expect(screen.queryAllByText(idleLabel)).toHaveLength(0);
    // And the one contract that must survive the removal: the lead cell is the
    // session name and nothing else — never a relocated chip (ISS-5666).
    const idleRowName = screen.getByText("Phantom Row");
    expect(idleRowName.parentElement?.textContent).not.toContain(idleLabel);
  });
});
