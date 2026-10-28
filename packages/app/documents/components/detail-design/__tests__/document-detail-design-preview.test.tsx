import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_DESIGN_ARTIFACT } from "../document-detail-design-fixtures";
import { DocumentDetailDesignPreview } from "../document-detail-design-preview";

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

const COMMENTS_RAIL_RE = /^Comments$/;
const COMMENTS_TOGGLE_RE = /comments rail$/;
const SESSION_COMMENTS_RAIL_RE = /^Session comments$/;
const APPROVER_RE = /approver/i;
const IN_PROGRESS_RE = /In progress/i;
const TABS = ["Artifact", "Sessions", "Details", "Activity"];

describe("DocumentDetailDesignPreview (ISS-12586)", () => {
  it("shows the shipped tabs and the document canvas with no sections under it", () => {
    render(<DocumentDetailDesignPreview />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      TABS
    );
    expect(
      screen.getByRole("button", { name: "Select version" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add comment" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "Fixture: Proposal" })
    ).toBeInTheDocument();
  });

  it("opens the canvas with the Issue page's toolbar: the text controls, always on, and the version", () => {
    render(<DocumentDetailDesignPreview />);
    const toolbar = screen.getByRole("region", { name: "Document toolbar" });
    expect(toolbar).toHaveClass("sticky");
    for (const name of ["Bold", "Heading 1", "Bullet List", "Link"]) {
      expect(within(toolbar).getByRole("button", { name })).toBeEnabled();
    }
    expect(
      within(toolbar).getByRole("button", { name: "Select version" })
    ).toBeInTheDocument();
    // No slug: the header names the document (Nerys, 2026-10-22).
    expect(
      within(toolbar).queryByText(DOCUMENT_DESIGN_ARTIFACT.slug)
    ).not.toBeInTheDocument();
    // Add comment is in the page header, just before the comments toggle;
    // the editor controls' own stays off.
    expect(
      within(toolbar).queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Comment" })).toBeNull();
    const addComment = screen.getByRole("button", { name: "Add comment" });
    expect(
      screen.getByRole("button", { name: COMMENTS_TOGGLE_RE }).parentElement
    ).toContainElement(addComment);
  });

  it("puts Add comment in the header on the Artifact tab only", async () => {
    const user = userEvent.setup();
    render(<DocumentDetailDesignPreview />);
    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(
      screen.getByRole("button", { name: COMMENTS_TOGGLE_RE })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
  });

  it("mounts the comments rail beside Artifact and Sessions only, as Branch does", async () => {
    const user = userEvent.setup();
    render(<DocumentDetailDesignPreview />);
    expect(
      screen.getByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Sessions" }));
    expect(
      screen.getByRole("complementary", { name: SESSION_COMMENTS_RAIL_RE })
    ).toBeInTheDocument();

    for (const tab of ["Details", "Activity"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.queryByRole("complementary", { name: COMMENTS_RAIL_RE })
      ).not.toBeInTheDocument();
    }
  });

  it("gives the Details tab Current version and no Document type or Approver (PRD-799)", () => {
    render(<DocumentDetailDesignPreview initialTab="details" />);
    expect(
      within(screen.getByRole("group", { name: "Slug" })).getByText("DOC-0042")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Current version" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Document type" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Approver" })
    ).not.toBeInTheDocument();
  });

  it("leaves the approver and the issue-only statuses out of the Document feed", () => {
    render(<DocumentDetailDesignPreview initialTab="activity" />);
    const feed = screen.getByRole("list", { name: "Activity" });
    expect(within(feed).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(within(feed).queryByText(APPROVER_RE)).not.toBeInTheDocument();
    expect(within(feed).queryByText(IN_PROGRESS_RE)).not.toBeInTheDocument();
  });
});
