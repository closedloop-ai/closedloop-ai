import { monitoredActivityTargetUrl } from "@repo/api/src/types/monitored-activity-target";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import type { Meta, StoryObj } from "@storybook/react";
import { SessionOtherRepositoriesRow } from "./session-other-repositories-row";
import { SessionPropertiesFrame } from "./session-properties-story-frame";

// Each url is the one the server derives from the target, so a linked pill
// carries exactly the href production would serve.
function linkedPullRequest(
  repositoryFullName: string,
  prNumber: number
): SessionUntrackedRepositoryTarget {
  const target = {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName,
    prNumber,
  } as const;
  const url = monitoredActivityTargetUrl(target);
  return url === undefined ? target : { ...target, url };
}

function linkedBranch(
  repositoryFullName: string,
  branchName: string
): SessionUntrackedRepositoryTarget {
  const target = {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName,
    branchName,
  } as const;
  const url = monitoredActivityTargetUrl(target);
  return url === undefined ? target : { ...target, url };
}

// No controls: `targets` is the only prop and each story's fixture is the point.
const meta = {
  title: "Primitives v1.0/Data Display/Session Other Repositories Row",
  component: SessionOtherRepositoriesRow,
  tags: ["deprecated", "autodocs"],
  parameters: {
    layout: "padded",
  },
  decorators: [
    (Story) => (
      <SessionPropertiesFrame>
        <Story />
      </SessionPropertiesFrame>
    ),
  ],
} satisfies Meta<typeof SessionOtherRepositoriesRow>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Every entry carries its derived url, so every pill is an external link. */
export const Linked: Story = {
  args: {
    targets: [
      linkedPullRequest("prisma/prisma-engines", 5860),
      linkedPullRequest("prisma/prisma-engines", 5861),
    ],
  },
};

/**
 * No url reaches the row: `..` names no location a URL can express, and the
 * server drops a stored url that is not the target's own derivation, so both
 * render as the same chip in inert text.
 */
export const PlainText: Story = {
  args: {
    targets: [
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "..",
        prNumber: 7,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "acme/other",
        prNumber: 8,
      },
    ],
  },
};

/** A repository and branch name too long for the value track: the pill wraps. */
export const LongRepositoryName: Story = {
  args: {
    targets: [
      linkedBranch(
        "acme-platform-infrastructure/terraform-aws-organization-baseline-modules",
        "worktree-iss-9182-untracked-repository-long-synthetic-branch-name"
      ),
      linkedPullRequest(
        "acme-platform-infrastructure/terraform-aws-organization-baseline-modules",
        12_345
      ),
    ],
  },
};

/** Pull request and branch targets side by side, told apart by their icon. */
export const MixedPullRequestAndBranch: Story = {
  args: {
    targets: [
      linkedBranch("acme/vendored", "fix/upstream"),
      linkedPullRequest("prisma/prisma-engines", 5860),
      linkedBranch("prisma/prisma-engines", "main"),
    ],
  },
};
