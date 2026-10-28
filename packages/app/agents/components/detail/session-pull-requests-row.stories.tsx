import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { SessionOutputDiff } from "./session-output-diff";
import { SessionPullRequestsRow } from "./session-pull-requests-row";

/**
 * Recreates the production ancestry these rows actually render in: every rule
 * that sizes them — the `.prd-prop` label/value grid, the wrapping
 * `.sd3-prs-value`, and the `.prd-prop-value > span` `white-space: nowrap;
 * overflow: hidden` the empty-state label has to survive — is defined under
 * `.sd3-props` in styles-session-detail-props.css. Without this frame the stories
 * render unstyled and the one thing worth putting on a canvas (do the two rows
 * read as one reconciled statement, at a real width?) is invisible.
 *
 * ISS-4769 is a contradiction BETWEEN two rows, so the frame renders both — the
 * "Pull requests" row under review and the "Lines changed" row it has to
 * reconcile with. Judging the copy on the PR row alone would miss the point.
 *
 * ISS-9964 / ISS-9980 (RULED 2026-09-11) changed what the second row prints: it
 * is now the lines landed in MERGED authored PRs, not the session's local churn,
 * so the merged count is the frame's parameter rather than a fixed `+420 -80`.
 * That makes the two rows describe ONE population, which is the reconciliation
 * this canvas now exists to judge — and it is why the empty state below reads a
 * measured `0` instead of a five-hundred-line figure arguing with "None".
 *
 * The `.prd-props` grid is `auto-fit, minmax(min(100%, 300px), 1fr)` inside the
 * detail pane's max width, so the frame is capped to a single ~432px column — the
 * narrower of the two shipped column widths, which is where the labels are
 * tightest.
 */
function PropertiesFrame({
  children,
  mergedAuthoredPrLinesChanged,
}: Readonly<{
  children: ReactNode;
  mergedAuthoredPrLinesChanged: number | null;
}>) {
  return (
    <section className="prd-props-section sd3-props" data-open="true">
      <div className="prd-props" style={{ maxWidth: "432px" }}>
        {children}
        <div className="prd-prop">
          <span className="prd-prop-label">Lines changed</span>
          <div className="prd-prop-value">
            <SessionOutputDiff session={{ mergedAuthoredPrLinesChanged }} />
          </div>
        </div>
      </div>
    </section>
  );
}

const meta = {
  title: "Primitives v1.0/Data Display/Session Pull Requests Row",
  component: SessionPullRequestsRow,
  tags: ["deprecated", "autodocs"],
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionPullRequestsRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * ISS-4769, as shipped — the state this change exists for. One word narrows the
 * row's claim to what its lane actually computed.
 *
 * Under ISS-9964 the two rows no longer argue at all: a session that authored no
 * PRs merged no lines, so "None authored" sits beside a measured `0 in merged
 * PRs` and both sentences describe the same population. The canvas is still
 * worth keeping because that agreement is a COPY judgment — two true statements
 * can still read as a contradiction — and because `0` and the not-available
 * placeholder must stay visibly different at a real width.
 */
export const EmptyAuthoredNone: Story = {
  args: { prs: [], repositoryFullName: "closedloop-ai/closedloop-ai" },
  decorators: [
    (Story) => (
      <PropertiesFrame mergedAuthoredPrLinesChanged={0}>
        <Story />
      </PropertiesFrame>
    ),
  ],
};

/**
 * The unresolved numerator, which is a DIFFERENT state from the `0` above and
 * has to look like one: a desktop session before its first cloud sync, or
 * ISS-4448's session whose merged PRs have no reachable per-PR LOC rows. The row
 * prints the shared not-available placeholder rather than a `0` that would claim
 * a measurement nobody took (ISS-9980, RULED 2026-09-11).
 */
export const EmptyAuthoredUnavailableLines: Story = {
  args: { prs: [], repositoryFullName: "closedloop-ai/closedloop-ai" },
  decorators: [
    (Story) => (
      <PropertiesFrame mergedAuthoredPrLinesChanged={null}>
        <Story />
      </PropertiesFrame>
    ),
  ],
};

/**
 * The populated row: the copy is an EMPTY-state label only, so a session with
 * attributed PRs renders no empty-state text at all. Pinned on a canvas because
 * "the label never appears here" is easy to assert in a test and easy to get
 * wrong in the markup.
 *
 * The pills are deliberately one MERGED and one OPEN against a merged-lines
 * figure that counts only the first. Since ISS-9964 the number beside them
 * describes a narrower population than the pills do, and whether that reads
 * honestly — rather than as "500 lines across these two PRs" — is a copy
 * judgment this canvas exists to make.
 */
export const WithAttributedPrs: Story = {
  args: {
    prs: [
      { num: 4246, title: "One Authored gate", status: "merged" },
      { num: 4249, title: "Drop unused pricing tables", status: "open" },
    ],
    repositoryFullName: "closedloop-ai/closedloop-ai",
  },
  decorators: [
    (Story) => (
      <PropertiesFrame mergedAuthoredPrLinesChanged={500}>
        <Story />
      </PropertiesFrame>
    ),
  ],
};
