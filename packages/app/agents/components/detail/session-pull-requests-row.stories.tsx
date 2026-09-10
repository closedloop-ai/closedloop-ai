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
 * The `.prd-props` grid is `auto-fit, minmax(min(100%, 300px), 1fr)` inside the
 * detail pane's max width, so the frame is capped to a single ~432px column — the
 * narrower of the two shipped column widths, which is where the labels are
 * tightest.
 */
function PropertiesFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section className="prd-props-section sd3-props" data-open="true">
      <div className="prd-props" style={{ maxWidth: "432px" }}>
        {children}
        <div className="prd-prop">
          <span className="prd-prop-label">Lines changed</span>
          <div className="prd-prop-value">
            <SessionOutputDiff
              session={{
                linesAdded: 420,
                linesRemoved: 80,
                authoredPrLinesChanged: 0,
              }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

const meta = {
  title: "Primitives/Data Display/Session Pull Requests Row",
  component: SessionPullRequestsRow,
  tags: ["autodocs"],
  argTypes: {
    prs: { control: "object" },
    repositoryFullName: { control: "text" },
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SessionPullRequestsRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * ISS-4769, as shipped — the state this change exists for. One word narrows the
 * row's claim to what its lane actually computed, and the two rows stop arguing:
 * this session opened no PRs, and it still changed 500 lines. The bare "None"
 * this replaced read as "nothing was delivered" beside that "+420 -80 in
 * session" figure, which is the contradiction the canvas exists to judge.
 */
export const EmptyAuthoredNone: Story = {
  args: { prs: [], repositoryFullName: "closedloop-ai/symphony-alpha" },
  decorators: [
    (Story) => (
      <PropertiesFrame>
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
 */
export const WithAttributedPrs: Story = {
  args: {
    prs: [
      { num: 4246, title: "One Authored gate", status: "merged" },
      { num: 4249, title: "Drop unused pricing tables", status: "open" },
    ],
    repositoryFullName: "closedloop-ai/symphony-alpha",
  },
  decorators: [
    (Story) => (
      <PropertiesFrame>
        <Story />
      </PropertiesFrame>
    ),
  ],
};
