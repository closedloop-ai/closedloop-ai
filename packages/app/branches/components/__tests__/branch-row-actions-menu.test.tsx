import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchRowActionsMenu } from "../branch-row-actions-menu";

// Render the Radix DropdownMenu inline so its items are queryable without
// driving the open interaction (flaky under jsdom). Wire `onSelect` to a click
// so handlers run. The `asChild` "View linked sessions" item passes a `Link`
// child (a real anchor) with no `onSelect`, so it must render that child
// directly rather than wrapping it in a <button>. Mirrors the sibling
// agent-row-actions-menu suite's mock precedent.
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    asChild?: boolean;
    disabled?: boolean;
    onSelect?: () => void;
  }) =>
    isValidElement(children) && !onSelect ? (
      children
    ) : (
      <button disabled={disabled} onClick={() => onSelect?.()} type="button">
        {children}
      </button>
    ),
}));

const FORBIDDEN_RE = /issues|docs|agents/i;
const VIEW_SESSIONS_RE = /view linked sessions/i;

const baseItem: BranchRow = {
  id: "id",
  branchName: "agent/x",
  baseBranch: "main",
  repo: "acme/web",
  owner: "Alex",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "t",
  prUrl: "https://github.com/acme/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

describe("BranchRowActionsMenu", () => {
  it("offers only branch-scoped actions; hides Open-detail/View-sessions without handlers", () => {
    render(<BranchRowActionsMenu item={baseItem} />);

    expect(screen.getByText("Copy branch name")).toBeInTheDocument();
    expect(screen.getByText("Open PR")).toBeInTheDocument();
    expect(screen.queryByText("Open detail")).not.toBeInTheDocument();
    expect(screen.queryByText(VIEW_SESSIONS_RE)).not.toBeInTheDocument();
    expect(screen.queryByText(FORBIDDEN_RE)).not.toBeInTheDocument();
  });

  it("shows and fires Open detail when the handler is provided", async () => {
    const user = userEvent.setup();
    const onOpenDetail = vi.fn();
    render(
      <BranchRowActionsMenu item={baseItem} onOpenDetail={onOpenDetail} />
    );

    await user.click(screen.getByText("Open detail"));
    expect(onOpenDetail).toHaveBeenCalledWith(baseItem);
  });

  it("renders View linked sessions as a link to getSessionsHref when supplied", () => {
    const nav = createMemoryNavigation({ initialPath: "/branches" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <BranchRowActionsMenu
          getSessionsHref={(item) =>
            `/branches/${encodeURIComponent(item.id)}?tab=sessions-timeline`
          }
          item={{ ...baseItem, id: "acme%2Fweb::feature" }}
        />
      </NavigationProvider>
    );

    const link = screen.getByRole("link", { name: VIEW_SESSIONS_RE });
    // The href factory double-encodes the already-percent-encoded desktop id
    // (mirrors the count chip), so the encoded segment survives the route's
    // single decode instead of landing on a not-found branch.
    expect(link).toHaveAttribute(
      "href",
      "/branches/acme%252Fweb%3A%3Afeature?tab=sessions-timeline"
    );
  });

  it("hides View linked sessions on a 0-count row even with a href factory", () => {
    const nav = createMemoryNavigation({ initialPath: "/branches" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <BranchRowActionsMenu
          getSessionsHref={(item) => `/branches/${item.id}`}
          item={{ ...baseItem, sessionCount: 0 }}
        />
      </NavigationProvider>
    );

    expect(screen.queryByText(VIEW_SESSIONS_RE)).not.toBeInTheDocument();
  });

  it("disables Open PR when the row has no PR", () => {
    render(
      <BranchRowActionsMenu
        item={{ ...baseItem, prNumber: null, prUrl: null }}
      />
    );

    const openPr = screen.getByText("Open PR").closest("button");
    expect(openPr).toBeDisabled();
  });

  it("disables Open PR for a non-canonical / unsafe PR URL", () => {
    render(
      <BranchRowActionsMenu
        item={{ ...baseItem, prUrl: "javascript:alert(1)" }}
      />
    );

    const openPr = screen.getByText("Open PR").closest("button");
    expect(openPr).toBeDisabled();
  });
});
