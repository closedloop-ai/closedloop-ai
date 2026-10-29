import { DocumentType } from "@repo/api/src/types/document";
import { ActivityArtifactKind } from "@repo/app/documents/components/feed-sidebar/sources/activity-card";
import { ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS } from "@repo/app/shared/components/artifact-detail-shell/artifact-detail-shell";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  ACTIVITY_FIXTURE_LINKS,
  ACTIVITY_FIXTURE_NOW,
  ACTIVITY_QUERY_DATA,
  activityQueryDataWithPhotos,
  EMILY,
  JAKE,
  newestFirst,
  RYAN,
} from "./activity-catalog.fixtures";
import {
  BRANCH_EXAMPLE_ROWS,
  DOCUMENT_EXAMPLE_ROWS,
  SESSION_EXAMPLE_ROWS,
  SINGLE_ACTOR_ROWS,
  SYSTEM_AND_AGENT_ROWS,
} from "./activity-example-timelines.fixtures";
import { ActivityTimeline } from "./activity-timeline";

/**
 * The Activity tab body (ISS-12117, ISS-12330): one continuous timeline,
 * newest first, each row read who, what, when: the actor's avatar on a 2px
 * zinc-100 line (a person's photo or initials, the cog for System, the robot
 * for an agent), the name, the action, then the exact time. It is an
 * audit trail, not an action surface: no filters, no sort control, no
 * grouping, one action per row, and comments are read-only boxes that link to
 * the comment. "Load more" is a plain button at the end and appends older
 * rows. GitHub's pull-request timeline is the inspiration; every surface here
 * is a design-system token.
 *
 * Engineering handoff: wire `GET /documents/[id]/activity` plus Liveblocks
 * comments for Documents; the Session and Branch endpoints arrive with PR
 * #8368. Page with the API's opaque `nextCursor`, passed unchanged, stopping
 * only at null (limit 50 by default, 100 max). `transactionId` is not in feed
 * items, so an undo cannot be labelled yet.
 *
 * Controls table:
 * | Prop | Control | Why |
 * |---|---|---|
 * | loading | boolean | swaps the feed for its skeleton rows |
 * | error | boolean | the first load failed: error with retry, never an empty history |
 * | hasMore | boolean | older pages exist: the feed ends in "Load more" |
 * | loadingMore | boolean | the next page is in flight |
 * | loadMoreError | boolean | partial: rows stay, the failed next page shows its own retry |
 * | artifactKind | select | whose feed; a Session words statuses and moves its own way |
 * | documentType | select | the "created this …" noun and the status vocabulary |
 * | onRetry, onLoadMore | action | callbacks, logged in the Actions panel |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | rows | the example timelines; each story picks its own |
 * | links | host-supplied links (version, run, report, related artifact), fixed fixtures |
 * | now | pinned to the fixtures' clock so relative times are deterministic |
 * | className | layout passthrough for the host |
 */
const meta = {
  title: "Composites/Shared/Activity/Activity Timeline",
  component: ActivityTimeline,
  tags: ["stable", "autodocs"],
  parameters: {
    layout: "padded",
    appCore: { queryData: ACTIVITY_QUERY_DATA },
  },
  argTypes: {
    loading: { control: "boolean" },
    error: { control: "boolean" },
    hasMore: { control: "boolean" },
    loadingMore: { control: "boolean" },
    loadMoreError: { control: "boolean" },
    onRetry: { action: "retry" },
    onLoadMore: { action: "loadMore" },
    artifactKind: {
      control: "select",
      options: Object.values(ActivityArtifactKind),
    },
    documentType: { control: "select", options: Object.values(DocumentType) },
    rows: { control: false },
    links: { control: false },
    now: { control: false },
    className: { control: false },
  },
  args: {
    rows: newestFirst(DOCUMENT_EXAMPLE_ROWS),
    loading: false,
    error: false,
    hasMore: false,
    loadingMore: false,
    loadMoreError: false,
    onRetry: fn(),
    onLoadMore: fn(),
    artifactKind: ActivityArtifactKind.Document,
    documentType: DocumentType.Feature,
    links: ACTIVITY_FIXTURE_LINKS,
    now: ACTIVITY_FIXTURE_NOW,
    // The tab's content width: every artifact detail tab shares it.
    className: ARTIFACT_DETAIL_CONTENT_WIDTH_CLASS,
  },
} satisfies Meta<typeof ActivityTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Document "ISS-1234 Activity tab V1": three weeks of edits, comments, an
 * agent's status change (API), System rows and bulk writes, newest
 * first. Every row is a capture-report row (C01–C20, C25) or projection.
 */
export const Document: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Activity" });
    const rows = within(list).getAllByRole("listitem");
    await expect(rows).toHaveLength(DOCUMENT_EXAMPLE_ROWS.length);
    // Newest first: Emily's reassignment leads, the creation closes the list.
    await expect(rows[0]).toHaveTextContent("reassigned from Jake Morrison");
    await expect(rows.at(-1)).toHaveTextContent("created this issue");
    // One agent row, the API-key status change (C02), with the robot on the
    // line; three System rows with the cog.
    await expect(canvas.getAllByText("API", { exact: true })).toHaveLength(1);
    await expect(list.querySelectorAll("svg.lucide-bot")).toHaveLength(1);
    await expect(list.querySelectorAll("svg.lucide-cog")).toHaveLength(3);
    await expect(
      canvas.getAllByRole("link", { name: "View comment" })
    ).toHaveLength(2);
  },
};

/** First page in flight: skeleton rows on the line. */
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("status", { name: "Loading activity" })
    ).toHaveAttribute("aria-busy", "true");
  },
};

/** The next page is in flight: a skeleton row where it will land. */
export const LoadingMore: Story = {
  name: "Loading More",
  args: {
    rows: newestFirst(SESSION_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Session,
    hasMore: true,
    loadingMore: true,
  },
};

/** Nothing has happened to the artifact yet. */
export const Empty: Story = {
  args: { rows: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("No activity yet")).toBeVisible();
    await expect(
      canvas.getByText("Edits and comments on this artifact will appear here.")
    ).toBeVisible();
    await expect(canvas.queryByRole("list")).toBeNull();
  },
};

/** The first load failed: an error with retry, not an empty history. */
export const ErrorState: Story = {
  name: "Error",
  args: { error: true },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Couldn't load activity")).toBeVisible();
    await expect(canvas.queryByText("No activity yet")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/**
 * Older pages exist: the list ends in "Load more", reachable by keyboard, and
 * a click asks the host for the next page.
 */
export const HasMore: Story = {
  name: "Has More",
  args: {
    rows: newestFirst(SESSION_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Session,
    hasMore: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Load more" });
    button.focus();
    await expect(button).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onLoadMore).toHaveBeenCalledTimes(1);
  },
};

/**
 * Partial: the loaded rows are real and stay; the next page failed and shows
 * its own retry where it would have landed.
 */
export const LoadMoreFailed: Story = {
  name: "Load More Failed",
  args: {
    rows: newestFirst(SESSION_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Session,
    hasMore: true,
    loadMoreError: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Couldn't load more activity")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }));
    await expect(args.onLoadMore).toHaveBeenCalledTimes(1);
  },
};

/**
 * One person's continuous run. V1 shows one action per row, so repeated rows
 * from the same person are expected; collapsing them is a V2 question (see
 * Future (Not For Build)).
 */
export const SingleActorRepeating: Story = {
  name: "Single Actor Repeating",
  args: { rows: newestFirst(SINGLE_ACTOR_ROWS) },
};

/**
 * Session "Refactor auth middleware": desktop sync (System), people, an
 * agent's priority change (C16, API), bulk writes and the stale-session
 * reaper. The retained-evidence rows (C30, C31) are not here: the Session
 * feed excludes them.
 */
export const Session: Story = {
  args: {
    rows: newestFirst(SESSION_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Session,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Activity" });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(
      SESSION_EXAMPLE_ROWS.length
    );
    // Session statuses read in the Session words, never the stored value.
    await expect(canvas.getAllByText("Inactive").length).toBeGreaterThan(0);
    await expect(canvas.queryByText("inactive")).toBeNull();
  },
};

/**
 * Branch "feature/auth-refactor": tags (C28, C29, C25), priority by a person
 * and an agent (C17), a batch move (C20) and a comment. No PR, CI or commit
 * rows: the Branch feed does not return them.
 */
export const Branch: Story = {
  args: {
    rows: newestFirst(BRANCH_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Branch,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Activity" });
    await expect(within(list).getAllByRole("listitem")).toHaveLength(
      BRANCH_EXAMPLE_ROWS.length
    );
  },
};

/**
 * The Document timeline where every person has a photo (the repo's seed
 * portraits). System and agent rows keep the cog and the robot.
 */
export const Photos: Story = {
  parameters: {
    appCore: { queryData: activityQueryDataWithPhotos([EMILY, JAKE, RYAN]) },
  },
};

/** The Session timeline, every person with a photo. */
export const PhotosSession: Story = {
  name: "Photos Session",
  args: {
    rows: newestFirst(SESSION_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Session,
  },
  parameters: {
    appCore: { queryData: activityQueryDataWithPhotos([EMILY, JAKE, RYAN]) },
  },
};

/**
 * The Document timeline with a mix: Emily and Ryan have photos, Jake has
 * none and reads as his initials.
 */
export const PhotosAndInitials: Story = {
  name: "Photos And Initials",
  parameters: {
    appCore: { queryData: activityQueryDataWithPhotos([EMILY, RYAN]) },
  },
};

/** The Branch timeline with a mix: Jake has a photo, Emily has initials. */
export const PhotosAndInitialsBranch: Story = {
  name: "Photos And Initials Branch",
  args: {
    rows: newestFirst(BRANCH_EXAMPLE_ROWS),
    artifactKind: ActivityArtifactKind.Branch,
  },
  parameters: {
    appCore: { queryData: activityQueryDataWithPhotos([JAKE]) },
  },
};

/**
 * Mostly machines: an agent's API-key edits, System projections and an
 * automatic unblock,
 * between a few rows by people. Agents draw the robot (with the key owner's
 * name and the API badge), System the cog.
 */
export const SystemAndAgents: Story = {
  name: "System And Agents",
  args: { rows: newestFirst(SYSTEM_AND_AGENT_ROWS) },
  parameters: {
    appCore: { queryData: activityQueryDataWithPhotos([EMILY, JAKE]) },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Activity" });
    // Two agent rows (the API-key edits), three System rows. Loop run rows
    // were retired with Loops (ISS-12435), so none renders.
    await expect(list.querySelectorAll("svg.lucide-bot")).toHaveLength(2);
    await expect(list.querySelectorAll("svg.lucide-cog")).toHaveLength(3);
    const runs = within(list)
      .getAllByRole("listitem")
      .filter((row) => row.textContent?.includes("started an agent run"));
    await expect(runs).toHaveLength(0);
  },
};

/** The Document timeline in the dark theme. */
export const Dark: Story = {
  globals: { theme: "dark" },
};

/**
 * A phone-width column: the avatar stays on the line, the name and the time
 * share the first line, and the action wraps under them.
 */
export const Narrow: Story = {
  args: { className: "max-w-[360px]" },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
