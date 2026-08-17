// Live merge-queue state from the GitHub GraphQL API (ISS-4450).
//
// `Repository.mergeQueue` is the only source that can see a merge queue that has
// stopped moving. CI Visibility pipeline data cannot: a required check that is
// never DISPATCHED emits no pipeline event at all, and a check that IS running
// has no `@duration` until it terminates. Both of those are invisible to any
// query over pipeline events, and both are visible here.
//
// Requires `pull-requests: read` — `mergeQueue` is in GitHub's Pull requests
// GraphQL category, so a token without it reads nothing.

import "server-only";
import type { Octokit } from "@octokit/rest";
import { z } from "zod";

/**
 * 100 is the GraphQL connection page maximum. It is NOT assumed to be the whole
 * queue: GitHub does not document `entries` ordering, so a built — possibly
 * stalled — group can sit on a later page. `totalCount` is returned so callers
 * can detect that case and refuse to derive rather than under-report.
 */
const ENTRIES_PAGE_SIZE = 100;

/**
 * Also the GraphQL page maximum, and also not assumed to be the whole set: a
 * merge group can carry more than 100 check contexts, and `statusCheckRollup`
 * returns re-run ATTEMPTS as separate nodes, so the count inflates faster than
 * the number of distinct checks. `totalCount` comes back so a truncated page can
 * be told apart from a complete one (ISS-5141).
 */
const ROLLUP_PAGE_SIZE = 100;

/**
 * The rollup selection set, exported so every query that reads a
 * `statusCheckRollup` selects the SAME fields.
 *
 * The timestamps are load-bearing and cannot be dropped as "unused fields".
 * `statusCheckRollup.contexts` carries every ATTEMPT at a context, so the newest
 * attempt has to win before failure is tested — without `completedAt`/
 * `startedAt`/`createdAt` there is nothing to order them by, and a stale FAILURE
 * would outlive the SUCCESS that replaced it.
 *
 * `checkSuite.app.databaseId` and `creator.__typename` are what make a context
 * REQUIRED rather than merely named the same: the branch ruleset identifies a
 * required context by `{context, integration_id}`, and a check posted by someone
 * else under a required context's name must not count.
 *
 * That identity is exactly why this is shared rather than restated.
 * `never-scheduled-runs.ts` reads the rollup on a PR head rather than on a
 * merge-group commit and asks which required rules have reported; a second,
 * hand-copied selection set would drift the moment one of them dropped a field,
 * and the drift would present as a required context looking reported when it was
 * not — a false-healthy, not a parse error.
 */
export const ROLLUP_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    name
    conclusion
    completedAt
    startedAt
    checkSuite { createdAt app { databaseId } }
  }
  ... on StatusContext {
    context
    state
    createdAt
    creator { __typename }
  }
`;

const MERGE_QUEUE_QUERY = `
  query($owner: String!, $name: String!, $branch: String!, $first: Int!, $rollupFirst: Int!) {
    repository(owner: $owner, name: $name) {
      mergeQueue(branch: $branch) {
        entries(first: $first) {
          totalCount
          nodes {
            state
            pullRequest { number }
            headCommit {
              committedDate
              oid
              statusCheckRollup {
                contexts(first: $rollupFirst) {
                  totalCount
                  nodes { ${ROLLUP_CONTEXT_FIELDS} }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const CheckRunNodeSchema = z.object({
  __typename: z.literal("CheckRun"),
  name: z.string(),
  /** NULL while the run is still going — a real state, not missing data. */
  conclusion: z.string().nullable(),
  completedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  /**
   * `App.databaseId` is a NULLABLE Int in GitHub's GraphQL schema, so it is
   * parsed nullable for the same reason the enum fields below are parsed as
   * open strings: one null on one CheckRun in one entry would otherwise fail
   * the whole `MergeQueueResponseSchema` and take the age and depth gauges
   * down with it, not just the required-context match. A null degrades to "no
   * integration id" exactly as an absent `app` or `checkSuite` does.
   */
  checkSuite: z
    .object({
      /**
       * When the SUITE was dispatched, which is the only ordering key a queued
       * attempt has: `CheckRun` carries no `createdAt` of its own (ISS-6018),
       * and a queued re-run has neither `completedAt` nor `startedAt`, so
       * without this it sorts to -Infinity and loses to the very attempt it
       * supersedes.
       */
      createdAt: z.string().nullish(),
      app: z.object({ databaseId: z.number().nullable() }).nullable(),
    })
    .nullable(),
});

const StatusContextNodeSchema = z.object({
  __typename: z.literal("StatusContext"),
  context: z.string(),
  state: z.string(),
  createdAt: z.string().nullable(),
  creator: z.object({ __typename: z.string() }).nullable(),
});

/**
 * The rollup is a `CheckRun | StatusContext` union and the split is NOT "Actions
 * vs Vercel": `e2e-gate` is an Actions-owned required context that arrives as a
 * StatusContext. Both members have to be understood or the required set is read
 * with half of it missing.
 *
 * Enum-valued fields (`conclusion`, `state`, and the entry `state` below) are
 * parsed as plain strings rather than pinned unions: GitHub can add an enum
 * member at any time, and a schema that rejected the whole response over one
 * unknown value would take the age and depth gauges down with it.
 */
const RollupContextNodeSchema = z.discriminatedUnion("__typename", [
  CheckRunNodeSchema,
  StatusContextNodeSchema,
]);

export type RollupContextNode = z.infer<typeof RollupContextNodeSchema>;

/**
 * A node this schema cannot read is DROPPED, not fatal.
 *
 * This sub-tree exists only for `failed_groups`, but it is parsed inside the
 * same response schema that gates `group_age_minutes` and `depth`. Strict
 * parsing here therefore had the secondary signal able to kill the primary
 * paging one: a null element, or a third `StatusCheckRollupContext` member
 * GitHub adds later, failed the WHOLE read as `Malformed`, and the route then
 * published no age, no depth and an error beat — the exact coupling the
 * comments in this file and in the route promise cannot happen.
 *
 * `.catch(null)` degrades an unreadable node to a hole instead. That is safe
 * ONLY because `totalCount` below is the server's own count and is deliberately
 * NOT recomputed from the surviving nodes: a dropped node leaves
 * `totalCount > nodes.length`, which the derivation already treats as an
 * unresolved group. Recomputing it — as `dedupeStatusCheckRollupCandidates` in
 * `index.ts` does for its display path — would hide the hole and could publish a
 * confident zero for a group whose failing check was the node that got dropped.
 */
export const LenientRollupContextNodeSchema =
  RollupContextNodeSchema.nullable().catch(null);

const StatusCheckRollupSchema = z.object({
  contexts: z.object({
    totalCount: z.number().int().nonnegative(),
    nodes: z.array(LenientRollupContextNodeSchema),
  }),
});

/**
 * An unreadable rollup CONTAINER is modeled as a rollup holding one context we
 * could not see — which is exactly what it is.
 *
 * Tolerating bad NODES was not enough: a malformed container (say
 * `totalCount: "1"`) still failed the whole response, so the secondary signal
 * could still take the age and depth gauges down with it. Catching to `null`
 * would have been worse than useless — `null` is the legitimate "this commit
 * has no checks reported yet" state, which reads as CLEAN, so an unparseable
 * rollup would have published a confident zero.
 *
 * A `totalCount` of 1 against zero readable nodes presents as a gap, and the
 * derivation already treats a gap as an unresolved group.
 */
const UNREADABLE_ROLLUP = { contexts: { totalCount: 1, nodes: [] } };

const TolerantStatusCheckRollupSchema =
  StatusCheckRollupSchema.nullable().catch(UNREADABLE_ROLLUP);

/**
 * An entry whose merge group has not been built yet has a NULL `headCommit`.
 * That is a real state, not missing data: GitHub only builds up to
 * `maximumEntriesToBuild` groups at a time.
 */
const MergeQueueEntrySchema = z.object({
  state: z.string(),
  pullRequest: z.object({ number: z.number().int() }).nullable(),
  headCommit: z
    .object({
      committedDate: z.string().datetime(),
      oid: z.string(),
      /** NULL when the group's commit has no checks reported against it at all. */
      statusCheckRollup: TolerantStatusCheckRollupSchema,
    })
    .nullable(),
});

const MergeQueueSchema = z.object({
  entries: z
    .object({
      totalCount: z.number().int().nonnegative(),
      nodes: z.array(MergeQueueEntrySchema),
    })
    // `totalCount` is the population; `nodes` is the page drawn from it, so the
    // page can never be larger. Accepting the inverted shape would publish a
    // depth smaller than the set the age was computed over — two metrics from
    // one read that contradict each other. There is no reading of that response
    // worth trusting, so it is malformed at the boundary rather than reconciled
    // downstream.
    .refine((entries) => entries.totalCount >= entries.nodes.length, {
      message: "totalCount is smaller than the number of nodes returned",
    }),
});

const MergeQueueResponseSchema = z.object({
  repository: z.object({ mergeQueue: MergeQueueSchema.nullable() }).nullable(),
});

export type MergeQueueEntry = z.infer<typeof MergeQueueEntrySchema>;
export type MergeQueueState = z.infer<typeof MergeQueueSchema>;

export const MergeQueueReadStatus = {
  Ok: "ok",
  /** No merge queue on that branch, or the token cannot see it. */
  NotConfigured: "not_configured",
  /** The response did not match the expected shape. */
  Malformed: "malformed",
  /** The API call itself failed. */
  Failed: "failed",
} as const;
export type MergeQueueReadStatus =
  (typeof MergeQueueReadStatus)[keyof typeof MergeQueueReadStatus];

export type MergeQueueReadResult =
  | { status: typeof MergeQueueReadStatus.Ok; state: MergeQueueState }
  | {
      status: Exclude<MergeQueueReadStatus, typeof MergeQueueReadStatus.Ok>;
      detail: string;
    };

/**
 * Reads the live merge queue for a branch.
 *
 * The Octokit is INJECTED rather than resolved here, matching the convention
 * the rest of this package follows: it keeps the function credential-agnostic,
 * so its parsing and classification are testable with no App env and no auth
 * mocking.
 *
 * Every failure is a distinct status rather than a thrown error or a defaulted
 * empty queue: a caller that treats "could not read" as "queue is empty" would
 * publish a confidently healthy reading for a queue it never saw.
 */
export async function getMergeQueueState(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<MergeQueueReadResult> {
  let raw: unknown;
  try {
    raw = await octokit.graphql(MERGE_QUEUE_QUERY, {
      owner,
      name: repo,
      branch,
      first: ENTRIES_PAGE_SIZE,
      rollupFirst: ROLLUP_PAGE_SIZE,
    });
  } catch (error) {
    return {
      status: MergeQueueReadStatus.Failed,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = MergeQueueResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: MergeQueueReadStatus.Malformed,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    };
  }

  const mergeQueue = parsed.data.repository?.mergeQueue;
  if (!mergeQueue) {
    return {
      status: MergeQueueReadStatus.NotConfigured,
      detail: `no merge queue visible on ${owner}/${repo}@${branch}`,
    };
  }

  return { status: MergeQueueReadStatus.Ok, state: mergeQueue };
}

/**
 * The branch ruleset's page size. The required-status-checks rule for `main`
 * fits in one page today; the loop below exists so it keeps working if a future
 * ruleset splits across several, and is bounded so a paging bug cannot spin.
 */
const RULES_PAGE_SIZE = 100;
const RULES_MAX_PAGES = 10;

/**
 * A context is required by `{name, integration}` — NOT by name alone. Anyone can
 * post a commit status called `Vercel – app-stage`; only the one from the Vercel
 * integration is the required check. Matching on name alone would let an
 * unrelated red status from any actor count as a blocked merge group.
 */
export type RequiredContext = {
  context: string;
  /**
   * NULL when the ruleset entry carries no `integration_id` — GitHub documents
   * the field as optional. Such a context is matched by NAME ALONE, because
   * without an integration the name is the only identity the rule provides.
   *
   * Rejecting those entries (the previous behavior) turned one integration-less
   * rule into a permanently omitted gauge for that branch; treating them as
   * "matches nothing" would have been worse still — the required set would be
   * non-empty while nothing could ever match it, publishing a confident zero
   * over a genuinely failing check. Matching by name can over-count against a
   * same-named impostor, and that is the direction this signal is allowed to err.
   */
  integrationId: number | null;
};

export const RequiredContextsReadStatus = {
  Ok: "ok",
  /** The response did not match the expected shape. */
  Malformed: "malformed",
  /** The API call itself failed. */
  Failed: "failed",
} as const;
export type RequiredContextsReadStatus =
  (typeof RequiredContextsReadStatus)[keyof typeof RequiredContextsReadStatus];

export type RequiredContextsReadResult =
  | {
      status: typeof RequiredContextsReadStatus.Ok;
      /**
       * Possibly EMPTY — the branch may genuinely have no required-status-checks
       * rule. Callers must not read empty as "nothing failed": with no required
       * set there is nothing to intersect against, so the only honest reading is
       * that the answer is unknown.
       */
      contexts: RequiredContext[];
    }
  | {
      status: Exclude<
        RequiredContextsReadStatus,
        typeof RequiredContextsReadStatus.Ok
      >;
      detail: string;
    };

/** Wire shape — snake_case keys are GitHub's, normalized to camelCase below. */
const RequiredStatusCheckSchema = z.object({
  context: z.string().min(1),
  /**
   * OPTIONAL per GitHub's rules API. Requiring it made one integration-less rule
   * reject the entire read, which omitted the gauge for that branch forever.
   * A blank `context` is still fatal — that entry really is malformed, and it
   * would match nothing while leaving the required set looking populated.
   */
  integration_id: z.number().int().nullish(),
});

const RequiredStatusChecksRuleSchema = z.object({
  parameters: z.object({
    required_status_checks: z.array(RequiredStatusCheckSchema),
  }),
});

/** Every other rule kind is passed over, so an unknown `type` is not an error. */
const BranchRuleSchema = z.object({ type: z.string() });

const REQUIRED_STATUS_CHECKS_RULE = "required_status_checks";

type RulesPageParse =
  | { ok: true; contexts: RequiredContext[]; ruleCount: number }
  | { ok: false; detail: string };

export function issueSummary(
  issues: { path: PropertyKey[]; message: string }[]
) {
  return issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}

/**
 * Extracts the required contexts from one page of branch rules.
 *
 * Split out of the paging loop so each has ONE job — the loop owns paging and
 * transport failure, this owns shape — and so the loop stays inside the
 * cognitive-complexity ceiling.
 */
function parseRulesPage(rules: unknown, page: number): RulesPageParse {
  const parsedPage = z.array(z.unknown()).safeParse(rules);
  if (!parsedPage.success) {
    return {
      ok: false,
      detail: `branch rules page ${page}: ${issueSummary(parsedPage.error.issues)}`,
    };
  }

  const contexts: RequiredContext[] = [];
  for (const rule of parsedPage.data) {
    // Each rule is re-validated from the RAW item rather than from a narrowed
    // copy, so the strict parse below sees every key GitHub sent.
    const kind = BranchRuleSchema.safeParse(rule);
    if (!kind.success) {
      // Skipping an unreadable rule could skip the required-status-checks rule
      // itself, which would empty the required set without anything saying so.
      return {
        ok: false,
        detail: `branch rules page ${page}: rule is not a typed object`,
      };
    }
    if (kind.data.type !== REQUIRED_STATUS_CHECKS_RULE) {
      continue;
    }
    const parsedRule = RequiredStatusChecksRuleSchema.safeParse(rule);
    if (!parsedRule.success) {
      return {
        ok: false,
        detail: `malformed ${REQUIRED_STATUS_CHECKS_RULE} rule: ${issueSummary(parsedRule.error.issues)}`,
      };
    }
    for (const check of parsedRule.data.parameters.required_status_checks) {
      contexts.push({
        context: check.context,
        integrationId: check.integration_id ?? null,
      });
    }
  }

  return { ok: true, contexts, ruleCount: parsedPage.data.length };
}

/**
 * Reads the LIVE required-context set for a branch from its ruleset.
 *
 * Read live rather than hardcoded because the set is owned by a separate
 * infrastructure repo with no CI: a hardcoded copy would keep counting a context
 * that is no longer required, or stop counting one that newly is, with nothing
 * failing to say so.
 *
 * A blank `context` is rejected outright instead of being skipped: it would
 * match nothing, silently thinning the required set while the caller goes on to
 * publish a confident "nothing is failing" — the exact false-healthy this signal
 * exists to avoid. An ABSENT `integration_id` is not that case; the field is
 * optional in GitHub's API, and such a context is kept and matched by name (see
 * `RequiredContext`).
 */
export async function getRequiredContexts(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string
): Promise<RequiredContextsReadResult> {
  const contexts: RequiredContext[] = [];

  for (let page = 1; page <= RULES_MAX_PAGES; page++) {
    let rules: unknown;
    try {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/rules/branches/{branch}",
        { owner, repo, branch, per_page: RULES_PAGE_SIZE, page }
      );
      rules = response.data;
    } catch (error) {
      return {
        status: RequiredContextsReadStatus.Failed,
        detail: error instanceof Error ? error.message : String(error),
      };
    }

    const parsed = parseRulesPage(rules, page);
    if (!parsed.ok) {
      return {
        status: RequiredContextsReadStatus.Malformed,
        detail: parsed.detail,
      };
    }

    contexts.push(...parsed.contexts);

    if (parsed.ruleCount < RULES_PAGE_SIZE) {
      return { status: RequiredContextsReadStatus.Ok, contexts };
    }
  }

  // Ran out of pages to walk. Returning the partial set would understate what is
  // required, so it is reported as unreadable instead.
  return {
    status: RequiredContextsReadStatus.Failed,
    detail: `branch rules exceeded ${RULES_MAX_PAGES} pages`,
  };
}
