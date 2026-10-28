import { ThreadStatus, TraceCommentKind } from "@repo/api/src/types/comment";
import { CommentAnchorState } from "@repo/api/src/types/comment-anchor";
import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import { CommentPolicyKey } from "@repo/api/src/types/comment-capabilities";
import { CommentSyncStatus } from "@repo/api/src/types/comment-thread-dto";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import {
  ALL_PERMISSIONS,
  capabilitiesFor,
  codeAnchor,
  desktopSync,
  FULL_CAPABILITIES,
  githubThread,
  makeComment,
  makeThread,
  NO_PERMISSIONS,
  READ_ONLY_CAPABILITIES,
  SESSION_THREADS,
  traceAnchor,
} from "./comments-pane.fixtures";
import {
  PaneHost,
  type PaneStoryArgs,
  TabbedPaneHost,
} from "./comments-pane.story-fixtures";
import {
  CommentsPaneLayout,
  CommentsPaneLoadStatus,
  NO_ANCHOR_STATE_LABELS,
} from "./comments-pane-model";

/**
 * The canonical comments pane (`CommentsPane`, ISS-11209): the unified thread
 * shape in, typed callbacks out. Every affordance is the source's capability
 * AND the item's permission; the pane never writes anything itself.
 *
 * Controls table:
 * | Prop / arg | Control | Why |
 * |---|---|---|
 * | loadStatus | select | loading / ready / partial / error (ISS-10550) |
 * | capabilities | object | the collection's capabilities for this viewer |
 * | threads | object | `CommentThreadDto[]` exactly as the service serves it |
 * | layout | inline-radio | wide rail, narrow right Sheet, mobile bottom Sheet |
 * | width | number | rail width; clamped to 280-560; live |
 * | open | boolean | host open state; live |
 * | title, notice | text | heading and the host's coverage note |
 * | anchorStateLabels | object | design-approved wording per anchor state, `null` until approved |
 * | on* | action | every write and navigation is a callback |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | drafts, onDraftChange, returnFocusRef | owned by the story host, like a real host |
 * | renderBody, formatTimestamp | function slots |
 */
const meta = {
  title: "Composites/Shared/Artifact Detail/Comments Pane",
  component: PaneHost,
  tags: ["stable", "autodocs"],
  parameters: { layout: "fullscreen", controls: { expanded: true } },
  argTypes: {
    loadStatus: {
      control: "select",
      options: Object.values(CommentsPaneLoadStatus),
    },
    layout: {
      control: "inline-radio",
      options: Object.values(CommentsPaneLayout),
    },
    width: { control: { type: "number", min: 200, max: 700, step: 16 } },
    open: { control: "boolean" },
    title: { control: "text" },
    notice: { control: "text" },
    anchorStateLabels: { control: "object" },
    capabilities: { control: "object" },
    threads: { control: "object" },
  },
  args: {
    anchorStateLabels: NO_ANCHOR_STATE_LABELS,
    capabilities: FULL_CAPABILITIES,
    composerTarget: { anchor: { kind: CommentAnchorKind.Artifact } },
    layout: CommentsPaneLayout.Wide,
    loadStatus: CommentsPaneLoadStatus.Ready,
    onCreateThread: fn(),
    onDelete: fn(),
    onEdit: fn(),
    onOpenChange: fn(),
    onReopen: fn(),
    onReply: fn(),
    onResolve: fn(),
    onRetryLoad: fn(),
    onRetrySync: fn(),
    onRevealAnchor: fn(),
    onSelectThread: fn(),
    onWidthChange: fn(),
    onWriteError: fn(),
    open: true,
    revealableAnchorKinds: [CommentAnchorKind.Trace, CommentAnchorKind.Code],
    threads: SESSION_THREADS,
    width: 360,
  },
  render: (args) => <PaneHost {...args} />,
} satisfies Meta<PaneStoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

const body = () => within(document.body);
const JUMP_TO = /^Jump to/;
const SEEDED_PREVIEW = "Added the variant and a focused unit test:";
const CODE_PREVIEW =
  "packages/app/shared/components/comments/comments-pane.tsx:42";

/** Click then paste: a keystroke per character can outlast the sweep's timeout on a loaded box. */
async function enter(field: HTMLElement, text: string) {
  await userEvent.click(field);
  await userEvent.paste(text);
}

function cueOf(text: string) {
  return body().getByText(text).closest("[data-anchor-cue]");
}

export const Default: Story = {};

export const Loading: Story = {
  args: { loadStatus: CommentsPaneLoadStatus.Loading, threads: [] },
  play: async () => {
    await expect(body().getByRole("status")).toHaveTextContent(
      "Loading comments…"
    );
    await expect(body().queryByText("No comments in this view")).toBeNull();
    await expect(
      body().getByRole("textbox", { name: "Add a comment" })
    ).toBeDisabled();
  },
};

export const Empty: Story = {
  args: { threads: [] },
  play: async () => {
    await expect(
      body().getByText("No comments in this view")
    ).toBeInTheDocument();
    await expect(body().getByRole("heading", { level: 2 })).toHaveTextContent(
      "Comments 0"
    );
  },
};

const COVERAGE_NOTE =
  "Comments from Session B are unavailable because that Session did not render.";

/** A failed read is an alert and "Unavailable", never an empty list or a zero. */
export const FailedLoadWithRetry: Story = {
  args: { loadStatus: CommentsPaneLoadStatus.Error, threads: [] },
  play: async ({ args }) => {
    await expect(body().getByRole("alert")).toHaveTextContent(
      "Comments are unavailable in this view."
    );
    await expect(body().getByRole("heading", { level: 2 })).toHaveTextContent(
      "Comments Unavailable"
    );
    await expect(body().queryByText("No comments in this view")).toBeNull();
    await expect(body().getByRole("button", { name: "All" })).toBeDisabled();
    await userEvent.click(body().getByRole("button", { name: "Retry" }));
    await expect(args.onRetryLoad).toHaveBeenCalledTimes(1);
  },
};

/** Partial data: the count reads "N shown" and the host's note says why. */
export const PartialOrStale: Story = {
  args: { loadStatus: CommentsPaneLoadStatus.Partial, notice: COVERAGE_NOTE },
  play: async () => {
    await expect(body().getByRole("heading", { level: 2 })).toHaveTextContent(
      "Comments 2 shown"
    );
    await expect(body().getByText(COVERAGE_NOTE)).toHaveAttribute(
      "role",
      "status"
    );
  },
};

/** A partial read with nothing in it is not "no comments": only the note speaks. */
export const PartialWithNothingShown: Story = {
  args: {
    loadStatus: CommentsPaneLoadStatus.Partial,
    notice: COVERAGE_NOTE,
    threads: [],
  },
  play: async () => {
    await expect(body().getByText(COVERAGE_NOTE)).toBeInTheDocument();
    await expect(body().queryByText("No comments in this view")).toBeNull();
  },
};

/** A refresh that failed over retained threads keeps them, under the alert. */
export const FailedRefreshOverThreads: Story = {
  args: { loadStatus: CommentsPaneLoadStatus.Error },
  play: async () => {
    await expect(body().getByRole("alert")).toBeInTheDocument();
    await expect(
      body().getByText("This step dominates the wall clock.")
    ).toBeInTheDocument();
  },
};

export const ReadOnly: Story = {
  args: { capabilities: READ_ONLY_CAPABILITIES },
  play: async () => {
    await expect(
      body().getByText(
        "The revision session accounts for most of the rework cost in this trace."
      )
    ).toBeInTheDocument();
    for (const name of [
      "Reply to comment",
      "Resolve comment",
      "Edit comment",
      "Delete thread",
    ]) {
      await expect(body().queryByRole("button", { name })).toBeNull();
    }
    await expect(body().queryByRole("textbox")).toBeNull();
  },
};

/** The same threads with everything granted: the read-only story's positive sibling. */
export const FullyWritable: Story = {
  play: async ({ args }) => {
    await expect(
      body().getAllByRole("button", { name: "Reply to comment" })
    ).toHaveLength(2);
    await userEvent.click(
      body().getAllByRole("button", { name: "Delete thread" })[0]!
    );
    await expect(args.onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "session-thread-1" })
    );
    await userEvent.click(
      body().getAllByRole("button", { name: "Edit comment" })[0]!
    );
    const editor = body().getByRole("textbox", { name: "Edit comment" });
    await userEvent.clear(editor);
    await enter(editor, "Edited");
    await userEvent.click(body().getByRole("button", { name: "Save" }));
    await expect(args.onEdit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: "Edited" })
    );
  },
};

/** The anchor is previewed but this surface cannot show code: no jump, and no state cue. */
export const AnchorNotRevealableHere: Story = {
  args: {
    revealableAnchorKinds: [CommentAnchorKind.Trace],
    threads: [githubThread("gh-1"), makeThread({ id: "trace-ok" })],
  },
  play: async () => {
    await expect(cueOf(CODE_PREVIEW)).toBeNull();
    await expect(body().getByText(CODE_PREVIEW)).not.toHaveClass("opacity-60");
    await expect(body().getAllByRole("button", { name: JUMP_TO })).toHaveLength(
      1
    );
    await expect(
      body().getByRole("button", { name: `Jump to ${SEEDED_PREVIEW}` })
    ).toBeInTheDocument();
  },
};

/** The desktop outbox has the write but the server has not accepted it. */
export const PendingWrite: Story = {
  args: {
    threads: [
      makeThread({
        id: "pending-1",
        sync: desktopSync(CommentSyncStatus.Pending),
      }),
    ],
  },
  play: async () => {
    await expect(body().getByRole("status")).toHaveTextContent("Pending");
  },
};

export const SyncFailedWithRetry: Story = {
  args: {
    threads: [
      makeThread({
        id: "failed-1",
        sync: desktopSync(CommentSyncStatus.Failed),
      }),
    ],
  },
  play: async ({ args }) => {
    await expect(body().getByText("Sync failed")).toBeInTheDocument();
    await userEvent.click(
      body().getByRole("button", { name: "Retry syncing trace note" })
    );
    await expect(args.onRetrySync).toHaveBeenCalledWith("failed-1");
  },
};

/** Only the item's retry permission differs from SyncFailedWithRetry: a badge with no door. */
export const SyncFailedWithoutRetry: Story = {
  args: {
    threads: [
      makeThread({
        id: "failed-2",
        permissions: { ...ALL_PERMISSIONS, canRetrySync: false },
        sync: desktopSync(CommentSyncStatus.Failed),
      }),
    ],
  },
  play: async () => {
    await expect(body().getByText("Sync failed")).toBeInTheDocument();
    await expect(
      body().queryByRole("button", { name: "Retry syncing trace note" })
    ).toBeNull();
  },
};

/** MOVED still places the anchor, so the jump stays; the dashed underline marks the move. */
export const AnchorMoved: Story = {
  args: {
    threads: [
      makeThread({ anchorState: CommentAnchorState.Moved, id: "moved" }),
    ],
  },
  play: async ({ args }) => {
    const jump = body().getByRole("button", {
      name: `Jump to ${SEEDED_PREVIEW}`,
    });
    await expect(jump).toHaveAttribute("data-anchor-cue", "moved");
    await expect(body().getByText(SEEDED_PREVIEW)).toHaveClass(
      "decoration-dashed"
    );
    await userEvent.click(jump);
    await expect(args.onRevealAnchor).toHaveBeenCalledTimes(1);
  },
};

/** OUTDATED: muted preview, no jump. A labelled sibling shows the host's wording wired in. */
export const AnchorOutdated: Story = {
  args: {
    anchorStateLabels: {
      ...NO_ANCHOR_STATE_LABELS,
      [CommentAnchorState.Outdated]: "Fixture: outdated label",
    },
    threads: [
      githubThread("outdated", { anchorState: CommentAnchorState.Outdated }),
      makeThread({ id: "anchored" }),
    ],
  },
  play: async () => {
    const cue = cueOf(CODE_PREVIEW);
    await expect(cue).toHaveAttribute("data-anchor-cue", "outdated");
    await expect(body().getByText(CODE_PREVIEW)).toHaveClass("opacity-60");
    await expect(cue).toHaveAccessibleDescription("Fixture: outdated label");
    await expect(body().getAllByRole("button", { name: JUMP_TO })).toHaveLength(
      1
    );
  },
};

export const AnchorOrphaned: Story = {
  args: {
    threads: [
      makeThread({ anchorState: CommentAnchorState.Orphaned, id: "orphaned" }),
      makeThread({
        anchor: traceAnchor("Still anchored", { row: 9 }),
        id: "anchored",
      }),
    ],
  },
  play: async () => {
    await expect(cueOf(SEEDED_PREVIEW)).toHaveAttribute(
      "data-anchor-cue",
      "orphaned"
    );
    await expect(body().getByText(SEEDED_PREVIEW)).toHaveClass("line-through");
    await expect(body().getAllByRole("button", { name: JUMP_TO })).toHaveLength(
      1
    );
    await expect(
      body().getByRole("button", { name: "Jump to Still anchored" })
    ).toBeInTheDocument();
  },
};

export const ResolvedAndOpen: Story = {
  args: {
    threads: [
      makeThread({ id: "open-1" }),
      makeThread({ id: "resolved-1", status: ThreadStatus.Resolved }),
    ],
  },
  play: async ({ args }) => {
    await expect(body().getByText("Resolved")).toBeInTheDocument();
    await userEvent.click(
      body().getByRole("button", { name: "Resolve comment" })
    );
    await expect(args.onResolve).toHaveBeenCalledWith("open-1");
    await userEvent.click(
      body().getByRole("button", { name: "Reopen comment" })
    );
    await expect(args.onReopen).toHaveBeenCalledWith("resolved-1");
  },
};

/** "Open comments" hides the resolved thread and keeps the open one. */
export const FilterOpenComments: Story = {
  args: ResolvedAndOpen.args,
  play: async () => {
    await userEvent.click(body().getByRole("button", { name: "All" }));
    await userEvent.click(
      await body().findByRole("menuitem", { name: "Open comments" })
    );
    await expect(body().getByText("Body of open-1")).toBeInTheDocument();
    await expect(body().queryByText("Body of resolved-1")).toBeNull();
    await expect(
      body().getByRole("complementary", { name: "Comments" })
    ).toBeInTheDocument();
  },
};

export const MixedNativeAndGithub: Story = {
  args: { threads: [...SESSION_THREADS, githubThread("gh-mixed")] },
  play: async () => {
    const groups = body().getAllByRole("group");
    await expect(groups).toHaveLength(3);
    const chipped = groups.filter((group) =>
      within(group).queryByText("Synced with GitHub")
    );
    await expect(chipped).toHaveLength(1);
    await expect(
      within(chipped[0]!).getByText(
        "Should this guard the empty anchor case too?"
      )
    ).toBeInTheDocument();
  },
};

export const GithubThreadWithLinkOut: Story = {
  args: {
    capabilities: capabilitiesFor(CommentPolicyKey.GithubBranch),
    threads: [githubThread("gh-link")],
  },
  play: async () => {
    await expect(
      body().getByRole("link", {
        name: "Synced with GitHub; open external record",
      })
    ).toHaveAttribute(
      "href",
      "https://github.com/closedloop-ai/closedloop-ai/pull/1#discussion_gh-link"
    );
  },
};

export const SelectedThreadWithActiveAnchor: Story = {
  args: {
    activeAnchor: traceAnchor(SEEDED_PREVIEW),
    selectedThreadId: "session-thread-1",
  },
  play: async ({ args }) => {
    const groups = body().getAllByRole("group");
    const selected = groups.find(
      (group) => group.getAttribute("aria-current") === "true"
    );
    const other = groups.find((group) => group !== selected);
    await expect(selected).toHaveAttribute("data-anchor-active", "true");
    // The selected card shows the accent fill, which an unselected card's bg-card would hide.
    await expect(selected).toHaveClass("bg-accent");
    await expect(selected).not.toHaveClass("bg-card");
    await expect(other).toHaveClass("bg-card");
    await userEvent.click(
      within(selected as HTMLElement).getByRole("button", {
        name: `Jump to ${SEEDED_PREVIEW}`,
      })
    );
    await expect(args.onRevealAnchor).toHaveBeenCalledTimes(1);
    await userEvent.click(
      body().getByText("This step dominates the wall clock.")
    );
    await expect(args.onSelectThread).toHaveBeenCalledWith("session-thread-2");
  },
};

const LONG_BODY = Array.from(
  { length: 12 },
  (_, index) => `Line ${index + 1} of a long review note.`
).join("\n");

export const LongThreadAndComposerOverflow: Story = {
  args: {
    threads: [
      makeThread({
        comments: Array.from({ length: 9 }, (_, index) =>
          makeComment({
            body: index === 0 ? LONG_BODY : `Reply ${index}`,
            threadId: "long",
          })
        ),
        id: "long",
      }),
    ],
  },
  play: async () => {
    await expect(body().getByText("Reply 8")).toBeInTheDocument();
    const composer = body().getByRole("textbox", { name: "Add a comment" });
    await enter(composer, LONG_BODY);
    await expect(composer).toHaveValue(LONG_BODY);
    // The composer caps its height and scrolls rather than pushing the list away.
    await expect(composer).toHaveClass("max-h-60");
  },
};

export const Closed: Story = {
  args: { open: false },
  play: async ({ args }) => {
    await expect(body().queryByRole("complementary")).toBeNull();
    await userEvent.click(
      body().getByRole("button", { name: "Show comments rail" })
    );
    await expect(
      body().getByRole("complementary", { name: "Comments" })
    ).toBeInTheDocument();
    await userEvent.click(body().getByRole("button", { name: "All" }));
    await userEvent.keyboard("{Escape}");
    await expect(body().queryByRole("button", { name: "All" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(body().queryByRole("complementary")).toBeNull();
    await expect(
      body().getByRole("button", { name: "Show comments rail" })
    ).toHaveFocus();
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false);
  },
};

/** The header X returns focus to the trigger just like Escape. */
export const CloseButtonReturnsFocus: Story = {
  play: async () => {
    await userEvent.click(
      body().getByRole("button", { name: "Close comments" })
    );
    await expect(body().queryByRole("complementary")).toBeNull();
    await expect(
      body().getByRole("button", { name: "Show comments rail" })
    ).toHaveFocus();
  },
};

/** Keyboard resize stops at 280 and 560 whatever the starting width. */
export const WideWithKeyboardResize: Story = {
  args: { width: 540 },
  play: async () => {
    const handle = body().getByRole("separator", {
      name: "Resize comments rail",
    });
    handle.focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await expect(handle).toHaveAttribute("aria-valuenow", "560");
    await userEvent.keyboard("{Home}{ArrowRight}");
    await expect(handle).toHaveAttribute("aria-valuenow", "280");
  },
};

/** The pane brings its own close, so the Sheet's corner X is suppressed: one close control. */
export const Narrow: Story = {
  args: { layout: CommentsPaneLayout.Narrow },
  globals: { viewport: { value: "768-1024" } },
  play: async () => {
    const sheet = await body().findByRole("dialog", { name: "Comments" });
    await expect(sheet).toHaveClass("right-0");
    await expect(
      within(sheet).queryByRole("button", { name: "Close" })
    ).toBeNull();
    await expect(
      within(sheet).getByRole("button", { name: "Close comments" })
    ).toBeInTheDocument();
  },
};

export const Mobile: Story = {
  args: { layout: CommentsPaneLayout.Mobile },
  globals: { viewport: { value: "390-844" } },
  play: async () => {
    const sheet = await body().findByRole("dialog", { name: "Comments" });
    await expect(sheet).toHaveClass("bottom-0");
    // Escape in the composer belongs to the field; the Sheet stays.
    await userEvent.click(
      within(sheet).getByRole("textbox", { name: "Add a comment" })
    );
    await userEvent.keyboard("{Escape}");
    await expect(
      body().getByRole("dialog", { name: "Comments" })
    ).toBeInTheDocument();
  },
};

export const Dark: Story = {
  args: { threads: [...SESSION_THREADS, githubThread("gh-dark")] },
  globals: { theme: "dark" },
};

/** Native Session comments as a staff viewer sees them: the parsing-bug kind is offered. */
export const SourceNativeSessionStaff: Story = {
  args: {
    capabilities: capabilitiesFor(CommentPolicyKey.NativeSession, {
      staff: true,
    }),
    composerTarget: {
      anchor: traceAnchor("Ran 412 tests"),
      label: "“Ran 412 tests”",
    },
  },
  play: async ({ args }) => {
    await enter(
      body().getByRole("textbox", { name: "Comment on “Ran 412 tests”" }),
      "Trace dropped the tool output"
    );
    await userEvent.click(
      body().getByRole("checkbox", { name: "Flag as parsing/data bug" })
    );
    await userEvent.click(body().getByRole("button", { name: "Comment" }));
    await expect(args.onCreateThread).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Trace dropped the tool output",
        kind: TraceCommentKind.ParsingBug,
      })
    );
  },
};

export const SourceNativeSession: Story = {
  args: {
    capabilities: capabilitiesFor(CommentPolicyKey.NativeSession),
    composerTarget: {
      anchor: traceAnchor("Ran 412 tests"),
      label: "“Ran 412 tests”",
    },
  },
  play: async () => {
    await expect(
      body().getByRole("textbox", { name: "Comment on “Ran 412 tests”" })
    ).toBeInTheDocument();
    await expect(
      body().queryByRole("checkbox", { name: "Flag as parsing/data bug" })
    ).toBeNull();
    await expect(
      body().getAllByRole("button", { name: "Resolve comment" }).length
    ).toBeGreaterThan(0);
  },
};

/** Native Branch comments with Branch's scope: only rendered Sessions, and the coverage note. */
export const SourceNativeBranch: Story = {
  args: {
    branchScope: {
      coverageNote: COVERAGE_NOTE,
      renderedSessionIds: ["session-a"],
      selectedPullRequestKey: null,
      tab: "sessions",
    },
    capabilities: capabilitiesFor(CommentPolicyKey.NativeBranch),
    composerTarget: null,
    threads: [
      ...SESSION_THREADS,
      makeThread({
        anchor: traceAnchor("Session B only", { sessionId: "session-b" }),
        id: "session-b-thread",
      }),
    ],
  },
  play: async () => {
    await expect(body().queryByText("Body of session-b-thread")).toBeNull();
    await expect(
      body().getByText(
        "Select an eligible trace row or range to add a comment."
      )
    ).toBeInTheDocument();
    await expect(
      body().getByText(
        "Comments updated for Sessions and timeline. 1 rendered Sessions included."
      )
    ).toBeInTheDocument();
  },
};

/**
 * Everything the viewer COULD be granted per item, and a code anchor the
 * composer could take: only the GitHub source policy keeps them read-only.
 */
export const SourceGithubReadOnly: Story = {
  args: {
    branchScope: {
      renderedSessionIds: [],
      selectedPullRequestKey: "closedloop-ai/closedloop-ai#1",
      tab: "details",
    },
    capabilities: capabilitiesFor(CommentPolicyKey.GithubBranch),
    composerTarget: { anchor: codeAnchor("src/index.ts", 3) },
    threads: [
      githubThread("gh-ro", {
        comments: [
          makeComment({
            body: "Should this guard the empty anchor case too?",
            threadId: "gh-ro",
          }),
        ],
        permissions: ALL_PERMISSIONS,
      }),
    ],
  },
  play: async () => {
    await expect(
      body().getByText("Should this guard the empty anchor case too?")
    ).toBeInTheDocument();
    for (const name of [
      "Reply to comment",
      "Edit comment",
      "Delete thread",
      "Reopen comment",
    ]) {
      await expect(body().queryByRole("button", { name })).toBeNull();
    }
    await expect(body().queryByRole("textbox")).toBeNull();
  },
};

export const DraftSurvivesCloseAndReopen: Story = {
  play: async () => {
    await enter(
      body().getByRole("textbox", { name: "Add a comment" }),
      "half-written"
    );
    await userEvent.click(
      body().getByRole("button", { name: "Hide comments rail" })
    );
    await expect(
      body().queryByRole("textbox", { name: "Add a comment" })
    ).toBeNull();
    await userEvent.click(
      body().getByRole("button", { name: "Show comments rail" })
    );
    await expect(
      body().getByRole("textbox", { name: "Add a comment" })
    ).toHaveValue("half-written");
  },
};

/** Per-tab open state, Details hiding the rail, and a draft that outlives both. */
export const DraftSurvivesTabSwitch: Story = {
  render: (args) => <TabbedPaneHost {...args} />,
  play: async () => {
    await enter(
      body().getByRole("textbox", { name: "Add a comment" }),
      "unsent"
    );
    await userEvent.click(body().getByRole("button", { name: "Details" }));
    await expect(body().queryByRole("complementary")).toBeNull();
    await userEvent.click(body().getByRole("button", { name: "Sessions" }));
    await expect(body().queryByRole("complementary")).toBeNull();
    await userEvent.click(body().getByRole("button", { name: "Artifact" }));
    await expect(
      body().getByRole("textbox", { name: "Add a comment" })
    ).toHaveValue("unsent");
  },
};

export const FailedSubmitKeepsDraft: Story = {
  args: {
    onCreateThread: fn(() => Promise.reject(new Error("offline"))),
  },
  play: async ({ args }) => {
    const composer = body().getByRole("textbox", { name: "Add a comment" });
    await enter(composer, "keep me");
    await userEvent.click(body().getByRole("button", { name: "Comment" }));
    await expect(args.onCreateThread).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(composer).toBeEnabled());
    await expect(composer).toHaveValue("keep me");
    await expect(args.onWriteError).toHaveBeenCalledWith(
      expect.objectContaining({ key: "new-thread" })
    );
  },
};

export const PendingSubmitBlocksDuplicate: Story = {
  args: {
    onCreateThread: fn(() => new Promise<void>(() => undefined)),
  },
  play: async ({ args }) => {
    const composer = body().getByRole("textbox", { name: "Add a comment" });
    await enter(composer, "once");
    const submit = body().getByRole("button", { name: "Comment" });
    await userEvent.click(submit);
    await expect(submit).toBeDisabled();
    await userEvent.click(submit);
    await expect(args.onCreateThread).toHaveBeenCalledTimes(1);
    await expect(composer).toHaveValue("once");
  },
};

/** Escape in a reply composer is its Cancel: the draft goes, the rail stays. */
export const EscapeInReplyCancels: Story = {
  play: async () => {
    await userEvent.click(
      body().getAllByRole("button", { name: "Reply to comment" })[0]!
    );
    await enter(
      body().getByRole("textbox", { name: "Reply to comment" }),
      "never mind"
    );
    await userEvent.keyboard("{Escape}");
    await expect(
      body().queryByRole("textbox", { name: "Reply to comment" })
    ).toBeNull();
    await expect(
      body().getByRole("complementary", { name: "Comments" })
    ).toBeInTheDocument();
  },
};
