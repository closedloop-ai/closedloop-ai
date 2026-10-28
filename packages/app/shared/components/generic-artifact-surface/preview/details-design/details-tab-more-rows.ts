// gardener-support: test and story data, not shipped
import { Chip } from "@repo/design-system/components/ui/chip";
import { createElement } from "react";
import {
  copyRow,
  countRow,
  custom,
  dateTimeRow,
  FROM_GIT,
  FROM_HARNESS,
  FROM_SESSIONS,
  readRow,
  row,
  text,
} from "./details-design-fixtures";
import type {
  DetailsEditableValue,
  DetailsField,
  DetailsFieldEdit,
} from "./details-design-model";
import {
  type DetailsPullRequest,
  PullRequestDetailsCell,
} from "./details-tab-cells";
import { DetailsTabFieldId } from "./details-tab-model";

/**
 * ISS-12252: the rows Kerensa's Details tab reconciliation (2026-10-07, "See
 * also" on ISS-12197) adds to ISS-12197's list, apart from the fixtures that
 * use them. Every row is left out when its value is absent.
 */

const F = DetailsTabFieldId;

/** Launch attribution, as the Properties panel words it. */
export type SessionLaunchDetails = {
  thread: string;
  agentRole: string;
  firstSkill: string;
  promptSource: string;
};

/** A Codex session's runtime rows, as the Properties panel words them. */
export type SessionCodexRuntimeDetails = {
  contextWindow: string;
  latestTurnTokens: string;
  rateLimits: readonly { label: string; value: string }[];
};

/** `row` for the ids the Details tab adds, which the shipped `DetailsFieldId` does not have. */
export const typeRow = (
  id: DetailsTabFieldId,
  label: string,
  value: DetailsEditableValue,
  edit: DetailsFieldEdit
): DetailsField => ({ edit, id, label, value });

export const formatCount = (count: number) => count.toLocaleString("en-US");

/** A shipped Details row under an id the Details tab adds. */
export const withId = (
  id: DetailsTabFieldId,
  field: DetailsField
): DetailsField => ({
  ...field,
  id,
});

/** The rows `make` builds from `value`, or none when it is absent. */
export function rowsWhen<T>(
  value: T | undefined,
  make: (present: T) => readonly DetailsField[]
): readonly DetailsField[] {
  return value === undefined ? [] : make(value);
}

/** Launch attribution, in the Properties panel's order. */
export const launchRows = (launch: SessionLaunchDetails) => [
  row(F.Thread, "Thread", text(launch.thread), FROM_HARNESS),
  row(F.AgentRole, "Agent role", text(launch.agentRole, true), FROM_HARNESS),
  row(
    F.FirstSkill,
    "First attributed skill",
    text(launch.firstSkill, true),
    FROM_HARNESS
  ),
  typeRow(
    F.PromptSource,
    "Prompt source",
    text(launch.promptSource),
    FROM_HARNESS
  ),
];

export const codexRows = (codex: SessionCodexRuntimeDetails) => [
  typeRow(
    F.ContextWindow,
    "Context window",
    text(codex.contextWindow, true),
    FROM_HARNESS
  ),
  typeRow(
    F.LatestTurnTokens,
    "Latest turn tokens",
    text(codex.latestTurnTokens, true),
    FROM_HARNESS
  ),
  ...codex.rateLimits
    .slice(0, 2)
    .map((limit, index) =>
      typeRow(
        index === 0 ? F.RateLimitPrimary : F.RateLimitSecondary,
        limit.label,
        text(limit.value, true),
        FROM_HARNESS
      )
    ),
];

export type BranchDetailsTabMore = {
  baseBranch?: string;
  /** The branch ref's head, not the pull request's. */
  headSha?: string;
  /** Human, Agent or Bot, from the branch name. */
  origin?: string;
  filesChanged?: number;
  reviewDecision?: string;
  /** GitHub reviewers on the pull request, apart from Collaborators. */
  reviewers?: readonly string[];
  prOpenedAt?: string;
  prMergedAt?: string;
  mergeCommit?: string;
  /** Summed over the branch's sessions. */
  tokens?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** The Sessions row's split: sessions that wrote, and that reviewed. */
  participation?: { wrote: number; reviewed: number };
  leadTime?: string;
  idleTime?: string;
};

/** the shipped Details fixture Branch, with the reconciliation's rows. */
export const BRANCH_DETAILS_TAB_MORE: BranchDetailsTabMore = {
  baseBranch: "main",
  headSha: "4f2c9e1a7b3d5f60812c4e9a0b7d3f5e1c2a9b8d",
  origin: "Agent",
  filesChanged: 18,
  reviewDecision: "Changes requested",
  reviewers: ["Jordan Kim", "Taylor Morgan"],
  prOpenedAt: "2026-09-24T16:40:00.000Z",
  tokens: {
    input: 84_200,
    output: 21_900,
    cacheRead: 310_000,
    cacheWrite: 18_400,
  },
  participation: { wrote: 5, reviewed: 2 },
  leadTime: "3d 4h",
  idleTime: "1d 2h",
};

export const FIXTURE_BRANCH_PULL_REQUEST: DetailsPullRequest = {
  // The lifecycle chip's In review: `LifecycleBadgeChip`'s accent tone.
  state: createElement(Chip, { size: "sm", variant: "accent" }, "In review"),
  href: null,
  number: 201,
  title: "Fixture: pull request title",
};

/** The rows `more` has a value for, in their groups' order. */
export function branchMoreRows(more: BranchDetailsTabMore): DetailsField[] {
  const tokenRow = (
    id: DetailsTabFieldId,
    label: string,
    count: number
  ): DetailsField =>
    typeRow(id, label, text(formatCount(count)), FROM_SESSIONS);
  return [
    ...rowsWhen(more.baseBranch, (base) => [
      typeRow(F.BaseBranch, "Base branch", text(base, true), FROM_GIT),
    ]),
    ...rowsWhen(more.headSha, (sha) => [
      withId(F.HeadSha, copyRow(F.Slug, "Head SHA", sha)),
    ]),
    ...rowsWhen(more.origin, (origin) => [
      typeRow(F.Origin, "Origin", text(origin), FROM_GIT),
    ]),
    ...rowsWhen(more.filesChanged, (files) => [
      withId(
        F.FilesChanged,
        countRow(
          F.CommitCount,
          "Files changed",
          files,
          { one: "file", other: "files" },
          FROM_GIT
        )
      ),
    ]),
    ...rowsWhen(more.reviewDecision, (decision) => [
      typeRow(F.ReviewDecision, "Review decision", text(decision), FROM_GIT),
    ]),
    ...rowsWhen(more.reviewers, (reviewers) => [
      withId(
        F.Reviewers,
        readRow(
          F.Collaborators,
          "Reviewers",
          {
            kind: "people",
            people: reviewers.map((name) => ({ key: name, name })),
          },
          FROM_GIT
        )
      ),
    ]),
    ...rowsWhen(more.prOpenedAt, (at) => [
      withId(F.PrOpenedAt, dateTimeRow(F.Started, "Opened at", at, FROM_GIT)),
    ]),
    ...rowsWhen(more.prMergedAt, (at) => [
      withId(F.PrMergedAt, dateTimeRow(F.Started, "Merged at", at, FROM_GIT)),
    ]),
    ...rowsWhen(more.mergeCommit, (sha) => [
      withId(F.MergeCommit, copyRow(F.Slug, "Merge commit", sha)),
    ]),
    ...rowsWhen(more.tokens, (tokens) => [
      tokenRow(F.InputTokens, "Input tokens", tokens.input),
      tokenRow(F.OutputTokens, "Output tokens", tokens.output),
      tokenRow(F.CacheReadTokens, "Cache read tokens", tokens.cacheRead),
      tokenRow(F.CacheWriteTokens, "Cache write tokens", tokens.cacheWrite),
    ]),
    ...rowsWhen(more.leadTime, (lead) => [
      typeRow(F.LeadTime, "Lead time", text(lead), FROM_SESSIONS),
    ]),
    ...rowsWhen(more.idleTime, (idle) => [
      typeRow(F.IdleTime, "Idle time", text(idle), FROM_SESSIONS),
    ]),
  ];
}

/** The Pull request row: number, title and state, with Draft as a state. */
export const pullRequestRow = (pullRequest: DetailsPullRequest) =>
  readRow(
    F.PullRequests,
    "Pull request",
    custom(() => createElement(PullRequestDetailsCell, { pullRequest })),
    FROM_GIT
  );

/** Sessions, with how many wrote and how many reviewed when that is known. */
export function sessionsRow(
  sessions: number,
  participation: BranchDetailsTabMore["participation"]
): DetailsField {
  const count = countRow(
    F.LinkedSessions,
    "Sessions",
    sessions,
    { one: "session", other: "sessions" },
    FROM_SESSIONS
  );
  return participation
    ? row(
        F.LinkedSessions,
        "Sessions",
        text(
          `${formatCount(sessions)} · ${formatCount(participation.wrote)} wrote, ${formatCount(participation.reviewed)} reviewed`
        ),
        FROM_SESSIONS
      )
    : count;
}
