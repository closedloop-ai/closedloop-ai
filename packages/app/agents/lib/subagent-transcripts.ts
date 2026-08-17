/**
 * ISS-4677: the partition + reconciliation model behind the LIVE session
 * transcript file switcher (`TranscriptFileSwitcher`), shared verbatim by the
 * web route and the desktop `SessionDetailView` because both mount the same
 * `SessionTranscriptPanel`.
 *
 * Two jobs, both about not lying:
 *
 * 1. **Partition + order.** Split a session's transcript files into the main
 *    conversation and its subagent sidechains, in a deterministic order rather
 *    than whatever order the producer happened to emit, so the chip wall can be
 *    collapsed behind a disclosure without the visible/hidden split reshuffling
 *    between renders.
 * 2. **Reconcile against the Subagents metric.** The number of subagent
 *    transcript FILES is not the number of subagents — a subagent whose
 *    transcript was never synced (skipped, too large, still uploading) has no
 *    file. Rendering a bare "(N)" next to the word "subagent" therefore reads as
 *    a subagent count and silently contradicts the Subagents MetricCard. This
 *    module derives both numbers from their canonical sources and reports the
 *    disagreement in BOTH directions — the two ride independent lanes
 *    (`agentCount` off the derived-data sync, `transcripts[]` off the
 *    SessionTranscript blob rows), so files can exceed reported subagents just
 *    as easily as fall short — so the surface says "12 subagents, 9 transcripts
 *    available" instead of a confident, wrong "9".
 *
 * ISS-5762: this caption is a reconciliation notice, NOT a truncation notice,
 * and nothing on this path bounds the set. `subagentFiles` is every
 * `subagent:`-prefixed row the producer served (the cloud read at
 * `apps/api/app/agent-sessions/service.ts` issues an UNCAPPED
 * `sessionTranscript.findMany`; the desktop's `resolveLocalTranscriptSummaries`
 * is likewise uncapped), and `TranscriptFileSwitcher` maps over all of them —
 * the disclosure COLLAPSES the chip wall behind a click, it does not drop
 * chips. The caption's earlier wording said "archived", which was true in this
 * codebase's sense ("uploaded to storage, bytes readable") but read in review as
 * "put away / not shown" and so looked like an admission of exactly the silent
 * subsetting it was built to prevent. The caption now names each population
 * separately ("72 subagents, 122 transcripts available"), which carries the same
 * meaning and cannot be read as "hidden". The counts themselves are unchanged. The
 * "completeness (ISS-5762)" suites in this module's own tests and in
 * `transcript-file-switcher.test.tsx` are the standing proof that a session with
 * far more sidechains than any cap in the tree still renders every chip; the two
 * PRODUCERS are pinned separately, by the transcript-availability cases in
 * `apps/api/app/agent-sessions/service.test.ts`.
 *
 * The unavailable-vs-true-zero distinction is the point of
 * {@link resolveSubagentCount} returning `null`: `agentCount` counts the
 * session's agent rows INCLUDING the main agent, so a real session always
 * reports at least 1. A `0` therefore means "the agent rows have not arrived",
 * not "this session ran zero subagents", and must never be rendered as a
 * confident zero.
 */

import type {
  AgentSessionDetail,
  SyncedAgentSessionAgent,
} from "@repo/api/src/types/agent-session";
import type { TranscriptAvailabilitySummary } from "@repo/api/src/types/desktop-transcripts";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import {
  MAIN_TRANSCRIPT_FILE_KEY,
  SUBAGENT_FILE_KEY_PREFIX,
  transcriptFileLabel,
} from "./session-transcript-href";

/**
 * How many subagent transcript chips may sit inline before the switcher folds
 * them behind a disclosure. One extra chip beside "Main" is not a wall, and
 * hiding it costs a click for nothing; two or more is where the row starts to
 * wrap and crowd the trace below it.
 */
export const SUBAGENT_TRANSCRIPT_INLINE_LIMIT = 1;

/**
 * What we know about a session's subagent transcripts. Three states, kept
 * distinct so the surface can never render "no subagent transcripts" for data
 * that simply has not arrived.
 */
export const SubagentTranscriptState = {
  /**
   * The producer did not report per-file availability at all (`transcripts` is
   * absent — an older desktop build, or a detail response still loading). We
   * know nothing; the surface must make no claim.
   */
  Unavailable: "unavailable",
  /**
   * Availability IS reported and contains no subagent sidechain. A real,
   * knowable zero — safe to state.
   */
  None: "none",
  /** At least one subagent transcript file is addressable. */
  Present: "present",
} as const;

export type SubagentTranscriptState =
  (typeof SubagentTranscriptState)[keyof typeof SubagentTranscriptState];

/** Availability states in which a file's bytes are actually readable today. */
const READABLE_AVAILABILITY: ReadonlySet<TranscriptAvailability> = new Set([
  TranscriptAvailability.Available,
  TranscriptAvailability.Stale,
]);

export type SubagentTranscriptSummary = {
  /** Unavailable / true-zero / present — never collapsed into a falsy count. */
  state: SubagentTranscriptState;
  /** The main conversation file(s), in producer order. */
  mainFiles: TranscriptAvailabilitySummary[];
  /**
   * Subagent sidechains — files whose key carries
   * {@link SUBAGENT_FILE_KEY_PREFIX} — deterministically ordered.
   */
  subagentFiles: TranscriptAvailabilitySummary[];
  /**
   * Files that are neither `main` nor a `subagent:` sidechain. The producer
   * writes no such key today, but the prefix is this format's SSOT and a future
   * key must not be silently counted as a subagent (it would inflate the header
   * count and deflate {@link missingTranscriptCount} while getting no label).
   * They render beside `main` and are counted as neither.
   */
  otherFiles: TranscriptAvailabilitySummary[];
  /**
   * Subagent sidechains whose bytes are actually readable today. This — not
   * `subagentFiles.length` — is what the caption's "available" means: an
   * `uploadFailed`, `missing` or `permanentlyUnavailable` file is a sidechain we
   * know about, not one we can open.
   *
   * ISS-5762: NOT a rendered-chip count and never a bound on one. Every entry in
   * `subagentFiles` renders regardless of this number; an unreadable sidechain
   * still gets its chip (disabled, with its own availability treatment).
   */
  readableCount: number;
  /**
   * Subagents the session itself reports — the SAME derivation the Subagents
   * MetricCard uses — or `null` when the agent rows have not arrived.
   */
  reportedSubagentCount: number | null;
  /**
   * How many reported subagents have no transcript file. `0` when the two
   * reconcile, or when `reportedSubagentCount` is unknown (we do not invent a
   * shortfall out of missing data).
   */
  missingTranscriptCount: number;
  /**
   * The SURPLUS direction of the same disagreement: how many readable sidechains
   * exceed the reported subagent count. The two numbers ride independent lanes —
   * `agentCount` comes off the derived-data sync, `transcripts[]` off the
   * SessionTranscript blob rows — so they can drift EITHER way, and a bare
   * "(9)" beside a Subagents metric reading 3 contradicts it just as loudly as a
   * shortfall does. `0` when the counts reconcile or the reported count is
   * unknown.
   */
  excessTranscriptCount: number;
  /**
   * Subagent files whose upload is genuinely still in flight
   * (`uploadPending`) — and ONLY those. This is the one bucket the caption may
   * describe with a time word.
   */
  pendingCount: number;
  /**
   * Subagent files with no readable bytes and no upload in flight —
   * `uploadFailed` (the attempt failed), `missing` (no row at all), and
   * `permanentlyUnavailable` (the archive will never contain them). Kept out of
   * {@link pendingCount} because "still uploading" promises bytes that are
   * coming, and for none of these is that true.
   */
  unavailableCount: number;
  /** True when the subagent chips are numerous enough to be worth folding. */
  shouldCollapse: boolean;
};

/**
 * The session's subagent count, from the same expression the Subagents
 * MetricCard renders — `agentCount` minus the main agent.
 *
 * Returns `null` (unknown) rather than `0` when `agentCount` is absent, zero, or
 * not a finite non-negative integer. A session that has loaded always has its
 * own main agent row, so `agentCount < 1` is the loading/unavailable shape, and
 * a bad value is corrupt data — neither is a subagent count of zero.
 */
export function resolveSubagentCount(
  session: Pick<AgentSessionDetail, "agentCount"> & {
    agents?: readonly SyncedAgentSessionAgent[];
  }
): number | null {
  const { agentCount, agents } = session;
  if (!Number.isFinite(agentCount) || agentCount < 1) {
    return null;
  }
  // When the agent ROWS are the same population `agentCount` counts, subtract
  // the actual main row rather than a blind 1. `agentCount - 1` and "exclude the
  // main row" only agree when exactly one row matches — a session whose root row
  // was deleted and not healed has none, and the blind subtraction then reports
  // one fewer subagent than the Overview tally renders chips for.
  if (agents && agents.length === Math.trunc(agentCount)) {
    return agents.filter((agent) => !isSessionMainAgent(agent)).length;
  }
  return Math.max(Math.trunc(agentCount) - 1, 0);
}

/**
 * ISS-4677: is this row the session's OWN main agent? The desktop writer inserts
 * exactly one such root row per session (`type='main'` with no subagent type and
 * no parent). Matching all three fields keeps an unparented NON-main row inside
 * the subagent population, so the tally and the metric agree on who counts.
 *
 * Canonical here, not at a render site: the Subagents metric, the Overview
 * type tally, and the transcript switcher's reconciliation must all partition
 * the agent rows the same way or they contradict each other on screen.
 */
export function isSessionMainAgent(agent: SyncedAgentSessionAgent): boolean {
  return (
    agent.type === "main" && !agent.subagentType && !agent.parentExternalAgentId
  );
}

/**
 * Deterministic chip order for subagent sidechains: by the text the chip
 * ACTUALLY renders, numeric-aware, so `Subagent agent-2` sorts before
 * `Subagent agent-10` and the visible/hidden split cannot reshuffle between
 * renders. Producer order is not stable enough — it is whatever the availability
 * fold emitted — and sorting by raw `fileKey` while rendering friendly names
 * lands the named chips in an order the reader can see no reason for.
 */
export function sortSubagentTranscriptFiles(
  files: readonly TranscriptAvailabilitySummary[],
  labels?: ReadonlyMap<string, string>
): TranscriptAvailabilitySummary[] {
  return [...files].sort((left, right) =>
    subagentChipSortKey(left, labels).localeCompare(
      subagentChipSortKey(right, labels),
      undefined,
      { numeric: true, sensitivity: "base" }
    )
  );
}

/** The rendered chip text a sidechain sorts on — the same string the UI shows. */
function subagentChipSortKey(
  file: TranscriptAvailabilitySummary,
  labels: ReadonlyMap<string, string> | undefined
): string {
  return labels?.get(file.fileKey) ?? transcriptFileLabel(file.fileKey);
}

/**
 * Fold a session's transcript availability into the switcher's view model.
 *
 * `files === undefined` is the unavailable state and is NOT the same as an empty
 * array: the former means the producer never told us, the latter means it told
 * us there are none.
 */
export function buildSubagentTranscriptSummary({
  files,
  labels,
  reportedSubagentCount,
}: {
  files: readonly TranscriptAvailabilitySummary[] | undefined;
  /** Friendly chip labels, so the order matches the text the reader sees. */
  labels?: ReadonlyMap<string, string>;
  reportedSubagentCount: number | null;
}): SubagentTranscriptSummary {
  if (!files) {
    return {
      state: SubagentTranscriptState.Unavailable,
      mainFiles: [],
      subagentFiles: [],
      otherFiles: [],
      readableCount: 0,
      reportedSubagentCount,
      missingTranscriptCount: 0,
      excessTranscriptCount: 0,
      pendingCount: 0,
      unavailableCount: 0,
      shouldCollapse: false,
    };
  }

  const mainFiles: TranscriptAvailabilitySummary[] = [];
  const sidechains: TranscriptAvailabilitySummary[] = [];
  const otherFiles: TranscriptAvailabilitySummary[] = [];
  for (const file of files) {
    if (file.fileKey === MAIN_TRANSCRIPT_FILE_KEY) {
      mainFiles.push(file);
    } else if (file.fileKey.startsWith(SUBAGENT_FILE_KEY_PREFIX)) {
      // The prefix is this format's SSOT — the same join
      // `buildSubagentTranscriptLabels` uses. Bucketing on "not main" instead
      // would count a future non-subagent key as a sidechain.
      sidechains.push(file);
    } else {
      otherFiles.push(file);
    }
  }
  const subagentFiles = sortSubagentTranscriptFiles(sidechains, labels);
  const readableCount = subagentFiles.filter((file) =>
    READABLE_AVAILABILITY.has(file.availability)
  ).length;
  const pendingCount = subagentFiles.filter(
    (file) => file.availability === TranscriptAvailability.UploadPending
  ).length;
  // readable + pending + unavailable partitions `subagentFiles` exactly, so no
  // file is reported inside two clauses of the same caption.
  const unavailableCount = subagentFiles.length - readableCount - pendingCount;

  return {
    state:
      subagentFiles.length > 0
        ? SubagentTranscriptState.Present
        : SubagentTranscriptState.None,
    mainFiles,
    subagentFiles,
    otherFiles,
    readableCount,
    reportedSubagentCount,
    // Only a KNOWN reported count can produce a disagreement. An unknown count
    // yields 0 both ways so the surface stays quiet rather than inventing one.
    missingTranscriptCount:
      reportedSubagentCount === null
        ? 0
        : Math.max(reportedSubagentCount - subagentFiles.length, 0),
    excessTranscriptCount:
      reportedSubagentCount === null
        ? 0
        : Math.max(readableCount - reportedSubagentCount, 0),
    pendingCount,
    unavailableCount,
    shouldCollapse: subagentFiles.length > SUBAGENT_TRANSCRIPT_INLINE_LIMIT,
  };
}

/** Separator between the caption's independent clauses. */
const CAPTION_SEPARATOR = " · ";

/**
 * Join INSIDE the count clause, deliberately tighter than
 * {@link CAPTION_SEPARATOR}. The count clause holds two numbers over two
 * DIFFERENT populations (subagents, files); the clauses around it hold numbers
 * over one (files). Reusing " · " for both made "5 subagents · 1 transcript
 * available · 1 unavailable" look like three peer tallies of the same thing, and
 * a reader summing them gets 7 files for a session that has 2 — the exact
 * failure the "N of M" form was abandoned for. A comma binds tighter than the
 * middot, so the pairing is visible without spending another word on it.
 */
const COUNT_CLAUSE_JOIN = ", ";

/**
 * The disclosure's caption — the reconciliation sentence, or `null` when the
 * file count and the Subagents metric already agree and every file is readable.
 * Kept here (not at the call site) so the web and desktop adapters cannot drift
 * into two different phrasings of the same reconciliation.
 *
 * The two unreadable clauses are deliberately worded differently: "still
 * uploading" promises the bytes are coming, which is true ONLY of an
 * `uploadPending` file. A failed upload, a missing row and a permanently
 * skipped file are all "unavailable" — collapsing any of them into "still
 * uploading" (or into a shared "not readable yet") would make the header lie
 * about a file that is not on its way.
 */
export function subagentTranscriptReconciliation(
  summary: SubagentTranscriptSummary
): string | null {
  const parts: string[] = [];
  const countClause = subagentCountReconciliation(summary);
  if (countClause) {
    parts.push(countClause);
  }
  if (summary.pendingCount > 0) {
    parts.push(`${summary.pendingCount} still uploading`);
  }
  if (summary.unavailableCount > 0) {
    parts.push(`${summary.unavailableCount} unavailable`);
  }
  return parts.length > 0 ? parts.join(CAPTION_SEPARATOR) : null;
}

/**
 * The clause that reconciles readable sidechains against the Subagents metric,
 * or `null` when the two already agree (or the metric is unknown).
 *
 * "Available" counts only files whose bytes can be opened right now — a failed,
 * missing or permanently-skipped sidechain is one we know about, not one we can
 * serve, and counting it here would report the same file inside two clauses of
 * one caption.
 *
 * ISS-5762: each number now carries its OWN noun, the two are no longer bound by
 * "of", and the pair binds itself with {@link COUNT_CLAUSE_JOIN} rather than the
 * separator between independent clauses. Four separate problems drove that:
 *
 * - **"archived" read as "hidden".** In this codebase it means "uploaded to
 *   storage, bytes readable", but outside it means "moved out of view" — which
 *   is exactly the silent subsetting this surface does not do. Nothing on this
 *   path bounds the chip list.
 * - **"N of M" attached the wrong noun to M.** The old shortfall form
 *   ("9 of 12 archived") left the noun unstated; naming it made the sentence
 *   claim there were 12 TRANSCRIPTS, when 12 is the SUBAGENT count. On a session
 *   with two sidechain files the caption legitimately reads `1 of 5` — a reader
 *   summing the clauses would get more files than exist. The two numbers count
 *   different populations, so they get different nouns and no shared "of".
 * - **The two directions needed two strings.** `N of M` only reads while
 *   `N <= M`, so the surplus case had its own phrasing and the pair could drift.
 *   One form covers both and makes "122 of 72" unrepresentable.
 * - **A shared separator re-merged the two populations.** See
 *   {@link COUNT_CLAUSE_JOIN}.
 *
 * The verb is deliberately NOT a transport word. "Synced", "archived" and
 * "uploaded" all assert the bytes reached a remote archive, and on a
 * desktop-local session that is false: `resolveLocalTranscriptSummaries`
 * (`apps/desktop/src/main/dashboard/local-transcript-detail-gate.ts`) reports
 * on-disk files as `Available` with `uploadedAt: null` precisely because no
 * archive identity exists, and it does so whether or not transcript sync is
 * enabled. Both surfaces mount this same caption from the same
 * `resolveSubagentCount` / `transcripts[]` props, so the wording has to be true
 * on either. "Available" is, it answers the only question the reader has (can I
 * open it), and it is the vocabulary the unreadable clause and the chip
 * treatments already use. It also rules out "saved", which implies a user
 * action nobody took.
 */
function subagentCountReconciliation(
  summary: SubagentTranscriptSummary
): string | null {
  const reported = summary.reportedSubagentCount;
  const readable = summary.readableCount;
  if (reported === null || readable === reported) {
    return null;
  }
  return `${reported} ${plural("subagent", reported)}${COUNT_CLAUSE_JOIN}${readable} ${plural("transcript", readable)} available`;
}

/** Inline count-agreement, matching the repo's existing call-site pattern. */
function plural(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

/**
 * Whether the header may print its own `(N)` parenthetical.
 *
 * Suppressed whenever the caption already carries a count, so the same number is
 * never printed twice — and, critically, so a bare `(9)` can never sit beside a
 * Subagents MetricCard reading 3 with nothing reconciling them. This is the one
 * derivation both directions of that disagreement route through.
 */
export function shouldShowSubagentFileCount(
  summary: SubagentTranscriptSummary
): boolean {
  return subagentCountReconciliation(summary) === null;
}

/**
 * True when the caption reports a state a reader should act on (bytes missing
 * or never coming) rather than a neutral reconciliation, so the surface can tone
 * it as a caveat instead of rendering the warning in the calmest color it owns.
 */
export function hasUnreadableSubagentTranscripts(
  summary: SubagentTranscriptSummary
): boolean {
  return summary.pendingCount + summary.unavailableCount > 0;
}

/**
 * Human labels for a session's subagent transcript chips.
 *
 * `transcriptFileLabel` can only render the raw file key ("Subagent agent-7"),
 * so a session with nine sidechains produces nine near-identical opaque strings
 * and the reader has nothing to choose on. When the session's agent rows carry a
 * subagent type or name for the SAME id, that is a far better chip label — but
 * only if it stays unambiguous: two chips both reading "code-reviewer" would
 * trade an opaque label for a wrong one, which is worse. So a friendly label is
 * used only when it resolves to exactly one file; every colliding (or
 * unmatched) key keeps its raw label.
 *
 * The join is an EXACT `externalAgentId` match — never a prefix or fuzzy match,
 * which could attach one subagent's name to another's transcript.
 *
 * A COLLIDING name (two sidechains both reporting `code-reviewer`) is
 * disambiguated with a short id suffix rather than dropped back to the raw key:
 * mixing "code-reviewer" and "Subagent agent-7" in one drawer is two label
 * systems side by side, and the reader cannot tell which chips are comparable.
 * Every matched chip therefore uses the same system. Only a file with no agent
 * row at all keeps the raw label — there is nothing else to say about it.
 */
export function buildSubagentTranscriptLabels({
  files,
  agents,
}: {
  files: readonly TranscriptAvailabilitySummary[];
  agents: readonly SyncedAgentSessionAgent[] | undefined;
}): Map<string, string> {
  const labels = new Map<string, string>();
  if (!agents?.length) {
    return labels;
  }
  const byExternalId = new Map(
    agents.map((agent) => [agent.externalAgentId, agent])
  );
  const candidates = new Map<string, string>();
  const claimCounts = new Map<string, number>();
  for (const file of files) {
    if (!file.fileKey.startsWith(SUBAGENT_FILE_KEY_PREFIX)) {
      continue;
    }
    const agent = byExternalId.get(
      file.fileKey.slice(SUBAGENT_FILE_KEY_PREFIX.length)
    );
    const candidate = agent?.subagentType?.trim() || agent?.name?.trim();
    if (!candidate) {
      continue;
    }
    candidates.set(file.fileKey, candidate);
    claimCounts.set(candidate, (claimCounts.get(candidate) ?? 0) + 1);
  }
  return disambiguateSubagentLabels(candidates, claimCounts);
}

/** How much of an agent id is enough to tell two same-named sidechains apart. */
const SHORT_AGENT_ID_LENGTH = 6;

function shortAgentId(fileKey: string): string {
  const id = fileKey.slice(SUBAGENT_FILE_KEY_PREFIX.length);
  return id.length <= SHORT_AGENT_ID_LENGTH
    ? id
    : id.slice(-SHORT_AGENT_ID_LENGTH);
}

/**
 * Resolve candidate names into final chip labels: unique names are used as-is,
 * colliding ones gain a short id suffix — and if that suffix still collides
 * (two ids sharing their tail), the FULL id is used, because a label that is
 * merely shorter is worthless if it is still ambiguous.
 */
function disambiguateSubagentLabels(
  candidates: ReadonlyMap<string, string>,
  claimCounts: ReadonlyMap<string, number>
): Map<string, string> {
  const shortened = new Map<string, string>();
  const shortenedCounts = new Map<string, number>();
  for (const [fileKey, candidate] of candidates) {
    const label =
      claimCounts.get(candidate) === 1
        ? candidate
        : `${candidate} ${shortAgentId(fileKey)}`;
    shortened.set(fileKey, label);
    shortenedCounts.set(label, (shortenedCounts.get(label) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const [fileKey, label] of shortened) {
    labels.set(
      fileKey,
      shortenedCounts.get(label) === 1
        ? label
        : `${candidates.get(fileKey)} ${fileKey.slice(SUBAGENT_FILE_KEY_PREFIX.length)}`
    );
  }
  return labels;
}
