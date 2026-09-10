import type { SessionPR } from "@repo/api/src/types/agent-session";
import { SessionPrLifecycleStatus } from "@repo/api/src/types/agent-session";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { PullRequestPill } from "./session-pull-request-pill";

const FIXTURE_REPO = "closedloop-ai/symphony-alpha" as const;

function makePullRequest(overrides: Partial<SessionPR> = {}): SessionPR {
  return {
    num: 4231,
    status: SessionPrLifecycleStatus.Merged,
    title:
      "Make session-detail linked-artifact and PR pills read as real links",
    ...overrides,
  };
}

// Same production scope the sibling row story recreates: the pill's styling
// (`.sd3-result-pr`, the `a.sd3-result-pr` link color, the `:focus-visible`
// ring) is all defined under `.sd3-props` in styles-session-detail-props.css, so
// without this ancestor the stories render unstyled and the linked-vs-inert
// distinction — the whole point of putting this on a canvas — disappears.
function PullRequestPillFrame({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <section className="prd-props-section sd3-props" data-open="true">
      <div className="prd-props">
        <div className="prd-prop">
          <span className="prd-prop-label">Pull requests</span>
          <div className="prd-prop-value sd3-prs-value">{children}</div>
        </div>
      </div>
    </section>
  );
}

const meta = {
  title: "Composites/Sessions/Detail/Session Pull Request Pill",
  component: PullRequestPill,
  tags: ["autodocs"],
  argTypes: {
    pr: { control: "object" },
    repositoryFullName: { control: "text" },
  },
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <PullRequestPillFrame>
        <Story />
      </PullRequestPillFrame>
    ),
  ],
} satisfies Meta<typeof PullRequestPill>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The resolved case: the repository is known and the number is a real PR number,
 * so the pill is an external link to GitHub. It is link-colored at rest — that
 * is the affordance, not a hover-only reveal — and Tab reveals the focus ring.
 * Hover or focus it to read the tooltip.
 */
export const Linked: Story = {
  args: {
    pr: makePullRequest(),
    repositoryFullName: FIXTURE_REPO,
  },
};

/**
 * No repository resolved for the session, so there is nothing to link against.
 * The pill stays an inert label — deliberately muted rather than link-colored,
 * so it does not advertise a destination it does not have — and its tooltip
 * explains why instead of leaving the reader to compare two identical chips.
 */
export const UnresolvedRepository: Story = {
  args: {
    pr: makePullRequest(),
    repositoryFullName: null,
  },
};

/**
 * The repository resolved but the reference carries no usable PR number, which
 * is a different problem from the story above and gets its own tooltip reason.
 */
export const UnusablePullRequestNumber: Story = {
  args: {
    pr: makePullRequest({ num: 0 }),
    repositoryFullName: FIXTURE_REPO,
  },
};

/**
 * `unknown` is the projection's sentinel for "we could not verify the
 * lifecycle", not a GitHub state — so the tooltip says "status not verified"
 * rather than dressing it up as "(Unknown)" mid-sentence.
 */
export const UnverifiedStatus: Story = {
  args: {
    pr: makePullRequest({ status: SessionPrLifecycleStatus.Unknown }),
    repositoryFullName: FIXTURE_REPO,
  },
};

/**
 * A multi-word status. `.sd3-result-status` capitalizes every word, so the
 * tooltip title-cases every word too — the two must not disagree a pixel apart.
 */
export const MultiWordStatus: Story = {
  args: {
    pr: makePullRequest({ status: "changes requested" }),
    repositoryFullName: FIXTURE_REPO,
  },
};

/**
 * A PR whose GitHub subject never resolved. The projection fills the title with
 * the literal `PR #<num>` placeholder, so the tooltip drops it rather than
 * echoing the stand-in back as though it were the subject.
 */
export const NoResolvedSubject: Story = {
  args: {
    pr: makePullRequest({ title: "PR #4231" }),
    repositoryFullName: FIXTURE_REPO,
  },
};

/**
 * An unbounded subject off the wire, truncated so one long PR title cannot
 * become the entire tooltip.
 */
export const LongSubjectTruncated: Story = {
  args: {
    pr: makePullRequest({
      title:
        "Reconcile the session-detail Properties pane pill treatment with the Branch delivered rows, publish the link token, and bring every inert chip onto one disclosure behavior",
    }),
    repositoryFullName: FIXTURE_REPO,
  },
};
