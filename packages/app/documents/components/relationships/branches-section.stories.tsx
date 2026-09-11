/**
 * ISS-5508: the Build section's empty state is the one place the run-in-flight
 * explanation renders OUTSIDE a menu — a plain button plus a visible reason
 * line — and it is the awkward state to reach by hand, because it needs the
 * poll and the rollout flag both in the right position at once (PR #4714
 * review, wongk).
 *
 * The three stories are a gradient over one axis, so the visual difference the
 * ticket is about is legible side by side rather than described:
 * nothing running, a run in flight WITHOUT the flag (the shipped pre-ISS-5508
 * treatment — greys out, says nothing), and a run in flight WITH it.
 *
 * `branches-section.test.tsx` / `branches-section-run-in-flight.test.tsx` pin
 * the behavior and the accessible contract; these pin the rendered shape those
 * assertions cannot see.
 */

import {
  type ArtifactLinkEndpoint,
  type ArtifactLinkWithEndpoints,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
  type PullRequestDetail,
} from "@repo/api/src/types/artifact";
import {
  ChecksStatus,
  ReviewDecision,
} from "@repo/api/src/types/branch-checks";
import type { GenerationStatus } from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github";
import { RunLoopCommand } from "@repo/api/src/types/loop";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import { ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { BranchesSection } from "./branches-section";

const DOCUMENT_ID = "iss-5508-story-document";
const PROJECT_ID = "iss-5508-story-project";
const PLAN_ID = "iss-5508-story-plan";

/**
 * Seeded rather than left to the harness transport so the section renders its
 * zero-branch empty state deterministically — that is the only branch of the
 * component that owns "Start Building". Spelled through `artifactLinkKeys` with
 * the same argument shape `BranchesSection` passes to `useResolvedArtifactLinks`,
 * so a change to either drifts loudly instead of quietly missing the cache and
 * falling back to a fixture response.
 */
const NO_BRANCH_LINKS = [
  artifactLinkKeys.list({
    artifactId: DOCUMENT_ID,
    direction: LinkDirection.Target,
    linkType: undefined,
    maxDepth: undefined,
    mode: LinkQueryMode.Tree,
    resolved: true,
  }),
  [],
] as const;

const STORY_TIMESTAMP = new Date("2026-04-02T15:00:00Z");

const STORY_DOCUMENT_ENDPOINT: ArtifactLinkEndpoint = {
  id: DOCUMENT_ID,
  organizationId: "org-story",
  projectId: PROJECT_ID,
  type: ArtifactType.Document,
  subtype: null,
  name: "Branches Section story document",
  slug: "branches-section-story-document",
  status: "IN_PROGRESS",
  priority: null,
  assigneeId: null,
  dueDate: null,
  externalUrl: null,
  sortOrder: null,
  createdAt: STORY_TIMESTAMP,
  createdById: null,
  updatedAt: STORY_TIMESTAMP,
};

/** Builds one branch link with a realistic PR attached, or none at all. */
function branchLink(input: {
  id: string;
  branchName: string;
  pullRequest: PullRequestDetail | null;
}): ArtifactLinkWithEndpoints {
  return {
    id: `link-${input.id}`,
    organizationId: "org-story",
    sourceId: DOCUMENT_ID,
    targetId: input.id,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: STORY_TIMESTAMP,
    source: STORY_DOCUMENT_ENDPOINT,
    target: {
      id: input.id,
      organizationId: "org-story",
      projectId: PROJECT_ID,
      type: ArtifactType.Branch,
      subtype: null,
      name: input.branchName,
      slug: null,
      status: "OPEN",
      priority: null,
      assigneeId: null,
      dueDate: null,
      externalUrl: input.pullRequest?.htmlUrl ?? null,
      sortOrder: null,
      createdAt: STORY_TIMESTAMP,
      createdById: null,
      updatedAt: STORY_TIMESTAMP,
      branch: {
        branchName: input.branchName,
        currentPullRequest: input.pullRequest,
      },
    },
  };
}

/**
 * Three branches at the lifecycle stages a real document collects: a PR
 * still being reviewed, one still in draft, and one already merged. Seeded
 * the same way `NO_BRANCH_LINKS` is, so the populated state renders
 * deterministically instead of depending on the fixture transport.
 */
const POPULATED_BRANCH_LINKS = [
  artifactLinkKeys.list({
    artifactId: DOCUMENT_ID,
    direction: LinkDirection.Target,
    linkType: undefined,
    maxDepth: undefined,
    mode: LinkQueryMode.Tree,
    resolved: true,
  }),
  [
    branchLink({
      branchName: "agent/chart-legend-color-order",
      id: "branch-chart-legend",
      pullRequest: {
        baseBranch: "main",
        body: null,
        branchArtifactId: "branch-chart-legend",
        checksStatus: ChecksStatus.Passing,
        closedAt: null,
        githubId: "PR_story_1822",
        headBranch: "agent/chart-legend-color-order",
        headSha: "3f1c9a2",
        htmlUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1822",
        id: "pr-1822",
        isDraft: false,
        lastRefreshAttemptAt: STORY_TIMESTAMP,
        lastVerifiedAt: STORY_TIMESTAMP,
        mergeCommitSha: null,
        mergedAt: null,
        number: 1822,
        prState: GitHubPRState.Open,
        repositoryFullName: "closedloop-ai/closedloop-web",
        repositoryId: "repo-closedloop-web",
        reviewDecision: ReviewDecision.ChangesRequested,
        title: "Fix chart series legend color order",
      },
    }),
    branchLink({
      branchName: "agent/onboarding-empty-state-copy",
      id: "branch-onboarding-copy",
      pullRequest: {
        baseBranch: "main",
        body: null,
        branchArtifactId: "branch-onboarding-copy",
        checksStatus: ChecksStatus.Pending,
        closedAt: null,
        githubId: "PR_story_1825",
        headBranch: "agent/onboarding-empty-state-copy",
        headSha: "9b7e410",
        htmlUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1825",
        id: "pr-1825",
        isDraft: true,
        lastRefreshAttemptAt: STORY_TIMESTAMP,
        lastVerifiedAt: STORY_TIMESTAMP,
        mergeCommitSha: null,
        mergedAt: null,
        number: 1825,
        prState: GitHubPRState.Open,
        repositoryFullName: "closedloop-ai/closedloop-web",
        repositoryId: "repo-closedloop-web",
        reviewDecision: null,
        title: "Draft: rewrite onboarding empty-state copy",
      },
    }),
    branchLink({
      branchName: "agent/session-timeline-bar-labels",
      id: "branch-session-timeline",
      pullRequest: {
        baseBranch: "main",
        body: null,
        branchArtifactId: "branch-session-timeline",
        checksStatus: ChecksStatus.Passing,
        closedAt: null,
        githubId: "PR_story_1798",
        headBranch: "agent/session-timeline-bar-labels",
        headSha: "6a44dc8",
        htmlUrl: "https://github.com/closedloop-ai/closedloop-web/pull/1798",
        id: "pr-1798",
        isDraft: false,
        lastRefreshAttemptAt: STORY_TIMESTAMP,
        lastVerifiedAt: STORY_TIMESTAMP,
        mergeCommitSha: "e21fa90",
        mergedAt: STORY_TIMESTAMP,
        number: 1798,
        prState: GitHubPRState.Merged,
        repositoryFullName: "closedloop-ai/closedloop-web",
        repositoryId: "repo-closedloop-web",
        reviewDecision: ReviewDecision.Approved,
        title: "Add cost rail labels to the session timeline bar",
      },
    }),
  ],
] as const;

/** An execute run the poll reports as still going. */
const EXECUTE_RUNNING: GenerationStatus = {
  status: "RUNNING",
  command: RunLoopCommand.Execute,
  htmlUrl: null,
  startedAt: null,
  completedAt: null,
  correlationId: null,
};

/**
 * A collapsible Build panel listing the code branches built from a document,
 * each with a pull request status and a menu to unlink it, or a button to
 * start one.
 */
const meta = {
  title: "Composites/Documents/Branches Section",
  component: BranchesSection,
  tags: ["autodocs"],
  argTypes: {
    documentId: {
      control: false,
      description:
        "Keys the seeded link query in `parameters.appCore`; editing it drops the fixture and the empty state stops being deterministic.",
    },
    projectId: { control: false },
    planId: {
      control: "text",
      description:
        "Null swaps Start Building for the needs-an-approved-plan button.",
    },
    generationStatus: {
      control: "object",
      description:
        "An execute run in an active state is what closes the Start Building gate.",
    },
    onStartBuild: { control: false, table: { category: "Events" } },
  },
  args: {
    documentId: DOCUMENT_ID,
    onStartBuild: fn(),
    planId: PLAN_ID,
    projectId: PROJECT_ID,
  },
  parameters: {
    appCore: { queryData: [NO_BRANCH_LINKS] },
    layout: "padded",
  },
} satisfies Meta<typeof BranchesSection>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * An empty pull request list for the document, seeded so the populated story is
 * deterministic.
 *
 * `BranchesSection` runs a SECOND query beside the links one, gated on
 * `enabled: isOpen && hasBranches`. The empty stories never trip that gate, so
 * they were always stable; this populated story is the only one that does. Left
 * unseeded it raced the fixture transport and failed roughly one run in six.
 *
 * Empty rather than populated on purpose: each branch link already carries its
 * own `pullRequest`, which is what the rendered rows read. This query only
 * supplies the by-branch lookup, and nothing in this story needs it to be full.
 */
const NO_DOCUMENT_PULL_REQUESTS = [
  [...documentKeys.detail(DOCUMENT_ID), "pull-request"],
  [],
];

/** Three branches at different points in their pull request lifecycle. */
export const Default: Story = {
  parameters: {
    appCore: {
      queryData: [POPULATED_BRANCH_LINKS, NO_DOCUMENT_PULL_REQUESTS],
    },
  },
};

/** No branches and nothing running: "Start Building" is plainly available. */
export const EmptyState: Story = {};

/**
 * A run in flight with the rollout flag OFF — the treatment that shipped before
 * this change, and the control for the story below. The button greys out via
 * native `disabled` and no explanation exists anywhere on screen.
 */
export const RunInFlightUnexplained: Story = {
  args: { generationStatus: EXECUTE_RUNNING },
};

/**
 * The same run with the flag ON. The button swaps native `disabled` for
 * `aria-disabled` so it keeps focus and its `aria-describedby` target, and the
 * reason renders beneath it as ordinary accompanying text — not a banner (which
 * ISS-5474 removed) and not a `title` tooltip (which neither keyboard nor screen
 * reader can reach).
 */
export const RunInFlightExplained: Story = {
  args: { generationStatus: EXECUTE_RUNNING },
  parameters: {
    appCore: {
      enabledFlags: [ARTIFACT_RUN_ACTION_UNAVAILABLE_REASON_FEATURE_FLAG_KEY],
      queryData: [NO_BRANCH_LINKS],
    },
  },
};
