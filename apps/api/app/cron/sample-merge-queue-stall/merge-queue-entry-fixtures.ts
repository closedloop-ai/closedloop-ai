// Shared merge-queue fixtures for the stall cron's two suites (ISS-5141).
//
// `derive.test.ts` and `route.test.ts` both need to build queue entries carrying
// a status-check rollup, and the shape is fiddly enough — a union of two node
// kinds, a nullable rollup, a totalCount that has to be able to disagree with
// the node count — that two hand-rolled copies would drift.
//
// The integration ids below are SYNTHETIC. The production code reads the real
// ones live from the branch ruleset, so pinning the live values here would test
// nothing and would go stale the moment the ruleset changed.

import type {
  MergeQueueState,
  RequiredContext,
  RollupContextNode,
} from "@repo/github/merge-queue";

/** Pinned clock, so every derived age is exact arithmetic, not a tolerance. */
export const NOW = new Date("2026-08-05T16:00:00Z");

export const ACTIONS_INTEGRATION_ID = 15_368;
export const VERCEL_INTEGRATION_ID = 8329;
/** An integration that owns none of the required contexts. */
export const IMPOSTOR_INTEGRATION_ID = 4242;

export const REQUIRED_CHECK_NAME = "typecheck";
export const REQUIRED_STATUS_NAME = "Vercel – app-stage";
/** Red on `main` for weeks under ISS-5136, and deliberately NOT required. */
export const ADVISORY_CHECK_NAME = "deploy-scripts";

export const REQUIRED_CONTEXTS: RequiredContext[] = [
  { context: REQUIRED_CHECK_NAME, integrationId: ACTIONS_INTEGRATION_ID },
  { context: REQUIRED_STATUS_NAME, integrationId: VERCEL_INTEGRATION_ID },
];

export const MergeQueueEntryState = {
  AwaitingChecks: "AWAITING_CHECKS",
  Mergeable: "MERGEABLE",
  Unmergeable: "UNMERGEABLE",
} as const;
export type MergeQueueEntryState =
  (typeof MergeQueueEntryState)[keyof typeof MergeQueueEntryState];

type CheckRunOptions = {
  conclusion?: string | null;
  integrationId?: number | null;
  /** Minutes before NOW. Omit for a run with no timestamps at all. */
  completedMinutesAgo?: number;
};

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

export function checkRun(
  name: string,
  options: CheckRunOptions = {}
): RollupContextNode {
  const {
    conclusion = null,
    integrationId = ACTIONS_INTEGRATION_ID,
    completedMinutesAgo,
  } = options;
  return {
    __typename: "CheckRun",
    name,
    conclusion,
    completedAt:
      completedMinutesAgo === undefined
        ? null
        : minutesAgo(completedMinutesAgo),
    startedAt: null,
    checkSuite:
      integrationId === null ? null : { app: { databaseId: integrationId } },
  };
}

type StatusContextOptions = {
  state?: string;
  /** `Bot` is what marks a status as app-posted rather than human-posted. */
  creator?: string | null;
  createdMinutesAgo?: number;
};

export function statusContext(
  name: string,
  options: StatusContextOptions = {}
): RollupContextNode {
  const { state = "SUCCESS", creator = "Bot", createdMinutesAgo } = options;
  return {
    __typename: "StatusContext",
    context: name,
    state,
    createdAt:
      createdMinutesAgo === undefined ? null : minutesAgo(createdMinutesAgo),
    creator: creator === null ? null : { __typename: creator },
  };
}

export type EntryOptions = {
  /** `null` means no merge group has been built for this entry yet. */
  minutesOld: number | null;
  state?: MergeQueueEntryState;
  pullRequest?: number | null;
  /** `null` models a node the boundary schema could not read. */
  contexts?: (RollupContextNode | null)[];
  /** Defaults to `contexts.length`; set higher to simulate a truncated page. */
  contextsTotalCount?: number;
  /** Set false for a group whose commit reports no checks at all. */
  withRollup?: boolean;
};

export function entry(
  options: EntryOptions
): MergeQueueState["entries"]["nodes"][number] {
  const {
    minutesOld,
    state = MergeQueueEntryState.AwaitingChecks,
    pullRequest = 1234,
    contexts = [],
    contextsTotalCount,
    withRollup = true,
  } = options;

  return {
    state,
    pullRequest: pullRequest === null ? null : { number: pullRequest },
    headCommit:
      minutesOld === null
        ? null
        : {
            committedDate: minutesAgo(minutesOld),
            oid: `oid-${pullRequest ?? "none"}-${minutesOld}`,
            statusCheckRollup: withRollup
              ? {
                  contexts: {
                    totalCount: contextsTotalCount ?? contexts.length,
                    nodes: contexts,
                  },
                }
              : null,
          },
  };
}

export function queueState(
  entries: MergeQueueState["entries"]["nodes"],
  totalCount = entries.length
): MergeQueueState {
  return { entries: { totalCount, nodes: entries } };
}

/** The age-only shorthand the pre-ISS-5141 suite was written against. */
export function ageQueue(
  minutesOld: (number | null)[],
  totalCount = minutesOld.length
): MergeQueueState {
  return queueState(
    minutesOld.map((minutes) => entry({ minutesOld: minutes })),
    totalCount
  );
}
