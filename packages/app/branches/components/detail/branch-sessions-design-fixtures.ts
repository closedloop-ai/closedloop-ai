// gardener-support: test and story data, not shipped
import {
  type BranchPageDetail,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchTraceCompletenessState,
  type BranchTraceResult,
  BranchTraceSessionHydrationState,
} from "@repo/api/src/types/branch-trace";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  makeBranchDetail,
  makeBranchSession,
} from "../../__tests__/branch-fixtures";
import { completeMetrics } from "../branch-story-metric-fixtures";

/**
 * ISS-12576: a full Sessions tab for the Branch, Document and Issue design
 * pages, so each shows everything the live tab can draw (Nerys, 2026-10-22).
 * Modelled on real closedloop-ai sessions from 2026-10-21/22: a build
 * session with subagents and a failed test run, a review on a second
 * machine, the merge-queue run and a short follow-up that overlaps it.
 *
 * Every element the merged trace carries appears at least once: a new, a
 * resumed and a CI session start, prompts and replies with running cost,
 * tool runs (one with a failure), subagents with their own cost, git (green),
 * info (blue) and error (red) events with tags, an idle gap and each
 * session's end. People are placeholders, as in the other design fixtures;
 * the work is this repository's own (placeholder-copy exception, Nerys
 * 2026-10-15).
 */

const BUILD = "design-ses-build";
const REVIEW = "design-ses-review";
const LAND = "design-ses-land";
const FOLLOW_UP = "design-ses-follow-up";

const SESSIONS = [
  {
    id: BUILD,
    slug: "SES-98092",
    name: "Issue detail canvas toolbar",
    owner: "Morgan Fixture",
    harness: "claude",
    startedAt: "2026-10-21T09:02:00.000Z",
    endedAt: "2026-10-21T10:48:00.000Z",
    costUsd: 18.4,
    tokens: {
      input: 2412,
      output: 186_540,
      cacheRead: 41_220_310,
      cacheWrite: 1_204_880,
    },
  },
  {
    id: REVIEW,
    slug: "SES-98102",
    name: "Review the canvas toolbar PR",
    owner: "Alice Fixture",
    harness: "codex",
    startedAt: "2026-10-21T11:10:00.000Z",
    endedAt: "2026-10-21T11:52:00.000Z",
    costUsd: 6.1,
    tokens: {
      input: 980,
      output: 42_310,
      cacheRead: 9_812_400,
      cacheWrite: 310_220,
    },
  },
  {
    id: LAND,
    slug: "SES-98207",
    name: "PR babysitting and landing",
    owner: "Morgan Fixture",
    harness: "claude",
    startedAt: "2026-10-21T12:05:00.000Z",
    endedAt: "2026-10-21T12:40:00.000Z",
    costUsd: 3.25,
    tokens: {
      input: 310,
      output: 12_880,
      cacheRead: 4_120_700,
      cacheWrite: 96_400,
    },
  },
  {
    id: FOLLOW_UP,
    slug: "SES-98268",
    name: "Storybook 7.0.1 version history",
    owner: "Priya Fixture",
    harness: "claude",
    startedAt: "2026-10-21T12:15:00.000Z",
    endedAt: "2026-10-21T12:31:00.000Z",
    costUsd: 2.15,
    tokens: {
      input: 204,
      output: 9640,
      cacheRead: 2_310_900,
      cacheWrite: 71_350,
    },
  },
] as const;

export const designSessionsDetail: BranchPageDetail = makeBranchDetail({
  id: "design-sessions-branch",
  branchName: "iss-12576-issue-detail-revision",
  repoFullName: "closedloop-ai/closedloop-ai",
  status: BranchStatus.Merged,
  prNumber: 9129,
  prTitle: "ISS-12576: Issue detail revision from the 21 Oct review",
  prState: GitHubPRState.Merged,
  prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/9129",
  additions: 1184,
  deletions: 412,
  estimatedCostUsd: SESSIONS.reduce((sum, session) => sum + session.costUsd, 0),
  lastActivityAt: "2026-10-21T12:40:00.000Z",
  sessionIds: SESSIONS.map((session) => session.id),
  openedAt: "2026-10-21T10:41:00.000Z",
  closedAt: "2026-10-21T12:31:00.000Z",
  mergedAt: "2026-10-21T12:31:00.000Z",
  sessions: SESSIONS.map((session, index) =>
    makeBranchSession({
      sessionId: session.id,
      slug: session.slug,
      name: session.name,
      harness: session.harness,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      isPrimary: index === 0,
      estimatedCostUsd: session.costUsd,
      inputTokens: session.tokens.input,
      outputTokens: session.tokens.output,
      cacheReadTokens: session.tokens.cacheRead,
      cacheWriteTokens: session.tokens.cacheWrite,
      ownerUserName: session.owner,
    })
  ),
  canonicalMetrics: completeMetrics(),
});

const MINUTE = 60_000;

/** A time `minutes` into the session that started at `startedAt`. */
function at(startedAt: string, minutes: number) {
  return {
    t: new Date(Date.parse(startedAt) + minutes * MINUTE).toISOString(),
    tMs: minutes * MINUTE,
  };
}

const [build, review, land, followUp] = SESSIONS;

const BUILD_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: BUILD,
    t: build.startedAt,
    actor: { name: build.owner, harness: "claude", isNew: true },
  },
  {
    type: "prompt",
    sessionId: BUILD,
    ...at(build.startedAt, 1),
    cumCostUsd: 0.12,
    actorName: build.owner,
    text: "Move the issue's key fields into a toolbar at the top of the canvas, Artifact tab only, and order the canvas: issue text, sub-issues, branch, activity summary.",
  },
  {
    type: "tools",
    sessionId: BUILD,
    ...at(build.startedAt, 2),
    endMs: 6 * MINUTE,
    summary: "Ran 6 tools · 1 bash · 4 read · 1 tool",
    hasFail: false,
    failN: 0,
    items: [
      {
        label: "Read",
        detail:
          "packages/app/issues/components/detail-design/issue-detail-design-preview.tsx",
        err: false,
      },
      {
        label: "Read",
        detail: "packages/app/documents/components/editor-toolbar-row.tsx",
        err: false,
      },
      {
        label: "Read",
        detail:
          "packages/app/issues/components/status-strip/issue-status-strip.tsx",
        err: false,
      },
      {
        label: "Read",
        detail:
          "apps/storybook/stories/surfaces-v2/v2-issue-detail.stories.tsx",
        err: false,
      },
      { label: "Grep", detail: "belowTabs", err: false },
      { label: "Bash", detail: "git log --oneline -5 origin/main", err: false },
    ],
  },
  {
    type: "say",
    sessionId: BUILD,
    ...at(build.startedAt, 7),
    cumCostUsd: 2.4,
    actorName: "Claude",
    text: "The strip already reuses the document metadata bar. I'll wrap it in the editor's toolbar row, make it sticky inside the canvas card and drop the shell's below-tabs slot.",
  },
  {
    type: "subagent",
    sessionId: BUILD,
    ...at(build.startedAt, 9),
    sub: "Explore: find every story that asserts the status strip sits under the tabs",
    model: "claude-haiku-5-5",
    costUsd: 0.84,
    costDeltaUsd: 0.84,
    cumCostUsd: 3.24,
  },
  {
    type: "tools",
    sessionId: BUILD,
    ...at(build.startedAt, 24),
    endMs: 41 * MINUTE,
    summary: "Ran 9 tools · 3 bash · 1 read · 5 tool",
    hasFail: true,
    failN: 1,
    items: [
      { label: "Edit", detail: "issue-detail-design-preview.tsx", err: false },
      { label: "Edit", detail: "document-detail-design-shell.tsx", err: false },
      { label: "Edit", detail: "pr-comment-markdown.tsx", err: false },
      { label: "Edit", detail: "linked-work-card.tsx", err: false },
      {
        label: "Write",
        detail: "issue-detail-design-preview.test.tsx",
        err: false,
      },
      {
        label: "Read",
        detail: "artifact-linked-artifacts-table.tsx",
        err: false,
      },
      { label: "Bash", detail: "pnpm exec biome check --write", err: false },
      {
        label: "Bash",
        detail: "pnpm exec vitest run issues/components/detail-design",
        err: true,
      },
      {
        label: "Bash",
        detail: "pnpm exec vitest run issues/components/detail-design",
        err: false,
      },
    ],
  },
  {
    type: "event",
    sessionId: BUILD,
    t: at(build.startedAt, 33).t,
    dot: "r",
    text: "vitest: 1 failed · region order expected Sub-issues before Branch",
    tag: "test",
  },
  {
    type: "say",
    sessionId: BUILD,
    ...at(build.startedAt, 42),
    cumCostUsd: 11.9,
    actorName: "Claude",
    text: "Fixed the order test: it now compares each region's position in the document instead of a bitwise mask. 97 tests pass.",
  },
  {
    type: "idle",
    sessionId: BUILD,
    t: at(build.startedAt, 43).t,
    gapMs: 38 * MINUTE,
  },
  {
    type: "prompt",
    sessionId: BUILD,
    ...at(build.startedAt, 81),
    cumCostUsd: 12.1,
    actorName: build.owner,
    text: "Looks right. Bump Storybook to 7.0.1, then commit and open the PR.",
  },
  {
    type: "subagent",
    sessionId: BUILD,
    ...at(build.startedAt, 84),
    sub: "code-review: bug hunter over the staged diff",
    model: "claude-sonnet-5-5",
    costUsd: 2.65,
    costDeltaUsd: 2.65,
    cumCostUsd: 15.2,
  },
  {
    type: "event",
    sessionId: BUILD,
    t: at(build.startedAt, 97).t,
    dot: "g",
    text: "Committed 4becd04 · ISS-12576: Issue detail revision from the 21 Oct review",
    tag: "commit",
  },
  {
    type: "event",
    sessionId: BUILD,
    t: at(build.startedAt, 99).t,
    dot: "g",
    text: "Opened pull request #9129",
    tag: "PR",
  },
  {
    type: "say",
    sessionId: BUILD,
    ...at(build.startedAt, 104),
    cumCostUsd: build.costUsd,
    actorName: "Claude",
    text: "PR #9129 is open with Storybook 7.0.1. Story counts come from the index: Composites 86/637, Surfaces 61/335.",
  },
  { type: "end", sessionId: BUILD, text: "Session ended" },
];

const REVIEW_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: REVIEW,
    t: review.startedAt,
    actor: {
      name: review.owner,
      harness: "codex",
      isResumed: true,
      machine: "alice-mbp",
    },
  },
  {
    type: "prompt",
    sessionId: REVIEW,
    ...at(review.startedAt, 1),
    cumCostUsd: 0.2,
    actorName: review.owner,
    text: "Review #9129. Focus on the comment rail guard and the highlight ranges.",
  },
  {
    type: "tools",
    sessionId: REVIEW,
    ...at(review.startedAt, 2),
    endMs: 14 * MINUTE,
    summary: "Ran 5 tools · 1 bash · 4 read",
    hasFail: false,
    failN: 0,
    items: [
      { label: "Bash", detail: "gh pr diff 9129", err: false },
      { label: "Read", detail: "document-detail-design-shell.tsx", err: false },
      { label: "Read", detail: "pr-comment-markdown.tsx", err: false },
      { label: "Read", detail: "use-design-comments-rail.ts", err: false },
      { label: "Read", detail: "issue-card.tsx", err: false },
    ],
  },
  {
    type: "say",
    sessionId: REVIEW,
    ...at(review.startedAt, 18),
    cumCostUsd: 4.3,
    actorName: "Codex",
    text: "Two findings. Add comment shows where the rail is not mounted, so it opens nothing at 1024px. Overlapping quotes split the text twice and only the first is marked.",
  },
  {
    type: "event",
    sessionId: REVIEW,
    t: at(review.startedAt, 31).t,
    dot: "b",
    text: "Requested changes on #9129 · 2 review threads",
    tag: "review",
  },
  {
    type: "prompt",
    sessionId: REVIEW,
    ...at(review.startedAt, 38),
    cumCostUsd: 5.6,
    actorName: review.owner,
    text: "Fixes are in 217ace2. Re-check both threads.",
  },
  {
    type: "say",
    sessionId: REVIEW,
    ...at(review.startedAt, 41),
    cumCostUsd: review.costUsd,
    actorName: "Codex",
    text: "Both fixed: the guard is back and overlapping ranges are merged before the split. Approved.",
  },
  { type: "end", sessionId: REVIEW, text: "Session ended" },
];

const LAND_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: LAND,
    t: land.startedAt,
    actor: { name: "CI", harness: "claude", ci: true },
  },
  {
    type: "tools",
    sessionId: LAND,
    ...at(land.startedAt, 1),
    endMs: 6 * MINUTE,
    summary: "Ran 3 tools · 3 bash",
    hasFail: false,
    failN: 0,
    items: [
      { label: "Bash", detail: "gh pr checks 9129", err: false },
      {
        label: "Bash",
        detail: "gh api graphql -f query=enqueuePullRequest",
        err: false,
      },
      { label: "Bash", detail: "scratchpad/queue-pr.sh 9129", err: false },
    ],
  },
  {
    type: "event",
    sessionId: LAND,
    t: at(land.startedAt, 6).t,
    dot: "b",
    text: "Entered the merge queue",
    tag: "queue",
  },
  {
    type: "say",
    sessionId: LAND,
    ...at(land.startedAt, 9),
    cumCostUsd: 1.4,
    actorName: "Claude",
    text: "Queued behind 3 PRs. All 7 required lanes are running on the merge group.",
  },
  {
    type: "event",
    sessionId: LAND,
    t: at(land.startedAt, 26).t,
    dot: "g",
    text: "Merged #9129 into main",
    tag: "merge",
  },
  {
    type: "say",
    sessionId: LAND,
    ...at(land.startedAt, 30),
    cumCostUsd: land.costUsd,
    actorName: "Claude",
    text: "Merged at 12:31. Posted the merge note on ISS-12576; it stays In Review for Ottilie.",
  },
  { type: "end", sessionId: LAND, text: "Session ended" },
];

const FOLLOW_UP_ITEMS: BranchTraceResult["items"] = [
  {
    type: "sessionstart",
    sessionId: FOLLOW_UP,
    t: followUp.startedAt,
    actor: { name: followUp.owner, harness: "claude" },
  },
  {
    type: "prompt",
    sessionId: FOLLOW_UP,
    ...at(followUp.startedAt, 1),
    cumCostUsd: 0.1,
    actorName: followUp.owner,
    text: "The 7.0.0 entry's story counts look stale. Measure them from the index before 7.0.1 lands.",
  },
  {
    type: "tools",
    sessionId: FOLLOW_UP,
    ...at(followUp.startedAt, 2),
    endMs: 9 * MINUTE,
    summary: "Ran 2 tools · 1 bash · 1 tool",
    hasFail: false,
    failN: 0,
    items: [
      {
        label: "Bash",
        detail: "pnpm exec storybook index -o index.json",
        err: false,
      },
      {
        label: "Edit",
        detail: "start-here-version-history.stories.tsx",
        err: false,
      },
    ],
  },
  {
    type: "say",
    sessionId: FOLLOW_UP,
    ...at(followUp.startedAt, 14),
    cumCostUsd: followUp.costUsd,
    actorName: "Claude",
    text: "Updated: Primitives 7/38, Composites 86/637, Patterns 13/71, Surfaces 61/335.",
  },
  { type: "end", sessionId: FOLLOW_UP, text: "Session ended" },
];

export const designSessionsTrace: BranchTraceResult = {
  items: [...BUILD_ITEMS, ...REVIEW_ITEMS, ...LAND_ITEMS, ...FOLLOW_UP_ITEMS],
  sessions: SESSIONS.map((session) => ({
    identity: {
      artifactId: session.id,
      name: session.name,
      slug: session.slug,
      navigableRef: session.slug,
    },
    state: BranchTraceSessionHydrationState.Loaded,
  })),
  qualifyingSessionCount: SESSIONS.length,
  completeness: { state: BranchTraceCompletenessState.Complete },
  aggregateCompleteness: { state: BranchTraceCompletenessState.Complete },
};
