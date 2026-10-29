import { CommentAnchorKind } from "@repo/api/src/types/comment-anchor-kind";
import {
  CommentsPaneOpenKey,
  CommentsPaneWidthKey,
} from "@repo/app/shared/components/comments/use-comments-pane-state";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";
import { storyCommentsSource } from "../../../shared/comments/comments-story-source";
import {
  FULL_CAPABILITIES,
  SESSION_THREADS,
} from "../../../shared/components/comments/comments-pane.fixtures";
import { SessionCommentsPaneContent } from "./session-comments-pane";

const SESSION_ID = "session-a";
const REVEALED = SESSION_THREADS[1];
const REVEALED_PASSAGE =
  REVEALED?.anchor?.kind === CommentAnchorKind.Trace
    ? REVEALED.anchor.selectedText
    : "";

const traceJump = { current: fn() };

/**
 * The Session's connected comments pane (PLN-2162 M6.1), against an in-memory
 * read-only port. The Session shell mounts it in its `comments` slot in place
 * of the legacy trace-comments rail.
 *
 * Controls table:
 * | Prop / arg | Control | Why |
 * |---|---|---|
 * | visible | boolean | whether the Sessions tab is on screen |
 * | selectTabThenReveal, onRevealedAnchorChange, onTraceSelectionUsed | action | the shell's reveal, highlight and spent selection |
 * No-control table:
 * | Prop | Reason |
 * |---|---|
 * | dataSource, organizationId, sessionId, traceJump, traceSelection | fixed by the fixture port |
 */
const meta = {
  title: "Composites v1.0/Agents/Detail/Session Comments Pane",
  component: SessionCommentsPaneContent,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "fullscreen" },
  // The pane's saved state is per viewer; each story starts from the default.
  beforeEach: () => {
    globalThis.localStorage.removeItem(CommentsPaneOpenKey.Session);
    globalThis.localStorage.removeItem(CommentsPaneWidthKey.Session);
  },
  decorators: [
    (Story) => (
      <div className="flex h-[40rem] bg-background">
        <div className="flex-1" />
        <Story />
      </div>
    ),
  ],
  args: {
    dataSource: storyCommentsSource({
      capabilities: FULL_CAPABILITIES,
      read: () => ({ artifactId: SESSION_ID, threads: SESSION_THREADS }),
    }),
    onRevealedAnchorChange: fn(),
    onTraceSelectionUsed: fn(),
    organizationId: null,
    selectTabThenReveal: fn((_tab: string, reveal: () => void) => reveal()),
    sessionId: SESSION_ID,
    traceJump,
    traceSelection: null,
    visible: true,
  },
  argTypes: {
    visible: { control: "boolean" },
  },
} satisfies Meta<typeof SessionCommentsPaneContent>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A revealed thread selects the Sessions tab first, then jumps to its row. */
export const RevealSelectsTheSessionsTab: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: `Jump to ${REVEALED_PASSAGE}` })
    );
    await expect(args.selectTabThenReveal).toHaveBeenCalledWith(
      ArtifactDetailTab.Sessions,
      expect.any(Function)
    );
    const [selected] = args.selectTabThenReveal.mock.invocationCallOrder;
    const [jumped] = traceJump.current.mock.invocationCallOrder;
    await expect(selected).toBeLessThan(jumped ?? 0);
  },
};

/** Off the Sessions tab, as on Details or Activity, the pane renders nothing. */
export const OffTheSessionsTab: Story = {
  args: { visible: false },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("heading", { level: 2 })
    ).toBeNull();
  },
};
