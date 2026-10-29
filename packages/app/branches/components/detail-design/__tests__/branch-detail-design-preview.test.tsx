import { expectCriticalAxeClean } from "@repo/app/test/a11y/axe";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRANCH_DESIGN_ARTIFACT } from "../branch-detail-design-fixtures";
import { BranchDetailDesignPreview } from "../branch-detail-design-preview";

// The Activity tab's rows resolve people, projects and tags through the org
// directories; seed them as a settled read with the example rows' records
// (activity-catalog.fixtures.ts), the way the stories do. Hoisted, so the
// records are declared here rather than imported.
const directory = vi.hoisted(() => {
  const settled = <T,>(data: T[]) => ({
    data,
    isPending: false,
    isError: false,
    fetchStatus: "idle",
  });
  return {
    users: settled([
      {
        id: "00000000-0000-7000-8000-000000000101",
        firstName: "Emily",
        lastName: "Carter",
      },
      {
        id: "00000000-0000-7000-8000-000000000102",
        firstName: "Jake",
        lastName: "Morrison",
      },
    ]),
    projects: settled([
      { id: "00000000-0000-7000-8000-000000000120", name: "Atlas" },
      { id: "00000000-0000-7000-8000-000000000121", name: "Orion" },
    ]),
    tags: settled([
      {
        id: "00000000-0000-7000-8000-000000000130",
        name: "frontend",
        color: "blue",
      },
      {
        id: "00000000-0000-7000-8000-000000000132",
        name: "backend",
        color: "green",
      },
    ]),
  };
});
vi.mock("@repo/app/users/hooks/use-users", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useOrganizationUsers: () => directory.users,
}));
vi.mock("@repo/app/projects/hooks/use-projects", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProjects: () => directory.projects,
}));
vi.mock("@repo/app/tags/hooks/use-tags", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTags: () => directory.tags,
}));
// A person's name links to their profile through the app's navigation port,
// which this harness has no provider for.
// Comment rows and linked values on the Activity tab are navigation-port
// links too; a plain anchor keeps their link semantics without a provider.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));
vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}));

const MERGED_OPTION_RE = /#1270/;
const OPEN_BODY = "Fixture: splits the awaiting-sync and not-present states.";
const MERGED_BODY = "Fixture: implements the Branch Detail shell.";
const OPEN_PR_COMMENT =
  "Fixture: please split the awaiting-sync state into its own file.";
const MERGED_PR_COMMENT = "Fixture: approved, the shell matches the handoff.";
// ISS-11209: the canonical pane names its landmark without the count.
const COMMENTS_RAIL_RE = /^Comments$/;
const SESSION_COMMENTS_RAIL_RE = /^Session comments$/;

const NATIVE_DRAFT = "Fixture: a new branch-level note";
const TOGGLE_RE = /^(Show|Hide) comments rail$/;

function setViewportNarrow(narrow: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: narrow,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BranchDetailDesignPreview", () => {
  it("shows Artifact, Sessions, Details and Activity (Activity kept, 2026-10-06)", () => {
    render(<BranchDetailDesignPreview />);

    // Sessions sits ahead of Details since ISS-12167 (operator, 2026-10-07).
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Artifact",
      "Sessions",
      "Details",
      "Activity",
    ]);
  });

  it("opens on Activity with the Branch feed, newest first, and no comments rail", () => {
    render(<BranchDetailDesignPreview initialTab="activity" />);

    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    const rows = within(
      screen.getByRole("list", { name: "Activity" })
    ).getAllByRole("listitem");
    expect(rows.length).toBeGreaterThan(0);
    // Newest first: Emily removing the tag (ISS-12117 example timeline, C29)
    // leads, the tag named rather than "a tag".
    expect(rows[0]).toHaveTextContent("Emily Carter");
    expect(rows[0]).toHaveTextContent("removed the frontend tag");
    expect(
      screen.queryByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).not.toBeInTheDocument();
  });

  it("re-scopes every PR-owned panel on the Artifact tab when another PR is selected", async () => {
    const user = userEvent.setup();
    render(<BranchDetailDesignPreview />);

    const openScope = screen.getByRole("region", {
      name: "Branch and pull request #1284 evidence",
    });
    expect(within(openScope).getByText(OPEN_BODY)).toBeInTheDocument();
    expect(within(openScope).getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText(OPEN_PR_COMMENT)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Pull request" }));
    await user.click(screen.getByRole("option", { name: MERGED_OPTION_RE }));

    const mergedScope = screen.getByRole("region", {
      name: "Branch and pull request #1270 evidence",
    });
    expect(within(mergedScope).getByText(MERGED_BODY)).toBeInTheDocument();
    expect(within(mergedScope).getByText("3 files")).toBeInTheDocument();
    expect(screen.queryByText(OPEN_BODY)).not.toBeInTheDocument();
    // The PR's GitHub comment follows the selection in the rail.
    expect(screen.getByText(MERGED_PR_COMMENT)).toBeInTheDocument();
    expect(screen.queryByText(OPEN_PR_COMMENT)).not.toBeInTheDocument();
  });

  it("mounts the comments rail beside Artifact and Sessions but not Details", async () => {
    const user = userEvent.setup();
    render(<BranchDetailDesignPreview />);

    expect(
      screen.getByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.queryByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(
      screen.getByRole("complementary", { name: SESSION_COMMENTS_RAIL_RE })
    ).toBeInTheDocument();
  });

  it("hides the comments rail and its toggle below the narrow breakpoint", () => {
    setViewportNarrow(true);
    render(<BranchDetailDesignPreview />);

    expect(screen.getByRole("tab", { name: "Artifact" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TOGGLE_RE })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).not.toBeInTheDocument();
  });

  it("shows the comments rail and its toggle at a wide viewport", () => {
    setViewportNarrow(false);
    render(<BranchDetailDesignPreview />);

    expect(screen.getByRole("button", { name: TOGGLE_RE })).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).toBeInTheDocument();
  });

  it("keeps a posted Closedloop comment across a PR switch while the GitHub comment follows the PR", async () => {
    const user = userEvent.setup();
    render(<BranchDetailDesignPreview />);

    await user.type(
      screen.getByRole("textbox", { name: "Add a comment" }),
      NATIVE_DRAFT
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(screen.getByText(NATIVE_DRAFT)).toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Pull request" }));
    await user.click(screen.getByRole("option", { name: MERGED_OPTION_RE }));

    expect(screen.getByText(NATIVE_DRAFT)).toBeInTheDocument();
    expect(screen.getByText(MERGED_PR_COMMENT)).toBeInTheDocument();
    expect(screen.queryByText(OPEN_PR_COMMENT)).not.toBeInTheDocument();
  });
  // ISS-10798 AC4: no critical WCAG 2.2 AA violations on any tab; icon-only
  // controls are named and the tab list carries its label.
  it.each(["Artifact", "Sessions", "Details", "Activity"])(
    "has no critical axe violations on the %s tab",
    async (tab) => {
      const user = userEvent.setup();
      const { container } = render(<BranchDetailDesignPreview />);
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.getByRole("tablist", { name: "Artifact detail sections" })
      ).toBeInTheDocument();
      await expectCriticalAxeClean(container);
    }
  );

  it("hands the page header the comments toggle beside Artifact and Sessions only", async () => {
    setViewportNarrow(false);
    const user = userEvent.setup();
    const pageHeader = vi.fn(() => null);
    render(<BranchDetailDesignPreview pageHeader={pageHeader} />);

    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commentsToggle: expect.anything(),
        title: expect.any(String),
      })
    );
    await user.click(screen.getByRole("tab", { name: "Details" }));
    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsToggle: null })
    );
    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(pageHeader).toHaveBeenLastCalledWith(
      expect.objectContaining({ commentsToggle: expect.anything() })
    );
  });

  it("shows the collaborators beside the tabs on every tab", async () => {
    const user = userEvent.setup();
    render(<BranchDetailDesignPreview />);

    for (const tab of ["Artifact", "Sessions", "Details", "Activity"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      // ISS-12273: the shared widget makes ONE accessibility statement — the
      // wrapper names every collaborator — so each name is asserted inside
      // that one label rather than on an avatar of its own.
      for (const name of BRANCH_DESIGN_ARTIFACT.collaborators) {
        expect(
          screen.getAllByRole("img", { name: new RegExp(name) }).length
        ).toBeGreaterThan(0);
      }
    }
  });
});
