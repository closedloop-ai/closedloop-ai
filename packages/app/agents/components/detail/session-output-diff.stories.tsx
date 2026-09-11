import type { Meta, StoryObj } from "@storybook/react";
import { FileDiffIcon } from "lucide-react";
import { expect, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { PropertyValue } from "./property-values";
import { SessionOutputDiff } from "./session-output-diff";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

// ISS-5698: the Properties pane's "Lines changed" value, isolated.
// `sessionOutputDiffDisplay` resolves one of THREE scopes and the unit tests
// already pin which one wins for a given session. What they cannot pin is the
// thing this row was redesigned around: the three shapes have to be
// distinguishable ON SIGHT, because the number itself is the same kind of number
// in all three and only the treatment says which question it answers.
// Two rules carry that, and both are visual:
//  - a per-side split keeps the honest green/red, and the single combined
//    added+removed roll-up does NOT — the green means "added" everywhere else in
//    this pane, and wearing it would mis-teach a combined figure as an addition;
//  - every shape carries a qualifier ("in session" / "branch total" / "in PRs"),
//    so "no caption" is never itself a hidden signal a reader has to learn.
// Read the stories in order and that is exactly what you are checking. Each one
// mounts the shared fixture through the production `PropertyValue` row inside the
// shipped `.sd3-props` frame, because the colour tokens and the value track are
// defined by that ancestry — a row rendered bare is a row rendered unstyled.
/**
 * The value for a session's Lines Changed row, shown as a real added and
 * removed split when possible, or plain text for a pull request's combined
 * total.
 */

const meta = {
  title: "Primitives/Data Display/Session Output Diff",
  component: SessionOutputDiff,
  tags: ["autodocs"],
  argTypes: {
    session: {
      control: "object",
      description:
        "Only the four scalars the scope resolver reads: linesAdded, linesRemoved, authoredPrLinesChanged and branchDiffStats.",
    },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <PropertyValue icon={FileDiffIcon} label="Lines changed" mono>
          <Story />
        </PropertyValue>
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionOutputDiff>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The session's own authored churn — the shared fixture, unmodified. A real
 * per-side split, so it keeps the green add / red del colouring, qualified "in
 * session".
 *
 * Not "working tree": these scalars have been transcript-derived since FEA-3922,
 * and ISS-5402 folded a delegated sub-agent's authored lines into them. A row
 * that names a scope its number does not have is a lying row, which is why the
 * qualifier here is the narrower claim.
 */
export const SessionChurn: Story = {
  args: { session: createAgentSessionDetailFixture() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+120")).toBeVisible();
    await expect(canvas.getByText("-12")).toBeVisible();
    await expect(canvas.getByText("in session")).toBeVisible();
  },
};

/**
 * ISS-4448's session: 88 merged PRs, an unreachable authored-PR LOC path, and a
 * working tree that has collapsed to a `+51 -5` residual since the merges. The
 * branch diff is the only signal left that describes what actually shipped, and
 * the row surfaces it rather than understating by two orders of magnitude.
 *
 * Still a per-side split, so it keeps the colours; the "branch total" qualifier
 * is what stops it being read as the session's own residual. Put it beside
 * {@link SessionChurn} — the two are the same shape and mean different things,
 * and the caption is the only thing that says so.
 */
export const BranchTotal: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 51,
      linesRemoved: 5,
      authoredPrLinesChanged: 0,
      branchDiffStats: {
        linesAdded: 3315,
        linesRemoved: 689,
        filesChanged: 42,
        source: "git",
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+3,315")).toBeVisible();
    await expect(canvas.getByText("branch total")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("+51");
  },
};

/**
 * The authored-PR roll-up, and the one shape that is deliberately NOT coloured.
 *
 * This is a single `additions + deletions` total per PR — there is no honest
 * per-side breakdown to split it into — so it renders at plain foreground
 * weight. If this story ever shows a green number, the roll-up has been
 * mis-taught as an addition, which is the exact defect FEA-4378 closed.
 */
export const AuthoredPullRequests: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 134,
      linesRemoved: 2,
      authoredPrLinesChanged: 8000,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("8,000")).toBeVisible();
    await expect(canvas.getByText("in PRs")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("+134");
  },
};

/**
 * The precedence rule, at the point where it is actually a decision: the
 * authored-PR roll-up and the branch diff total the SAME 4,004 lines.
 *
 * The tie goes to the PRs, because that roll-up is the more authoritative
 * account of delivered code — a branch can span several sessions, and a
 * post-merge branch pointer can drift, but an authored PR's line count is a
 * verified fact about this session's output. Nothing on screen announces a tie,
 * so this story is where the rule is legible at all.
 */
export const AuthoredPullRequestsWinTies: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 51,
      linesRemoved: 5,
      authoredPrLinesChanged: 4004,
      branchDiffStats: {
        linesAdded: 3315,
        linesRemoved: 689,
        filesChanged: 42,
        source: "git",
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("4,004")).toBeVisible();
    await expect(canvas.getByText("in PRs")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("branch total");
  },
};

/**
 * ISS-5402, and the case most likely to be mistaken for a bug: a delegating
 * session whose own scalars now carry its folded sub-agents' authored lines, so
 * they exceed BOTH shipped-code signals (golden f7441d99 went 345 -> 5,313 on
 * that fold).
 *
 * Largest-wins is deliberate — the row must never understate — so this
 * legitimately resolves to the session rung with a big number. What it must not
 * do is borrow a shipped-code caption for it: `+4,306 -1,007 in session` is
 * true, `in PRs` or `branch total` would not be.
 */
export const DelegatedFoldExceedsShippedSignals: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 4306,
      linesRemoved: 1007,
      authoredPrLinesChanged: 900,
      branchDiffStats: {
        linesAdded: 300,
        linesRemoved: 45,
        filesChanged: 19,
        source: "git",
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+4,306")).toBeVisible();
    await expect(canvas.getByText("in session")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("in PRs");
  },
};

/**
 * A session that only added — a scaffolding or docs run. The `-0` stays, and
 * that is the right call: it is a MEASURED zero, and dropping it would leave the
 * row visually indistinguishable from a shape that has no removal side at all.
 */
export const AdditionsOnly: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 372,
      linesRemoved: 0,
      authoredPrLinesChanged: 0,
    }),
  },
};

/**
 * The mirror: a deletion-only run, which is what a dead-code sweep looks like.
 * Worth its own canvas because it is the case where a reader most wants to be
 * sure the sign is real rather than a formatting artefact.
 */
export const DeletionsOnly: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 0,
      linesRemoved: 1288,
      authoredPrLinesChanged: 0,
    }),
  },
};

/**
 * A genuine, measured zero — a session that ran, cost money, and wrote no code.
 * It renders `+0 -0 in session`, not a dash and not a blank.
 *
 * Read this one against {@link UnmeasuredIsIndistinguishableFromZero}, which is
 * the SAME canvas from different data. The pair is the point: this row cannot
 * currently tell a measured zero from an absent measurement, so neither can a
 * reader.
 */
export const MeasuredZero: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 0,
      linesRemoved: 0,
      authoredPrLinesChanged: 0,
      branchDiffStats: null,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+0")).toBeVisible();
    await expect(canvas.getByText("-0")).toBeVisible();
    await expect(canvas.getByText("in session")).toBeVisible();
  },
};

/**
 * NOTHING was measured — and the row says `+0 -0 in session` anyway.
 *
 * `linesAdded` and `linesRemoved` are `number | null | undefined` on
 * `AgentSessionDetail`, and `sessionOutputDiffDisplay` coerces every rung with
 * `?? 0`, so an absent measurement resolves to the working-tree shape carrying
 * two zeros. `session-properties-panel.tsx` renders this row unconditionally, so
 * the state is reachable rather than theoretical: any producer that has not
 * populated the scalars — a live session before its first transcript fold, a
 * version-skewed desktop build — lands here.
 *
 * This story asserts the CONFLATION, not an endorsement of it. It renders
 * byte-for-byte identically to {@link MeasuredZero}, which is precisely the
 * "unavailable vs a real zero must be visibly distinct" failure `packages/app`
 * names as a documented failure mode for these surfaces, and which the sibling
 * `sessions-summary-cards-loading` and `error-propagation-map` stories exist to
 * hold the line on. Distinguishing the two means changing what
 * `SessionOutputDiff` RENDERS — a perceivable UI change, so it needs its own
 * flagged change rather than riding in a story backfill. Until then this canvas
 * is the standing evidence, and the day the row learns to say "not measured"
 * this `play` fails and brings the caption with it.
 */
export const UnmeasuredIsIndistinguishableFromZero: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: null,
      linesRemoved: null,
      authoredPrLinesChanged: null,
      branchDiffStats: null,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+0")).toBeVisible();
    await expect(canvas.getByText("-0")).toBeVisible();
    // The scope qualifier is the tell: the row does not merely print zeros, it
    // affirmatively captions them "in session" — claiming a measurement of this
    // session's churn that was never taken.
    await expect(canvas.getByText("in session")).toBeVisible();
  },
};

/**
 * A version-skewed producer: an older desktop build that emits the session
 * scalars and neither of the richer fields. Both are optional and additive, so
 * they coerce to 0 and the row falls back to the session shape rather than
 * rendering an empty value.
 *
 * The point of the story is that this degrades to a NORMAL row. A reader on an
 * older client should not be able to tell the difference, and nothing here
 * should hint that a field is missing.
 */
export const VersionSkewedProducer: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 50,
      linesRemoved: 10,
      authoredPrLinesChanged: undefined,
      branchDiffStats: undefined,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+50")).toBeVisible();
    await expect(canvas.getByText("in session")).toBeVisible();
  },
};

/**
 * Monorepo-scale numbers. Two grouped seven-figure figures plus the qualifier
 * all have to share one value track, which is where this row either wraps
 * cleanly or runs into its label — narrow the canvas and that is what to watch.
 *
 * Not contrived: a long-lived branch diff reaches seven figures on a
 * generated-code or lockfile-heavy change, and that is exactly when a reader is
 * squinting at the row. The grouping separators are load-bearing at this
 * magnitude — `1284301` and `1,284,301` are not equally readable numbers.
 */
export const CrowdedValueTrack: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      linesAdded: 51,
      linesRemoved: 5,
      authoredPrLinesChanged: 0,
      branchDiffStats: {
        linesAdded: 1_284_301,
        linesRemoved: 998_220,
        filesChanged: 3184,
        source: "git",
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("+1,284,301")).toBeVisible();
    await expect(canvas.getByText("-998,220")).toBeVisible();
    await expect(canvas.getByText("branch total")).toBeVisible();
  },
};
