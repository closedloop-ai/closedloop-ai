import { BranchCommentsState } from "@repo/api/src/types/branch";
import { BranchDetailTabParam } from "@repo/api/src/types/notification-routes";
import {
  BRANCH_DESIGN_ARTIFACT,
  BRANCH_DESIGN_DETAILS_INPUT,
} from "@repo/app/branches/components/detail-design/branch-detail-design-fixtures";
import {
  type BranchDesignTab,
  BranchDetailDesignPreview,
} from "@repo/app/branches/components/detail-design/branch-detail-design-preview";
import { ACTIVITY_QUERY_DATA } from "@repo/app/documents/components/artifact-activity/activity-catalog.fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, within } from "storybook/test";
import BranchDetailRoutePage from "@/app/(authenticated)/[orgSlug]/branches/[branchId]/page";
import { BranchDetailPageHeader } from "../composites-v2/v2-artifact-detail-page-header";
import {
  BRANCH_DETAIL_ID,
  branchCommentsFixture,
  branchDetailApiRoutes,
  branchDetailFixture,
  branchDetailRoutes,
} from "./fixtures/branch-detail-fixtures";
import { LivePage } from "./live-page";
import {
  expectActiveNavItem,
  LIVE_ORG_SLUG,
  withLiveRoute,
} from "./live-route";

// ISS-11361 Target sidebar, entry 5 of 62: Branch Detail (Four-tab artifact detail).
// The page is the PRD-751 Branch detail (ISS-10798): Patterns's
// artifact detail shell with the Branch tab set (Artifact / Sessions /
// Details / Activity, reordered by ISS-12167), filled with the Composites sections and fixture
// data, in the app frame. ISS-12412 builds its Details tab into the
// production page and ISS-12171 copies this pattern to the remaining artifact
// types; live Activity data is ISS-10980.
//
// The `Live` stories are the page the live app ships today
// (`apps/app/.../branches/[branchId]/page.tsx` over `BranchDetailPage`, with
// its Branch details and Sessions & timeline tabs), one per state it reaches
// from its reads or its `?tab=` param.

const BRANCH_PATH = `/${LIVE_ORG_SLUG}/branches/${BRANCH_DETAIL_ID}`;

const meta = {
  title: "Surfaces/Artifacts/Branches/Branch Detail",
  tags: ["stable"],
  decorators: [withLiveRoute],
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Artifact} />,
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
    liveRoute: { path: BRANCH_PATH, params: { branchId: BRANCH_DETAIL_ID } },
    appCore: { apiRoutes: branchDetailApiRoutes },
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

const COMMENTS_TOGGLE_RE = /comments rail$/;

/** The people and projects the PRD-751 page's Activity rows name. */
const design = {
  parameters: { appCore: { queryData: ACTIVITY_QUERY_DATA } },
} as const;

/** The PRD-751 page, opened on `tab`, in the app frame. */
function BranchDesignPage({ tab }: { tab: BranchDesignTab }) {
  return (
    <LivePage activePath="/branches">
      <BranchDetailDesignPreview
        initialTab={tab}
        pageHeader={BranchDetailPageHeader}
      />
    </LivePage>
  );
}

/** The page the live app ships today, in the same frame. */
const live = {
  render: () => (
    <LivePage activePath="/branches">
      <BranchDetailRoutePage />
    </LivePage>
  ),
} satisfies Partial<Story>;

const COMMENTS_RAIL = { name: "Comments" } as const;

/** `branchDetailApiRoutes` with one read answered differently. */
function withRead(
  path: string,
  respond: FixtureRoute["respond"],
  status?: number
) {
  return {
    appCore: {
      apiRoutes: [
        { method: "GET", path, respond, status },
        ...branchDetailApiRoutes,
      ] satisfies FixtureRoute[],
    },
  };
}

const SESSIONS_TAB_ROUTE = {
  path: `${BRANCH_PATH}?tab=${BranchDetailTabParam.SessionsTimeline}`,
  params: { branchId: BRANCH_DETAIL_ID },
};

function commentsIn(state: BranchCommentsState) {
  return {
    appCore: {
      apiRoutes: branchDetailRoutes(
        branchDetailFixture,
        branchCommentsFixture(state)
      ),
    },
  };
}

/**
 * The page on Artifact. Tab movement, by keyboard and by pointer: arrows
 * move along the labelled tab list, and the comments rail follows the
 * shell's per-tab rule.
 */
export const Default: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Artifact} />,
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

    const artifact = canvas.getByRole("tab", { name: "Artifact" });
    await expect(artifact).toHaveAttribute("aria-selected", "true");
    await expect(
      canvas.getByRole("complementary", COMMENTS_RAIL)
    ).toBeInTheDocument();

    await userEvent.click(artifact);
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Sessions" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();

    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Activity" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(canvas.getByRole("list", { name: "Activity" })).toBeVisible();
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();

    await userEvent.click(canvas.getByRole("tab", { name: "Artifact" }));
    await expect(artifact).toHaveAttribute("aria-selected", "true");
    await expect(
      canvas.getByRole("complementary", COMMENTS_RAIL)
    ).toBeInTheDocument();
    await expectActiveNavItem(canvasElement, "Branches");
    // The page header row: the breadcrumbs, with the comments toggle at its end.
    const pageHeader = canvas
      .getByRole("button", { name: COMMENTS_TOGGLE_RE })
      .closest("header");
    await expect(pageHeader).not.toBeNull();
    await expect(
      within(pageHeader as HTMLElement).getByRole("link", { name: "Branches" })
    ).toBeInTheDocument();
    // The tab row ends with the collaborators.
    // ISS-12273: the shared widget makes ONE accessibility statement — the
    // wrapper names every collaborator — so each name is asserted inside that
    // single label rather than on an avatar of its own.
    for (const name of BRANCH_DESIGN_ARTIFACT.collaborators) {
      await expect(
        canvas.getAllByRole("img", { name: new RegExp(name) }).length
      ).toBeGreaterThan(0);
    }
  },
};

/**
 * Opened on Details (ISS-12252, ISS-12403): Artifact details, Branch
 * details and Associated artifacts, for the branch the header names, with no
 * comments rail beside them.
 */
export const DetailsTab: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Details} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Details", selected: true })
    ).toBeInTheDocument();
    await expect(canvas.getByRole("group", { name: "Name" })).toHaveTextContent(
      BRANCH_DESIGN_DETAILS_INPUT.name
    );
    // The tab names the branch the page header names.
    await expect(
      canvas.getAllByText(BRANCH_DESIGN_DETAILS_INPUT.name).length
    ).toBeGreaterThanOrEqual(2);
    await expect(canvas.queryByRole("complementary", COMMENTS_RAIL)).toBeNull();
  },
};

/** The Details tab in the dark theme. */
export const DetailsTabDark: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Details} />,
  globals: { theme: "dark" },
};

/** Opened on Sessions: the sessions that worked the branch. */
export const SessionsTab: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Sessions} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("tab", { name: "Sessions", selected: true })
    ).toBeInTheDocument();
  },
};

/**
 * Opened on Activity: the Branch feed, newest first. Branches
 * store priority, project and tag changes; person, API-key ("Agent") rows,
 * no comments rail.
 */
export const ActivityTab: Story = {
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Activity} />,
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
  // The design preview, not the shipped page (ISS-12610: Experimental).
  tags: ["!stable", "experimental"],
  ...design,
  render: () => <BranchDesignPage tab={ArtifactDetailTab.Artifact} />,
  globals: { theme: "dark" },
};

/** The page the live app ships today. */
export const Live: Story = {
  ...live,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      (
        await canvas.findAllByText(
          branchDetailFixture.branchName,
          {},
          { timeout: 10_000 }
        )
      ).length
    ).toBeGreaterThan(0);
    await expectActiveNavItem(canvasElement, "Branches");
  },
};

/** The branch read is still in flight. */
export const LiveLoading: Story = {
  ...live,
  parameters: withRead(
    `/branches/${BRANCH_DETAIL_ID}`,
    () => new Promise(() => undefined)
  ),
};

/** The branch read failed. */
export const LiveErrorState: Story = {
  ...live,
  name: "Live Error",
  parameters: withRead(`/branches/${BRANCH_DETAIL_ID}`, () => null, 500),
};

/** The id names no branch in this workspace. */
export const LiveNotFound: Story = {
  ...live,
  parameters: withRead(`/branches/${BRANCH_DETAIL_ID}`, () => null, 404),
};

/** Opened on Sessions & timeline (`?tab=sessions-timeline`). */
export const LiveSessionsTab: Story = {
  ...live,
  parameters: { liveRoute: SESSIONS_TAB_ROUTE },
};

/** Sessions & timeline while the merged trace is still loading. */
export const LiveSessionsTabLoading: Story = {
  ...live,
  parameters: {
    liveRoute: SESSIONS_TAB_ROUTE,
    ...withRead(
      `/branches/${BRANCH_DETAIL_ID}/trace`,
      () => new Promise(() => undefined)
    ),
  },
};

/** Sessions & timeline for a branch no session has worked yet. */
export const LiveSessionsTabEmpty: Story = {
  ...live,
  parameters: {
    liveRoute: SESSIONS_TAB_ROUTE,
    appCore: {
      apiRoutes: branchDetailRoutes({ ...branchDetailFixture, sessions: [] }),
    },
  },
};

/** The PR's comments have never been synced. */
export const LiveCommentsUnsynced: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.UnsyncedUnknown),
};

/** GitHub could not be reached for the PR's comments. */
export const LiveCommentsProviderError: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.ProviderError),
};

/** Synced, and the PR has no comments. */
export const LiveCommentsSyncedEmpty: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.SyncedEmpty),
};

/** Some comments come from an older sync. */
export const LiveCommentsStaleMixed: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.StaleMixed),
};

/** More comments than the read returns. */
export const LiveCommentsOverLimit: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.OverLimitTruncated),
};

/** The comments belong to a pull request this viewer cannot read. */
export const LiveCommentsForbiddenMismatch: Story = {
  ...live,
  parameters: commentsIn(BranchCommentsState.ForbiddenMismatch),
};
