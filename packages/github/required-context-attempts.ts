// Matching a check rollup against the REQUIRED-context set, and collapsing
// re-run attempts to the live one (ISS-4450, ISS-5141, ISS-5386).
//
// Moved here verbatim from the stall cron's derivation (ISS-6018) because it now
// has a second consumer: the "ready to enqueue" sweep asks the same question of
// the same rollup on a PR head that the cron asks of a merge-group commit — has
// this required rule reported, and what did it report. Re-declaring the identity
// rule in the second consumer is the SSOT-drift-by-copy failure AGENTS.md names,
// and the drift would be invisible: both copies would keep answering, just
// differently.
//
// No `server-only` and no Octokit import, matching
// `merge-queue-failure-classification.ts` — it is imported by a pure cron
// derivation and by an ordinary CI script, and neither should drag a GitHub
// client in behind it.
//
// ## The identity, and why it is not a name
//
// A required rule is `{context, integration_id}`. Anyone can post a check run
// called `test`; only the one from the integration the ruleset names is the
// required check. Matching by name alone lets an impostor stand in for a rule
// that never reported, which reads as healthy — the false direction.

// Explicit `.ts` extensions, unlike most of this package. Node resolves ESM
// specifiers literally, so an extensionless relative import is unresolvable to
// anything but a bundler — and this module is executed directly by `node` from
// `scripts/ci/ready-to-enqueue.ts`, in a workflow with no build step.
// `allowImportingTsExtensions` is already on for this package, so the form costs
// the bundler consumers nothing.
import type { RequiredContext, RollupContextNode } from "./merge-queue.ts";
import {
  TERMINAL_CHECK_CONCLUSIONS,
  TERMINAL_STATUS_STATES,
} from "./merge-queue-failure-classification.ts";

const BOT_ACTOR_TYPENAME = "Bot";

const CHECK_RUN_PRIORITY = 0;
const STATUS_CONTEXT_PRIORITY = 1;

/**
 * `CheckRun.conclusion` values branch protection accepts as satisfying a
 * required context, in the GraphQL enum's casing.
 *
 * `SKIPPED` is the load-bearing member: GitHub treats a skipped required check
 * as satisfied, and `e2e-gate` reports `skipped` on most PRs — its entry in
 * `merge-group-required-contexts-manifest.ts` records that verbatim. A readiness
 * signal that waited for green would never flip on those PRs. `NEUTRAL` is
 * accepted for the same reason GitHub accepts it.
 *
 * Deliberately an ALLOW-LIST rather than "not a terminal failure". `CANCELLED`
 * and `ACTION_REQUIRED` are neither in `TERMINAL_CHECK_CONCLUSIONS` nor
 * satisfying, and GitHub can add an enum member at any time — an unknown
 * conclusion read as satisfied is a confident "ready to merge" over a context
 * that is blocking, which is the one direction this must never err in.
 */
export const SATISFYING_CHECK_CONCLUSIONS = [
  "SUCCESS",
  "SKIPPED",
  "NEUTRAL",
] as const;

/** `StatusContext.state` values that satisfy a required context. */
export const SATISFYING_STATUS_STATES = ["SUCCESS"] as const;

/** `StatusContext.state` values that mean the context has not reported yet. */
const PENDING_STATUS_STATES = ["PENDING", "EXPECTED"] as const;

/**
 * Whether an attempt satisfies the required rule it matched, as BRANCH
 * PROTECTION would judge it.
 *
 * A separate axis from `ContextAttempt.failed`, not a re-spelling of it. That
 * one is the EJECTION classification shared with the merge-queue metrics
 * emitter, which deliberately excludes `CANCELLED` (an ejection's aftermath, not
 * its cause) and `ACTION_REQUIRED`. Both of those still block a merge, so the
 * two questions have genuinely different answers and both are asked here.
 */
export const RequiredAttemptState = {
  /** Branch protection would let this one through. */
  Satisfied: "satisfied",
  /** Still running, or a status that has not resolved. */
  Pending: "pending",
  /** Reported something that is not satisfying — failed, cancelled, unknown. */
  NotSatisfied: "not_satisfied",
} as const;
export type RequiredAttemptState =
  (typeof RequiredAttemptState)[keyof typeof RequiredAttemptState];

/**
 * One attempt at one context, flattened from either arm of the rollup union so
 * the two can be compared against each other.
 */
export type ContextAttempt = {
  name: string;
  /**
   * Terminal failure under the EJECTION classification
   * (`merge-queue-failure-classification.ts`). See `RequiredAttemptState` for
   * why readiness does not reuse it.
   */
  failed: boolean;
  /** How branch protection would judge this attempt. */
  state: RequiredAttemptState;
  /**
   * Identity of the required RULE this attempt satisfies, or null if it
   * satisfies none.
   *
   * A boolean was not enough. Two required rules can share a context name under
   * different integrations, and collapsing them by name let a newer success
   * from one app retire a failure from the other — the rules contract
   * identifies a required context by `{context, integration_id}`, so the
   * collapse has to use that same identity.
   */
  requiredKey: string | null;
  observedAtMs: number;
  /** Lower wins a timestamp tie: a CheckRun outranks a StatusContext. */
  sourcePriority: number;
  position: number;
};

/** `\u0000` cannot appear in a context name, so the join is unambiguous. */
export function requiredKey(entry: RequiredContext): string {
  return `${entry.context}\u0000${entry.integrationId ?? "*"}`;
}

/**
 * The context name off either arm of the rollup union.
 *
 * Exported so a caller that needs only the NAME does not re-write the
 * discrimination. A copied `__typename === "CheckRun" ? ... : ...` ternary is
 * exactly the drift this module's header exists to prevent: if GitHub adds a
 * third `StatusCheckRollupContext` member, the union handling here is what gets
 * updated, and the copy would silently keep reading the new arm as a
 * StatusContext.
 */
export function contextNameOf(node: RollupContextNode): string {
  return node.__typename === "CheckRun" ? node.name : node.context;
}

/**
 * True when this node reported `SKIPPED`.
 *
 * Exported for the advisory COUNT rather than for any verdict: GitHub collapses
 * skipped rows out of the check list an author is looking at, so counting them
 * would print a number that cannot be reconciled against the page — on the very
 * line whose job is to correct that author's miscount.
 */
export function isSkippedNode(node: RollupContextNode): boolean {
  return node.__typename === "CheckRun" && node.conclusion === "SKIPPED";
}

/** Absent timestamps sort oldest, so any dated attempt beats an undated one. */
function observedAtMs(value: string | null): number {
  if (value === null) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function matchedCheckRunRule(
  node: Extract<RollupContextNode, { __typename: "CheckRun" }>,
  required: readonly RequiredContext[]
): RequiredContext | null {
  // Nullish, not just undefined: `App.databaseId` is nullable in GitHub's
  // schema, so an explicit null means "no integration id" exactly as an absent
  // `app` or `checkSuite` does.
  const integrationId = node.checkSuite?.app?.databaseId;
  return (
    required.find((entry) => {
      if (entry.context !== node.name) {
        return false;
      }
      // A rule with no `integration_id` (the field is optional in GitHub's API)
      // provides no identity beyond the name, so the name is what it matches on.
      if (entry.integrationId === null) {
        return true;
      }
      return entry.integrationId === integrationId;
    }) ?? null
  );
}

/**
 * A StatusContext carries no app id, so the integration cannot be matched the
 * way a CheckRun's can. "Posted by a Bot" is the closest available stand-in.
 *
 * The obvious alternative — matching the creator's login against a known
 * literal — was measured and rejected: GraphQL reports Vercel's login as
 * `vercel` while REST reports `vercel[bot]`, so a literal copied from the wrong
 * API silently stops counting the very context that failed in both incidents.
 * Under-reporting a real stall is worse than the narrow over-count this admits.
 */
function matchedStatusContextRule(
  node: Extract<RollupContextNode, { __typename: "StatusContext" }>,
  required: readonly RequiredContext[],
  /**
   * Passed in rather than derived here so the ambiguity test below can ask the
   * SAME matcher what a readable poster would have matched. Two copies of this
   * predicate would drift, and the drift would be invisible.
   */
  postedByBot: boolean
): RequiredContext | null {
  return (
    required.find((entry) => {
      if (entry.context !== node.context) {
        return false;
      }
      // The Bot test is a STAND-IN for the integration id a StatusContext does
      // not carry, so it only applies where the rule actually names an
      // integration. A rule with no `integration_id` constrains nothing but the
      // name, and adding a poster constraint it never expressed would drop a
      // genuinely failing status and publish a confident zero.
      return entry.integrationId === null || postedByBot;
    }) ?? null
  );
}

/** The Bot stand-in, read off a node whose creator GitHub actually returned. */
function postedByBotActor(
  node: Extract<RollupContextNode, { __typename: "StatusContext" }>
): boolean {
  return node.creator?.__typename === BOT_ACTOR_TYPENAME;
}

function keyOfMatch(entry: RequiredContext | null): string | null {
  return entry === null ? null : requiredKey(entry);
}

/**
 * The required rule a StatusContext WOULD satisfy if its poster could be read,
 * or null when there is nothing ambiguous about it.
 *
 * `creator` is nullable in GitHub's schema, and reading a null one through the
 * optional chain renders it as "not a Bot" — the one path in this file where an
 * oddity degraded toward healthy. The status stopped matching its required rule,
 * `liveAttempts` dropped it before the failure test, and a genuinely red
 * required context published a confident 0.
 *
 * Counting it as a Bot instead would only invert the lie. A missing creator is
 * ambiguous in BOTH directions: the hidden poster may own the FAILURE we can see
 * (dropping it undercounts), or a newer SUCCESS that already retired one
 * (admitting it overcounts).
 *
 * It returns the KEY rather than a boolean because that ambiguity is scoped to
 * the one rule it could satisfy. Only an unreadable poster on the SAME rule can
 * retire that rule's failure, so a confirmed failure on any OTHER required
 * context in the group still stands — see `deriveFailedGroups`. (ISS-5386)
 */
function ambiguousStatusPosterKey(
  node: RollupContextNode,
  required: readonly RequiredContext[]
): string | null {
  if (node.__typename !== "StatusContext") {
    return null;
  }
  // A creator that IS present but is not a Bot is a KNOWN human poster, not an
  // unknown one — `matchedStatusContextRule` is right to exclude it outright.
  if (node.creator) {
    return null;
  }
  // Asked of the SAME matcher, so this cannot drift from the real rule. A node
  // that already matches with the stand-in FALSE is unambiguous whatever the
  // poster was — a rule naming no integration constrains nothing but the context
  // name, so a missing creator costs it nothing there.
  if (matchedStatusContextRule(node, required, false) !== null) {
    return null;
  }
  // Ambiguous only if a readable Bot poster would have changed the answer.
  return keyOfMatch(matchedStatusContextRule(node, required, true));
}

function checkRunState(conclusion: string | null): RequiredAttemptState {
  if (conclusion === null) {
    return RequiredAttemptState.Pending;
  }
  if (SATISFYING_CHECK_CONCLUSIONS.some((value) => value === conclusion)) {
    return RequiredAttemptState.Satisfied;
  }
  return RequiredAttemptState.NotSatisfied;
}

function statusContextState(state: string): RequiredAttemptState {
  if (SATISFYING_STATUS_STATES.some((value) => value === state)) {
    return RequiredAttemptState.Satisfied;
  }
  if (PENDING_STATUS_STATES.some((value) => value === state)) {
    return RequiredAttemptState.Pending;
  }
  return RequiredAttemptState.NotSatisfied;
}

function toAttempt(
  node: RollupContextNode,
  position: number,
  required: readonly RequiredContext[]
): ContextAttempt {
  if (node.__typename === "CheckRun") {
    return {
      name: node.name,
      failed: TERMINAL_CHECK_CONCLUSIONS.some(
        (conclusion) => conclusion === node.conclusion
      ),
      state: checkRunState(node.conclusion),
      requiredKey: keyOfMatch(matchedCheckRunRule(node, required)),
      // The suite's creation time is the LAST fallback, not the first: a queued
      // re-run has neither `completedAt` nor `startedAt` (and `CheckRun` has no
      // `createdAt` of its own), so without it the re-run sorts to -Infinity,
      // loses to the older completed SUCCESS it supersedes, and the PR is
      // reported ready while branch protection is still waiting on it.
      //
      // Dispatch time rather than "pending always wins", because the inverse
      // case is this module's own subject: a run that never scheduled (ISS-6011)
      // is also permanently timestamp-less, and must still LOSE to a later
      // SUCCESS rather than pin the context pending forever. Ordering by when
      // each attempt was dispatched gets both right.
      observedAtMs: observedAtMs(
        node.completedAt ?? node.startedAt ?? node.checkSuite?.createdAt ?? null
      ),
      sourcePriority: CHECK_RUN_PRIORITY,
      position,
    };
  }
  return {
    name: node.context,
    failed: TERMINAL_STATUS_STATES.some((state) => state === node.state),
    state: statusContextState(node.state),
    requiredKey: keyOfMatch(
      matchedStatusContextRule(node, required, postedByBotActor(node))
    ),
    observedAtMs: observedAtMs(node.createdAt),
    sourcePriority: STATUS_CONTEXT_PRIORITY,
    position,
  };
}

/**
 * True when `candidate` should replace `incumbent` as the live attempt for a
 * context. Mirrors the identity and winner rule in
 * `dedupeStatusCheckRollupCandidates` (`packages/github/index.ts`) rather than
 * inventing a second one: newest observation wins, a CheckRun beats a
 * StatusContext on a tie, and later position breaks a remaining tie.
 */
function beats(candidate: ContextAttempt, incumbent: ContextAttempt): boolean {
  if (candidate.observedAtMs !== incumbent.observedAtMs) {
    return candidate.observedAtMs > incumbent.observedAtMs;
  }
  if (candidate.sourcePriority !== incumbent.sourcePriority) {
    return candidate.sourcePriority < incumbent.sourcePriority;
  }
  return candidate.position > incumbent.position;
}

/**
 * Collapses re-run attempts to the live one per context BEFORE failure is
 * tested. Filtering for failure first is the bug this exists to prevent: a
 * context that failed and was then re-run green still has its old FAILURE node
 * in the rollup, so a failure-first read keeps the gauge red after the re-run
 * has already fixed the group.
 */
export function liveAttempts(
  /** Nullable: the boundary schema drops a node it cannot read rather than
   * failing the whole response, which would take the age and depth gauges with
   * it. The dropped node still shows up as a `totalCount` gap upstream. */
  nodes: readonly (RollupContextNode | null)[],
  required: readonly RequiredContext[]
): ContextAttempt[] {
  const byRule = new Map<string, ContextAttempt>();
  for (const [position, node] of nodes.entries()) {
    if (node === null) {
      continue;
    }
    const attempt = toAttempt(node, position, required);
    // REQUIRED-ONLY, and filtered BEFORE the collapse rather than after it.
    // Collapsing first let a newer same-named attempt that is NOT required — a
    // different integration, or a human-posted status — evict a required one
    // that was failing, and the group then read clean.
    if (attempt.requiredKey === null) {
      continue;
    }
    // Keyed on the matched RULE, not on the context name. Exact name alone
    // still collapsed two required rules that share a name under different
    // integrations, and it is deliberately NOT `getStatusCheckDedupeKey` from
    // `@repo/github/provider-field-normalize`: that helper lower-cases because
    // it dedupes a PR's check list for DISPLAY, where case-variants are one row
    // to a human. Here identity has to be the ruleset's.
    const incumbent = byRule.get(attempt.requiredKey);
    if (!incumbent || beats(attempt, incumbent)) {
      byRule.set(attempt.requiredKey, attempt);
    }
  }
  return [...byRule.values()];
}

/**
 * The required rules in ONE group whose verdict turns on a poster GitHub did not
 * return. Collected per group, so a confirmed failure on any other rule in the
 * same group is still judged normally.
 */
export function ambiguousPosterKeys(
  nodes: readonly (RollupContextNode | null)[],
  required: readonly RequiredContext[]
): ReadonlySet<string> {
  return new Set(
    ambiguousStatusCandidates(nodes, required).map(
      (candidate) => candidate.requiredKey
    )
  );
}

/** One status whose poster GitHub did not name, and WHEN it was posted. */
export type AmbiguousStatusCandidate = {
  requiredKey: string;
  observedAtMs: number;
};

/**
 * The same ambiguous statuses `ambiguousPosterKeys` collects, but dated.
 *
 * The timestamp is the whole point: an unreadable poster is only a problem while
 * that status could still be the LIVE attempt for its rule. The rollup carries
 * every historical attempt, so a creatorless status from days ago sits in the
 * response forever — and a caller that treats the bare presence of one as
 * unreadable never recovers, even after a newer readable result has retired it.
 * A caller that can order it against the attempt that survived can tell the two
 * apart; one that only needs "is this rule implicated at all" still uses the
 * key set above.
 */
export function ambiguousStatusCandidates(
  nodes: readonly (RollupContextNode | null)[],
  required: readonly RequiredContext[]
): AmbiguousStatusCandidate[] {
  const candidates: AmbiguousStatusCandidate[] = [];
  for (const node of nodes) {
    if (node === null || node.__typename !== "StatusContext") {
      continue;
    }
    const requiredKey = ambiguousStatusPosterKey(node, required);
    if (requiredKey !== null) {
      candidates.push({
        requiredKey,
        observedAtMs: observedAtMs(node.createdAt),
      });
    }
  }
  return candidates;
}

/**
 * A failing attempt counts unless an unreadable poster could have RETIRED this
 * very failure.
 *
 * Only a status satisfying the SAME required rule can do that — the collapse in
 * `liveAttempts` is keyed on the rule, so a newer SUCCESS never retires a
 * different rule's failure. An unreadable poster on any other context therefore
 * leaves this verdict untouched, which is what keeps a confirmed red group
 * reported instead of deferred.
 */
export function isConfirmedFailure(
  attempt: ContextAttempt,
  ambiguousKeys: ReadonlySet<string>
): boolean {
  if (!attempt.failed) {
    return false;
  }
  return (
    attempt.requiredKey === null || !ambiguousKeys.has(attempt.requiredKey)
  );
}

/**
 * The required contexts with NOTHING reported against a commit's rollup
 * (ISS-6011).
 *
 * Lives beside the identity rule rather than in the never-scheduled derivation,
 * because the identity is the hard part. A required rule is
 * `{context, integration_id}`, so "has `test` reported?" is not a name lookup:
 * any app can post a check run called `test`, and matching by name alone would
 * let an impostor stand in for the required rule and make a genuinely absent
 * context look reported. That is the false-healthy direction on a paging signal,
 * and it is the exact collapse ISS-5141 and ISS-5386 removed from the failure
 * verdict. Routing through `liveAttempts` means the two answers cannot drift:
 * whatever counts as "this rule reported" for the failure verdict counts here.
 *
 * Note this asks a DIFFERENT question of the same attempts than
 * `deriveFailedGroups` does. That one asks whether a reported context is red;
 * this one asks whether it reported at all. A red required check is therefore
 * NOT unreported — a workflow that ran and failed is a different problem with a
 * different owner, and this signal is only about the one that never ran.
 */
export function unreportedRequiredContexts(
  nodes: readonly (RollupContextNode | null)[],
  required: readonly RequiredContext[]
): string[] {
  const reported = new Set(
    liveAttempts(nodes, required).map((attempt) => attempt.requiredKey)
  );
  return [
    ...new Set(
      required
        .filter((entry) => !reported.has(requiredKey(entry)))
        .map((entry) => entry.context)
    ),
  ];
}
