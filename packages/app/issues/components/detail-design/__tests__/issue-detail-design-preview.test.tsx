import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_TAGS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_TEXT_COMMENT,
  IssueDesignState,
  issueCommentHighlights,
} from "../issue-detail-design-fixtures";
import {
  ISSUE_EDIT_BAR_LABEL,
  IssueDesignRegion,
  IssueDetailDesignPreview,
} from "../issue-detail-design-preview";

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
// The status strip's data-bound leaves, as document-metadata-bar.test.tsx
// stubs them: the tag picker and attach button each own their own queries.
vi.mock("@repo/app/tags/components/tag-picker", () => ({
  TagPicker: ({ appliedTags }: { appliedTags: { name: string }[] }) => (
    <div>{appliedTags.map((tag) => tag.name).join(", ")}</div>
  ),
}));
vi.mock("@repo/app/documents/components/attach-files-button", () => ({
  AttachFilesButton: () => <button type="button">Attach files</button>,
}));
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
const SHOW_EVENTS_RE = /^Show \d+ events/;
const APPROVER_RE = /approver/i;
const IN_PROGRESS_RE = /In progress/i;
const STAND_IN_RE = /Stand-in/;
const ISSUE_CANVAS = "Issue";
const [TEXT_QUOTE] = issueCommentHighlights([ISSUE_DESIGN_TEXT_COMMENT]);
const COMMENT_ON_RE = /^Comment on/;
const DONE_RE = /\bDone\b/;
const IN_REVIEW_RE = /In review/i;
const EDITED_DOCUMENT_RE = /edited the document/;
const COMMENTS_TOGGLE_RE = /comments rail$/;
const OTHER_LINKS_RE = /Other links|External links|Deployments/;
const PROJECT_RE = /Fixture: Artifact detail pages/;
const SUB_ISSUE_OF_RE = /Sub-issue of/;
const EDITED_RE = /edited/i;
const VERSION_RE = /version/i;
const BODY_RE = /^Fixture: give the Issue Detail page/;
const BODY_QUOTE_RE = /Fixture: give the Issue Detail page/;
const TABS = ["Artifact", "Sessions", "Details", "Activity"];

/**
 * The page under the real flag seam, with artifact tags on.
 */
function renderPreview(
  props: {
    initialEditing?: boolean;
    initialTab?: "artifact" | "sessions" | "details" | "activity";
    state?: IssueDesignState;
  } = {}
) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_TAGS_FEATURE_FLAG_KEY],
      })}
    >
      <IssueDetailDesignPreview {...props} />
    </FeatureFlagAdapterProvider>
  );
}

describe("IssueDetailDesignPreview (ISS-12586)", () => {
  it("stacks the toolbar, the issue, Sub-issues, Branch and Activity summary, in that order (Ottilie, 2026-10-21)", () => {
    renderPreview();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(
      TABS
    );
    const canvas = screen.getByRole("region", { name: ISSUE_CANVAS });
    const article = within(canvas).getByRole("article", {
      name: ISSUE_DESIGN_ARTIFACT.title,
    });
    const [toolbar, ...sections] = Object.values(IssueDesignRegion).map(
      (name) => within(canvas).getByRole("region", { name })
    );
    // Top to bottom, in document order.
    const all = [...canvas.querySelectorAll("*")];
    const order = [toolbar, article, ...sections].map((node) =>
      all.indexOf(node as Element)
    );
    expect(order).not.toContain(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Each block under its own heading.
    for (const name of ["Sub-issues", "Branch", "Activity summary"]) {
      expect(
        within(canvas).getByRole("heading", { level: 3, name })
      ).toBeInTheDocument();
    }
    expect(screen.queryByText(STAND_IN_RE)).not.toBeInTheDocument();
  });

  it("leaves sessions, documents and other links off the canvas", () => {
    renderPreview();
    const canvas = screen.getByRole("region", { name: ISSUE_CANVAS });
    expect(within(canvas).queryByText(OTHER_LINKS_RE)).not.toBeInTheDocument();
    expect(
      within(canvas).queryByRole("heading", { name: "Sessions" })
    ).not.toBeInTheDocument();
    expect(
      within(canvas).queryByRole("heading", { name: "Documents" })
    ).not.toBeInTheDocument();
  });

  it("puts the slug and key fields in a toolbar at the top of the canvas, not the page header (Ottilie, 2026-10-21)", () => {
    renderPreview();
    const toolbar = screen.getByRole("region", {
      name: IssueDesignRegion.Toolbar,
    });
    expect(screen.getByRole("tabpanel")).toContainElement(toolbar);
    expect(toolbar).toHaveClass("sticky");
    // The slug leads; project, milestone and tags are on Details (Nerys,
    // 2026-10-21), even with the artifact tags flag on.
    expect(toolbar.textContent?.startsWith("ISS-0005")).toBe(true);
    expect(toolbar).toHaveTextContent("Due date");
    // The slug carries the issue icon its sub-issue rows carry, and the slug
    // and due date are bordered like the controls beside them (Nerys,
    // 2026-10-22).
    const slugField = within(toolbar).getByText("ISS-0005").parentElement;
    expect(slugField).toHaveClass("border");
    expect(slugField?.querySelector("svg")).not.toBeNull();
    expect(within(toolbar).getByText("Due date").parentElement).toHaveClass(
      "border"
    );
    expect(toolbar).not.toHaveTextContent(PROJECT_RE);
    expect(
      within(toolbar).queryByRole("button", { name: "Add tag" })
    ).not.toBeInTheDocument();
    // The type badge stays off: the page already is an issue (PRD-799 G-01).
    expect(within(toolbar).queryByText("Feature")).not.toBeInTheDocument();
    // Add comment is in the page header, just before the comments toggle;
    // the toolbar's right end is kept for Publish (Nerys, 2026-10-22).
    expect(
      within(toolbar).queryByRole("button", { name: "Add comment" })
    ).not.toBeInTheDocument();
    const addComment = screen.getByRole("button", { name: "Add comment" });
    const toggle = screen.getByRole("button", { name: COMMENTS_TOGGLE_RE });
    expect(toggle.parentElement).toContainElement(addComment);
    expect(addComment.compareDocumentPosition(toggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it("shows the edit bar under the toolbar once the issue's text is clicked, and keeps it", async () => {
    const user = userEvent.setup();
    renderPreview();
    expect(
      screen.queryByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("heading", {
        level: 2,
        name: ISSUE_DESIGN_ARTIFACT.title,
      })
    );
    const editBar = screen.getByRole("toolbar", {
      name: ISSUE_EDIT_BAR_LABEL,
    });
    // Under the toolbar, inside its sticky region, so both stay on top.
    expect(
      screen.getByRole("region", { name: IssueDesignRegion.Toolbar })
    ).toContainElement(editBar);
    expect(within(editBar).getByRole("button", { name: "Bold" })).toBeEnabled();
    // Editing stays on for the visit, as the live editor's does.
    await user.click(screen.getByRole("heading", { name: "Branch" }));
    expect(
      screen.getByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).toBeInTheDocument();
  });

  it("opens already editing when asked", () => {
    renderPreview({ initialEditing: true });
    expect(
      screen.getByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).toBeInTheDocument();
  });

  it("offers no Add comment where the comments rail is not mounted (1024px and below)", () => {
    const narrow = vi.spyOn(globalThis.window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList
    );
    try {
      renderPreview();
      expect(
        screen.getByRole("region", { name: IssueDesignRegion.Toolbar })
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add comment" })
      ).not.toBeInTheDocument();
    } finally {
      narrow.mockRestore();
    }
  });

  it("shows the toolbar on the Artifact tab only", async () => {
    const user = userEvent.setup();
    renderPreview();
    for (const tab of ["Sessions", "Details", "Activity"]) {
      await user.click(screen.getByRole("tab", { name: tab }));
      expect(
        screen.queryByRole("region", { name: IssueDesignRegion.Toolbar })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add comment" })
      ).not.toBeInTheDocument();
    }
  });

  it("lists the sub-issues under their own heading, with no edited marker or version", () => {
    renderPreview();
    const canvas = screen.getByRole("region", { name: ISSUE_CANVAS });
    const article = within(canvas).getByRole("article", {
      name: ISSUE_DESIGN_ARTIFACT.title,
    });
    const subIssues = within(canvas).getByRole("region", {
      name: IssueDesignRegion.SubIssues,
    });
    expect(within(subIssues).getByText("ISS-0006")).toBeInTheDocument();
    // The heading says how they relate: no Relationship column to fill.
    expect(
      within(subIssues).queryByText("Relationship")
    ).not.toBeInTheDocument();
    expect(within(canvas).queryByText(SUB_ISSUE_OF_RE)).not.toBeInTheDocument();
    // Issues have no versions; history, body edits included, is on the
    // Activity tab (Q2; Ottilie, 2026-10-21).
    expect(within(article).queryByText(EDITED_RE)).not.toBeInTheDocument();
    expect(within(canvas).queryByText(VERSION_RE)).not.toBeInTheDocument();
    expect(
      within(canvas).queryByRole("combobox", { name: VERSION_RE })
    ).not.toBeInTheDocument();
  });

  it("names the parent above the title on a sub-issue", () => {
    renderPreview({ state: IssueDesignState.SubIssue });
    const article = within(
      screen.getByRole("region", { name: ISSUE_CANVAS })
    ).getByRole("article", { name: ISSUE_DESIGN_ARTIFACT.title });
    const parent = within(article).getByText(SUB_ISSUE_OF_RE);
    const title = within(article).getByRole("heading", { level: 2 });
    // Siblings, parent first.
    expect(parent.compareDocumentPosition(title)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
    expect(within(article).getByRole("link")).toHaveAttribute(
      "href",
      "/issues/ISS-0004"
    );
  });

  it.each([
    [IssueDesignState.ImportedFromGitHub, "Synced with GitHub"],
    [IssueDesignState.ImportedFromLinear, "Synced with Linear"],
  ])("says where an imported issue syncs from (%s)", (state, label) => {
    renderPreview({ state });
    expect(
      within(screen.getByRole("region", { name: ISSUE_CANVAS })).getByText(
        label
      )
    ).toBeInTheDocument();
  });

  it("shows a new issue with no owner, no branch and one event", () => {
    renderPreview({ state: IssueDesignState.New });
    const branch = screen.getByRole("region", {
      name: IssueDesignRegion.Branch,
    });
    expect(within(branch).getByText("No branch yet")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: IssueDesignRegion.SubIssues })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: SHOW_EVENTS_RE })
    ).not.toBeInTheDocument();
  });

  it("heads the section Branches when there is more than one", () => {
    renderPreview({ state: IssueDesignState.SeveralBranches });
    const branch = screen.getByRole("region", {
      name: IssueDesignRegion.Branch,
    });
    expect(
      within(branch).getByRole("heading", { level: 3, name: "Branches" })
    ).toBeInTheDocument();
  });

  it("highlights the passage a text-anchored comment quotes, and nothing for a comment on the whole issue (Ottilie, 2026-10-21)", () => {
    const { unmount } = renderPreview({
      state: IssueDesignState.TextComment,
    });
    const marks = document.querySelectorAll("[data-issue-body] mark");
    expect([...marks].map((mark) => mark.textContent)).toEqual([TEXT_QUOTE]);
    unmount();
    renderPreview({ state: IssueDesignState.IssueComment });
    expect(document.querySelector("[data-issue-body] mark")).toBeNull();
  });

  it("marks a future-state Other links section of plain-text addresses", () => {
    renderPreview({ state: IssueDesignState.FutureOtherLinks });
    const section = screen.getByRole("region", { name: "Other links" });
    expect(within(section).getByText("Future state")).toBeInTheDocument();
    expect(within(section).queryByRole("link")).not.toBeInTheDocument();
  });

  it("tells an issue's own history: issue statuses, no document versions", () => {
    renderPreview({ state: IssueDesignState.New });
    const brief = screen.getByRole("region", {
      name: IssueDesignRegion.ActivitySummary,
    });
    expect(brief).toHaveTextContent("created this issue");
    expect(brief).toHaveTextContent("Triage");
    expect(brief).not.toHaveTextContent("Draft");
  });

  it("ends the brief on the move to Done, with no version rows", () => {
    renderPreview();
    const brief = screen.getByRole("region", {
      name: IssueDesignRegion.ActivitySummary,
    });
    expect(brief).not.toHaveTextContent(EDITED_DOCUMENT_RE);
    const lists = within(brief).getAllByRole("list", { name: "Activity" });
    expect(lists.at(-1)).toHaveTextContent("Done");
  });

  it.each([
    [IssueDesignState.InProgressNoBranch, IN_PROGRESS_RE],
    [IssueDesignState.OneBranch, IN_REVIEW_RE],
    [IssueDesignState.SubIssue, IN_REVIEW_RE],
  ])(
    "ends the %s brief on its own status, as the toolbar shows it",
    (state, label) => {
      renderPreview({ state });
      const brief = screen.getByRole("region", {
        name: IssueDesignRegion.ActivitySummary,
      });
      const last = within(brief)
        .getAllByRole("list", { name: "Activity" })
        .at(-1);
      expect(last).toHaveTextContent(label);
      expect(brief).not.toHaveTextContent(DONE_RE);
    }
  );

  it("comments on the selected body text in the rail, and highlights it (ISS-12570 Q3)", async () => {
    const user = userEvent.setup();
    renderPreview({ state: IssueDesignState.IssueComment });
    const article = within(
      screen.getByRole("region", { name: ISSUE_CANVAS })
    ).getByRole("article", { name: ISSUE_DESIGN_ARTIFACT.title });
    const paragraph = within(article).getByText(BODY_RE);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    globalThis.getSelection()?.removeAllRanges();
    globalThis.getSelection()?.addRange(range);
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    const rail = screen.getByRole("complementary", { name: COMMENTS_RAIL_RE });
    expect(within(rail).getAllByText(BODY_QUOTE_RE).length).toBeGreaterThan(0);
    await user.type(
      within(rail).getByRole("textbox", { name: COMMENT_ON_RE }),
      "Fixture: a quoted comment"
    );
    await user.click(within(rail).getByRole("button", { name: "Comment" }));
    expect(
      document.querySelector("[data-issue-body] mark")?.textContent
    ).toMatch(BODY_QUOTE_RE);
  });

  it("does not bring a posted quote back after a trip to another tab", async () => {
    const user = userEvent.setup();
    renderPreview();
    const article = within(
      screen.getByRole("region", { name: ISSUE_CANVAS })
    ).getByRole("article", { name: ISSUE_DESIGN_ARTIFACT.title });
    const range = document.createRange();
    range.selectNodeContents(within(article).getByText(BODY_RE));
    globalThis.getSelection()?.removeAllRanges();
    globalThis.getSelection()?.addRange(range);
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    const rail = () =>
      screen.getByRole("complementary", { name: COMMENTS_RAIL_RE });
    await user.type(
      within(rail()).getByRole("textbox", { name: COMMENT_ON_RE }),
      "Fixture: a quoted comment"
    );
    await user.click(within(rail()).getByRole("button", { name: "Comment" }));
    const quoted = within(rail()).getAllByText(BODY_QUOTE_RE).length;

    await user.click(screen.getByRole("tab", { name: "Details" }));
    await user.click(screen.getByRole("tab", { name: "Artifact" }));

    // The posted thread is still there, and no new draft quotes it again.
    expect(within(rail()).getAllByText(BODY_QUOTE_RE)).toHaveLength(quoted);
    expect(
      within(rail()).getAllByText("Fixture: a quoted comment")
    ).toHaveLength(1);
    expect(
      within(rail()).queryByRole("textbox", { name: COMMENT_ON_RE })
    ).not.toBeInTheDocument();
  });

  it("opens the Activity tab from the brief's fold row", async () => {
    const user = userEvent.setup();
    renderPreview();
    const [fold] = screen.getAllByRole("button", { name: SHOW_EVENTS_RE });
    if (fold === undefined) {
      throw new Error("no fold row in the Activity brief");
    }
    await user.click(fold);
    expect(screen.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(
      screen.queryByRole("complementary", { name: COMMENTS_RAIL_RE })
    ).not.toBeInTheDocument();
  });

  it("keeps the delivery statuses in the feed but no approver, as Details has none", () => {
    renderPreview({ initialTab: "activity" });
    const feed = screen.getByRole("list", { name: "Activity" });
    expect(within(feed).getAllByText(IN_PROGRESS_RE).length).toBeGreaterThan(0);
    expect(within(feed).queryByText(APPROVER_RE)).not.toBeInTheDocument();
  });

  it("draws the Issue details group on the Details tab", () => {
    renderPreview({ initialTab: "details" });
    expect(
      screen.getByRole("heading", { level: 2, name: "Issue details" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Linked branch" })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("group", { name: "Slug" })).getByText("ISS-0005")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Approver" })
    ).not.toBeInTheDocument();
  });
});
