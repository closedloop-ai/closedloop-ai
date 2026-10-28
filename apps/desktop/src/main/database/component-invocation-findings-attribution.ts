/**
 * @file component-invocation-findings-attribution.ts
 * @description ISS-11238: the join between ISS-10724's attributor and
 * ISS-10725's columns, on the Desktop write side.
 *
 * Both halves already existed and nothing wired them together, so a Desktop
 * code-review run synced with `findings_emitted`/`findings_invalidated` NULL —
 * which the read contract correctly reports as "nothing ever measured this".
 * This module reads the `review_result.json` envelopes the run left on disk,
 * runs them through {@link collectCodeReviewFindings}, and stamps the resolved
 * funnel onto the matching invocation candidate BEFORE the insert.
 *
 * WHICH RUNS BELONG TO THIS SESSION. A repository accumulates every review it
 * has ever run under `.closedloop-ai/code-review/`, so reading the whole
 * directory would attribute a year of findings to every session imported from
 * that checkout. Only a run the session ITSELF names is read, and only from its
 * tool INPUTS: an input is a path the session asked its own harness to act on,
 * so it is evidence of work this session did in that directory. A tool OUTPUT is
 * not — a `Glob` over the tree for every `review_result.json`, or a `grep -rl`,
 * prints every run the checkout has ever accumulated, so scanning outputs would
 * re-admit exactly the year-of-findings attribution this paragraph rules out
 * (tamsinb on #7978). A run whose directory was cleaned up is then absent
 * rather than mis-attributed, which is the cost ISS-10724 already recorded for
 * the collector-recovers route.
 *
 * NEVER DROPPED, NEVER CRASHED, NEVER FABRICATED (ISS-11238 AC2). An envelope
 * that is missing, unparseable, or names a reviewer this build cannot place
 * leaves the candidate exactly as it was born — unattributed — and the whole
 * pass is best-effort: the candidates are written either way. `null` is the
 * honest internal spelling of "unknown", and a wrong component's name would be
 * worse than none.
 *
 * WHAT THE PER-ROW STAMP DOES AND DOES NOT CLAIM. The envelope carries no
 * invocation identifier, and several reviewers of one run are spawned as the
 * SAME subagent type (`bha_p0` and `auditor` are both
 * `code-review:code-review-worker`), which is why ISS-10724 reports
 * `association: ambiguous` rather than an exact match. So a funnel is placed on
 * AN invocation of the component that produced it, in a deterministic order,
 * and not on a provably-identified one: the component's totals are exact, every
 * stamped pair is a real reviewer's real pair, and which of N same-component
 * invocations owns which reviewer's funnel is not recoverable from this
 * evidence. Refusing to stamp on that account would discard a real measurement
 * to buy a precision the envelope cannot supply — the count is published with
 * the ambiguity reported beside it (see {@link reportFindingsAttribution}).
 *
 * ONLY THE TRANSCRIPT IMPORT PATH STAMPS. The stored-row rebuild lanes have no
 * session to scan and no cwd to read, which is exactly why
 * `preserveMeasuredFindings` carries a prior row's funnel forward for them.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  AgentComponentFindingsDisposition,
  agentComponentFindingsDispositionLabel,
  agentComponentFindingsWithheldDisposition,
} from "@repo/api/src/types/agent-component-findings-disposition";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import { CODE_REVIEW_FUNNEL_COMPONENT_KEYS } from "@repo/lib/code-review/findings-funnel-attribution";
import {
  CODE_REVIEW_FINDINGS_FOLD_BUDGET,
  type CodeReviewBudgetSpend,
  type CodeReviewRunSource,
  collectCodeReviewFindings,
} from "@repo/lib/code-review/findings-funnel-ingest";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import type { AgentComponentInvocationCandidate } from "./component-invocation-row-writer.js";

/** Where the `code-review` plugin keeps one directory per run. */
const CODE_REVIEW_RUN_ROOT = [".closedloop-ai", "code-review"] as const;
const REVIEW_RESULT_FILENAME = "review_result.json";

/** Per-envelope read deadline. A local file this size is milliseconds away. */
const RUN_ENVELOPE_READ_TIMEOUT_MS = 2000;
/** Open descriptors in flight at once, so a long session cannot exhaust them. */
const RUN_ENVELOPE_READ_CONCURRENCY = 8;
/** What the whole enrichment may cost the transaction it runs inside. */
const RUN_ENVELOPE_PASS_BUDGET_MS = 5000;
/**
 * The largest envelope this pass will read and parse (whitlockk on #7978).
 *
 * `JSON.parse` is synchronous and runs on the store thread INSIDE the writer
 * transaction, so a pathological envelope costs the whole app its only writer
 * slot and the db-host its RSS. The `stat` is what bounds it: a file past this
 * size is reported as UNREADABLE, never truncated and never partially counted,
 * because a capped bucket would publish a number smaller than the run's real
 * one as if it were the measurement. A real run of this plugin is kilobytes —
 * the largest `review_result.json` in this repo's own history is under 300 KB.
 */
const RUN_ENVELOPE_MAX_BYTES = 8 * 1024 * 1024;

/*
 * ISS-11310: BYTES ARE NOT THE ONLY UNBOUNDED DIMENSION, AND THE SECOND GATE IS
 * NOT HERE.
 *
 * The gate above bounds how much this pass will READ and hand to `JSON.parse`.
 * It does not bound the FOLD: 8 MiB of minimal JSON array entries is several
 * million bucket entries, and both `parseCodeReviewResultEnvelope`'s
 * `z.array(z.unknown())` and the attributor's per-finding verdict read are linear
 * in that number — inside this same writer transaction. So the count bound lives
 * with the linear work, in `@repo/lib/code-review/findings-funnel-ingest`
 * ({@link CODE_REVIEW_FINDINGS_FOLD_BUDGET}), and its refusals arrive here as
 * `countCappedRuns`. Lowering the byte gate is NOT a substitute for it and the
 * ticket says so: the two bound different failure modes.
 */

/**
 * A run directory named anywhere in the session's own tool traffic. Anchored on
 * the plugin's fixed prefix so an unrelated `cr-` token cannot mint a run id,
 * and tolerant of both path separators because the transcript carries whatever
 * the harness wrote.
 *
 * The PREFIX is captured as well as the id, because a run id is only "stable
 * within a repository" (`findings-funnel-ingest.ts`) and rebuilding the path
 * from `session.cwd` alone would read a same-named run out of whatever tree the
 * session happened to sit in — another worktree's envelope stamped onto these
 * invocations as a confident measurement. An ABSOLUTE reference is read where
 * the session said it was; a relative one is RESOLVED against the cwd
 * (`path.resolve(cwd, prefix)`), which is what it was relative to. Replacing a
 * relative prefix with the bare cwd instead would read `<cwd>/.closedloop-ai/…`
 * for a run that lived in `<cwd>/sub/pkg/.closedloop-ai/…` — either finding
 * nothing, or finding a same-named run from the wrong tree, which is the very
 * mis-attribution the capture exists to prevent (tamsinb on #7978).
 *
 * ISS-10911: the prefix is the whole separator-free token the reference sits in,
 * so the text is split on {@link RUN_REFERENCE_TOKEN_SEPARATOR} and only the
 * tail below is matched inside each token. A single regex with a leading
 * `[^…]*` prefix group re-scans the rest of the token from every start position:
 * quadratic in the longest separator-free run, synchronous on the store thread,
 * inside the writer transaction. One 256 KB base64 tool input held the thread
 * for 2 to 2.6 minutes; quadratic growth reaches the 65-minute unresponsive
 * watchdog near 1.4 MB.
 * Within one token the greedy prefix settled on the LAST reference, so
 * {@link lastRunReferenceIn} keeps that choice.
 */
const RUN_REFERENCE_TOKEN_SEPARATOR = /[\s"'`,\]}]+/;
const CODE_REVIEW_RUN_MARKER = ".closedloop-ai";
const CODE_REVIEW_RUN_REFERENCE_TAIL =
  /\.closedloop-ai[/\\]code-review[/\\](cr-[A-Za-z0-9_-]+)/g;

/**
 * A run's identity here is its RESOLVED ABSOLUTE ENVELOPE PATH, not its run id.
 *
 * A run id is only "stable within a repository" (`findings-funnel-ingest.ts`),
 * so two checkouts open in one session can both hold `cr-60054`. Keying the
 * ingest by id makes `collectCodeReviewFindings` collapse the second
 * repository's run into the first and drop every finding it carried (codex on
 * #7978), so the path is what travels as the key.
 */
export type CodeReviewEnvelopePath = string;

/**
 * The run envelopes this session referenced, de-duplicated by resolved path and
 * in a stable order so a re-import reads the same files in the same sequence.
 */
export function codeReviewEnvelopePathsInSession(
  session: NormalizedSession,
  cwd: string
): readonly CodeReviewEnvelopePath[] {
  const files = new Set<CodeReviewEnvelopePath>();
  for (const toolUse of session.toolUses ?? []) {
    collectRunReferencesFromValue(toolUse.input, cwd, files);
  }
  return [...files].sort((left, right) => (left < right ? -1 : 1));
}

function collectRunReferencesFromValue(
  value: unknown,
  cwd: string,
  into: Set<CodeReviewEnvelopePath>
): void {
  if (value === undefined || value === null) {
    return;
  }
  const text = typeof value === "string" ? value : safeJson(value);
  if (text === null || !text.includes(CODE_REVIEW_RUN_MARKER)) {
    return;
  }
  for (const token of text.split(RUN_REFERENCE_TOKEN_SEPARATOR)) {
    const match = lastRunReferenceIn(token);
    const runId = match?.[1];
    if (match === null || runId === undefined) {
      continue;
    }
    into.add(
      path.join(
        path.resolve(cwd, token.slice(0, match.index)),
        ...CODE_REVIEW_RUN_ROOT,
        runId,
        REVIEW_RESULT_FILENAME
      )
    );
  }
}

function lastRunReferenceIn(token: string): RegExpExecArray | null {
  if (!token.includes(CODE_REVIEW_RUN_MARKER)) {
    return null;
  }
  let last: RegExpExecArray | null = null;
  for (const match of token.matchAll(CODE_REVIEW_RUN_REFERENCE_TAIL)) {
    last = match;
  }
  return last;
}

/**
 * A tool payload is arbitrary decoded JSON, and a cyclic or non-serializable
 * value must not abort an import that had nothing to do with findings.
 */
function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/** A read the pass gave up on. Distinct from a read that FAILED: nothing was seen. */
const READ_ABANDONED = Symbol("code-review-envelope-read-abandoned");

/**
 * One run's envelope and whether the file was too large to parse, or
 * `envelope: null` when it could not be read at all.
 *
 * A missing file, a directory that was cleaned up, an unreadable one, a
 * truncated JSON write and one past {@link RUN_ENVELOPE_MAX_BYTES} all land here
 * as the SAME fact the ingest counts as unreadable — deliberately, because none
 * of them is "this run found nothing".
 */
type CodeReviewEnvelopeRead = {
  source: CodeReviewRunSource;
  oversize: boolean;
};

/**
 * `stat` FIRST, then read: the size gate has to run before the bytes land, or it
 * is not a gate. `stat` takes no `AbortSignal`, which is precisely why the
 * caller races this whole function against the pass budget rather than trusting
 * the signal below to bound it.
 */
async function readCodeReviewRunSource(
  file: CodeReviewEnvelopePath
): Promise<CodeReviewEnvelopeRead> {
  const unreadable: CodeReviewRunSource = { runId: file, envelope: null };
  // ISS-11914: reading inside a TCC-protected folder raises a macOS permission
  // prompt, so such a run counts as one we could not read.
  if (isTccProtectedPath(file)) {
    return { source: unreadable, oversize: false };
  }
  try {
    const { size } = await stat(file);
    if (size > RUN_ENVELOPE_MAX_BYTES) {
      return { source: unreadable, oversize: true };
    }
    return {
      source: {
        runId: file,
        envelope: JSON.parse(
          await readFile(file, {
            encoding: "utf8",
            signal: AbortSignal.timeout(RUN_ENVELOPE_READ_TIMEOUT_MS),
          })
        ),
      },
      oversize: false,
    };
  } catch {
    // An abort lands here with every other failure, which is correct: a read we
    // gave up on is a run we could not read, not a run with no findings.
    return { source: unreadable, oversize: false };
  }
}

/**
 * Settle `work`, or ABANDON it at `ms` without waiting for it.
 *
 * `AbortSignal.timeout` on `readFile` is not a bound on the call: the signal is
 * only observed BETWEEN syscalls, so a blocked `open()` or `read()` — the
 * network-mount and FUSE cases this module exists to survive — never settles at
 * all and the aborted promise stays pending indefinitely (tamsinb measured a
 * FIFO still pending at 4s under a 500ms signal on node 24.18). A timer the
 * caller owns is the only thing that can settle in that case, so the pass races
 * every read against one and drops whatever has not finished. The abandoned
 * promise keeps running to nowhere; its rejection is swallowed here so an
 * abandoned read cannot surface later as an unhandled rejection.
 */
function withReadDeadline(
  work: Promise<CodeReviewEnvelopeRead>,
  ms: number
): Promise<CodeReviewEnvelopeRead | typeof READ_ABANDONED> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(READ_ABANDONED), Math.max(0, ms));
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(READ_ABANDONED);
      }
    );
  });
}

/** What one bounded read pass saw, and what it never got to. */
type CodeReviewRunSourceRead = {
  sources: CodeReviewRunSource[];
  /** References never read at all — abandoned, or past the budget. Reported. */
  skippedReferences: number;
  /** Files refused by the size gate, so the log can say WHY they are unread. */
  oversizeRunFiles: string[];
};

/**
 * Read every referenced envelope under a bounded wait and a bounded fan-out.
 *
 * This runs INSIDE the import transaction, which is dispatched through the one
 * app-wide SQLite write queue (`write-queue.ts`), and that queue cannot abort a
 * libSQL transaction it has already started: an unbounded `readFile` on a
 * stalled path (a network mount, a FUSE volume) would therefore hold the only
 * writer slot forever and starve every other lane — every remaining record
 * group, every other session's import, and the invocation-sync outbox enqueue
 * itself.
 *
 * THE BOUND IS PER BATCH, NOT PER PASS. Checking the deadline only between
 * batches bounds nothing once a batch stalls: the `await` below is what holds
 * the writer, so it is the `await` that carries the remaining budget (whitlockk and
 * tamsinb on #7978). Each batch is raced against whatever is left of
 * {@link RUN_ENVELOPE_PASS_BUDGET_MS}, anything still pending when that expires
 * is ABANDONED rather than waited on, and the pass stops there — a budget the
 * first batch already spent cannot be spent again by the second. Every
 * reference the pass never read is REPORTED, never silently dropped.
 */
async function readCodeReviewRunSources(
  references: readonly CodeReviewEnvelopePath[]
): Promise<CodeReviewRunSourceRead> {
  const sources: CodeReviewRunSource[] = [];
  const oversizeRunFiles: string[] = [];
  const deadline = Date.now() + RUN_ENVELOPE_PASS_BUDGET_MS;
  for (
    let start = 0;
    start < references.length;
    start += RUN_ENVELOPE_READ_CONCURRENCY
  ) {
    const remainingBudgetMs = deadline - Date.now();
    if (remainingBudgetMs <= 0) {
      return {
        sources,
        skippedReferences: references.length - start,
        oversizeRunFiles,
      };
    }
    const batch = references.slice(
      start,
      start + RUN_ENVELOPE_READ_CONCURRENCY
    );
    const settled = await Promise.all(
      batch.map((file) =>
        withReadDeadline(readCodeReviewRunSource(file), remainingBudgetMs)
      )
    );
    let abandoned = 0;
    for (const read of settled) {
      if (read === READ_ABANDONED) {
        abandoned += 1;
        continue;
      }
      sources.push(read.source);
      if (read.oversize) {
        oversizeRunFiles.push(read.source.runId);
      }
    }
    if (abandoned > 0) {
      return {
        sources,
        skippedReferences:
          abandoned + (references.length - start - batch.length),
        oversizeRunFiles,
      };
    }
  }
  return { sources, skippedReferences: 0, oversizeRunFiles };
}

/** The candidates a funnel may be placed on, grouped by their component key. */
function subagentCandidatesByComponentKey(
  candidates: readonly AgentComponentInvocationCandidate[]
): ReadonlyMap<string, AgentComponentInvocationCandidate[]> {
  const byKey = new Map<string, AgentComponentInvocationCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.componentKind !== AgentComponentInvocationKind.Subagent) {
      continue;
    }
    const bucket = byKey.get(candidate.componentKey);
    if (bucket === undefined) {
      byKey.set(candidate.componentKey, [candidate]);
      continue;
    }
    bucket.push(candidate);
  }
  for (const bucket of byKey.values()) {
    bucket.sort((left, right) => left.sequence - right.sequence);
  }
  return byKey;
}

/** What one pass placed, and what it could not. */
export type CodeReviewFindingsStamp = {
  stampedCandidates: number;
  /** A matched funnel with no unclaimed invocation of its component to sit on. */
  unplaceableFunnels: number;
  unreadableRuns: number;
  /** The envelope paths behind `unreadableRuns`, so a reader can find the file. */
  unreadableRunFiles: readonly string[];
  /** Envelopes refused by the size gate. A subset of `unreadableRunFiles`. */
  oversizeRunFiles: readonly string[];
  /** References the pass budget cut or abandoned. Reported, never silent. */
  skippedReferences: number;
  /**
   * ISS-11310: envelopes that were READ and then refused by the findings-count
   * fold budget, and the exact number of entries they carry.
   *
   * A THIRD state, and it has to stay a third one. `oversizeRunFiles` above is a
   * file we never opened, so we cannot say what it held; these we sized exactly
   * and declined to fold, because folding a prefix of one would write a count
   * smaller than the run's real one into `findings_emitted` where nothing could
   * tell it from a genuine smaller count. Both withhold the funnel; only this
   * one can say how much was withheld, and that figure is a measurement even
   * though the per-producer split it stands in for is not computable within the
   * bound.
   */
  countCappedRunFiles: readonly string[];
  /** Bucket entries across {@link countCappedRunFiles}. Exact, never truncated. */
  findingsPresentInCappedRuns: number;
  /**
   * The subset of {@link countCappedRunFiles} that is larger than the WHOLE fold
   * budget on its own — the pathological envelope, as opposed to a run that
   * merely did not fit what earlier runs of the same pass had left.
   *
   * Reported separately because the two are different facts and an operator acts
   * on them differently: one names a file to go and look at, the other says the
   * pass ran out of budget. One sentence covering both would send a reader to
   * inspect a 200-entry envelope.
   */
  oversizedByCountRunFiles: readonly string[];
  /**
   * The runs that SPENT the fold budget, largest charge first.
   *
   * Reported alongside a STARVED cap — a run withheld because earlier runs had
   * already spent the budget — because the capped list alone names only the
   * victim: the envelope worth opening is the one that spent it, and without
   * this it appears in no line of the report (tamsinb on #7993).
   */
  budgetSpend: readonly CodeReviewBudgetSpend[];
  /**
   * Stamped candidates that were carrying a PRIOR row's funnel this pass
   * replaced with a different one.
   *
   * Fresh readable envelope evidence outranks a carried-forward pair, so the
   * replacement is right — but it is the one case where a re-import changes a
   * number that was already published, so it is reported rather than silent.
   */
  restampedPreservedCandidates: number;
  unmatchedReviewers: number;
  unattributedFindings: number;
  /**
   * ISS-11325: the disposition this pass wrote onto the rows whose funnel it
   * WITHHELD, or `null` when nothing was withheld.
   *
   * A withheld envelope names no reviewer and therefore no component, so the
   * label goes on every invocation a code-review funnel COULD have landed on and
   * did not — that is the necessary condition and the honest claim. When more
   * than one of the three reasons applied, which one covered a given row is not
   * recoverable, and the label says that rather than picking a winner.
   */
  withheldDisposition: AgentComponentFindingsDisposition | null;
  /** How many rows carry {@link withheldDisposition}. Reported, never inferred. */
  withheldDispositionCandidates: number;
  /**
   * Findings of a STAMPED funnel that never reached a verdict.
   *
   * ISS-10724 excludes them from both counts and exports the tally so "every
   * funnel above is a floor rather than a final count" survives the fold. The
   * two persisted columns cannot carry that caveat — the schema is ISS-10725's
   * and holds exactly the pair — so it is reported here instead of discarded:
   * a stamped pair that is a floor and one that is final would otherwise be
   * indistinguishable everywhere, with nothing anywhere saying so.
   */
  unadjudicatedFindings: number;
};

const NO_FINDINGS_STAMP: CodeReviewFindingsStamp = {
  stampedCandidates: 0,
  unplaceableFunnels: 0,
  unreadableRuns: 0,
  unreadableRunFiles: [],
  oversizeRunFiles: [],
  skippedReferences: 0,
  countCappedRunFiles: [],
  findingsPresentInCappedRuns: 0,
  oversizedByCountRunFiles: [],
  budgetSpend: [],
  restampedPreservedCandidates: 0,
  unmatchedReviewers: 0,
  unattributedFindings: 0,
  unadjudicatedFindings: 0,
  withheldDisposition: null,
  withheldDispositionCandidates: 0,
};

/**
 * Read this session's code-review runs and stamp their funnels onto candidates.
 *
 * Returns what it placed so the caller can report the shortfalls rather than
 * letting them read as zeros. Never throws: every failure mode degrades to a
 * candidate set that persists unattributed.
 */
export async function stampCodeReviewFindingsOnCandidates(
  session: NormalizedSession,
  candidates: AgentComponentInvocationCandidate[]
): Promise<CodeReviewFindingsStamp> {
  const cwd = session.cwd;
  if (!cwd) {
    return NO_FINDINGS_STAMP;
  }
  const references = codeReviewEnvelopePathsInSession(session, cwd);
  if (references.length === 0) {
    return NO_FINDINGS_STAMP;
  }
  const { sources, skippedReferences, oversizeRunFiles } =
    await readCodeReviewRunSources(references);
  const ingest = collectCodeReviewFindings(sources);
  const byKey = subagentCandidatesByComponentKey(candidates);
  const claimed = new Set<AgentComponentInvocationCandidate>();
  let stampedCandidates = 0;
  let unplaceableFunnels = 0;
  let unadjudicatedFindings = 0;
  let restampedPreservedCandidates = 0;
  for (const run of ingest.runs) {
    for (const matched of run.matched) {
      const funnel = matched.funnel;
      if (funnel === null) {
        continue;
      }
      const target = placementCandidate(
        byKey,
        matched.componentKeys,
        claimed,
        funnel
      );
      if (target === undefined) {
        unplaceableFunnels += 1;
        continue;
      }
      claimed.add(target);
      if (holdsAFunnel(target) && !holdsExactly(target, funnel)) {
        restampedPreservedCandidates += 1;
      }
      target.findingsEmitted = funnel.findingsEmitted;
      target.findingsInvalidated = funnel.findingsInvalidated;
      /* ISS-11325: this pass read the producer's own envelope, so the pair is
         THIS run's measurement — including on a re-import that re-placed a pair
         `preserveMeasuredFindings` had carried forward a moment earlier, where
         the carried label is no longer true. */
      target.findingsDisposition =
        AgentComponentFindingsDisposition.MeasuredThisRun;
      stampedCandidates += 1;
      unadjudicatedFindings += matched.unadjudicatedFindings;
    }
  }
  const withheldDisposition = agentComponentFindingsWithheldDisposition({
    countCapped: ingest.countCappedRuns.length > 0,
    byteGated: oversizeRunFiles.length > 0,
    unreadable:
      genuinelyUnreadableRunCount(ingest.unreadableRuns, oversizeRunFiles) >
        0 || skippedReferences > 0,
  });
  const withheldDispositionCandidates = markWithheldFindingsRows(
    candidates,
    withheldDisposition
  );
  return {
    stampedCandidates,
    unplaceableFunnels,
    unreadableRuns: ingest.unreadableRuns.length,
    unreadableRunFiles: ingest.unreadableRuns.map((run) => run.runId),
    oversizeRunFiles,
    skippedReferences,
    countCappedRunFiles: ingest.countCappedRuns.map((run) => run.runId),
    findingsPresentInCappedRuns: ingest.countCappedRuns.reduce(
      (total, run) => total + run.findingsPresent,
      0
    ),
    oversizedByCountRunFiles: ingest.countCappedRuns
      .filter((run) => run.exceedsWholeBudget)
      .map((run) => run.runId),
    budgetSpend: ingest.budgetSpend,
    unmatchedReviewers: ingest.unmatchedReviewerCount,
    unattributedFindings: ingest.unattributedFindingCount,
    unadjudicatedFindings,
    restampedPreservedCandidates,
    withheldDisposition: withheldDisposition ?? null,
    withheldDispositionCandidates,
  };
}

/**
 * Runs that could not be read for a reason OTHER than the byte gate.
 *
 * `readCodeReviewRunSource` reports an oversize file as unreadable so the fold
 * never sees it, which makes `oversizeRunFiles` a SUBSET of the ingest's
 * unreadable list. Counting the list as-is would therefore report every
 * byte-gated pass as ALSO unreadable, and two reasons is the one input that
 * turns a precise reason into `withheld-ambiguous-reason` — the disclosure would
 * degrade itself on the commonest case it exists to describe.
 */
function genuinelyUnreadableRunCount(
  unreadableRuns: readonly { runId: string }[],
  oversizeRunFiles: readonly string[]
): number {
  const oversize = new Set(oversizeRunFiles);
  return unreadableRuns.filter((run) => !oversize.has(run.runId)).length;
}

/**
 * Say on the rows that a withheld funnel COULD have landed on that it was
 * withheld, and why. Returns how many were marked.
 *
 * The eligible set is narrow on purpose: a subagent invocation of a component
 * the code-review attributor can place a funnel on
 * ({@link CODE_REVIEW_FUNNEL_COMPONENT_KEYS}), which is not carrying a funnel
 * after this pass. Marking wider would claim a withholding for a component no
 * code-review envelope could ever have described; marking a row that DOES hold a
 * funnel would contradict the counts sitting beside the label — a carried-forward
 * pair keeps saying `carried-forward`, which is the true statement about it.
 *
 * IT IS A NECESSARY CONDITION, NOT A PROVEN ONE, AND THE LABEL SAYS SO
 * (review-soul, class A). This set is wider than the set of rows the withheld
 * envelope would actually have covered, and it cannot be narrowed to it: the
 * envelope names no reviewer and so no invocation. It also admits rows whose
 * funnel is absent for causes that are not withholdings — a reviewer id this
 * build cannot place (`unmatchedReviewers`), a reviewer whose every finding went
 * unadjudicated (`funnel === null` at the placement loop above), and a worker
 * invocation no envelope ever described. All three are reported separately by
 * {@link reportFindingsAttribution}, and the disposition's own LABEL is
 * pass-scoped ("Withheld this pass — …") precisely so a row never claims the
 * withholding was its own. Narrowing by dropping the mark instead would put the
 * reader back where this ticket found them: a NULL with nothing beside it.
 */
function markWithheldFindingsRows(
  candidates: readonly AgentComponentInvocationCandidate[],
  disposition: AgentComponentFindingsDisposition | undefined
): number {
  if (disposition === undefined) {
    return 0;
  }
  let marked = 0;
  for (const candidate of candidates) {
    if (
      candidate.componentKind !== AgentComponentInvocationKind.Subagent ||
      !CODE_REVIEW_FUNNEL_COMPONENT_KEYS.has(candidate.componentKey) ||
      holdsAFunnel(candidate)
    ) {
      continue;
    }
    candidate.findingsDisposition = disposition;
    marked += 1;
  }
  return marked;
}

/**
 * Where this funnel goes, honoring the attributor's own preference order over
 * the keys the role may be spawned as — and, WITHIN that order, preferring the
 * invocation it sat on last time.
 *
 * WHY PLACEMENT HAS TO BE RE-IMPORT STABLE (tamsinb on #7978).
 * `preserveStrongerEvidence` runs BEFORE this pass and has already copied each
 * prior row's funnel onto its candidate, so on a re-import these rows are not
 * empty. Take a session whose run A envelope has since been cleaned up while run
 * B's is still on disk, with A last placed on the first invocation and B on the
 * second. A "first unclaimed in sequence order" placement puts B on the FIRST
 * one, overwriting A, while the second keeps its carried-forward B — so B is
 * counted twice and A is lost. Matching the carried pair first puts B back where
 * it was and leaves A alone, which is the only placement that neither inflates a
 * component's total nor erases a measurement.
 *
 * The three tiers, in order:
 *  1. an unclaimed invocation ALREADY carrying this exact pair — where it sat;
 *  2. an unclaimed invocation carrying no funnel at all — a free slot, which is
 *     every slot on a first import, so fresh placement stays sequence-ordered;
 *  3. any unclaimed invocation — fresh readable evidence outranks a carried
 *     pair, and the replacement is counted in
 *     `restampedPreservedCandidates` rather than left silent.
 */
function placementCandidate(
  byKey: ReadonlyMap<string, AgentComponentInvocationCandidate[]>,
  componentKeys: readonly string[],
  claimed: ReadonlySet<AgentComponentInvocationCandidate>,
  funnel: { findingsEmitted: number; findingsInvalidated: number }
): AgentComponentInvocationCandidate | undefined {
  const tiers: ((candidate: AgentComponentInvocationCandidate) => boolean)[] = [
    (candidate) => holdsExactly(candidate, funnel),
    (candidate) => !holdsAFunnel(candidate),
    () => true,
  ];
  for (const admits of tiers) {
    for (const componentKey of componentKeys) {
      for (const candidate of byKey.get(componentKey) ?? []) {
        if (!claimed.has(candidate) && admits(candidate)) {
          return candidate;
        }
      }
    }
  }
  return;
}

/** Whether either cell is written — a carried-forward pair, or an earlier stamp. */
function holdsAFunnel(candidate: AgentComponentInvocationCandidate): boolean {
  return (
    candidate.findingsEmitted !== null || candidate.findingsInvalidated !== null
  );
}

/** Whether the candidate is already carrying exactly this pair. */
function holdsExactly(
  candidate: AgentComponentInvocationCandidate,
  funnel: { findingsEmitted: number; findingsInvalidated: number }
): boolean {
  return (
    candidate.findingsEmitted === funnel.findingsEmitted &&
    candidate.findingsInvalidated === funnel.findingsInvalidated
  );
}

/**
 * Say what the pass could not attribute, at the layer that knows the session.
 *
 * Every counter here describes a real population the stamp did NOT cover, so
 * silence is the only honest reading of an absent line — a reader must never
 * have to infer a shortfall from a NULL column.
 */
export function reportFindingsAttribution(
  sessionId: string,
  stamp: CodeReviewFindingsStamp,
  log: (message: string) => void
): void {
  if (stamp.stampedCandidates > 0) {
    log(
      `component_invocations ${sessionId}: attributed a code-review findings funnel to ${stamp.stampedCandidates} invocation(s)`
    );
  }
  if (stamp.unreadableRuns > 0) {
    log(
      `component_invocations ${sessionId}: could not read ${stamp.unreadableRuns} code-review run envelope(s) (${stamp.unreadableRunFiles.join(", ")}); their findings are absent, not zero`
    );
  }
  if (stamp.oversizeRunFiles.length > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.oversizeRunFiles.length} code-review run envelope(s) exceeded ${RUN_ENVELOPE_MAX_BYTES} bytes and were not parsed (${stamp.oversizeRunFiles.join(", ")}); their findings are absent, not zero and not truncated`
    );
  }
  if (stamp.countCappedRunFiles.length > 0) {
    log(
      `component_invocations ${sessionId}: the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding fold budget withheld ${stamp.countCappedRunFiles.length} code-review run envelope(s) carrying ${stamp.findingsPresentInCappedRuns} finding(s) in total (${stamp.countCappedRunFiles.join(", ")}); their findings are absent, not zero and not truncated`
    );
  }
  if (stamp.oversizedByCountRunFiles.length > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.oversizedByCountRunFiles.length} of those envelope(s) exceed the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding budget on their own rather than having run it out (${stamp.oversizedByCountRunFiles.join(", ")})`
    );
  }
  /* A capped run that does NOT exceed the whole budget was starved by earlier
     runs, and the line above names it without naming them. Only then, because
     for a purely pathological envelope the spenders are beside the point. */
  const starvedRuns =
    stamp.countCappedRunFiles.length - stamp.oversizedByCountRunFiles.length;
  if (starvedRuns > 0 && stamp.budgetSpend.length > 0) {
    const spenders = stamp.budgetSpend
      .map((run) => `${run.runId} (${run.findingsCharged})`)
      .join(", ");
    log(
      `component_invocations ${sessionId}: ${starvedRuns} of those envelope(s) fit the ${CODE_REVIEW_FINDINGS_FOLD_BUDGET}-finding budget on their own and were withheld because it was already spent by ${spenders}`
    );
  }
  if (stamp.skippedReferences > 0) {
    log(
      `component_invocations ${sessionId}: gave up on ${stamp.skippedReferences} code-review run envelope(s) within ${RUN_ENVELOPE_PASS_BUDGET_MS}ms; they were never read`
    );
  }
  if (stamp.withheldDisposition !== null) {
    log(
      `component_invocations ${sessionId}: recorded "${agentComponentFindingsDispositionLabel(stamp.withheldDisposition)}" on ${stamp.withheldDispositionCandidates} invocation(s) a withheld code-review funnel could have described; which of them it would actually have covered is not recoverable from the envelope`
    );
  }
  if (stamp.restampedPreservedCandidates > 0) {
    log(
      `component_invocations ${sessionId}: replaced a carried-forward findings funnel on ${stamp.restampedPreservedCandidates} invocation(s) with this pass's envelope evidence`
    );
  }
  if (stamp.unmatchedReviewers > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.unmatchedReviewers} code-review producer(s) matched no component this build knows; left unattributed`
    );
  }
  if (stamp.unplaceableFunnels > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.unplaceableFunnels} attributed funnel(s) had no derived invocation of their component to sit on`
    );
  }
  if (stamp.unattributedFindings > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.unattributedFindings} finding(s) named no producer at all`
    );
  }
  if (stamp.unadjudicatedFindings > 0) {
    log(
      `component_invocations ${sessionId}: ${stamp.unadjudicatedFindings} finding(s) of a stamped funnel never reached a verdict, so those counts are a floor`
    );
  }
}
