/**
 * @file activity-segment-classifier.ts
 * @description FEA-2269 (PRD-488): the versioned, PURE, deterministic
 * session-activity classifier. FEA-2267 shipped a STUB body here (one `other`
 * active segment per span) so the hard cross-cutting guarantees — complete
 * tiling, exact spend reconciliation, byte-identical determinism, version-bump
 * backfill — could be frozen against a classifier too simple to be wrong.
 *
 * This feature replaces ONLY the classification body: it consumes FEA-2268's
 * abstract, harness-blind evidence TIMELINE (`buildEvidenceTimeline`), partitions
 * each active span into contiguous typed windows via windowing + hysteresis, and
 * labels each window with a taxonomy-v1 phase + confidence + evidence-layer
 * provenance (`activity-scoring.ts`). The store contract is INHERITED UNCHANGED:
 * the segment record shape, deterministic sha256 IDs, the complete-tiling
 * invariant, the per-turn spend join, the first-class `idle` kind, and the
 * version-bump backfill all still belong to FEA-2267 — this module only produces
 * the classification, expressed as a tiling of `[startMs, endMs)`.
 *
 * Mirrors `artifact-ref-extractor.ts`: a single versioned module producing
 * deterministic sha256 row IDs, where bumping the version triggers a full
 * historical re-derive via the backfill pass.
 */
import { createHash } from "node:crypto";
import type { SessionTracePhaseSource } from "@repo/api/src/types/agent-session";
import { buildEvidenceTimeline } from "../evidence/build-session-evidence.js";
import {
  type EvidenceUnit,
  emptyCategoryMix,
  ToolCategory,
} from "../evidence/evidence-model.js";
import type { Harness, NormalizedSession } from "../types.js";
import {
  type ActivityCategoryCounts,
  scoreWindow,
} from "./activity-scoring.js";
import { parseMsOrNull, sortedUniqueMs } from "./activity-segment-relabel.js";
import { ACTIVITY_PHASE, type ActivityPhase } from "./activity-taxonomy.js";
import { applyStatefulPhaseCarry } from "./phase-carry.js";
import { computeReviewRequestMs } from "./review-intent-detector.js";
import { applyReworkDetection } from "./rework-detector.js";
import { mergeSlivers } from "./sliver-merge.js";
import { applySubagentPurposeAttribution } from "./subagent-purpose.js";

// Bumping this triggers a full historical re-derive via
// activity-segment-backfill.ts (mirrors EXTRACTOR_VERSION). Per AGENTS.md
// §Idempotent Re-Processing, any change to deterministic segment-producing
// logic increments this FROM ITS VALUE AT HEAD (monotonic — never a hard-coded
// target integer). Because `phase` is stored as TEXT, a taxonomy change is a
// version bump + re-derive, NOT a schema migration (Q-001).
//
// v2 (FEA-2269): the stub's single-`other`-per-span body is replaced by the real
// structural classifier (windowing + hysteresis + layered declared→structural
// scoring over the FEA-2268 evidence timeline), and ACTIVITY_PHASE gains the
// active-work labels. Every historical session is re-tiled on next boot.
// v3 (FEA-2270): the review→fix rework post-pass (`applyReworkDetection`) runs
// after the structural tiling, relabelling the active segments inside a
// review-intent span to `rework`. New producible label + new segment-producing
// logic ⇒ this bump re-derives all history so `rework` appears retroactively.
// v4 (FEA-2271): the subagent purpose-attribution post-pass
// (`applySubagentPurposeAttribution`) runs after rework, re-filing each subagent's
// folded spend to a segment of the subagent's OWN purpose (classified from its own
// tool evidence) and recording the `subagentId` provenance marker. It
// re-partitions existing spend (never re-adds the subagent's folded copy), so
// Σ-reconciliation holds; new segment-producing logic ⇒ this bump re-derives all
// history so delegated spend is re-attributed retroactively.
// v5 (PRD-488 state-aware): the stateless per-window scorer is made STATE-AWARE by
// the `applyStatefulPhaseCarry` post-pass (runs after rework, before subagent):
// `explore` becomes the leading-only orientation, ambient reads/git inherit the
// current phase, and a DECLARED review REQUEST establishes the `review` phase.
// `review` is no longer scored from git-lifecycle (git is now ambient), and the
// rework post-pass drops its review-command + PR-open triggers (a review command
// means `review`, not `rework`). New segment-producing logic ⇒ re-derive history.
// v6 (FEA-4184): `plan` now requires a PLAN-SPECIFIC declared signal — a bare human
// turn (or a generic declaration like an MCP `get-document` or a `/code-review`) no
// longer argmaxes to `plan`. Previously a lone human-turn tick (present at the start
// of nearly every session) scored `plan` at full confidence, and the state-aware
// carry then propagated that eager `plan` across the session, mislabelling
// explore/implement stretches (and the branch rollup) as `plan`. The evidence core
// now splits declarations into `DeclaredPlan` (plan-specific: `/create-plan`,
// `ExitPlanMode`, a `plan` trace phase) vs the generic `DeclaredIntent`, `planScore`
// gates on `DeclaredPlan > 0`, and the hysteresis windower never absorbs a
// declared-plan tick into a non-plan run (so a bare-human → declared-plan transition
// can't retro-relabel the accumulated run). Scoring change ⇒ re-derive all history.
// NOTE: the paired DATA_REVISION 42 bump routes Copilot/OpenCode — which the
// BUILTIN_TRANSCRIPT_SOURCES-only activity-segment backfill cannot reach — through
// the collector rebuild so their v5 segments re-derive to v6 too.
// v7 (FEA-4010, golden-corpus audit — the vocabulary-free tiling/scoring tranche):
//   - AA-01: idle anchors are the harness-blind UNION of all observed-activity
//     instants (assistant turns + human messages + tool executions + declared
//     signals) INCLUDING raw `session.toolUses` timestamps the scored timeline
//     drops (uncategorized tools — Task/TodoWrite, or any tool from an unknown
//     harness), not `tokenSeries` alone, and the head/tail edges are gap-checked —
//     so shell-only / zero-turn sessions detect dead gaps and edge dead time is
//     `idle`, not active (no more multi-day trailing `implement` segments).
//   - AA-05 (phase-carry.ts): an idle gap RESETS the carried phase (resumed work
//     re-establishes from its own evidence, floor `other`); a carried window drops
//     to EMPTY evidence layers at a capped confidence instead of copying the
//     establishing window's confidence + `declared`/`structural` layers — an
//     inherited span has no first-hand evidence, so it claims none.
//   - AA-11 (activity-scoring.ts): the STORED confidence is the runner-up margin
//     tempered by evidence mass + layer corroboration, so a single thin signal no
//     longer reads as maximal certainty (the label gate still keys on the margin).
//   - AA-12 (sliver-merge.ts): sub-threshold span-edge slivers are merged into an
//     adjacent active segment before persist (tiling hygiene), guarded so a
//     declared `review`/`rework` window, a subagent-owned slice, or a carried
//     (AA-05 empty-evidence) window is never absorbed away.
// All four are structural/temporal — no harness vocabulary; they layer on FEA-4184's
// v6 plan-gating. New segment-producing logic ⇒ this bump re-derives all history.
// v8 (FEA-4010, AA-03 — declared signals stop being a catch-all): a NAME-derived
// declaration (slash command, skill, MCP call) now claims the `declared` layer only
// when the core positively RECOGNIZES it as work intent; everything unrecognized
// falls to the new INERT `DeclaredUtility` category. Previously EVERY such
// invocation minted `DeclaredIntent`, so `/login`, `/model`, `/plugin`, `/clear` and
// work-tracking MCP bookkeeping stamped FR-7 `declared` provenance (and took the
// declared confidence boost) off commands that declare nothing about the work —
// "declared without a declaration", which also inflated `declaredDurationMs` in the
// session rollups. Inert signals are STILL emitted onto the timeline, so they keep
// anchoring time and AA-01 idle detection is unchanged; they simply score no phase,
// claim no provenance, take no boost, and add no AA-11 evidence mass. A trace phase
// is exempt (it declares the work phase itself rather than a guessed name) and keeps
// `DeclaredIntent`. Fail-safe direction: an unrecognized genuine declaration merely
// under-claims provenance, where the old default FABRICATED it. A recognition rule,
// never a denylist of one organization's command names. Scoring/provenance change ⇒
// re-derive all history; paired with DATA_REVISION 45 for Copilot/OpenCode.
// v9 (FEA-4010, AA-04 + AA-09 C2 — effect-based command evidence): two coupled
// corrections to how SHELL work is read.
//   - AA-04 (command-semantics.ts): an un-refined `RunCommand` whose command text
//     is confidently READ-ONLY now refines to `ReadSearch`. Previously only a
//     harness's own Read/Grep/Glob tools produced explore signal, so investigation
//     conducted through the shell (`grep`, `sed -n`, `git log`, `cat`) scored
//     nothing and `explore` was structurally near-unreachable — a shell-only
//     harness could never explore at all. Effect-based and harness-blind: the line
//     is parsed into segments past wrappers / `cd` / env prefixes and classified
//     from UNIVERSAL command vocabulary; anything mutating or unreadable stays
//     `RunCommand`, so the failure direction is under-claiming explore.
//   - AA-09 C2 (activity-scoring.ts): an un-refined `RunCommand` is a command the
//     core could NOT read, so it may no longer outvote the mutation it accompanies.
//     Its implement support is capped at the in-window mutation count, and it no
//     longer contributes AA-11 evidence mass (the same treatment AA-03 gave inert
//     declarations). Before this, one scratch write beside twenty analysis commands
//     scored implement 23 and reported RISING confidence as the unreadable commands
//     piled up — the audit's E-1 failure, where an analysis session read as 92%
//     implementation. Unchanged: commands alone still reach no phase, and a window
//     genuinely editing code still labels implement.
// Categorization + scoring change ⇒ re-derive all history; paired with
// DATA_REVISION 49 for Copilot/OpenCode and EVIDENCE_MODEL_VERSION 3.
// v10 (FEA-4010, AA-09 C1 — mutations classified by what they TOUCHED): a mutating
// tool use now refines from its target path into `MutateCode`, `MutateDocument`, or
// `MutateScratch` (see `evidence/mutation-kind.ts`), and the three score differently:
//   - `MutateScratch` — the harness's own memory/scratchpad state (adapter-declared)
//     or a bare file dropped in the system temp directory — scores NO phase,
//     corroborates nothing, and adds no evidence mass, while still anchoring time
//     exactly like an inert declaration. Before this, a `/tmp/.commit-msg-*` write
//     anchored `implement` across 10.7 minutes of PR-admin and CI-triage, and one
//     corpus session's 19 memory-file writes outnumbered its 17 real source edits:
//     `implement` was being claimed off files the project never contained.
//   - `MutateDocument` scores implement at a third of a source edit and no longer
//     VETOES `plan` — writing the plan document inside a declared planning window is
//     planning, not implementation. Only a SOURCE mutation vetoes now.
//   - `MutateCode` keeps its full weight and its veto, and remains the fail-safe
//     default for any target the core cannot read — so this can only ever remove an
//     over-claim, never invent one.
// Categorization + scoring change ⇒ re-derive all history; paired with
// EVIDENCE_MODEL_VERSION 4.
// v11 — FEA-4010 / AA-09 test detection: `TestRun` is decided by PARSING the
//   command line rather than scanning it for runner names. The substring form was
//   wrong in both directions on the corpus: it counted `which pytest`,
//   `ls .venv/bin/pytest`, `cat vitest.config.mts` and a heredoc quoting a test
//   command as validation (13 lines of fabricated `validate`), while missing
//   `pnpm turbo test` and `node --test` / `tsx --test` (36 lines of real
//   validation scored as un-refined `RunCommand`). Detection now resolves the
//   command HEAD through the shared lexical layer, so a runner named in an
//   argument, inside quotes, or inside a heredoc body is text rather than an
//   invocation. Paired with EVIDENCE_MODEL_VERSION 5.
// v12 — FEA-4010 / AA-06 + AA-07 (PLN-1490 step 4): review-request and rework
//   ENTRY detection stop reading identifiers and long work orders as prose.
//   AA-06: a slash-command / skill name is matched as WORDS, so `code-review`
//   requests a review and `apply-nightly-reviews` — which triages bot-review PRs
//   — no longer does; subagent-scoped skills stop minting parent phase
//   transitions; and a re-run request ("re-run the review") is recognized, which
//   restores DECLARED provenance to a review that carry had been inferring.
//   AA-07: the split-clause rework fallback is bounded by prompt length and
//   clause proximity and vetoes comment-AUTHORING frames, so a 2,265-character
//   autonomous kickoff no longer declares a whole session rework from t0; and the
//   cues admit the phrasings the corpus actually used — severity shorthand ("the
//   2 mediums in the PR"), a reviewer's possessive findings, and demonstratives
//   ("comments on this PR"). Evidence model unchanged: this moves PHASE
//   assignment, not categorization, so EVIDENCE_MODEL_VERSION stays 5.
// v13 — FEA-4010 / AA-08 (PLN-1490 step 5): a subagent's purpose takes the
//   parent's DECLARED phase as a prior. Purpose was scored from the subagent's
//   own tool mix alone, and that mix is read-dominated for exactly the
//   delegations whose purpose is least ambiguous: measured over the corpus, all
//   74 subagents scored `explore` (65) or `other` (9) — not one scored `review`,
//   including two 18-agent review fleets. Reading code IS what reviewing looks
//   like, so its own evidence can never separate the two; only the context it was
//   spawned into can. A subagent now inherits a declared `review`/`rework` unless
//   its OWN evidence argmaxes to `implement`. `review`/`rework` are declared-only
//   phases (the scorer never produces either), so the prior always traces to a
//   real declaration. Evidence model unchanged: EVIDENCE_MODEL_VERSION stays 5.
// v14 — FEA-4010 / AA-09 review follow-ups (EVIDENCE_MODEL_VERSION 6): three
//   command-lexing defects that suppressed real test runs. Corpus effect is one
//   session: two `pnpm -C apps/desktop test:e2e` Playwright runs, invisible while
//   a namespaced task name was discarded as a flag's value, split a 318s
//   `implement` span into `implement` + `validate`. Time-conserving — the span is
//   re-partitioned, never re-added.
// v15 — FEA-4010 / AA-09 review round 2 (EVIDENCE_MODEL_VERSION 7): an inherited
//   subagent label now takes BOTH its phase and its strength from the declaration
//   (previously the confidence came from the score of the phase just discarded, so
//   an evidence-free delegate inside a requested review reported 0%), and reports
//   the `declared` evidence layer rather than the structural one that argued for a
//   different phase. The prior also resolves at the subagent's ENTRY instead of by
//   longest overlap, so a delegation outliving a declaration is not relabelled
//   retroactively. Corpus effect: 25 rows in one fleet session change layer; no
//   segment boundary moves.
// v16 — FEA-4010 / AA-09 review round 3 (EVIDENCE_MODEL_VERSION 8): five command
//   reader fixes, four of which correct SEGMENTATION rather than vocabulary. The
//   splitter now tracks escape and comment state, so a line-continuation or an
//   `-exec … \;` no longer tears one command into fragments whose heads are bare
//   flags. Corpus effect: 2 sessions re-tile, both toward more honest labels —
//   `f9830b64`'s sole `find | xargs wc -l | sort | head` becomes `explore`
//   instead of `other`, and `413572cc` moves 2 segments out of `implement`.
//   Time-conserving in both.
export const ACTIVITY_CLASSIFIER_VERSION = 16;

/**
 * Inactivity gap (ms) at/above which an `idle` segment is opened between two
 * consecutive turn timestamps. SSOT default ratified in PLN-1196 §4 (Q-005):
 * 600_000 ms / 10 min. A named, calibratable constant owned by this feature
 * (tuned per cohort by FEA-2266); idle is its own first-class kind so the tiling
 * stays complete without attributing idle time to active phases.
 */
export const ACTIVITY_IDLE_GAP_MS = 600_000;

// A run's phase is only re-opened when a differing pattern PERSISTS across this
// many ticks (the Schmitt-trigger dwell). A lone off-pattern turn inside a
// sustained burst is absorbed, not split. Provisional (Q-003 tuning surface),
// versioned by ACTIVITY_CLASSIFIER_VERSION.
const HYSTERESIS_DWELL_TICKS = 2;

/**
 * The in-memory shape the classifier emits and `persistActivitySegments`
 * consumes. `id`, `session_id`, and `observed_at` are stamped at persist time
 * (mirroring how `ArtifactRefRecord` omits the DB `id`).
 */
export type ActivitySegmentRecord = {
  phase: ActivityPhase;
  /** epoch-ms, inclusive lower bound. */
  startMs: number;
  /** epoch-ms, exclusive upper bound — half-open [startMs, endMs). */
  endMs: number;
  confidence: number;
  /**
   * The ranked evidence layers (`declared`/`structural`) that fed the label,
   * persisted to the `Json` `evidence_layers` column. Empty for `idle`, for
   * evidence-free `other` spans, and for AA-05 carried (inherited-phase) windows —
   * all of which have no first-hand evidence; populated by the scorer otherwise.
   * `declared` presence is the segment's inferred-vs-declared provenance signal (FR-7).
   */
  evidenceLayers: string[];
  version: number;
  workItemRef?: string | null;
  /**
   * FEA-2271: the parser-stable local subagent id when this segment's spend was
   * re-filed to a subagent's own purpose phase; absent/null for main-agent
   * segments. Persisted to the nullable `subagent_id` column so FEA-2275 can badge
   * delegated spend without a taxonomy/phase-column change.
   */
  subagentId?: string | null;
};

/**
 * Deterministic row id: sha256(sessionId|startMs|version)[:16], mirroring
 * `artifactLinkId`. Under a complete, non-overlapping tiling `start_ms` is
 * unique per session+version, so it is a sufficient natural key; the version
 * component separates re-derivations across classifier versions.
 */
export function activitySegmentId(
  sessionId: string,
  startMs: number,
  version: number
): string {
  return createHash("sha256")
    .update(`${sessionId}|${startMs}|${version}`)
    .digest("hex")
    .slice(0, 16);
}

type SessionBoundsMs = { startMs: number; endMs: number };

/**
 * Derive the deterministic outer span [startMs, endMs) of a session, enclosing
 * BOTH the declared start/end and the earliest/latest turn timestamp so no
 * token_event can fall outside the tiling (the complete-tiling invariant). Pure:
 * reads only NormalizedSession fields, never the wall clock. Returns null when
 * no finite timestamp exists at all — the caller then persists nothing,
 * consistent with the importer already skipping `startedAt`-less sessions.
 *
 * `endMs` is one ms PAST the latest observed/declared timestamp. The `+1`
 * guarantees `endMs` strictly exceeds every turn timestamp, so (a) the final
 * active segment always has positive width — even when the last turn lands
 * exactly on the declared session end after an idle gap (no zero-width row), and
 * (b) no turn ever sits on the exclusive upper bound, so the half-open spend
 * join captures every turn without relying on a boundary special case (the
 * last-segment-inclusive arm of {@link segmentIndexForMs} is then belt-and-
 * suspenders).
 */
export function deriveSessionBoundsMs(
  session: NormalizedSession
): SessionBoundsMs | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const consider = (iso: string | null | undefined): void => {
    if (!iso) {
      return;
    }
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) {
      min = ms < min ? ms : min;
      max = ms > max ? ms : max;
    }
  };
  consider(session.startedAt);
  consider(session.endedAt);
  for (const record of session.tokenSeries ?? []) {
    consider(record.timestamp);
  }
  if (!Number.isFinite(min)) {
    return null;
  }
  const startMs = min;
  const endMs = max + 1;
  return { startMs, endMs };
}

/**
 * Classify a normalized session into a complete, non-overlapping, contiguous
 * tiling of [startMs, endMs). The session's active time (spans between idle gaps
 * ≥ ACTIVITY_IDLE_GAP_MS) is partitioned into typed windows by scoring the
 * FEA-2268 evidence timeline with windowing + hysteresis; dead gaps stay
 * first-class `idle` segments. AA-01: idle gaps are anchored on the harness-blind
 * union of every observed-activity instant (assistant turns, human messages, tool
 * executions, declared signals) and the head/tail edges are gap-checked too, so
 * dead time before the first / after the last instant is idle, not active.
 *
 * `harness` selects the FEA-2268 adapter that maps this session's concrete tool
 * names to abstract categories (the ONLY vendor-aware step; the classifier core
 * is harness-blind). `tracePhaseSources` are the optional DB-derived declared
 * phase boundaries; omitted, the declared layer still draws on slash commands and
 * per-tool skill/MCP signals.
 *
 * REACHABILITY: no production caller supplies `tracePhaseSources` today —
 * `write-core.ts` computes this tiling pre-transaction precisely so no DB read is
 * in the path, and `activity-segment-backfill.ts` mirrors it. The option has been
 * dormant since FEA-2269 introduced it; wiring the sync-time trace phases
 * (`extractTracePhaseSources`) into both callers is tracked separately. It is kept
 * exercised by tests because the declared layer's category split must stay correct
 * for the day it IS wired — see `declaredCategoryForTracePhase`.
 *
 * Determinism: reads only `NormalizedSession` + `harness` + the version constant
 * — no `Date.now()`, no randomness; the evidence timeline is totally ordered and
 * every tie-break (argmax taxonomy order, tick grouping) is explicit — so
 * identical input yields a byte-identical ordered record array (and identical
 * hashed IDs).
 */
export function classifyActivitySegments(
  session: NormalizedSession,
  harness: Harness,
  options?: { tracePhaseSources?: readonly SessionTracePhaseSource[] }
): ActivitySegmentRecord[] {
  const bounds = deriveSessionBoundsMs(session);
  if (!bounds) {
    return [];
  }
  const { startMs, endMs } = bounds;
  const timeline = buildEvidenceTimeline(session, harness, options);
  // AA-01: idle anchors are the harness-blind union of ALL observed-activity
  // instants (assistant turns + human messages + tool executions + declared
  // signals), not `tokenSeries` alone — so shell-only / human-only / zero-turn
  // sessions still detect dead gaps and edge dead-time is tiled as idle.
  const activityMs = sortedUniqueActivityMs(session, timeline, startMs, endMs);

  const segments: ActivitySegmentRecord[] = [];
  appendIdleTiling(segments, timeline, activityMs, startMs, endMs);
  // FEA-2270 review→fix post-pass: relabel active segments inside a review-intent
  // span to `rework`, splitting only at the exact trigger/exit timestamps (so the
  // tiling stays complete and Σ-reconciled). Reads the same `timeline` for its
  // edit gate. A no-op when no review-trigger + edit pair is present (honest zero).
  const reworked = applyReworkDetection(segments, session, timeline);
  // PRD-488 state-aware post-pass: re-attribute the stateless per-window tiling to
  // a stateful phase progression — `explore` leads only, ambient reads/git inherit
  // the current phase, and a declared review REQUEST establishes `review`. Runs
  // after rework (so a rework relabel is a strong phase it carries forward) and
  // before the subagent pass. Only subdivides + relabels, so complete-tiling and
  // Σ-reconciliation hold.
  const stateAware = applyStatefulPhaseCarry(
    reworked,
    computeReviewRequestMs(session)
  );
  // FEA-2271 subagent post-pass: re-file each subagent's folded spend to a segment
  // of the subagent's OWN purpose (classified from its own tool evidence), running
  // AFTER rework so a delegated sub-task dispatched inside a rework span is
  // attributed by what the subagent did. Re-partitions the same token rows (never
  // re-adds the folded copy), so complete-tiling and Σ-reconciliation still hold.
  const attributed = applySubagentPurposeAttribution(
    stateAware,
    session,
    harness
  );
  // AA-12 tiling hygiene (runs LAST, after every relabel that can mint an edge
  // sliver): merge sub-threshold span-edge slivers into their adjacent active
  // segment, then restore the maximal-same-phase-run invariant.
  return mergeSlivers(attributed);
}

/**
 * Canonical timestamp → segment assignment for per-segment spend attribution.
 * Half-open [startMs, endMs); the LAST segment is treated as inclusive of its
 * upper bound so a turn at exactly the session end (when `endMs` equals the
 * latest turn) is not dropped. Returns the index into `segments` (assumed
 * sorted, contiguous, complete) or -1 when `ms` precedes the first segment.
 * Pure + shared so the reconciliation guard and later read surfaces (FEA-2268)
 * compute spend through ONE boundary rule and cannot drift.
 */
export function segmentIndexForMs(
  segments: readonly Pick<ActivitySegmentRecord, "startMs" | "endMs">[],
  ms: number
): number {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const isLast = i === segments.length - 1;
    const withinUpper = ms < seg.endMs || (isLast && ms <= seg.endMs);
    if (ms >= seg.startMs && withinUpper) {
      return i;
    }
  }
  return -1;
}

/**
 * Classify one active span [activeStart, activeBreak) into typed sub-segments by
 * windowing + hysteresis over its evidence, appending them contiguously so they
 * tile the span exactly. A span with NO evidence is a single `other` segment
 * (honest: active spend the classifier saw but cannot type), matching the
 * FEA-2267 stub for evidence-free sessions. Boundaries fall on distinct tick
 * timestamps, so every emitted sub-segment has positive width.
 */
function appendActiveSegments(
  segments: ActivitySegmentRecord[],
  timeline: readonly EvidenceUnit[],
  activeStart: number,
  activeBreak: number
): void {
  const ticks = groupTicks(timeline, activeStart, activeBreak);
  if (ticks.length === 0) {
    segments.push(
      makeSegment(ACTIVITY_PHASE.Other, activeStart, activeBreak, 0, [])
    );
    return;
  }
  const runs = windowTicks(ticks);
  for (let j = 0; j < runs.length; j++) {
    const segStart = j === 0 ? activeStart : runs[j].startMs;
    const segEnd = j === runs.length - 1 ? activeBreak : runs[j + 1].startMs;
    const { phase, confidence, layers } = scoreWindow(runs[j].counts);
    segments.push(makeSegment(phase, segStart, segEnd, confidence, layers));
  }
}

/** One distinct-timestamp bucket of evidence within an active span. */
type EvidenceTick = { ms: number; counts: ActivityCategoryCounts };

/** A contiguous run of same-phase ticks, anchored at its first tick's ms. */
type PhaseRun = { startMs: number; counts: ActivityCategoryCounts };

/**
 * Bucket the active span's evidence units by distinct timestamp (a "tick"),
 * summing the abstract-category counts at each ms. Grouping by ms — then sorting
 * — means run boundaries land on distinct timestamps, so no sub-segment can be
 * zero-width, and the ordering is deterministic (never Map-iteration order).
 * Units outside [activeStart, activeBreak) belong to another span and are
 * skipped.
 */
function groupTicks(
  timeline: readonly EvidenceUnit[],
  activeStart: number,
  activeBreak: number
): EvidenceTick[] {
  const byMs = new Map<number, ActivityCategoryCounts>();
  for (const unit of timeline) {
    if (unit.ms < activeStart || unit.ms >= activeBreak) {
      continue;
    }
    let counts = byMs.get(unit.ms);
    if (!counts) {
      counts = emptyCategoryMix();
      byMs.set(unit.ms, counts);
    }
    counts[unit.category] += 1;
  }
  const ticks: EvidenceTick[] = [];
  for (const [ms, counts] of byMs) {
    ticks.push({ ms, counts });
  }
  ticks.sort((a, b) => a.ms - b.ms);
  return ticks;
}

/**
 * Partition the ticks into contiguous same-phase runs. Each run starts at a tick,
 * takes that tick's dominant phase, and extends over compatible ticks; a differing
 * tick only opens a new run when the shift is SUSTAINED (hysteresis).
 */
function windowTicks(ticks: readonly EvidenceTick[]): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let i = 0;
  while (i < ticks.length) {
    const startMs = ticks[i].ms;
    const counts = { ...ticks[i].counts };
    const phase = scoreWindow(counts).phase;
    i = extendRun(ticks, i + 1, counts, phase);
    runs.push({ startMs, counts });
  }
  return runs;
}

/**
 * Extend the current run from index `from`. A tick whose OWN dominant phase
 * matches the run extends it; a differing tick opens a new run only if the shift
 * is sustained across the dwell — otherwise it is absorbed as a transient without
 * changing the run's phase (a lone off-pattern turn inside a burst never splits
 * it). Mutates `counts`; returns the index of the first tick of the NEXT run.
 *
 * The dwell has ONE exception: a DECLARED-PLAN tick is never absorbed into a
 * non-plan run (FEA-4184). A plan declaration (`/create-plan`, `ExitPlanMode`, a
 * `plan` trace phase) is a discrete, high-confidence intent event, not the noisy
 * off-pattern turn hysteresis exists to smooth. Absorbing it would fold its
 * `DeclaredPlan` count into the run, and `appendActiveSegments` would then rescore
 * the COMBINED counts as `plan`, relabelling the whole accumulated run (e.g. a
 * bare human tick → one declared plan tick, dwell=2, the plan tick transient) from
 * its start. Breaking here keeps the plan transition starting exactly at the plan
 * tick, so the preceding non-plan work is never retro-relabelled.
 */
function extendRun(
  ticks: readonly EvidenceTick[],
  from: number,
  counts: ActivityCategoryCounts,
  phase: ActivityPhase
): number {
  let i = from;
  while (i < ticks.length) {
    const incoming = scoreWindow(ticks[i].counts).phase;
    const differs = incoming !== phase;
    const declaresPlan =
      phase !== ACTIVITY_PHASE.Plan &&
      ticks[i].counts[ToolCategory.DeclaredPlan] > 0;
    if (differs && (declaresPlan || sustainedShift(ticks, i, phase))) {
      break;
    }
    addCountsInto(counts, ticks[i].counts);
    i++;
  }
  return i;
}

/**
 * A phase shift is real only if it PERSISTS across the dwell AND resolves to a
 * confident DIFFERENT phase: the combined phase over the next
 * HYSTERESIS_DWELL_TICKS ticks is neither the current run's phase nor `other`.
 * An ambiguous (`other`) lookahead is NOT a shift — a lone off-pattern turn whose
 * local window is a near-tie stays absorbed in the burst, not split out. Fewer
 * than the dwell's worth of ticks left ⇒ transient (no split), so a lone trailing
 * off-pattern tick never opens a one-tick tail segment.
 */
function sustainedShift(
  ticks: readonly EvidenceTick[],
  from: number,
  phase: ActivityPhase
): boolean {
  if (ticks.length - from < HYSTERESIS_DWELL_TICKS) {
    return false;
  }
  const counts = emptyCategoryMix();
  for (let i = from; i < from + HYSTERESIS_DWELL_TICKS; i++) {
    addCountsInto(counts, ticks[i].counts);
  }
  const shifted = scoreWindow(counts).phase;
  return shifted !== phase && shifted !== ACTIVITY_PHASE.Other;
}

function addCountsInto(
  target: ActivityCategoryCounts,
  source: ActivityCategoryCounts
): void {
  for (const category of Object.values(ToolCategory)) {
    target[category] += source[category];
  }
}

function makeSegment(
  phase: ActivityPhase,
  startMs: number,
  endMs: number,
  confidence: number,
  evidenceLayers: string[]
): ActivitySegmentRecord {
  return {
    phase,
    startMs,
    endMs,
    confidence,
    evidenceLayers,
    version: ACTIVITY_CLASSIFIER_VERSION,
  };
}

/** A first-class `idle` segment: full confidence, no evidence layers (dead time). */
function makeIdleSegment(
  startMs: number,
  endMs: number
): ActivitySegmentRecord {
  return makeSegment(ACTIVITY_PHASE.Idle, startMs, endMs, 1, []);
}

/**
 * AA-01: the harness-blind union of every observed-activity instant the session
 * carries — assistant usage turns (`tokenSeries`, via the `sortedUniqueMs` SSOT),
 * every SCORED evidence-timeline instant (human messages, categorized tool
 * executions, declared signals), AND every RAW parseable tool-execution instant —
 * deduped, ascending, and clamped to `[startMs, endMs)`. Idle anchors draw from
 * this union, not `tokenSeries` alone: a session with zero assistant turns (only
 * human/tool activity) can now detect its dead gaps, and edge dead time is anchored
 * rather than swallowed by the final active segment.
 *
 * The raw `session.toolUses` pass is deliberate and NOT redundant with `timeline`:
 * `buildEvidenceTimeline` drops any tool the harness adapter cannot categorize
 * (`categorize` → null — e.g. Task / TodoWrite, or EVERY tool from an unknown
 * harness), so those executions never reach the scored timeline. They are still
 * observed activity, so a late uncategorized tool would otherwise sit inside the
 * new trailing idle span and be mis-reported as dead time. Anchoring on the tool
 * timestamp directly is harness-blind (no category dependency) and keeps AA-01
 * honest for unknown harnesses. Instants outside the derived bounds are dropped
 * (they carry no spend, and the complete-tiling invariant is defined over
 * `[startMs, endMs)`).
 */
function sortedUniqueActivityMs(
  session: NormalizedSession,
  timeline: readonly EvidenceUnit[],
  startMs: number,
  endMs: number
): number[] {
  const seen = new Set<number>(sortedUniqueMs(session.tokenSeries ?? []));
  for (const unit of timeline) {
    seen.add(unit.ms);
  }
  for (const tool of session.toolUses) {
    const ms = parseMsOrNull(tool.timestamp);
    if (ms !== null) {
      seen.add(ms);
    }
  }
  return [...seen]
    .filter((ms) => ms >= startMs && ms < endMs)
    .sort((a, b) => a - b);
}

/**
 * AA-01: tile `[startMs, endMs)` into active spans separated by first-class
 * `idle` segments, anchoring idle on `activityMs` (the observed-activity union).
 * Beyond the interior inter-instant gaps, the HEAD span `[startMs, firstInstant)`
 * and TAIL span `[lastInstant+1, endMs)` are gap-checked against
 * ACTIVITY_IDLE_GAP_MS, so a declared start/end driven far past real activity
 * (e.g. trailing machine-injected records) becomes idle instead of inflating an
 * active segment. Each active sub-run closes 1ms after its last anchoring instant
 * so that instant stays inside the half-open active span. When `activityMs` is
 * empty (only declared start/end bounds exist, no observed activity), the whole
 * span is a single honest active tiling rather than a fabricated idle anchor.
 */
function appendIdleTiling(
  segments: ActivitySegmentRecord[],
  timeline: readonly EvidenceUnit[],
  activityMs: readonly number[],
  startMs: number,
  endMs: number
): void {
  const firstMs = activityMs.at(0);
  const lastMs = activityMs.at(-1);
  if (firstMs === undefined || lastMs === undefined) {
    appendActiveSegments(segments, timeline, startMs, endMs);
    return;
  }
  let activeStart = startMs;
  // Head: dead time before the first observed instant.
  if (firstMs - startMs >= ACTIVITY_IDLE_GAP_MS) {
    segments.push(makeIdleSegment(startMs, firstMs));
    activeStart = firstMs;
  }
  // Interior gaps between consecutive instants.
  for (let i = 0; i + 1 < activityMs.length; i++) {
    const gap = activityMs[i + 1] - activityMs[i];
    if (gap < ACTIVITY_IDLE_GAP_MS) {
      continue;
    }
    const activeBreak = activityMs[i] + 1;
    appendActiveSegments(segments, timeline, activeStart, activeBreak);
    segments.push(makeIdleSegment(activeBreak, activityMs[i + 1]));
    activeStart = activityMs[i + 1];
  }
  // Tail: dead time after the last observed instant.
  const activeEnd = lastMs + 1;
  if (endMs - activeEnd >= ACTIVITY_IDLE_GAP_MS) {
    appendActiveSegments(segments, timeline, activeStart, activeEnd);
    segments.push(makeIdleSegment(activeEnd, endMs));
  } else {
    appendActiveSegments(segments, timeline, activeStart, endMs);
  }
}
