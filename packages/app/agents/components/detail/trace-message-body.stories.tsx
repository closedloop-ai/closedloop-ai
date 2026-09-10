import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, userEvent, within } from "storybook/test";
import { TraceMessageBody } from "./trace-message-body";

/**
 * ISS-5698: one Session Trace message body, isolated.
 *
 * This component picks between three renderers before it draws anything — an
 * exact-offset highlight, a plain markdown body, or a folded mix of markdown and
 * harness chips — and which one it picks is invisible in the result. Two of the
 * three exist to stop the SAME failure: raw harness XML, or raw `**` delimiters,
 * leaking into a transcript a human is reading. That is a thing to look at, and
 * the populated `AgentSessionDetailView` story cannot serve it: its fixture
 * carries no harness wrapper, no truncated tag, and no comment anchor, so every
 * turn on it takes the plain branch.
 *
 * The highlight branch is the one worth the `play` functions. It measures the
 * RENDERED text nodes rather than the markdown source precisely so a selection
 * that starts in prose and ends inside bold does not have to reconstruct the
 * source offsets — and the only way to see that it worked is to read back what
 * the markers actually wrapped.
 */

/** Production ancestry: `session-trace.tsx` mounts every message body inside the
 *  trace's `.st` root, and `styles.css` scopes the monospace face as `.st .mono`
 *  — which is the face the command chip's argument tail renders in. Without this
 *  frame that tail shows in the body face here and in monospace in production. */
function TraceFrame({ children }: Readonly<{ children: ReactNode }>) {
  return <div className="st">{children}</div>;
}

/** No harness wrapper anywhere, which is the common case: every part parses as
 *  `md` and the body takes the plain `TraceMarkdown` branch. */
const PLAIN_BODY = [
  "Landed the fix in `session-trace-subagent.tsx` and re-ran the affected slice.",
  "",
  "- typecheck: 39/39",
  "- lint: clean",
  "",
  "The remaining red at #12 is the flaky desktop suite, not this diff.",
].join("\n");

/** Prose plus one paired harness wrapper — the mixed branch, where the body
 *  renders a `parts.map` of markdown spans and collapsed chips. */
const HARNESS_TAG_BODY =
  "Switched the model before the next turn.\n\n<local-command-stdout>Model set to Opus 4.1 for this session</local-command-stdout>";

/** The inner text behind the collapsed chip above, asserted absent while closed. */
const HARNESS_TAG_INNER = "Model set to Opus 4.1 for this session";

/** A wrapper carrying another wrapper. `renderMessageBodyInner` recurses through
 *  `TraceMessageBody`, so the inner tag folds on expand instead of leaking. */
const NESTED_HARNESS_TAG_BODY =
  "<local-command-stdout>Wrote 3 files.\n\n<system-reminder>Context is at 71% of the window</system-reminder>\n\nDone.</local-command-stdout>";

/** An opener whose closer upstream truncation removed — the `truncateText`
 *  4,096-byte cap landing mid-wrapper. Folds via `foldUnterminatedTag`. */
const UNTERMINATED_TAG_BODY =
  "Picking up where the last turn stopped. <system-reminder>Do not re-read files already in context; the transcript was cut here by the byte";

/** The raw opener that must never survive to the screen. */
const RAW_OPENER = "<system-reminder>";

/** A whole slash-command invocation, re-injected by the harness as three
 *  adjacent `command-*` wrappers. `parseTraceParts` folds the run into ONE
 *  chip so the turn reads as the command the user typed. */
const SLASH_COMMAND_BODY = [
  "<command-name>/review</command-name>",
  "<command-message>Run the review lane over the open diff</command-message>",
  "<command-args>--fix packages/app/agents</command-args>",
].join("\n");

/** The argument tail of {@link SLASH_COMMAND_BODY}, short enough that the head
 *  shows it whole and it earns no detail row of its own. */
const SLASH_COMMAND_ARGS = "--fix packages/app/agents";

/** The same invocation with an argument string past `INLINE_ARGS_MAX_LENGTH`,
 *  where `.st-tag-args`'s `max-width: 32ch` ellipsizes the head. */
const LONG_ARGS_COMMAND_BODY = [
  "<command-name>/review</command-name>",
  "<command-args>--fix packages/app/agents/components/detail --dry-run</command-args>",
].join("\n");

const LONG_COMMAND_ARGS =
  "--fix packages/app/agents/components/detail --dry-run";

/** Substring matcher for the command chip's head, which concatenates the command
 *  name and its argument tail into one accessible name. */
const SLASH_COMMAND_CHIP_NAME = /^\/review/;

/**
 * The passage a trace comment is anchored to. Rendered, this is
 * `The reviewer flagged the gutter cost row twice in one pass.` — the `**`
 * around `gutter cost` is markdown syntax and occupies no rendered offset, which
 * is exactly why the highlight works in rendered coordinates.
 */
const HIGHLIGHT_BODY =
  "The reviewer flagged the **gutter cost** row twice in one pass.";

/** `the gutter cost row` in RENDERED coordinates: it opens in the leading text
 *  node, covers the whole `<strong>`, and closes in the trailing node, so the
 *  per-node loop has to emit three markers for one logical selection. */
const HIGHLIGHT_START_OFFSET = 21;
const HIGHLIGHT_END_OFFSET = 40;
const HIGHLIGHT_SELECTED_TEXT = "the gutter cost row";

/** The marker `applyRenderedTextHighlight` wraps each covered range in. */
const HIGHLIGHT_MARKER_SELECTOR = "[data-trace-selected-passage]";

/** The selection anchor a comment rail passes down when selection is armed. */
const SELECTION_ROW = 42;
const SELECTION_SESSION_ID = "session-detail-1";
const SELECTION_TRACE_ID = "trace-session-detail-1-42";
const SELECTION_TURN_ID = "turn-9";
const SELECTION_ACTOR = { name: "claude-opus-4", human: null };
const SELECTION_ROW_ATTRIBUTE = "[data-trace-text-row]";

const meta = {
  title: "Primitives/Content/Trace Message Body",
  component: TraceMessageBody,
  tags: ["autodocs"],
  argTypes: {
    text: {
      control: "text",
      description:
        "The turn body. Harness wrapper tags in it fold into chips; everything else parses as markdown.",
      table: { category: "Content" },
    },
    traceHighlight: {
      control: "object",
      description:
        "An exact anchor highlights a span in rendered coordinates; a row anchor tints the whole body.",
      table: { category: "Content" },
    },
    className: { control: false, table: { category: "Appearance" } },
    traceSelectionEnabled: {
      control: "boolean",
      description:
        "Publishes the data-trace-* attributes the comment rail reads back from a selection.",
      table: { category: "State" },
    },
    traceRow: {
      control: { type: "number", min: 0, step: 1 },
      description:
        "Row number of this turn. Without it no selection anchor is published at all.",
      table: { category: "Data" },
    },
    traceActor: { control: "object", table: { category: "Data" } },
    traceId: { control: "text", table: { category: "Data" } },
    traceSessionId: { control: "text", table: { category: "Data" } },
    traceText: { control: "text", table: { category: "Data" } },
    traceTurnId: { control: "text", table: { category: "Data" } },
    onJump: { control: false, table: { category: "Events" } },
  },
  args: { text: PLAIN_BODY, traceSelectionEnabled: false },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TraceFrame>
        <Story />
      </TraceFrame>
    ),
  ],
} satisfies Meta<typeof TraceMessageBody>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The common case: nothing to fold, so `parts.every(md)` holds and the body is a
 * single `TraceMarkdown`. Worth pinning because the two folding branches below
 * have to leave this one byte-identical — a fold that starts wrapping ordinary
 * prose in a chip would show up here first.
 */
export const PlainMarkdown: Story = {
  args: { text: PLAIN_BODY },
};

/**
 * Empty text. Reachable: a turn whose whole body was a harness wrapper the
 * projection stripped, or one truncated to zero characters. `parseTraceParts`
 * returns no parts, `every` is vacuously true, and the plain branch renders an
 * empty block — not a placeholder claiming content the transcript never had.
 */
export const EmptyBody: Story = {
  args: { text: "" },
};

/**
 * The mixed branch, CLOSED — the state a reader actually meets. The harness
 * output is one quiet chip beside the prose rather than a wall of tool noise.
 *
 * The play asserts the inner text is genuinely absent from the DOM, not merely
 * hidden: `TraceChipShell` renders `null` for a closed body, and "collapsed"
 * that still ships the text is a different (and much larger) transcript.
 */
export const HarnessTagCollapsed: Story = {
  args: { text: HARNESS_TAG_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: "Command output" });
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    await expect(canvas.queryByText(HARNESS_TAG_INNER)).toBeNull();
  },
};

/**
 * The same chip, OPENED. Pinned separately because the disclosure is the whole
 * bargain the fold makes: the noise is out of the way but still reachable, so
 * expanding has to actually produce the wrapper's content.
 */
export const HarnessTagExpanded: Story = {
  args: { text: HARNESS_TAG_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: "Command output" });
    await userEvent.click(chip);
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText(HARNESS_TAG_INNER)).toBeVisible();
  },
};

/**
 * A wrapper inside a wrapper, which is why `renderMessageBodyInner` recurses
 * through this component rather than rendering the inner text as markdown. If
 * that recursion is ever flattened, opening the outer chip prints a raw
 * `<system-reminder>` opener into the transcript — the exact leak the fold
 * closes. The play opens one level and requires the second chip, not the tag.
 */
export const NestedHarnessTags: Story = {
  args: { text: NESTED_HARNESS_TAG_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const outer = canvas.getByRole("button", { name: "Command output" });
    await userEvent.click(outer);
    await expect(
      canvas.getByRole("button", { name: "System reminder" })
    ).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent(RAW_OPENER);
  },
};

/**
 * The truncated-wrapper case. Upstream byte caps routinely cut a turn mid-tag,
 * and a paired-only matcher would render the orphaned opener verbatim. The
 * fallback folds the tail into the same chip treatment, so the reader sees a
 * collapsed "System reminder" rather than markup.
 */
export const UnterminatedHarnessTag: Story = {
  args: { text: UNTERMINATED_TAG_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "System reminder" })
    ).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent(RAW_OPENER);
  },
};

/**
 * A typed slash command, folded into ONE chip rather than three anonymous
 * "Command" chips. The arguments ride in the head beside the name, so the row
 * reads like the command line the user actually typed — `/review --fix
 * packages/app/agents`, not a bare `/review` you have to expand to understand.
 *
 * Behind the disclosure there is exactly one row: the harness's
 * `<command-message>`, and only because it says something the head did not. The
 * arguments earn no row here — they are short enough to be shown whole — which
 * is the distinction the next story pins.
 */
export const SlashCommandInvocation: Story = {
  args: { text: SLASH_COMMAND_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: SLASH_COMMAND_CHIP_NAME });
    await expect(canvas.getByTitle(SLASH_COMMAND_ARGS)).toHaveTextContent(
      SLASH_COMMAND_ARGS
    );
    await userEvent.click(chip);
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByText("Message")).toBeVisible();
    await expect(canvas.queryByText("Arguments")).toBeNull();
  },
};

/**
 * The same chip with an argument string past the inline cap. `.st-tag-args`
 * ellipsizes at `32ch`, so the head no longer shows the whole value — and the
 * chip answers by adding an "Arguments" detail row carrying it in full.
 *
 * That pairing is the contract worth pinning: the head is allowed to elide, but
 * the chip must never WITHHOLD. The `title` on the head carries the untruncated
 * string too, so a hover answers without opening anything.
 */
export const SlashCommandLongArguments: Story = {
  args: { text: LONG_ARGS_COMMAND_BODY },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const chip = canvas.getByRole("button", { name: SLASH_COMMAND_CHIP_NAME });
    await expect(canvas.getByTitle(LONG_COMMAND_ARGS)).toBeVisible();
    await userEvent.click(chip);
    await expect(canvas.getByText("Arguments")).toBeVisible();
  },
};

/**
 * A trace comment's exact anchor, resolved. The selection opens in plain prose,
 * covers a whole `<strong>`, and closes in the trailing text — three DOM nodes,
 * one logical passage.
 *
 * The play reads the markers back and joins them, because that concatenation IS
 * the contract: it must equal the words the commenter selected, with no `**`
 * anywhere on the canvas. Highlighting the markdown SOURCE offsets instead would
 * still paint something plausible here and would drag the delimiters in with it.
 */
export const ExactHighlightAcrossEmphasis: Story = {
  args: {
    text: HIGHLIGHT_BODY,
    traceHighlight: {
      kind: "exact",
      startOffset: HIGHLIGHT_START_OFFSET,
      endOffset: HIGHLIGHT_END_OFFSET,
    },
  },
  play: async ({ canvasElement }) => {
    const markers = Array.from(
      canvasElement.querySelectorAll(HIGHLIGHT_MARKER_SELECTOR)
    );
    const highlighted = markers.map((marker) => marker.textContent).join("");
    await expect(highlighted).toBe(HIGHLIGHT_SELECTED_TEXT);
    await expect(canvasElement).not.toHaveTextContent("**");
  },
};

/**
 * The anchor that no longer resolves — a stale comment whose offsets survived a
 * trace refresh that rewrote the turn. `applyRenderedTextHighlight` bails when
 * the range is empty or inverted, so the passage renders whole and UNMARKED.
 *
 * That is the honest outcome and the reason this is its own story: a partial or
 * arbitrary highlight would tell the reader a specific passage was commented on
 * when the anchor no longer names one.
 */
export const ExactHighlightStaleAnchor: Story = {
  args: {
    text: HIGHLIGHT_BODY,
    traceHighlight: {
      kind: "exact",
      startOffset: HIGHLIGHT_END_OFFSET,
      endOffset: HIGHLIGHT_START_OFFSET,
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelectorAll(HIGHLIGHT_MARKER_SELECTOR)
    ).toHaveLength(0);
    await expect(canvasElement).toHaveTextContent(HIGHLIGHT_SELECTED_TEXT);
  },
};

/**
 * The coarser anchor: a comment that resolved to a ROW but not to a passage, so
 * the whole body is tinted instead of a span within it. Deliberately a different
 * treatment from the exact case above — same colour would claim a precision the
 * anchor does not have.
 */
export const RowHighlight: Story = {
  args: { text: HIGHLIGHT_BODY, traceHighlight: { kind: "row" } },
};

/**
 * Selection armed. The body publishes the `data-trace-*` attributes the comment
 * rail reads back when the user selects text, so a draft anchor carries the
 * session, row, turn, actor, and source text without the rail re-deriving any of
 * it from the DOM.
 */
export const SelectionAnchorsPublished: Story = {
  args: {
    text: HIGHLIGHT_BODY,
    traceActor: SELECTION_ACTOR,
    traceId: SELECTION_TRACE_ID,
    traceRow: SELECTION_ROW,
    traceSelectionEnabled: true,
    traceSessionId: SELECTION_SESSION_ID,
    traceTurnId: SELECTION_TURN_ID,
  },
  play: async ({ canvasElement }) => {
    const body = canvasElement.querySelector<HTMLElement>(
      SELECTION_ROW_ATTRIBUTE
    );
    await expect(body).toHaveAttribute(
      "data-trace-text-row",
      String(SELECTION_ROW)
    );
    await expect(body).toHaveAttribute("data-trace-id", SELECTION_TRACE_ID);
    await expect(body).toHaveAttribute("data-trace-turn-id", SELECTION_TURN_ID);
    await expect(body).toHaveAttribute(
      "data-trace-actor",
      SELECTION_ACTOR.name
    );
  },
};

/**
 * Selection armed but the row is UNKNOWN — a turn the projection could not
 * number. `getTraceSelectionProps` publishes nothing at all rather than a
 * partial anchor, so a selection here cannot mint a comment pinned to a row that
 * does not exist. The play asserts the absence, which is the entire behavior.
 */
export const SelectionSuppressedWithoutRow: Story = {
  args: {
    text: HIGHLIGHT_BODY,
    traceActor: SELECTION_ACTOR,
    traceSelectionEnabled: true,
    traceSessionId: SELECTION_SESSION_ID,
  },
  play: async ({ canvasElement }) => {
    await expect(
      canvasElement.querySelector(SELECTION_ROW_ATTRIBUTE)
    ).toBeNull();
  },
};
