import type { Meta, StoryObj } from "@storybook/react";
import { FileDiffIcon } from "lucide-react";
import { expect, within } from "storybook/test";
import { createAgentSessionDetailFixture } from "./agent-session-detail-fixtures";
import { PropertyValue } from "./property-values";
import { SessionOutputDiff } from "./session-output-diff";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

/**
 * ISS-5698 / ISS-9964 / ISS-9980: the Properties pane's "Lines changed" value,
 * isolated.
 *
 * ISS-9980 (RULED 2026-09-11) reduced this row to ONE measured population — the
 * lines landed in MERGED authored PRs — so the three-scope canvas set this file
 * used to carry (session churn, branch total, the legacy "in PRs" caption, and
 * the flag-gate pair) documents shapes that no longer exist. What is left to
 * check visually is the distinction the ruling turns on, and it is the one a
 * number alone cannot carry: a `0` this row MEASURED and a value it could not
 * measure must not render as the same glyph. Read {@link MergedZero} and
 * {@link NotAvailable} side by side — that pair is the whole point of the set,
 * and it is the fix for the conflation the retired
 * `UnmeasuredIsIndistinguishableFromZero` canvas stood as evidence of.
 *
 * Each story mounts the shared fixture through the production `PropertyValue`
 * row inside the shipped `.sd3-props` frame, because the colour tokens and the
 * value track are defined by that ancestry — a row rendered bare is a row
 * rendered unstyled.
 */

const meta = {
  title: "Primitives v1.0/Content/Session Output Diff",
  component: SessionOutputDiff,
  tags: ["deprecated", "autodocs"],
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
 * The shipped shape: a single `additions + deletions` roll-up over the session's
 * merged authored PRs, and deliberately NOT coloured.
 *
 * There is no honest per-side breakdown to split a combined figure into, so it
 * renders at plain foreground weight. If this story ever shows a green number,
 * the roll-up has been mis-taught as an addition.
 */
export const MergedPullRequests: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      mergedAuthoredPrLinesChanged: 8000,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("8,000")).toBeVisible();
    await expect(canvas.getByText("in merged PRs")).toBeVisible();
  },
};

/**
 * A genuine, measured zero — a session that ran, cost money, and landed nothing.
 * It renders `0 in merged PRs`, not a dash and not a blank, because that is a
 * fact about the population rather than a gap in it.
 *
 * Read it against {@link NotAvailable}: the pair is the distinction ISS-9980
 * ruled on, and this canvas is where it is legible at all.
 */
export const MergedZero: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      mergedAuthoredPrLinesChanged: 0,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("0")).toBeVisible();
    await expect(canvas.getByText("in merged PRs")).toBeVisible();
  },
};

/**
 * Nothing was measured, and the row now says so.
 *
 * Reachable rather than theoretical: a desktop session before its first cloud
 * sync carries no per-PR LOC at all, and ISS-4448's session has 88 merged PRs
 * whose per-PR rows are unreachable. Both used to land on a confident number.
 * The `—` plus "not available" is what stops this canvas rendering
 * byte-for-byte identically to {@link MergedZero}.
 */
export const NotAvailable: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      mergedAuthoredPrLinesChanged: null,
      authoredPrLinesChanged: null,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("not available")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("in merged PRs");
  },
};

/**
 * A version-skewed producer sending only the pre-rename ISS-6114 key. That key
 * predates the merge gate, so its figure describes a WIDER population than this
 * row claims — the honest answer is the unavailable state, not the number under
 * a label it cannot keep.
 */
export const LegacyFieldOnly: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      mergedAuthoredPrLinesChanged: null,
      authoredPrLinesChanged: 8000,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("not available")).toBeVisible();
    await expect(canvasElement).not.toHaveTextContent("8,000");
  },
};

/**
 * Monorepo-scale numbers. The seven-figure total plus the qualifier share one
 * value track, which is where this row either wraps cleanly or runs into its
 * label — narrow the canvas and that is what to watch. The grouping separators
 * are load-bearing at this magnitude: `1284301` and `1,284,301` are not equally
 * readable numbers.
 */
export const CrowdedValueTrack: Story = {
  args: {
    session: createAgentSessionDetailFixture({
      mergedAuthoredPrLinesChanged: 1_284_301,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("1,284,301")).toBeVisible();
    await expect(canvas.getByText("in merged PRs")).toBeVisible();
  },
};
