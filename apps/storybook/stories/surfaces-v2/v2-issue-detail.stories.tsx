import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import type { DocumentDesignTab } from "@repo/app/documents/components/detail-design/document-detail-design-shell";
import {
  ISSUE_DESIGN_ARTIFACT,
  ISSUE_DESIGN_TEXT_COMMENT,
  IssueDesignState,
  issueCommentHighlights,
} from "@repo/app/issues/components/detail-design/issue-detail-design-fixtures";
import {
  ISSUE_EDIT_BAR_LABEL,
  IssueDesignRegion,
  IssueDetailDesignPreview,
} from "@repo/app/issues/components/detail-design/issue-detail-design-preview";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import { DocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/documents/[slug]/document-editor-container";
import { IssueDetailPageHeader } from "../composites-v2/v2-artifact-detail-page-header";
import { DocumentRoutePage, documentRoute } from "./document-route-page";
import {
  artifactLinksFixture,
  documentDetailRoutes,
  issueDetailFixture,
  olderVersionOf,
  pendingBySlugRoute,
} from "./fixtures/document-detail-fixtures";
import { LivePage } from "./live-page";
import { withLiveRoute } from "./live-route";

// ISS-11361 Target sidebar, entry 45 of 62: Issue Detail (Document editor).
// Default, the state stories and the tab stories are the full PRD-751 Issue
// detail page (ISS-12576, DI-07): the artifact detail shell with the shipped
// tab set (Artifact / Sessions / Details / Activity), filled with the
// Composites sections under Labs/Issues/Issue Detail and fixture data, in the
// app frame, as Branch and Session Detail are. As Ottilie and Nerys settled it
// on 2026-10-21: the Artifact tab's canvas opens with a toolbar (the issue's
// slug with the issue icon and its key fields, DI-08; the same toolbar the
// Document page has, its right end kept for Publish, Nerys 2026-10-22)
// that stays at its top while the issue scrolls; then the issue's text
// (DI-07), Sub-issues, Branch (DI-10) and Activity summary (DI-09), each
// under its own heading. A click on the issue's text starts editing, as in
// the live document editor: the text controls show in an edit bar under the
// toolbar. The toolbar is on the Artifact tab only. The page header holds
// what every artifact's holds, with Add comment just before the comments
// toggle on the Artifact tab. Every comment is in the rail: on a passage of the body, which
// the body highlights, or on the issue as a whole. Issues have no versions.
// Each state story is one of DI-07's states.
//
// Still open, so kept as they are: the person field's label (DI-03 ruling 1,
// ISS-12572), the branch's description and Storybook preview ("Data pending",
// ISS-12580), the comments rail chrome and collaborators (no change for now,
// Ottilie 2026-10-21; C5 on ISS-12571).
//
// The `Live` stories are the page the live app ships today
// (`apps/app/.../[orgSlug]/documents/[slug]/page.tsx`: `DocumentEditorContainer`)
// in the app frame: the header, the metadata bar, the editor and the
// sections under it. Each is one state the page reaches from its reads or its
// `?version=`. Before 2.0.31 they were Default, Loading, No Plan Yet and
// Historical Version.
//
// The editor's Liveblocks room is replaced by the room-less branch
// (.storybook/collaboration-room-utils-mock.ts), so presence, anchored
// comments and the feed rail are not shown.

const meta = {
  title: "Surfaces/Labs/Issues/Issue Detail",
  tags: ["preview"],
  decorators: [withLiveRoute],
  render: () => <IssueDesignPage tab={ArtifactDetailTab.Artifact} />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: documentRoute("issues", issueDetailFixture.slug),
    appCore: { apiRoutes: documentDetailRoutes(issueDetailFixture) },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const COMMENTS_RAIL = { name: "Comments" } as const;
const PAGE_TITLE = `${ISSUE_DESIGN_ARTIFACT.slug} ${ISSUE_DESIGN_ARTIFACT.title}`;
const SHOW_EVENTS_RE = /^Show \d+ events/;
const TOOLBAR = IssueDesignRegion.Toolbar;
const [QUOTE] = issueCommentHighlights([ISSUE_DESIGN_TEXT_COMMENT]);

/** The people and projects the PRD-751 page's Activity rows name. */
const design = {
  parameters: {
    appCore: {
      queryData: ACTIVITY_QUERY_DATA,
      apiRoutes: documentDetailRoutes(issueDetailFixture),
    },
  },
} as const;

/** The PRD-751 page, opened on `tab` in `state`, in the app frame. */
function IssueDesignPage({
  state,
  tab,
}: {
  state?: IssueDesignState;
  tab: DocumentDesignTab;
}) {
  return (
    <LivePage activePath="/issues">
      <IssueDetailDesignPreview
        initialTab={tab}
        pageHeader={IssueDetailPageHeader}
        state={state}
      />
    </LivePage>
  );
}

/** The page the live app ships today, in the document route's frame. */
const live = {
  render: () => (
    <DocumentRoutePage
      activePath="/issues"
      container={DocumentEditorContainer}
      slug={issueDetailFixture.slug}
    />
  ),
} satisfies Partial<Story>;

/**
 * A finished issue on Artifact: the canvas toolbar, the issue, its
 * sub-issues, the merged branch and the activity summary, with the comments
 * rail beside them: a comment on a passage of the body (highlighted), one on
 * the whole issue, and a resolved one. The activity summary's "Show N events"
 * row opens the Activity tab.
 */
export const Default: Story = {
  ...design,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tablist = canvas.getByRole("tablist", {
      name: "Artifact detail sections",
    });
    await expect(
      within(tablist)
        .getAllByRole("tab")
        .map((tab) => tab.textContent)
    ).toEqual(["Artifact", "Sessions", "Details", "Activity"]);
    await expect(
      canvas.getByRole("heading", { level: 1, name: PAGE_TITLE })
    ).toBeInTheDocument();
    for (const region of Object.values(IssueDesignRegion)) {
      await expect(canvas.getByRole("region", { name: region })).toBeVisible();
    }
    // Add comment is in the page header, just before the comments toggle.
    await expect(
      within(canvas.getByRole("region", { name: TOOLBAR })).queryByRole(
        "button",
        { name: "Add comment" }
      )
    ).toBeNull();
    await expect(
      canvas.getByRole("button", { name: "Add comment" })
    ).toBeVisible();
    await expect(canvasElement.querySelector("mark")?.textContent).toBe(QUOTE);
    await expect(
      canvas.getByRole("complementary", COMMENTS_RAIL)
    ).toBeInTheDocument();

    const [fold] = canvas.getAllByRole("button", { name: SHOW_EVENTS_RE });
    if (fold === undefined) {
      throw new Error("no fold row in the Activity brief");
    }
    await userEvent.click(fold);
    await expect(
      canvas.getByRole("tab", { name: "Activity", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
    await expect(canvas.queryByRole("region", { name: TOOLBAR })).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Artifact" }));
  },
};

/** A state of the issue, on Artifact. */
function stateStory(state: IssueDesignState): Story {
  return {
    ...design,
    render: () => (
      <IssueDesignPage state={state} tab={ArtifactDetailTab.Artifact} />
    ),
  };
}

/**
 * Editing the issue's text: a click on the text shows the edit bar (the live
 * editor's text controls) under the toolbar, and it stays for the visit.
 */
export const Editing: Story = {
  ...design,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.queryByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL })
    ).toBeNull();
    await userEvent.click(
      canvas.getByRole("heading", {
        level: 2,
        name: ISSUE_DESIGN_ARTIFACT.title,
      })
    );
    const editBar = canvas.getByRole("toolbar", { name: ISSUE_EDIT_BAR_LABEL });
    await expect(editBar).toBeVisible();
    await expect(
      canvas.getByRole("region", { name: TOOLBAR })
    ).toContainElement(editBar);
  },
};

/** Just filed: no owner, no branch, no sub-issues, one event, no comments. */
export const New: Story = {
  ...stateStory(IssueDesignState.New),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No branch yet")).toBeVisible();
  },
};

/** Picked up, with nothing pushed yet. */
export const InProgressNoBranch: Story = stateStory(
  IssueDesignState.InProgressNoBranch
);

/** One branch, its pull request in review. */
export const OneBranch: Story = stateStory(IssueDesignState.OneBranch);

/** Its own branch and a branch on one of its sub-issues. */
export const SeveralBranches: Story = stateStory(
  IssueDesignState.SeveralBranches
);

/**
 * Closed as done while its only pull request closed without merging, as on
 * GitHub #112 (DOC-47): the branch says so beside the Done status.
 */
export const ClosedNotMerged: Story = stateStory(
  IssueDesignState.ClosedNotMerged
);

/** A sub-issue: its parent above the title. */
export const SubIssue: Story = {
  ...stateStory(IssueDesignState.SubIssue),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Sub-issue of", { exact: false })
    ).toBeVisible();
  },
};

/** Came from GitHub: synced, its GitHub comments in the rail. */
export const ImportedFromGitHub: Story = {
  name: "Imported From GitHub",
  ...stateStory(IssueDesignState.ImportedFromGitHub),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Synced with GitHub")[0]).toBeVisible();
  },
};

/** Came from Linear: synced, its Linear comments in the rail. */
export const ImportedFromLinear: Story = {
  ...stateStory(IssueDesignState.ImportedFromLinear),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Synced with Linear")[0]).toBeVisible();
  },
};

/**
 * One comment, on a passage of the body: the passage is highlighted, and the
 * thread in the rail quotes it.
 */
export const TextComment: Story = {
  ...stateStory(IssueDesignState.TextComment),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("mark")?.textContent).toBe(QUOTE);
  },
};

/** One comment, on the issue as a whole: nothing in the body is marked. */
export const IssueComment: Story = {
  ...stateStory(IssueDesignState.IssueComment),
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("mark")).toBeNull();
  },
};

/** Both kinds of comment in the rail together, and a resolved one. */
export const BothCommentTypes: Story = stateStory(IssueDesignState.Default);

/**
 * Future state, not part of the current design: prototype and Storybook
 * addresses as plain text under Other links, until they have an artifact
 * type (Ottilie, 2026-10-21).
 */
export const FutureOtherLinks: Story = {
  ...stateStory(IssueDesignState.FutureOtherLinks),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Future state")).toBeVisible();
  },
};

/** Opened on Sessions: the sessions that wrote to or commented on it. */
export const SessionsTab: Story = {
  ...design,
  render: () => <IssueDesignPage tab={ArtifactDetailTab.Sessions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Sessions", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: TOOLBAR })).toBeNull();
    // Beside Sessions the rail holds the session comments, as on Branch.
    await expect(
      canvas.getByRole("complementary", { name: "Session comments" })
    ).toBeInTheDocument();
  },
};

/**
 * Opened on Details: Artifact details, then Issue details (status, closed
 * reason, parent issue, sub-issues, linked branch, external links), Custom
 * fields and Associated artifacts. No comments rail.
 */
export const DetailsTab: Story = {
  ...design,
  render: () => <IssueDesignPage tab={ArtifactDetailTab.Details} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: true })
    ).toBeInTheDocument();
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Issue details" })
    ).toBeVisible();
    await expect(canvas.queryByRole("region", { name: TOOLBAR })).toBeNull();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
  },
};

/** Opened on Activity: the Issue feed, newest first. No comments rail. */
export const ActivityTab: Story = {
  ...design,
  render: () => <IssueDesignPage tab={ArtifactDetailTab.Activity} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Activity", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByRole("list", { name: "Activity" })).toBeVisible();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
  },
};

/** The page in the dark theme. */
export const Dark: Story = {
  ...design,
  globals: { theme: "dark" },
};

/** The page the live app ships today. */
export const Live: Story = {
  ...live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The full jsdom sweep can hold a second matching heading, so any one
    // visible title is enough.
    const titles = await canvas.findAllByRole(
      "heading",
      { level: 1, name: issueDetailFixture.title },
      { timeout: 10_000 }
    );
    await expect(titles[0]).toBeVisible();
  },
};

/** The artifact read is still in flight. */
export const LiveLoading: Story = {
  ...live,
  parameters: {
    appCore: {
      apiRoutes: [
        pendingBySlugRoute(issueDetailFixture),
        ...documentDetailRoutes(issueDetailFixture),
      ],
    },
  },
};

/** No plan has been made for the issue yet. */
export const LiveNoPlanYet: Story = {
  ...live,
  parameters: {
    appCore: {
      apiRoutes: documentDetailRoutes(issueDetailFixture, {
        links: artifactLinksFixture,
      }),
    },
  },
};

/** An earlier version, opened from the version history (`?version=1`). */
export const LiveHistoricalVersion: Story = {
  ...live,
  parameters: {
    liveRoute: documentRoute("issues", issueDetailFixture.slug, 1),
    appCore: {
      apiRoutes: documentDetailRoutes(issueDetailFixture, {
        versions: {
          1: olderVersionOf(
            issueDetailFixture,
            1,
            "# Wire session lanes into the branch trace\n\n## Context\nShow every session on a branch.\n"
          ),
        },
      }),
    },
  },
};
