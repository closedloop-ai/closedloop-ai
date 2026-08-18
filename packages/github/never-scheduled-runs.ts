// Live reads for the "workflow run that never scheduled a job" stall (ISS-6011).
//
// Sibling of `merge-queue.ts`, and deliberately not part of it: that module reads
// the merge QUEUE, this one reads open PR heads. They share the `RequiredContext`
// contract and the rollup selection set, nothing else.
//
// ## The failure this exists to see
// GitHub sometimes creates a workflow run that never schedules a single job. The
// run sits `queued` with `jobs.total_count == 0`, its check suite reports
// `latest_check_runs_count: 0`, and therefore NO check run is ever posted. A
// required context owned by that workflow is not red and not pending — it is
// ABSENT, and branch protection waits for a report that will never come.
//
// That absence is why the run itself has to be read. There is no failing check to
// find on the PR, no CI Visibility pipeline event (nothing ever dispatched), and
// nothing on the check suite either. The Actions runs list is the only surface
// that shows the run exists at all.
//
// Requires `actions: read` for the runs/jobs reads and `pull-requests: read` for
// the PR read.

import "server-only";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";
// Explicit `.ts`: this module is executed directly by `node` from
// `scripts/ci/ready-to-enqueue.ts`, which resolves ESM specifiers literally
// rather than probing extensions the way a bundler does.
import {
  issueSummary,
  LenientRollupContextNodeSchema,
  ROLLUP_CONTEXT_FIELDS,
  type RollupContextNode,
} from "./merge-queue.ts";

/**
 * REST page maximum. Runs come back newest-first, so a repository that has
 * accumulated more permanently-queued runs than one page still surfaces the NEW
 * ones. The entries pushed off the end are the oldest — but nothing here can
 * prove those are all closed-PR debris, so a full page is reported as truncated
 * and the caller degrades the tick rather than assuming.
 */
const RUNS_PAGE_SIZE = 100;

/** GraphQL connection maximum for both the PR page and each head's rollup. */
const OPEN_PR_PAGE_SIZE = 100;
const ROLLUP_PAGE_SIZE = 100;

/**
 * How many of a PR's comments come back when `withComments` is set, ordered
 * most-recently-UPDATED first.
 *
 * The ordering is the load-bearing half, not the size. The only consumer is
 * looking for its OWN marker comment, which it PATCHes in place — and this
 * connection's default order is by CREATION, which a patch never moves. A
 * newest-created page would therefore lose the marker on any PR that accrued
 * more than `COMMENT_PAGE_SIZE` comments after it (routine here: nightly-review
 * bots, design bots, the merge-queue ETA writer, human threads), the sweep would
 * post a SECOND comment, and the first would sit frozen on a stale verdict
 * forever. `UPDATED_AT DESC` keeps the comment the sweep touches every time it
 * changes at the head of the page by construction.
 */
const COMMENT_PAGE_SIZE = 30;

/**
 * The only non-terminal status this reads.
 *
 * `in_progress` is excluded, and the reason it is NOT is that a job started —
 * that was the old justification here and it is false. ISS-6019 recorded four
 * runs that reached `in_progress` with every job `skipped` by its `if:` in under
 * a second, no step ever executed, and no conclusion afterwards; all four are
 * still sitting there. They are genuinely stuck, but a different failure: a
 * skipped job SATISFIES a required check, so unlike the zero-job stall this
 * signal exists to find, they block nothing. Out of scope on purpose —
 * `docs/runbooks/merge-queue-operations.md` documents them and how to tell the
 * two apart.
 *
 * What is left is an ASSUMPTION, stated rather than dressed up as construction:
 * every `in_progress` run observed so far has had jobs, so none can be the
 * zero-job stall. Nothing proves GitHub cannot flip a zero-job run to
 * `in_progress` — it demonstrably flips runs whose jobs never ran — and if it
 * does, this read never sees it and the gauge publishes a confident zero over a
 * blocked PR. Widen the status filter here if one is ever observed.
 *
 * `waiting` and `pending` are environment-approval and concurrency gates — real
 * blocks, but human- or config-owned ones with an operator already in the loop,
 * which is a different failure with a different remedy.
 */
const QUEUED_RUN_STATUS = "queued";

/** Wire shape — snake_case keys are GitHub's, normalized to camelCase below. */
const WorkflowRunSchema = z.object({
  id: z.number().int(),
  /**
   * Nullable in GitHub's schema (a run whose workflow file was deleted). Such a
   * run still blocks, so it is kept and named rather than dropped.
   */
  name: z.string().nullable(),
  head_sha: z.string().min(1),
  head_branch: z.string().nullable(),
  /**
   * Nullable so one run missing it cannot fail the whole page. A run with no
   * start time cannot be aged, which the derivation treats as unresolved rather
   * than as young — see `derive-never-scheduled.ts`.
   */
  run_started_at: z.string().nullable(),
});

/**
 * A run this schema cannot read fails the WHOLE page, unlike the rollup nodes in
 * `merge-queue.ts` which degrade to holes.
 *
 * The asymmetry is deliberate and is about which direction the damage runs.
 * There, a dropped node leaves a `totalCount` gap the derivation already treats
 * as unresolved. Here there is no such gap to leave: a silently dropped run is a
 * run that never gets probed, so the tick would publish a confident "nothing is
 * stuck" over the very run that was. Failing the read resolves to `Unknown` and
 * omits the gauge, which is the safe direction.
 */
const WorkflowRunsResponseSchema = z.object({
  workflow_runs: z.array(WorkflowRunSchema),
});

export type QueuedWorkflowRun = {
  id: number;
  /** The workflow's display name, or a stable placeholder when GitHub omits it. */
  workflow: string;
  headSha: string;
  headBranch: string | null;
  runStartedAt: string | null;
};

export const QueuedRunsReadStatus = {
  Ok: "ok",
  /** The response did not match the expected shape. */
  Malformed: "malformed",
  /** The API call itself failed. */
  Failed: "failed",
} as const;
export type QueuedRunsReadStatus =
  (typeof QueuedRunsReadStatus)[keyof typeof QueuedRunsReadStatus];

export type QueuedRunsReadResult =
  | {
      status: typeof QueuedRunsReadStatus.Ok;
      runs: QueuedWorkflowRun[];
      /**
       * The page came back full, so queued runs exist that were NOT read. True
       * at exactly `RUNS_PAGE_SIZE` even when nothing lies beyond it — the
       * endpoint gives no way to tell those apart, and over-reporting truncation
       * costs a degraded tick while under-reporting it costs a missed block.
       */
      truncated: boolean;
    }
  | {
      status: Exclude<QueuedRunsReadStatus, typeof QueuedRunsReadStatus.Ok>;
      detail: string;
    };

const UNNAMED_WORKFLOW = "(unnamed workflow)";

/**
 * Lists the repository's currently-queued workflow runs.
 *
 * Truncation is detected from a FULL PAGE, not from `total_count`. The two
 * usually agree (35 = 35 on three consecutive reads on 2026-08-12), but they
 * were once observed disagreeing on this endpoint — 38 against 36 returned
 * nodes on a single unpaginated page — which a run completing mid-request
 * explains without any page being cut. Keying truncation on the disagreement
 * would therefore degrade a tick over a complete page, whereas a page filled to
 * `RUNS_PAGE_SIZE` is direct evidence that more exist.
 */
export async function listQueuedWorkflowRuns(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<QueuedRunsReadResult> {
  let raw: unknown;
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs",
      { owner, repo, status: QUEUED_RUN_STATUS, per_page: RUNS_PAGE_SIZE }
    );
    raw = response.data;
  } catch (error) {
    return {
      status: QueuedRunsReadStatus.Failed,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = WorkflowRunsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: QueuedRunsReadStatus.Malformed,
      detail: issueSummary(parsed.error.issues),
    };
  }

  const runs = parsed.data.workflow_runs.map((run) => ({
    id: run.id,
    workflow: run.name ?? UNNAMED_WORKFLOW,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    runStartedAt: run.run_started_at,
  }));

  return {
    status: QueuedRunsReadStatus.Ok,
    runs,
    truncated: parsed.data.workflow_runs.length >= RUNS_PAGE_SIZE,
  };
}

/**
 * Open PRs with the rollup already reported on their head commits.
 *
 * The rollup rides along in the SAME query rather than being fetched per flagged
 * run: it is what turns "a run is stuck" into "and PR #N is therefore missing
 * `test` and `typecheck`", and fetching it per candidate would put an unbounded
 * number of round trips inside the tick's probe budget.
 *
 * `orderBy UPDATED_AT DESC` is load-bearing, not cosmetic. GitHub's default
 * ordering for this connection is oldest-first, so a repository with more than
 * `OPEN_PR_PAGE_SIZE` open PRs would cut the MOST recently active ones — exactly
 * the PRs a stuck run is likely to be sitting on. The caller degrades a truncated
 * page to `Unknown` regardless; this makes the page that IS read the useful one.
 *
 * The rollup selection set is imported rather than restated so it cannot drift
 * from the one `deriveFailedGroups` matches required rules against.
 */
const OPEN_PULL_REQUESTS_QUERY = `
  query($owner: String!, $name: String!, $first: Int!, $after: String, $rollupFirst: Int!, $commentLimit: Int!, $withComments: Boolean!) {
    repository(owner: $owner, name: $name) {
      pullRequests(states: OPEN, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          headRefName
          headRefOid
          baseRefName
          isDraft
          mergeable
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  contexts(first: $rollupFirst) {
                    totalCount
                    nodes { ${ROLLUP_CONTEXT_FIELDS} }
                  }
                }
              }
            }
          }
          comments(first: $commentLimit, orderBy: {field: UPDATED_AT, direction: DESC}) @include(if: $withComments) {
            pageInfo { hasNextPage endCursor }
            nodes { id body viewerDidAuthor }
          }
        }
      }
    }
  }
`;

const PullRequestRollupSchema = z.object({
  contexts: z
    .object({
      /**
       * ISS-6018. The server's own count, never recomputed from `nodes`, exactly
       * as `merge-queue.ts` reads it: the rollup returns one node per re-run
       * ATTEMPT, so on a PR that has been re-run or ejected repeatedly the page
       * cap is reachable. GitHub does not document node ordering, so a cut page
       * can hide the newest attempt and leave an older one looking live — which
       * would let a stale SUCCESS outlive the FAILURE that replaced it. A caller
       * that compares this against the readable node count can refuse to answer
       * instead.
       */
      totalCount: z.number().int().nonnegative(),
      nodes: z.array(LenientRollupContextNodeSchema),
    })
    // The same connection invariant the open-PR page carries, for the same
    // reason: `totalCount` is the population and `nodes` the page drawn from it,
    // so the page can never be larger. Accepting the inverted shape would make
    // `rollupTruncated` false on a rollup that IS cut, and the readiness
    // consumer would then read a surviving stale SUCCESS as the live attempt and
    // answer "Ready to enqueue". A rollup that fails this is caught by
    // `TolerantPullRequestRollupSchema` into the unreadable sentinel, which is
    // what turns it into an Unknown verdict rather than a confident wrong one.
    .refine((contexts) => contexts.totalCount >= contexts.nodes.length, {
      message: "totalCount is smaller than the number of rollup nodes returned",
    }),
});

/**
 * ISS-6018 — the comment page, present only when the caller asked for it via
 * `@include(if: $withComments)`.
 *
 * Selected in THIS query rather than read per PR over REST. A sweep over ~30
 * open PRs paginating `/issues/{n}/comments` costs 30-60 REST calls a tick,
 * which at a 5-minute cadence is most of `GITHUB_TOKEN`'s 1,000/hour/repository
 * budget — shared with every other workflow on the repo.
 */
const PullRequestCommentSchema = z.object({
  /**
   * The GraphQL node ID, NOT `databaseId`.
   *
   * `databaseId` is the legacy 32-bit projection and issue-comment ids have
   * already outgrown it, so GitHub returns `null` for it on any recently created
   * comment. A null id made `findExisting` drop a marker the sweep genuinely
   * owned, and a sweep that cannot find its own comment POSTs a new one — every
   * five minutes, forever. `id` is `ID!`: non-null by construction, with no
   * range to outgrow, and it is what `updateIssueComment` takes.
   */
  id: z.string().min(1),
  body: z.string(),
  /**
   * The only safe way to decide a comment is ours to edit. Matching a marker
   * alone would let a human who quoted the bot's body have their comment
   * overwritten by the next sweep.
   */
  viewerDidAuthor: z.boolean(),
});

/**
 * ISS-6018 — the cursor half, which is what makes the marker findable at all.
 *
 * `UPDATED_AT DESC` keeps the marker near the head only while the sweep keeps
 * TOUCHING it, and the sweep deliberately does not: an unchanged verdict costs
 * no write. So on a busy PR the marker stops being updated, thirty newer
 * comments accumulate above it, it falls off the first page, and the sweep no
 * longer finds the comment it owns. The consumer follows this cursor until it
 * does — ordering narrows the search, it does not bound it.
 */
const CommentConnectionSchema = z
  .object({
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
    nodes: z.array(PullRequestCommentSchema),
  })
  // A further page with no cursor to reach it by is unreachable, and the whole
  // point of the cursor is that "no cursor" may mean "done". Rejecting at the
  // boundary keeps `commentsCursor: null` meaning exactly one thing downstream;
  // the alternative is a consumer that reads unreachable as complete and posts
  // the duplicate this pagination exists to prevent.
  .refine(
    (connection) =>
      !connection.pageInfo.hasNextPage ||
      connection.pageInfo.endCursor !== null,
    {
      message: "comment connection reports a further page with no endCursor",
    }
  );

/**
 * An unreadable or absent rollup degrades to "nothing reported", which is the
 * INVERSE of what the same fallback would mean in `merge-queue.ts`.
 *
 * There, `null` reads as clean, so catching to it would publish a confident zero
 * over a group whose failing check was the node that got dropped — hence its
 * synthetic `UNREADABLE_ROLLUP` gap. Here the question is "did this required
 * context report at all", so an empty rollup means every required context is
 * unreported, which resolves TOWARD flagging the PR. The safe direction is
 * opposite, so the fallback is too.
 */
/**
 * ISS-6018 — an unreadable CONTAINER is modeled as a rollup holding one context
 * we could not see, exactly as `merge-queue.ts` does, rather than as `null`.
 *
 * The two inputs are not the same fact and must not collapse to the same
 * answer. A GraphQL `null` genuinely means "no checks reported on this commit
 * yet", passes `.nullable()`, and never reaches this catch. A container that
 * fails to PARSE means the checks may well have reported and we could not read
 * them — and folding that into `null` published it as "nothing reported", which
 * the readiness consumer renders as a confident "still to report: <every
 * required context>". The synthetic gap makes it show up as a truncated page
 * instead, which resolves to Unknown.
 */
const UNREADABLE_ROLLUP = { contexts: { totalCount: 1, nodes: [] } };

const TolerantPullRequestRollupSchema =
  PullRequestRollupSchema.nullable().catch(UNREADABLE_ROLLUP);

const OpenPullRequestSchema = z.object({
  number: z.number().int(),
  headRefName: z.string(),
  headRefOid: z.string().min(1),
  /**
   * ISS-6018. The required-context set is per BRANCH, so a consumer that asks
   * "are this PR's required checks green" has to know which branch's ruleset the
   * answer was computed against. A PR into a feature branch (a stack) or into
   * `production` is not governed by `main`'s rules, and answering it from them
   * would be a confident wrong answer rather than no answer.
   */
  baseRefName: z.string(),
  /** ISS-6018 — a draft cannot be enqueued whatever its checks say. */
  isDraft: z.boolean(),
  /**
   * ISS-6018 — `MergeableState`, parsed as an open string for the same reason
   * the rollup enums are: GitHub can add a member at any time, and rejecting
   * the whole page over one unknown value would take the never-scheduled gauge
   * down with it. `UNKNOWN` is routine (GitHub computes mergeability lazily),
   * so only `CONFLICTING` is a verdict.
   */
  mergeable: z.string(),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: TolerantPullRequestRollupSchema,
        }),
      })
    ),
  }),
  /** Absent unless `withComments` was requested — see `PullRequestCommentSchema`. */
  comments: CommentConnectionSchema.nullish(),
});

const OpenPullRequestsConnectionSchema = z
  .object({
    totalCount: z.number().int().nonnegative(),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
    nodes: z.array(OpenPullRequestSchema),
  })
  // `totalCount` is the population and `nodes` the page drawn from it, so the
  // page can never be larger. Accepting the inverted shape would compute
  // `truncated: false` for a page that WAS cut, and an unseen open PR head
  // silently demotes a stuck run to debris — a confident "nothing is blocked"
  // over heads never read. Malformed at the boundary, as `merge-queue.ts` does
  // for the same shape.
  .refine((connection) => connection.totalCount >= connection.nodes.length, {
    message: "totalCount is smaller than the number of nodes returned",
  });

const OpenPullRequestsResponseSchema = z.object({
  repository: z
    .object({ pullRequests: OpenPullRequestsConnectionSchema })
    .nullable(),
});

export type OpenPullRequestHead = {
  number: number;
  headSha: string;
  headBranch: string;
  /** The branch this PR would merge into — see `OpenPullRequestSchema`. */
  baseBranch: string;
  isDraft: boolean;
  /** `MergeableState` verbatim — see `OpenPullRequestSchema`. */
  mergeable: string;
  /**
   * The head commit's rollup nodes, passed through unflattened so the caller can
   * apply the SAME `{context, integration_id}` required-rule identity
   * `deriveFailedGroups` uses. Flattening to context names here would throw away
   * the integration id and the status creator, and matching by name alone lets
   * any app's check called `test` stand in for the required `test`.
   */
  rollupContexts: (RollupContextNode | null)[];
  /**
   * TRUE when the rollup page was cut, so `rollupContexts` is known incomplete
   * and no verdict read off it is safe. Derived from the server's `totalCount`
   * against the READABLE nodes, so a node the boundary schema dropped counts as
   * a gap exactly as a cut page does.
   */
  rollupTruncated: boolean;
  /**
   * The FIRST page of comments, EMPTY unless the caller passed `withComments`.
   * Empty therefore means "not requested or none present" — a caller that has
   * to tell those apart must not use this.
   */
  comments: PullRequestComment[];
  /**
   * Where to continue the comment walk, or null when this page was the whole of
   * it. A caller looking for a comment it OWNS must follow this before deciding
   * the comment is absent — see `CommentConnectionSchema`.
   */
  commentsCursor: string | null;
};

export type PullRequestComment = z.infer<typeof PullRequestCommentSchema>;

export const OpenPullRequestsReadStatus = {
  Ok: "ok",
  Malformed: "malformed",
  Failed: "failed",
} as const;
export type OpenPullRequestsReadStatus =
  (typeof OpenPullRequestsReadStatus)[keyof typeof OpenPullRequestsReadStatus];

export type OpenPullRequestsReadResult =
  | {
      status: typeof OpenPullRequestsReadStatus.Ok;
      pullRequests: OpenPullRequestHead[];
      /** More open PRs exist than the page returned. */
      truncated: boolean;
    }
  | {
      status: Exclude<
        OpenPullRequestsReadStatus,
        typeof OpenPullRequestsReadStatus.Ok
      >;
      detail: string;
    };

/**
 * Reads every open PR's head SHA and the rollup reported against it.
 *
 * `withComments` is opt-in rather than always-on: the comment page is only
 * useful to a caller that owns a marker comment on the PR, and selecting it
 * unconditionally would grow the stall cron's response for data it never reads.
 * The `@include` directive keeps one query serving both.
 */
export async function listOpenPullRequestHeads(
  octokit: Octokit,
  owner: string,
  repo: string,
  options: { withComments?: boolean } = {}
): Promise<OpenPullRequestsReadResult> {
  const pullRequests: OpenPullRequestHead[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_OPEN_PR_PAGES; page++) {
    let raw: unknown;
    try {
      raw = await octokit.graphql(OPEN_PULL_REQUESTS_QUERY, {
        owner,
        name: repo,
        first: OPEN_PR_PAGE_SIZE,
        after: cursor,
        rollupFirst: ROLLUP_PAGE_SIZE,
        commentLimit: COMMENT_PAGE_SIZE,
        withComments: options.withComments ?? false,
      });
    } catch (error) {
      return {
        status: OpenPullRequestsReadStatus.Failed,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const parsed = OpenPullRequestsResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        status: OpenPullRequestsReadStatus.Malformed,
        detail: issueSummary(parsed.error.issues),
      };
    }

    const connection = parsed.data.repository?.pullRequests;
    if (!connection) {
      return {
        status: OpenPullRequestsReadStatus.Failed,
        detail: `no repository visible at ${owner}/${repo}`,
      };
    }

    pullRequests.push(...connection.nodes.map(toOpenPullRequestHead));
    if (!connection.pageInfo.hasNextPage) {
      return {
        status: OpenPullRequestsReadStatus.Ok,
        pullRequests,
        // Belt and braces over the walk: the server's own population count
        // against what was actually collected. `hasNextPage` alone would report
        // a short page as the whole population if GitHub ever ended the
        // connection early, and this signal's failure direction is a confident
        // "nothing is blocked" over heads that were never read.
        truncated: connection.totalCount > pullRequests.length,
      };
    }
    cursor = connection.pageInfo.endCursor;
    if (cursor === null) {
      // A further page with no cursor to reach it by. Report what was read as
      // an incomplete population rather than as the whole of it.
      break;
    }
  }

  return {
    status: OpenPullRequestsReadStatus.Ok,
    pullRequests,
    // Only reachable now by exhausting the page cap: the loop above follows the
    // connection to its end in every ordinary case.
    truncated: true,
  };
}

/**
 * How many PR pages one sweep will walk.
 *
 * A bound, not a page size. `OPEN_PR_PAGE_SIZE` is GraphQL's maximum, so this
 * covers 1,000 open PRs — an order of magnitude above anything observed here —
 * and exists so a pathological repository cannot spin a five-minute tick.
 */
const MAX_OPEN_PR_PAGES = 10;

function toOpenPullRequestHead(
  node: z.infer<typeof OpenPullRequestSchema>
): OpenPullRequestHead {
  const rollup = node.commits.nodes.at(0)?.commit.statusCheckRollup;
  const nodes = rollup?.contexts.nodes ?? [];
  // READABLE nodes, not array length: the boundary schema maps a node it
  // cannot parse to a null PLACEHOLDER, so comparing against `nodes.length`
  // would see no gap and report a cut page as complete.
  const readable = nodes.filter((context) => context !== null).length;
  return {
    number: node.number,
    headSha: node.headRefOid,
    headBranch: node.headRefName,
    baseBranch: node.baseRefName,
    isDraft: node.isDraft,
    mergeable: node.mergeable,
    rollupContexts: nodes,
    // Three inputs reach this line and only two of them are the same fact, so
    // read it as a three-way rather than as a null-coalesce:
    //   - `null` — GraphQL's own answer, meaning no check has reported on this
    //     commit yet. `0 > 0` is false, so NOT truncated: the rollup is
    //     genuinely empty and every required rule is legitimately pending.
    //   - `UNREADABLE_ROLLUP` — the container parsed as garbage and was caught.
    //     Its synthetic `totalCount: 1` over zero readable nodes makes `1 > 0`
    //     true, so it lands as truncated and the consumer answers Unknown. This
    //     is the case that must NOT collapse into the one above.
    //   - a real rollup — the server's own count against the nodes that
    //     survived the boundary schema.
    rollupTruncated: (rollup?.contexts.totalCount ?? 0) > readable,
    comments: node.comments?.nodes ?? [],
    commentsCursor: nextCommentCursor(node.comments),
  };
}

/** Null when this page was the whole connection — see `OpenPullRequestHead`. */
function nextCommentCursor(
  connection: z.infer<typeof CommentConnectionSchema> | null | undefined
): string | null {
  if (!connection?.pageInfo.hasNextPage) {
    return null;
  }
  return connection.pageInfo.endCursor;
}

const JobsResponseSchema = z.object({
  total_count: z.number().int().nonnegative(),
});

/**
 * How many jobs a run has scheduled, or NULL when that could not be established.
 *
 * `null` is not 0. Reporting an unreadable probe as zero jobs would manufacture
 * the exact stall this signal exists to detect, so the caller counts a null as
 * unresolved instead.
 *
 * `per_page: 1` because only `total_count` is read — the job bodies are large and
 * none of them is consulted.
 */
export async function countScheduledJobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  runId: number
): Promise<number | null> {
  try {
    const response = await octokit.request(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
      { owner, repo, run_id: runId, per_page: 1 }
    );
    const parsed = JobsResponseSchema.safeParse(response.data);
    return parsed.success ? parsed.data.total_count : null;
  } catch {
    return null;
  }
}

const PULL_REQUEST_COMMENTS_QUERY = `
  query($owner: String!, $name: String!, $number: Int!, $commentLimit: Int!, $after: String!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        comments(first: $commentLimit, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
          pageInfo { hasNextPage endCursor }
          nodes { id body viewerDidAuthor }
        }
      }
    }
  }
`;

const PullRequestCommentsResponseSchema = z.object({
  repository: z
    .object({
      pullRequest: z.object({ comments: CommentConnectionSchema }).nullable(),
    })
    .nullable(),
});

/** One further page of a PR's comments, or NULL when it could not be read. */
export type PullRequestCommentPage = {
  comments: PullRequestComment[];
  /** Null once the walk is complete — see `OpenPullRequestHead`. */
  cursor: string | null;
};

/**
 * Continues the comment walk `listOpenPullRequestHeads` started.
 *
 * Returns NULL rather than an empty page when the read fails, because the two
 * are opposite answers to the only question a caller asks here: an empty page
 * means "your comment is not on this PR" and licenses a POST, while a failed
 * read means "not known" and must not. Collapsing them is how a sweep posts a
 * duplicate beside the comment it already owns.
 *
 * Costs a request only on a PR whose marker was NOT on the first page, which is
 * the busy minority — the batched query in `listOpenPullRequestHeads` still
 * answers for everything else in one call.
 */
export async function listPullRequestCommentPage(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  after: string
): Promise<PullRequestCommentPage | null> {
  let raw: unknown;
  try {
    raw = await octokit.graphql(PULL_REQUEST_COMMENTS_QUERY, {
      owner,
      name: repo,
      number: pullRequestNumber,
      commentLimit: COMMENT_PAGE_SIZE,
      after,
    });
  } catch {
    return null;
  }

  const parsed = PullRequestCommentsResponseSchema.safeParse(raw);
  const connection = parsed.success
    ? parsed.data.repository?.pullRequest?.comments
    : null;
  if (!connection) {
    return null;
  }
  return {
    comments: connection.nodes,
    cursor: nextCommentCursor(connection),
  };
}
