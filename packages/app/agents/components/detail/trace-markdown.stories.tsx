import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { expect, fn, userEvent, within } from "storybook/test";
import { TraceMarkdown } from "./trace-markdown";

/**
 * ISS-5698: the Session Trace message renderer, isolated.
 *
 * `MarkdownContent` already has a Design System story, so this file deliberately
 * does not re-canvas the primitive. What lives HERE is the domain layer bolted
 * onto it — the `remarkTraceLinks` transformer and the `TraceAnchor` override —
 * and the whole of that layer is a decision about WHICH `#<row>` tokens become
 * controls. A `#12` in prose is a jump button; the identical three characters
 * inside a code sample are a literal the reader must be able to copy. Nothing on
 * a rendered screen tells you those two were routed differently, which is why
 * that split is the spine of this matrix rather than a footnote.
 *
 * The rest is the promise the component's own docstring makes: headings, lists,
 * emphasis, tables, inline and fenced code all parse. That promise is asserted
 * nowhere else for THIS component, and an over-eager remark plugin is exactly
 * the kind of change that keeps the plugin working and quietly breaks the table.
 */

/** Production ancestry. `TraceMessageBody` — the only caller — mounts
 *  `TraceMarkdown` inside `.st-text` under the trace's `.st` root, and both are
 *  load-bearing: `styles.css` scopes the trace text face to `.st-text` and the
 *  monospace face to `.st .mono`. Rendered bare, every story below would show a
 *  face the production surface never uses. */
function TraceTextFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="st">
      <div className="st-text">{children}</div>
    </div>
  );
}

/** Every construct `TraceMarkdown`'s docstring claims to parse, in one pass:
 *  heading, ordered list, GFM table, blockquote, inline code, fenced code with a
 *  language, emphasis, and an external link. */
const CONSTRUCT_SAMPLER = [
  "## Review pass 2",
  "",
  "Two findings, both in `session-trace.tsx`, and *neither* is new.",
  "",
  "1. The tools row opened by default on a 400-row trace",
  "2. The gutter cost printed a floored `$0.00` over sub-cent turns",
  "",
  "| check     | result | note              |",
  "| --------- | ------ | ----------------- |",
  "| typecheck | 39/39  | cached            |",
  "| lint      | clean  | after `lint:fix`  |",
  "",
  "> The ceiling is 1,000 **logical** lines, so a long template literal does",
  "> not count against it.",
  "",
  "```ts",
  'const REACH_CLASS = "reach";',
  "```",
  "",
  "Full contract in the [contributor guide](https://example.com/guide).",
].join("\n");

/** Two `#<row>` references in ordinary prose — the linkified case. */
const TRACE_ROW_PROSE =
  "Reverted the change from #12 after the suite went red; the failure at #34 turned out to be unrelated.";

/** The same token in prose, in inline code, and in a fenced block. Only the
 *  first is a control; the other two are text the reader may need to copy. */
const TRACE_ROWS_AROUND_CODE = [
  "The regression lands at #12, so start there.",
  "",
  "The literal `#34` is a shell comment, not a row reference.",
  "",
  "```bash",
  "rg '#56' packages/app/agents",
  "```",
].join("\n");

/** The container `MarkdownContent` renders its parsed tree into. Scoping to it
 *  keeps the markup assertions about the MARKDOWN's output — the Storybook
 *  preview injects its own `<script nonce>` into the canvas for theming, and a
 *  whole-tree query would match that and fail for every story. */
const MARKDOWN_ROOT_SELECTOR = ".prose";

/** Author-controlled text that looks like markup. `TraceMarkdown` passes no
 *  `rehype-raw` and no `skipHtml`, so none of this can become live DOM. */
const MARKUP_SHAPED_TEXT =
  'Deploy note <script>alert("xss")</script> and <img src=x onerror="alert(1)"> and a <b>bold-looking</b> tag, all of it authored by the agent.';

/** Tokens with no break opportunity, which is what a transcript actually
 *  carries: a container digest, a deep repo path, and a signed URL.
 *
 *  The path is repo-relative on purpose. What this story exercises is a LONG
 *  token wrapping inside a narrow bubble, and the leading `/Users/<name>/…` an
 *  earlier draft carried added no length the repo path does not already supply
 *  — it only pinned the fixture to one machine's home directory, which
 *  `AGENTS.md` forbids unless the behavior under test genuinely needs an
 *  absolute path. This one does not: `TraceMarkdown` never resolves the string,
 *  it only wraps it. */
const UNBREAKABLE_TOKENS = [
  "Digest `sha256:9f2c41ab7de0c6155b83a0d47e9f1c2b8a6d5e3f4c7b9a0d1e2f3a4b5c6d7e8f`",
  "",
  "Worktree packages/app/agents/components/detail/session-trace-transcript-panel-fixtures/windowed-trace-items.ts",
  "",
  "Artifact https://example.com/artifacts/2026/08/session-detail-trace-bundle-with-a-deliberately-unbreakable-query?signature=abcdef0123456789abcdef0123456789",
].join("\n");

/**
 * Renders the markdown inside a session trace message, turning a reference
 * like #12 into a working link, built specifically for trace text.
 */
const meta = {
  title: "Composites/Sessions/Trace/Trace Markdown",
  component: TraceMarkdown,
  tags: ["autodocs"],
  argTypes: {
    text: { control: "text" },
    dense: {
      control: "boolean",
      description: "Tight paragraph rhythm, which is the trace default.",
    },
    className: { control: false },
    onJump: {
      control: false,
      description:
        "Without it a #<row> token renders as a static span rather than a jump button.",
      table: { category: "Events" },
    },
  },
  args: { dense: true, text: CONSTRUCT_SAMPLER },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TraceTextFrame>
        <Story />
      </TraceTextFrame>
    ),
  ],
} satisfies Meta<typeof TraceMarkdown>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The parse surface, all of it at once. This is the story to read when someone
 * adds a remark plugin: a transformer that walks the tree too greedily breaks
 * the GFM table or swallows the fence long before it breaks a paragraph, and
 * those two are the constructs nothing else on this canvas would show.
 */
export const ConstructSampler: Story = {
  args: { text: CONSTRUCT_SAMPLER },
};

/**
 * `dense` defaults to `true` because the trace packs turns tightly. The roomy
 * setting is a real prop branch with a real caller-facing difference in
 * paragraph rhythm, so it is pinned beside the dense default rather than left to
 * be discovered.
 */
export const Roomy: Story = {
  args: { dense: false, text: CONSTRUCT_SAMPLER },
};

/**
 * `#<row>` in prose WITH a handler: each token becomes a real `<button>`, and
 * the play proves the click reaches `onJump` carrying the parsed row NUMBER —
 * not the `"#12"` string, and not the `#trace-12` href the transformer routes it
 * through. Those two intermediate shapes are where a regression would hide.
 */
export const JumpLinks: Story = {
  args: { onJump: fn(), text: TRACE_ROW_PROSE },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "#12" }));
    await expect(args.onJump).toHaveBeenCalledWith(12);
  },
};

/**
 * The SAME text with no handler. `TraceAnchor` renders a static span instead of
 * a button, which is the honest outcome: a control that looks clickable and
 * jumps nowhere is worse than plain text. The play asserts the affordance is
 * absent, because that is the half a screenshot cannot show.
 */
export const JumpLinksWithoutHandler: Story = {
  args: { text: TRACE_ROW_PROSE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "#12" })).toBeNull();
    await expect(canvasElement).toHaveTextContent("#12");
  },
};

/**
 * The rule the whole transformer exists to get right. `splitTraceText` only
 * rewrites mdast `text` nodes; `code` and `inlineCode` carry a `value` and no
 * children, so they pass through untouched.
 *
 * Visually the three tokens are indistinguishable, so the play does the work:
 * exactly the prose one is a control, and the other two survive verbatim in the
 * rendered text where a reader can still copy them.
 */
export const RowTokensInsideCodeStayLiteral: Story = {
  args: { onJump: fn(), text: TRACE_ROWS_AROUND_CODE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "#12" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "#34" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "#56" })).toBeNull();
    await expect(canvasElement).toHaveTextContent("#34");
    await expect(canvasElement).toHaveTextContent("#56");
  },
};

/**
 * Author-shaped markup, which on this surface is agent-authored text and must
 * never execute. No `rehype-raw` is in the pipeline and `skipHtml` is left at
 * its default, so the tags reach the reader as characters.
 *
 * The play queries the rendered markdown subtree directly rather than through
 * `within`: the claim is that no `script` or `img` NODE was created from this
 * text, and a role query cannot express an element's absence. It is scoped to
 * the markdown root because the canvas itself is not ours — the Storybook
 * preview injects a `<script nonce>` for theming, and a whole-tree query would
 * be asserting against the harness rather than the component.
 */
export const MarkupShapedTextIsNotMarkup: Story = {
  args: { text: MARKUP_SHAPED_TEXT },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>(
      MARKDOWN_ROOT_SELECTOR
    );
    // Thrown rather than asserted so the two claims below cannot pass
    // vacuously against an optional-chained `undefined` if the container ever
    // stops rendering.
    if (!root) {
      throw new Error("MarkdownContent did not render its container");
    }
    await expect(root.querySelector("script")).toBeNull();
    await expect(root.querySelector("img")).toBeNull();
    await expect(root).toHaveTextContent("Deploy note");
  },
};

/**
 * Overflow. `MarkdownContent` sets `overflow-x-auto` on its root, so an
 * unbreakable digest, path, or signed URL scrolls its own block rather than
 * widening the trace column and pushing the gutter off screen. Read this one at
 * a narrow canvas width — that is where the failure mode appears.
 */
export const UnbreakableTokens: Story = {
  args: { text: UNBREAKABLE_TOKENS },
};

/**
 * Empty text, which is reachable: `TraceMessageBody` hands this component the
 * whole body when a turn folds to nothing, and a projection can emit a turn
 * whose text was truncated to zero characters. It must render an empty block,
 * not throw and not print a placeholder the transcript never contained.
 */
export const EmptyText: Story = {
  args: { text: "" },
};
