// Reading GitHub's PARTIAL answer to the open-PR-heads query (ISS-10452).
//
// Split out of `never-scheduled-runs.ts` rather than appended to it: that file
// was at the 1,000-line ceiling, and this is one cohesive responsibility —
// everything about an answer GitHub gave with `errors[]` attached, and nothing
// about reading PR heads.
//
// The behaviour it exists for: since 2026-09-16 GitHub answers this query with
// HTTP 200, a fully populated `data`, AND an `errors[]` carrying
// `Resource not accessible by integration` for a handful of nodes — ~16 of 1,411
// on the day it started. `octokit.graphql` throws on any `errors` entry, so the
// reader's catch discarded 1,395 readable nodes with them: the stall cron
// omitted its gauge entirely and `scripts/ci/ready-to-enqueue.ts` failed every
// run. The readable nodes are a real reading over a smaller set.

// Explicit `.ts`: this module is reached from `never-scheduled-runs.ts`, which
// `scripts/ci/ready-to-enqueue.ts` executes under plain `node` — and node
// resolves ESM specifiers literally rather than probing extensions.
import {
  graphqlErrorEntries,
  graphqlErrorPaths,
  type PartialGraphqlEnvelope,
  recoverPartialGraphqlEnvelope,
} from "./provider-error-classification.ts";

/**
 * What GitHub refused on a page it otherwise answered (ISS-10452).
 *
 * Present on an `Ok` read, because a salvaged answer is a REAL reading over a
 * smaller set and not a failure — but it is a lower bound, so the shortfall is
 * carried beside the value rather than left for the caller to infer. A caller
 * that only wants the heads can ignore it; one that reports on its own
 * completeness must not.
 */
export type OpenPullRequestsPartialRead = {
  /** How many `errors[]` entries the salvaged pages carried, in total. */
  graphqlErrorCount: number;
  /**
   * The first few error `path`s, which name the selections GitHub refused.
   * Bounded by {@link REPORTED_GRAPHQL_ERROR_PATHS} — a single answer can carry
   * hundreds, and this rides in a log line on every tick.
   */
  paths: string[];
};

/**
 * How many GraphQL error paths a failure detail or a salvage note carries.
 *
 * Three, not all of them: one 403 answer on 2026-09-16 carried ~16 entries over
 * 1,411 nodes, and this string goes to a log line on a five-minute cron. Enough
 * to name where the refusal landed without letting the line grow with the repo.
 */
const REPORTED_GRAPHQL_ERROR_PATHS = 3;

/**
 * GitHub's partial answer, recovered from the throw — or null when there is
 * nothing to recover (ISS-10452).
 *
 * Since 2026-09-16 GitHub answers this query with HTTP 200, a fully populated
 * `data`, AND an `errors[]` carrying `Resource not accessible by integration`
 * for a handful of nodes — ~16 of 1,411 on the day it started. `octokit.graphql`
 * throws on any `errors` entry, so the catch above discarded 1,395 readable
 * nodes with them: the stall cron omitted its gauge entirely and
 * `scripts/ci/ready-to-enqueue.ts` failed every run. The readable nodes are a
 * real reading over a smaller set, and the machinery below already models the
 * hole — `LenientRollupContextNodeSchema` degrades an unreadable context to
 * null, which leaves `totalCount` above the readable count and lands as
 * `rollupTruncated`, i.e. as an unresolved verdict rather than a healthy one.
 *
 * The SHAPE guard is what keeps this from swallowing a genuine failure. GitHub's
 * server-side abort answers the same 200-plus-`errors` envelope with
 * `repository.pullRequests` NULL — nothing to salvage, and recovering it would
 * report the abort as a zod complaint instead of as GitHub's own message. Only
 * a connection that is actually there is salvageable; everything else falls
 * through to `Failed`, exactly as before. Same salvage, and the same
 * `recoverPartialGraphqlEnvelope` helper, as `pull-request-point-read.ts`
 * (ISS-8287).
 *
 * The ENVELOPE comes back, not just the data, because the attribution below has
 * to read the `errors` that shipped with THIS wrapper: octokit hangs them off
 * the error, but a nested `response.data.data` payload keeps them at
 * `response.data.errors`, and reading the wrong one reports "nothing refused"
 * over an answer GitHub refused part of.
 *
 * A candidate qualifies only when it carries BOTH the connection and at least
 * one error entry (raised by marisolashgrove on #7440). Matching on the data alone
 * admitted an envelope whose errors live on a DIFFERENT wrapper, and the walk
 * then published `partial:true` beside "GitHub refused 0 selection(s) (no path
 * reported)" — a shortfall asserted over an answer nothing was refused in,
 * while `refusedPullRequestNodes` handed that same empty array said nothing
 * was. Requiring both keeps "salvaged" and "something was refused" ONE fact,
 * and it makes the search pick the wrapper that is internally consistent rather
 * than the first one that merely looks like a page. The rule itself is owned by
 * `recoverPartialGraphqlEnvelope`, so every salvage applies the same one.
 *
 * It does not narrow the salvage this module exists for. octokit throws only
 * once the body carried `errors`, so the ISS-10452 shape always has them, and
 * every salvage case here still recovers. A throw carrying a page-shaped
 * payload and NO errors is not a partial GraphQL answer at all — calling it one
 * would invent a reading rather than recover one, which is the opposite of the
 * rule this module serves.
 */
export function recoverPartialOpenPullRequests(
  error: unknown
): PartialGraphqlEnvelope | null {
  return recoverPartialGraphqlEnvelope(error, hasPullRequestsConnection);
}

function hasPullRequestsConnection(
  value: unknown
): value is { repository: { pullRequests: object } } {
  const repository = (value as { repository?: unknown } | null)?.repository;
  const pullRequests = (repository as { pullRequests?: unknown } | null)
    ?.pullRequests;
  return typeof pullRequests === "object" && pullRequests !== null;
}

/**
 * Folds one salvaged page's shortfall into the walk's running total.
 *
 * `errors` is non-empty by construction — `recoverPartialOpenPullRequests` only
 * returns an envelope that carried entries — so the result always asserts a
 * shortfall that happened. Handing this an empty array would publish a
 * `partial` reading claiming nothing.
 *
 * Counts sum across pages because each page is a separate answer; paths are
 * capped rather than concatenated so a walk that salvages every page cannot grow
 * this unbounded.
 */
export function mergePartialRead(
  previous: OpenPullRequestsPartialRead | null,
  errors: readonly unknown[]
): OpenPullRequestsPartialRead {
  const paths = graphqlErrorPaths(errors, REPORTED_GRAPHQL_ERROR_PATHS);
  const count = errors.length;
  if (previous === null) {
    return { graphqlErrorCount: count, paths };
  }
  return {
    graphqlErrorCount: previous.graphqlErrorCount + count,
    paths: [...previous.paths, ...paths].slice(0, REPORTED_GRAPHQL_ERROR_PATHS),
  };
}

/** A page GitHub answered in full: no head's rollup is in doubt. */
export const NOTHING_REFUSED = (_index: number) => false;

/** Every path in this query is rooted here — the query has one root selection. */
const PULL_REQUEST_NODES_PATH = ["repository", "pullRequests", "nodes"];

/**
 * Which of THIS PAGE's PR nodes a refusal landed under, as a predicate over the
 * node's index in `connection.nodes` (ISS-10452).
 *
 * The salvage keeps the readable nodes, but "readable" has to be decided PER
 * HEAD: a refusal under one PR says nothing about the other 24, and saying it
 * did would answer every PR on the page Unknown over one refused node.
 *
 * An entry this cannot attribute marks the WHOLE page instead of being ignored.
 * The query has a single root selection, so any path here is about these nodes;
 * we simply cannot say which one, and the failure direction that matters is a
 * confident verdict over a rollup nobody saw. Rare by construction — GitHub
 * attributes a per-field error with a full path.
 */
export function refusedPullRequestNodes(
  errors: readonly unknown[]
): (index: number) => boolean {
  if (errors.length === 0) {
    return NOTHING_REFUSED;
  }
  const refused = new Set<number>();
  for (const entry of errors) {
    const index = refusedPullRequestIndex(entry);
    if (index === null) {
      return () => true;
    }
    refused.add(index);
  }
  return (index: number) => refused.has(index);
}

/** The `nodes[i]` an error entry points at, or null when it names no node. */
function refusedPullRequestIndex(entry: unknown): number | null {
  const path = (entry as { path?: unknown } | null)?.path;
  if (!Array.isArray(path) || path.length <= PULL_REQUEST_NODES_PATH.length) {
    return null;
  }
  const rooted = PULL_REQUEST_NODES_PATH.every(
    (segment, position) => path[position] === segment
  );
  const index = path[PULL_REQUEST_NODES_PATH.length];
  if (!(rooted && typeof index === "number" && Number.isInteger(index))) {
    return null;
  }
  return index;
}

/**
 * The thrown error's message, plus the paths that name what GitHub refused.
 *
 * The message alone was the whole detail until ISS-10452, and on a per-node
 * permission error every entry carries the SAME message — so the one field that
 * says which node is unreadable was the one field being dropped. Absent paths
 * (a transport failure, a plain `Error`) leave the detail exactly as it was.
 */
export function graphqlFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const paths = graphqlErrorPaths(
    graphqlErrorEntries(error),
    REPORTED_GRAPHQL_ERROR_PATHS
  );
  return paths.length > 0 ? `${message} (at ${paths.join(", ")})` : message;
}
