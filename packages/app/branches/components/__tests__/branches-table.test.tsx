import { BranchTagAvailability } from "@repo/api/src/types/branch";
import { ChecksStatus } from "@repo/api/src/types/branch-checks";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import {
  type BranchRow,
  BranchRowStatus,
  RENDER_MISSING,
  RENDER_UNATTRIBUTED,
} from "../../lib/branch-row";
import { BranchesTable } from "../branches-table";

const RE_WIP_LOCAL_NAME = /wip\/local/;
// The reorder handle's accessible name states the operation ("use arrow keys")
// so a screen-reader user knows the keys reorder, not just that a control exists.
const RE_REORDER_HANDLE = /^Reorder .+ column, use arrow keys$/;
const RE_REORDER_OWNER = /^Reorder Owner column, use arrow keys$/;
// FEA-4168: the resize handle's accessible name states the operation, matching
// the reorder-handle convention above.
const RE_RESIZE_HANDLE = /^Resize .+ column, use arrow keys$/;
// FEA-4259: the Linked Sessions count link's accessible name ("N linked session(s)").
const RE_LINKED_SESSIONS = /linked session/i;

const fullRow: BranchRow = {
  id: "owner%2Fweb::feature",
  branchName: "feature/full",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://gh/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: ChecksStatus.Passing,
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

const missingRow: BranchRow = {
  id: "local::wip",
  branchName: "wip/local",
  baseBranch: RENDER_MISSING,
  repo: RENDER_MISSING,
  owner: RENDER_UNATTRIBUTED,
  status: BranchRowStatus.Draft,
  prNumber: null,
  prTitle: null,
  prUrl: null,
  prState: null,
  checksPassed: null,
  checksTotal: null,
  checksStatus: null,
  behind: null,
  ahead: null,
  additions: null,
  deletions: null,
  sessionCount: 0,
  commentCount: null,
  lastActivityLabel: "10m ago",
};

const GRID_TEMPLATE_RE = /grid-template-columns:\s*([^;]+)/;

// Count top-level grid tracks, treating a parenthesized function such as
// `minmax(260px, 1fr)` (which contains a space) as a single track.
function countTracks(template: string): number {
  let depth = 0;
  let inToken = false;
  let count = 0;
  for (const ch of template) {
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    }
    if (ch === " " && depth === 0) {
      inToken = false;
    } else if (!inToken) {
      inToken = true;
      count += 1;
    }
  }
  return count;
}

function gridShape(el: Element): { children: number; tracks: number } {
  const match = (el.getAttribute("style") ?? "").match(GRID_TEMPLATE_RE);
  return {
    children: el.children.length,
    tracks: match ? countTracks(match[1]) : 0,
  };
}

describe("BranchesTable grid alignment", () => {
  it("renders the approved fixed column order without Checks or actions", () => {
    render(<BranchesTable approved items={[fullRow]} />);

    expect(
      screen
        .getAllByRole("columnheader")
        .map((header) => header.textContent?.trim())
    ).toEqual([
      "Name",
      "Owner",
      "Collaborators",
      "Linked sessions",
      "Changes",
      "Status",
      "Pull request",
      "Last active",
      "Repository",
      "Tags",
    ]);
    expect(screen.queryByText("Checks")).not.toBeInTheDocument();
  });

  it("keeps cached Desktop tags read-only while offline", () => {
    const taggedRow: BranchRow = {
      ...fullRow,
      artifactId: "artifact-1",
      tagAvailability: BranchTagAvailability.Available,
      tagPermissions: { canApply: true, canRemove: true },
      tags: [],
    };
    const view = render(
      <BranchesTable approved items={[taggedRow]} tagsReadOnly />,
      { wrapper: AppCoreStoryProviders }
    );

    expect(
      screen.queryByRole("button", { name: "Edit tags for feature/full" })
    ).not.toBeInTheDocument();

    view.rerender(<BranchesTable approved items={[taggedRow]} />);
    expect(
      screen.getByRole("button", { name: "Edit tags for feature/full" })
    ).toBeInTheDocument();
  });

  it("renders approved unavailable and unattributed states explicitly", () => {
    render(
      <BranchesTable
        approved
        items={[
          {
            ...fullRow,
            additions: null,
            deletions: null,
            owner: "unattributed",
          },
        ]}
      />
    );

    expect(screen.getByText("Unattributed")).toBeInTheDocument();
    expect(screen.getAllByText("Unavailable")).not.toHaveLength(0);
  });

  it("links repository cells and exposes collision-safe full identities", () => {
    const colliding = {
      ...fullRow,
      id: "other%2Fweb::feature",
      branchName: "feature/other",
      repo: "other/web",
    };
    const unique = {
      ...fullRow,
      id: "owner%2Fapi::feature",
      branchName: "feature/api",
      repo: "owner/api",
    };
    render(
      <BranchesTable
        allRows={[fullRow, colliding, unique]}
        approved
        items={[fullRow, colliding, unique]}
        visibleColumns={new Set(["repo"])}
      />
    );

    const ownerRepo = screen.getByRole("link", {
      name: "owner/web repository on GitHub",
    });
    expect(ownerRepo).toHaveAttribute("href", "https://github.com/owner/web");
    expect(ownerRepo).toHaveAttribute("title", "owner/web");
    expect(ownerRepo).toHaveTextContent("owner/web");
    expect(
      screen.getByRole("link", {
        name: "other/web repository on GitHub",
      })
    ).toHaveTextContent("other/web");
    const uniqueRepo = screen.getByRole("link", {
      name: "owner/api repository on GitHub",
    });
    expect(uniqueRepo).toHaveTextContent("api");
    expect(uniqueRepo).toHaveAttribute("title", "owner/api");
  });

  it("renders exactly one grid cell per template track (no phantom trailing cell)", () => {
    // Regression: a phantom trailing border cell with no template track wrapped
    // onto an implicit grid row and overlaid the first row's name cell, eating
    // its mouse events. Header and data rows must each have cells === tracks.
    render(<BranchesTable items={[fullRow]} />);

    const headerEl = screen.getByText("Branch").closest("div.grid");
    const rowEl = screen.getByText("feature/full").closest("div.grid");
    expect(headerEl).not.toBeNull();
    expect(rowEl).not.toBeNull();

    const header = gridShape(headerEl as Element);
    const row = gridShape(rowEl as Element);
    expect(header.tracks).toBeGreaterThan(0);
    expect(header.children).toBe(header.tracks);
    expect(row.children).toBe(row.tracks);
  });
});

// FEA-4273 sort/alignment coverage moved to the sibling
// `branches-table-sort-alignment.test.tsx` (shafty023 review): the block was
// growing this already-large file past the split signal, and the sort tests were
// rewritten there to drive real header clicks through a stateful harness instead
// of pre-sorted props + a no-op `onSort`.

describe("BranchesTable column set + order — prototype reconciliation (FEA-4006, FEA-4066)", () => {
  // Source of truth: apps/prototypes/app/p/branches/components/branches-table.tsx
  // `COLUMN_SPECS` — repo, status, owner, lastActivity, sessions, changes, pr,
  // checks — after the Name lead. The base table keeps the shared column order
  // (Owner first per FEA-3968) with the trailing `checks` column restored
  // (FEA-4066); `version` is the agent-detail-only trailing `extra` column
  // (data-gated), so it is not in the base inline set.
  const EXPECTED_HEADERS_IN_ORDER = [
    "Branch", // lead
    "Owner",
    "Repository",
    "Status",
    "Last active",
    "Linked Sessions",
    "Changes",
    "Pull request",
    "Checks",
  ] as const;

  it("renders exactly the prototype's columns, in order, and none excluded", () => {
    // Two rows with differing status/owner/repo so FEA-3968 collapse keeps every
    // low-variance categorical column present for the assertion.
    render(
      <BranchesTable
        items={[
          fullRow,
          {
            ...fullRow,
            id: "second",
            branchName: "feature/second",
            owner: "Sam Lee",
            repo: "owner/api",
            status: BranchRowStatus.Merged,
          },
        ]}
      />
    );
    const headerRow = screen.getByText("Branch").closest("div.grid");
    expect(headerRow).not.toBeNull();
    const renderedHeaders = [...(headerRow as HTMLElement).children]
      .map((cell) => cell.textContent?.trim() ?? "")
      .filter((label) => label.length > 0);
    // Header order (left→right) must match the prototype's column order exactly.
    expect(renderedHeaders).toEqual([...EXPECTED_HEADERS_IN_ORDER]);
    // FEA-4066: the Checks column is restored and must render.
    expect(screen.getByText("Checks")).toBeInTheDocument();
    for (const excluded of [
      "Behind / Ahead",
      "Story points",
      "Projects",
      "Tags",
      "Issues",
      "Reviewer",
    ]) {
      expect(screen.queryByText(excluded)).not.toBeInTheDocument();
    }
  });

  it("renders a fully-enriched row's cells", () => {
    render(<BranchesTable items={[fullRow]} />);
    expect(screen.getByText("feature/full")).toBeInTheDocument();
    expect(screen.getByText("web")).toBeInTheDocument(); // short repo name
    expect(screen.getByText("web#42")).toBeInTheDocument(); // PR badge
    expect(screen.getByText("+10")).toBeInTheDocument(); // changes
    expect(screen.getByText("−5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // linked sessions count
    // FEA-4066: the Checks column renders its rollup value.
    expect(screen.getByText("12/12 passing")).toBeInTheDocument();
  });

  it("degrades github-live cells to the empty-value affordance when absent", () => {
    render(<BranchesTable items={[missingRow]} />);
    // repo, PR, changes, sessions, checks → "—"
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(5);
  });

  it("renders the Checks rollup value and degrades to empty when checks are absent (FEA-4066)", () => {
    // Two rows with differing values so no low-variance collapse hides a column,
    // and to exercise both the enriched and null-enrichment Checks paths.
    render(
      <BranchesTable
        items={[
          fullRow,
          {
            ...missingRow,
            id: "no-checks",
            branchName: "feature/no-checks",
          },
        ]}
        visibleColumns={new Set(["checks"])}
      />
    );
    expect(screen.getByText("Checks")).toBeInTheDocument();
    // Enriched row → "N/N passing"; null-enrichment row → em-dash empty value.
    expect(screen.getByText("12/12 passing")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("degrades to empty when the passed count is absent, never fabricating a zero (FEA-4066)", () => {
    // The web BFF (`branch-read-service.toBranchRow`) emits `checksPassed: null`
    // with a NON-null `checksTotal` (from `checksDetailTotalCount`, a non-null
    // Int). A naive `checksPassed ?? 0` would render "0/N passing" on every
    // enriched row — a wall of fabricated CI failures. Two rows so nothing
    // collapses; the cell must show the empty-value affordance, not "0/9".
    render(
      <BranchesTable
        items={[
          {
            ...fullRow,
            id: "web-bff",
            checksPassed: null,
            checksTotal: 9,
            checksStatus: ChecksStatus.Passing,
          },
          fullRow,
        ]}
        visibleColumns={new Set(["checks"])}
      />
    );
    expect(screen.queryByText("0/9 passing")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("tones the rollup by checksStatus so a failing build reads destructive (FEA-4066)", () => {
    // The rollup takes its color from the same variant vocabulary as Status
    // (SSOT): FAILING → destructive text, not the neutral default tone that
    // makes a red build indistinguishable from a green one.
    render(
      <BranchesTable
        items={[
          {
            ...fullRow,
            id: "failing",
            checksPassed: 3,
            checksTotal: 9,
            checksStatus: ChecksStatus.Failing,
          },
          fullRow,
        ]}
        visibleColumns={new Set(["checks"])}
      />
    );
    const failing = screen.getByText("3/9 passing");
    expect(failing.className).toContain("text-destructive");
    const passing = screen.getByText("12/12 passing");
    expect(passing.className).toContain("text-success-foreground");
  });

  it("collapses the Checks column entirely when every row is empty (FEA-4066)", () => {
    // No producer emits the passed count today, so an all-empty Checks column
    // must drop its header + track (FEA-3968 collapse) rather than render a wall
    // of em-dashes. Both rows null-enriched ⇒ the header disappears.
    render(
      <BranchesTable
        items={[
          { ...missingRow, id: "a", branchName: "wip/a" },
          { ...missingRow, id: "b", branchName: "wip/b" },
        ]}
        visibleColumns={new Set(["checks"])}
      />
    );
    expect(screen.queryByText("Checks")).not.toBeInTheDocument();
  });
});

describe("BranchesTable Owner column (on by default, hideable)", () => {
  it("renders the Owner header + actor only when visibleColumns includes owner", () => {
    render(
      <BranchesTable
        items={[fullRow]}
        visibleColumns={new Set(["repo", "status", "owner"])}
      />
    );
    expect(screen.getByText("Owner")).toBeInTheDocument();
    expect(screen.getByText("Alex Rivera")).toBeInTheDocument();
  });

  it("renders the shared em-dash empty value for a null actor (FEA-3432)", () => {
    // Consistent with the Sessions owner column: a null owner shows the shared
    // `GridEmptyValue` em-dash, not a literal "unattributed" chip. Only the
    // Owner column is visible, so the em-dash comes from that cell.
    render(
      <BranchesTable items={[missingRow]} visibleColumns={new Set(["owner"])} />
    );
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(RENDER_UNATTRIBUTED)).not.toBeInTheDocument();
  });

  it("hides Owner when visibleColumns omits it (opt-in)", () => {
    render(
      <BranchesTable items={[fullRow]} visibleColumns={new Set(["repo"])} />
    );
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
  });
});

describe("BranchesTable row→detail navigation (C2)", () => {
  it("wraps the Name lead in an anchor to the branch href when provided", () => {
    // missingRow has no PR, so the lead anchor is the only link in the row.
    // FEA-4051: the lead now renders the surface-agnostic `@repo/navigation`
    // `Link`, which requires a NavigationProvider — supplied by the shared
    // AppCoreStoryProviders (memory adapter).
    render(
      <BranchesTable
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[missingRow]}
      />,
      { wrapper: AppCoreStoryProviders }
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "#/branches/local::wip");
    expect(link).toHaveTextContent("wip/local");
  });

  it("renders a plain (non-link) lead when getBranchHref is omitted", () => {
    render(<BranchesTable items={[missingRow]} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("wip/local")).toBeInTheDocument();
  });

  it("delegates lead rendering to the platform-owned render seam", () => {
    render(
      <BranchesTable
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[missingRow]}
        renderBranchLink={({ children, className, item }) => (
          <span className={className} data-branch-id={item.id}>
            {children}
          </span>
        )}
      />
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.getByText("wip/local").closest("[data-branch-id]")
    ).toHaveAttribute("data-branch-id", missingRow.id);
  });

  it("links EVERY row's lead, including the first, not just later rows", () => {
    // Regression guard: the first row's name must be a branch-detail link too.
    // fullRow also renders a PR-badge link (to the PR url), so we isolate the
    // lead anchors by their branch-detail href prefix.
    render(
      <BranchesTable
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[fullRow, missingRow]}
      />,
      { wrapper: AppCoreStoryProviders }
    );
    const leadHrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
      .filter((href) => href?.startsWith("#/branches/"));
    expect(leadHrefs).toContain(`#/branches/${fullRow.id}`);
    expect(leadHrefs).toContain(`#/branches/${missingRow.id}`);
  });

  // FEA-4051 regression: the Name lead was a raw `<a href>`, which the desktop
  // renderer's hash-store navigation adapter does not intercept (and the
  // Electron nav guard blocks the raw document navigation), so clicking the
  // branch name was a dead click on desktop. Routing through the
  // surface-agnostic `@repo/navigation` `Link` drives the active adapter on a
  // plain left-click. Assert the adapter's real navigation state changed — the
  // shared behavior both surfaces rely on — not just the rendered href.
  it("drives the navigation adapter when the Name lead is clicked (not a raw anchor)", () => {
    const nav = createMemoryNavigation({ initialPath: "/branches" });
    render(
      <NavigationProvider adapter={nav.adapter}>
        <BranchesTable
          getBranchHref={(item) => `/branches/${item.id}`}
          items={[missingRow]}
        />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: RE_WIP_LOCAL_NAME }));

    expect(nav.getCurrentHref()).toBe(`/branches/${missingRow.id}`);
    expect(nav.getHistory()).toContain(`/branches/${missingRow.id}`);
  });
});

describe("BranchesTable Linked Sessions count → sessions link (FEA-4259)", () => {
  it("renders the count as a link to getSessionsHref with an accessible name", () => {
    // fullRow has sessionCount 3 and a PR-badge link, so isolate the sessions
    // link by its accessible name (the bare count is not descriptive alone).
    render(
      <BranchesTable
        getSessionsHref={(item) =>
          `#/branches/${item.id}?tab=sessions-timeline`
        }
        items={[fullRow]}
      />,
      { wrapper: AppCoreStoryProviders }
    );

    const link = screen.getByRole("link", { name: RE_LINKED_SESSIONS });
    expect(link).toHaveAttribute(
      "href",
      `#/branches/${fullRow.id}?tab=sessions-timeline`
    );
    // Accessible name pluralizes on the count (3 → "3 linked sessions").
    expect(link).toHaveAccessibleName("3 linked sessions");
    expect(link).toHaveTextContent("3");
  });

  it("uses the singular accessible name for a single-session branch", () => {
    render(
      <BranchesTable
        getSessionsHref={(item) =>
          `#/branches/${item.id}?tab=sessions-timeline`
        }
        items={[{ ...fullRow, sessionCount: 1 }]}
      />,
      { wrapper: AppCoreStoryProviders }
    );
    expect(
      screen.getByRole("link", { name: RE_LINKED_SESSIONS })
    ).toHaveAccessibleName("1 linked session");
  });

  it("does NOT render a dead link for a zero-session branch (honest degrade)", () => {
    // missingRow has sessionCount 0 — the count is a plain empty-value
    // affordance, never a link to an empty sessions view.
    render(
      <BranchesTable
        getSessionsHref={(item) =>
          `#/branches/${item.id}?tab=sessions-timeline`
        }
        items={[missingRow]}
      />,
      { wrapper: AppCoreStoryProviders }
    );
    expect(
      screen.queryByRole("link", { name: RE_LINKED_SESSIONS })
    ).not.toBeInTheDocument();
  });

  it("renders a plain (non-link) count when getSessionsHref is omitted", () => {
    render(<BranchesTable items={[fullRow]} />, {
      wrapper: AppCoreStoryProviders,
    });
    expect(
      screen.queryByRole("link", { name: RE_LINKED_SESSIONS })
    ).not.toBeInTheDocument();
    // The count still renders — it just isn't a link.
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("drives the navigation adapter when the count is clicked (not a raw anchor)", () => {
    // Cross-surface guard mirroring the Name-lead FEA-4051 test: the desktop
    // renderer's hash-store adapter ignores a raw `<a>`, so the count must route
    // through the surface-agnostic `@repo/navigation` `Link`.
    const nav = createMemoryNavigation({ initialPath: "/branches" });
    const target = `/branches/${fullRow.id}?tab=sessions-timeline`;
    render(
      <NavigationProvider adapter={nav.adapter}>
        <BranchesTable getSessionsHref={() => target} items={[fullRow]} />
      </NavigationProvider>
    );

    fireEvent.click(screen.getByRole("link", { name: RE_LINKED_SESSIONS }));

    expect(nav.getCurrentHref()).toBe(target);
    expect(nav.getHistory()).toContain(target);
  });
});

describe("BranchesTable low-variance status label + collapse — FEA-3968", () => {
  const openA: BranchRow = {
    ...fullRow,
    id: "a",
    branchName: "feature/a",
    prNumber: null,
    prState: null,
  };
  const openB: BranchRow = {
    ...fullRow,
    id: "b",
    branchName: "feature/b",
    owner: "Sam Lee",
    prNumber: null,
    prState: null,
  };
  const mergedB: BranchRow = {
    ...openB,
    status: BranchRowStatus.Merged,
  };

  it("renders Status as a plain colored label, not a filled chip", () => {
    // fullRow status is Open; single row ⇒ no collapse, so the label renders.
    render(<BranchesTable items={[fullRow]} />);
    const label = screen.getByText("Open");
    expect(label.className).toContain("truncate");
    expect(label.className).not.toContain("rounded-full");
  });

  it("collapses the Status column when every visible row is the same status", () => {
    render(<BranchesTable items={[openA, openB]} />);
    // "Open" on every row ⇒ the Status column (header label + cells) is dropped.
    // No `onSort` here, so the header renders as a plain "Status" label.
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.queryByText("Open")).not.toBeInTheDocument();
  });

  it("keeps the Status column (emphasis) when status varies across rows", () => {
    render(<BranchesTable items={[openA, mergedB]} />);
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Open")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
  });

  it("collapses Repository by the DISPLAYED short name, not the full path (wongk)", () => {
    // `acme/web` and `other/web` both render as `web`, so the column conveys
    // nothing on the page and must collapse — keying on the full path would keep
    // it while painting an identical `web` down every row.
    const acmeWeb: BranchRow = { ...openA, repo: "acme/web" };
    const otherWeb: BranchRow = { ...openB, repo: "other/web" };
    render(
      <BranchesTable
        items={[acmeWeb, otherWeb]}
        visibleColumns={new Set(["repo"])}
      />
    );
    expect(screen.queryByText("Repository")).not.toBeInTheDocument();
    expect(screen.queryByText("web")).not.toBeInTheDocument();
  });

  it("never collapses the active sort column even when it is constant (wongk)", () => {
    // Status is constant "Open" AND the active sort column ⇒ kept, so the sort
    // header (which reverses the sort) can never vanish.
    render(
      <BranchesTable
        items={[openA, openB]}
        onSort={() => {
          // no-op
        }}
        sortBy="status"
        sortDir="asc"
      />
    );
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("keeps the Blocked status as a filled chip for emphasis, not a plain label", () => {
    // "Changes requested" is the one status someone must go act on, so it keeps
    // the boxed destructive chip (rounded-full) with its status dot.
    const blocked: BranchRow = { ...fullRow, status: BranchRowStatus.Blocked };
    render(<BranchesTable items={[blocked]} />);
    const chip = screen.getByText("Changes requested");
    expect(chip.className).toContain("rounded-full");
  });
});

describe("BranchesTable column reorder — FEA-4021", () => {
  // A second row so the low-variance collapse (which needs 2+ constant rows)
  // never drops a column under test, and so the reorder acts on a stable set.
  const rowB: BranchRow = {
    ...fullRow,
    id: "owner%2Fweb::feature-b",
    branchName: "feature/b",
    owner: "Sam Chen",
    repo: "acme/api",
    sessionCount: 1,
  };

  function renderReorderable(
    onColumnOrderChange: (order: string[]) => void,
    columnOrder?: string[]
  ) {
    return render(
      <BranchesTable
        columnOrder={columnOrder}
        items={[fullRow, rowB]}
        onColumnOrderChange={onColumnOrderChange}
      />
    );
  }

  it("renders a keyboard-operable drag handle per reorderable data column", () => {
    renderReorderable(() => {
      // no-op
    });
    // The Owner header column exposes an accessibly-named reorder control.
    expect(
      screen.getByRole("button", { name: RE_REORDER_OWNER })
    ).toBeInTheDocument();
    // Every reorder handle names a real column label; the always-on actions
    // column (empty label, absent from the order) never gets one.
    const handles = screen.getAllByRole("button", { name: RE_REORDER_HANDLE });
    expect(handles.length).toBeGreaterThan(0);
    for (const handle of handles) {
      expect(handle.getAttribute("aria-label")).not.toBe(
        "Reorder  column, use arrow keys"
      );
    }
  });

  it("emits a new column order when a handle is moved right via keyboard", () => {
    const emitted: string[][] = [];
    renderReorderable((order) => {
      emitted.push(order);
    });
    const ownerHandle = screen.getByRole("button", {
      name: RE_REORDER_OWNER,
    });
    // `fireEvent` returns false when the handler called preventDefault, which it
    // must so the arrow key does not ALSO scroll the table sideways.
    const notPrevented = fireEvent.keyDown(ownerHandle, { key: "ArrowRight" });
    expect(notPrevented).toBe(false);
    // Owner leads the default order; ArrowRight swaps it past Repository.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].slice(0, 2)).toEqual(["repo", "owner"]);
  });

  it("keeps a hidden column in the emitted order when the visible subset is reordered", () => {
    // "status" is hidden, so the header renders only [owner, repo, ...] and can
    // only reorder that subset. The emitted order must still carry "status" in
    // its natural slot (index 2) — not drop it or append it at the end — so
    // re-showing it later restores its position (codex P2 / FEA-4021).
    const emitted: string[][] = [];
    render(
      <BranchesTable
        items={[fullRow, rowB]}
        onColumnOrderChange={(order) => emitted.push(order)}
        visibleColumns={
          new Set(["owner", "repo", "lastActivity", "sessions", "changes"])
        }
      />
    );
    const ownerHandle = screen.getByRole("button", { name: RE_REORDER_OWNER });
    fireEvent.keyDown(ownerHandle, { key: "ArrowRight" });
    expect(emitted).toHaveLength(1);
    // The full data order is emitted (every COLUMN_SPECS id), with the hidden
    // "status" still at its canonical index 2, and the visible move applied.
    expect(emitted[0]).toContain("status");
    expect(emitted[0].indexOf("status")).toBe(2);
    expect(emitted[0].indexOf("repo")).toBeLessThan(
      emitted[0].indexOf("owner")
    );
  });

  it("renders data columns in the persisted order (repo before owner)", () => {
    renderReorderable(() => {
      // no-op
    }, ["repo", "owner"]);
    const headerEl = screen.getByText("Branch").closest("div.grid");
    expect(headerEl).not.toBeNull();
    const cells = [
      ...(headerEl as Element).querySelectorAll("[data-column-id]"),
    ].map((cell) => cell.getAttribute("data-column-id"));
    // Repository now precedes Owner in DOM order (the persisted order won).
    expect(cells).toContain("repo");
    expect(cells).toContain("owner");
    expect(cells.indexOf("repo")).toBeLessThan(cells.indexOf("owner"));
  });
});

describe("BranchesTable column resize — FEA-4168", () => {
  const rowB: BranchRow = {
    ...fullRow,
    id: "owner%2Fweb::feature-b",
    branchName: "feature/b",
    owner: "Sam Chen",
    repo: "acme/api",
    sessionCount: 1,
  };

  // Split a grid-template into top-level tracks, treating a parenthesized
  // function such as `minmax(260px, 1fr)` (which contains a space) as one track.
  function splitTracks(template: string): string[] {
    const tracks: string[] = [];
    let depth = 0;
    let token = "";
    for (const ch of template.trim()) {
      if (ch === "(") {
        depth += 1;
      } else if (ch === ")") {
        depth -= 1;
      }
      if (ch === " " && depth === 0) {
        if (token) {
          tracks.push(token);
          token = "";
        }
      } else {
        token += ch;
      }
    }
    if (token) {
      tracks.push(token);
    }
    return tracks;
  }

  function trackFor(headerEl: Element, columnId: string): string | null {
    const style = headerEl.getAttribute("style") ?? "";
    const match = style.match(GRID_TEMPLATE_RE);
    if (!match) {
      return null;
    }
    const tracks = splitTracks(match[1]);
    const cells = [...headerEl.querySelectorAll("[data-column-id]")].map((c) =>
      c.getAttribute("data-column-id")
    );
    // The lead column occupies the first track (`minmax(...)`, no data-column-id
    // cell before it), so a data column's track is at its index + 1.
    const dataIndex = cells.indexOf(columnId);
    return dataIndex === -1 ? null : (tracks[dataIndex + 1] ?? null);
  }

  it("renders a keyboard-operable resize handle per data column", () => {
    render(
      <BranchesTable
        columnWidths={{}}
        items={[fullRow, rowB]}
        onColumnWidthChange={() => {
          // no-op — this case only asserts the handle renders.
        }}
      />
    );
    expect(
      screen.getByRole("button", {
        name: "Resize Owner column, use arrow keys",
      })
    ).toBeInTheDocument();
  });

  it("emits no resize handle when onColumnWidthChange is absent", () => {
    render(<BranchesTable items={[fullRow, rowB]} />);
    expect(
      screen.queryByRole("button", { name: RE_RESIZE_HANDLE })
    ).not.toBeInTheDocument();
  });

  it("applies a persisted width to the column's grid track (restore)", () => {
    render(
      <BranchesTable
        columnWidths={{ owner: 240 }}
        items={[fullRow, rowB]}
        onColumnWidthChange={() => {
          // no-op
        }}
      />
    );
    const headerEl = screen.getByText("Branch").closest("div.grid");
    expect(headerEl).not.toBeNull();
    // The Owner track reflects the persisted 240px, not its 150px natural width.
    expect(trackFor(headerEl as Element, "owner")).toBe("240px");
  });

  it("emits a new width for the resized column via keyboard (persist)", () => {
    const emitted: [string, number][] = [];
    render(
      <BranchesTable
        columnWidths={{ owner: 150 }}
        items={[fullRow, rowB]}
        onColumnWidthChange={(id, width) => emitted.push([id, width])}
      />
    );
    const handle = screen.getByRole("button", {
      name: "Resize Owner column, use arrow keys",
    });
    // preventDefault must fire so the arrow key does not scroll the table.
    const notPrevented = fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(notPrevented).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe("owner");
    expect(emitted[0][1]).toBeGreaterThan(150);
  });
});
