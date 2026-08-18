/**
 * @file rework-detector.ts
 * @description FEA-2270 (PRD-488, Story 3): the deterministic, PURE in-session
 * review→fix rework post-pass. It RELABELS a subset of the segments the FEA-2269
 * structural classifier already produced to `rework`. The ONLY boundary it ever
 * introduces is a split placed on an exact review-trigger/exit timestamp so a
 * span that begins or ends mid-window relabels only its fixing slice; it never
 * moves an existing FEA-2269 boundary, reassigns a turn, or invents time — so the
 * complete-tiling and Σ(segment spend) == session-total invariants are preserved
 * (each split just subdivides one interval of the existing contiguous tiling).
 *
 * ── Why this differs from PLN-1201 as written ────────────────────────────────
 * The plan's original heuristic was "a `review` window → mutate the same files".
 * It assumed FEA-2269's `review` phase meant code INSPECTION. The landed FEA-2269
 * taxonomy instead scores code inspection as `explore` and uses `review` for
 * git-lifecycle (commit/push/PR). It also exposes no per-window file targets on
 * the evidence timeline, so the plan's "same-file overlap" cannot be computed
 * without extending the DONE FEA-2268 evidence model.
 *
 * So FEA-2270 detects rework from an explicit ADDRESS-REVIEW signal in the session
 * rather than from file-overlap (confirmed with the plan owner):
 *   ENTER a contiguous `rework` phase on an address-review human prompt (cue-
 *     matched message text — "address the review comments" / "fix the PR feedback").
 *   EXIT on the next human prompt that is NOT itself an address-review prompt (a
 *     fresh instruction = new work), or at session end.
 * Everything ACTIVE inside the phase (reading the findings, editing, testing the
 * fix, committing it) is rework — those activities are the CONTENT of rework, not
 * the signal of it. `idle` stays `idle` (a spend-free gap the store owns).
 *
 * The EXIT bounds only this EDIT-GATED rework SPAN (which edits are counted as
 * fixing). It does NOT bound downstream ambient INHERITANCE: under the state-aware
 * model, reads after the exit that establish no new strong phase inherit the
 * current phase (`rework`) via the carry pass — exactly as trailing reads inherit
 * `implement` after a build. The exit ends the span; the phase persists as state
 * until a new strong phase begins. (See `phase-carry.ts`.)
 *
 * ── State-aware update (PRD-488) ─────────────────────────────────────────────
 * The two weaker ENTER triggers this module once carried — an in-session review
 * COMMAND and a PR being opened (`gh pr create`) — were removed. A review command
 * is a request to PERFORM a review, so it now establishes the `review` phase (see
 * `review-intent-detector.ts`), not `rework`; and a `gh pr create` is git-lifecycle,
 * which the state-aware model treats as AMBIENT (it inherits the current phase),
 * not as a phase-driving signal. Only the high-precision address-review PROMPT — a
 * human explicitly asking to fix a review — opens a rework phase now.
 *
 * ── Honest zero (AC-003.3) ───────────────────────────────────────────────────
 * A candidate span becomes `rework` only when it contains ≥1 real edit
 * (`implement`). A review trigger that led to no code change (reviewed, nothing
 * to fix) leaves the segments untouched — no fabricated `rework` phase. The bias
 * is deliberately toward UNDER-claiming (PRD-488: over-claiming rework is the
 * most damaging failure).
 *
 * Determinism: reads only the `NormalizedSession` (+ the segment tiling) and the
 * named constants below — no `Date.now()`, no randomness; every tie-break is
 * explicit — so identical input yields byte-identical output. Privacy: message
 * text is inspected on-device with fixed cue regexes (bounded deterministic cue
 * matching, PLN-1201 §2.4 — NOT the opt-in linguistic layer FEA-2274).
 */
import {
  EvidenceLayer,
  type EvidenceUnit,
  WORKSPACE_MUTATION_CATEGORIES,
} from "../evidence/evidence-model.js";
import type { NormalizedSession } from "../types.js";
import {
  coalesceAdjacentRuns,
  containingSpan,
  interiorCuts,
  parseMsOrNull,
  type RelabelableSegment,
  sameRunByLabel,
  splitAtCuts,
} from "./activity-segment-relabel.js";
import { ACTIVITY_PHASE } from "./activity-taxonomy.js";

// ── Calibration surface (Q-004 tuning knobs; all named, versioned by
// ACTIVITY_CLASSIFIER_VERSION) ───────────────────────────────────────────────

/**
 * Confidence an address-review `rework` segment carries (0–1, the same scale
 * FEA-2267 persists and FEA-2266 buckets). PROVISIONAL — the FEA-2266 corpus
 * (Q-003/Q-004) sets the real floor. An explicit human "address the review
 * comments" instruction is high-precision evidence; the ≥1-edit gate still
 * guards the honest-zero case (a review that led to no fix).
 */
export const REWORK_CONFIDENCE_PROMPT = 0.9;

/**
 * The address-review PROMPT cue: a directive verb (address/fix/resolve/…)
 * followed, within a few words, by a review-context object (review/PR/CR/reviewer
 * + comments/feedback/findings/…). Deliberately narrow and high-precision — it
 * REQUIRES the review qualifier, so "fix the null check" or "address the code
 * comments" (source comments) do not match, only "address the review comments" /
 * "evaluate the following code review comments" / "fix the PR feedback" do.
 * Missing a phrasing yields honest zero for that session (the safe direction);
 * this is the primary calibration surface and is meant to grow with real corpus
 * evidence, not to be exhaustive on day one.
 */
export const REVIEW_FIX_PROMPT_CUE =
  /(?<![\w-])(?:address|fix|resolv\w*|appl\w*|incorporat\w*|handl\w*|evaluat\w*|action|implement|respond\s+to|act\s+on|go\s+through|work\s+through|rework)(?![\w-])(?:\W+\w+){0,6}?\W+(?:(?:code\s+)?(?:review|reviewer'?s?|pr|cr)\W+(?:comments?|feedback|findings?|notes?|suggestions?)|changes?\s+requested|(?:\d+\s+)?(?:blockers?|criticals?|highs?|mediums?|lows?|nits?)\s+(?:in|on|from)\s+(?:the\s+|this\s+|that\s+)?(?:pr|pull\s+request|review)|\w+['’]s\s+(?:findings?|comments?|feedback))\b/i;

/**
 * A looser fallback for the very common shape where a PR/review-comment reference
 * and the fix directive sit in SEPARATE clauses — "there's a comment on the PR,
 * please fix the issue it raised"; "address the comments on the PR" (object BEFORE
 * "PR", which the forward-proximity {@link REVIEW_FIX_PROMPT_CUE} can't bridge).
 * It fires only when BOTH a specific review-comment reference AND a fix directive
 * appear anywhere in the message. The reference is deliberately specific ("PR /
 * review / reviewer comments", "comments on the PR") so a bare "review this code"
 * never matches; and the ≥1-edit gate is the backstop against the rare
 * "don't fix the review comments yet, just list them" (no edits ⇒ honest zero).
 * (Calibrated against the golden corpus — surfaced by scanning it for review-fix
 * prompts this module was missing.)
 */
export const REVIEW_COMMENT_REFERENCE_CUE =
  /\b(?:comments?\s+on\s+(?:the\s+|this\s+|that\s+|my\s+|your\s+)?(?:pr|pull\s+request)|(?:pr|pull\s+request|reviewer'?s?|review)\s+comments?)\b/i;
export const REVIEW_FIX_DIRECTIVE_CUE =
  /(?<![\w-])(?:address|fix|resolv\w*|reply|respond|handl\w*|incorporat\w*|appl\w*)(?![\w-])/i;

/**
 * A conservative NEGATION veto shared by both review cues. The cues are
 * proximity/keyword matches with no grammar, so a DECLINED intent — "no need to
 * address the review comments", "don't review my changes yet", "you don't need to
 * fix the PR feedback" — otherwise matches, and for rework can mislabel the edits
 * that follow the decline as `rework` at high confidence (the over-claiming PRD-488
 * calls most damaging; the ≥1-edit gate does NOT catch it once real edits follow).
 * This vetoes a cue when an explicit negator sits within three words before a
 * REVIEW-SPECIFIC directive (address/fix/resolve/…/review) — NOT a general verb like
 * "implement", so a decline that happens to sit in a long, mostly-positive prompt
 * ("implement this finding … if bogus, do NOT implement it") is not falsely
 * suppressed. It carves out the do-ANYWAY idioms ("don't forget/hesitate/delay to
 * address …"). Deliberately narrow — direct declines only; full natural-language
 * negation is out of scope, and the ≥1-edit gate remains the backstop for the residue.
 *
 * The intervening-word gap admits HYPHENS, and the directive set includes the
 * run-verbs, because AA-06 added a re-run request shape ("re-run the review").
 * Without both, `don't re-run the review yet` slipped the veto entirely — `\w+`
 * cannot cross the hyphen in `re-run`, so the gap never reached the noun.
 *
 * The gap is THREE words because the request cue this vetoes admits a TWO-word verb:
 * `don't kick off the review` spends the entire budget on `kick off` and still needs
 * one more to reach the noun. A verb added there needs the gap to still clear it.
 */
export const NEGATED_REVIEW_INTENT_CUE =
  /\b(?:no\s+need\s+to|no\s+longer|not\s+going\s+to|do(?:es)?n['’]?t(?:\s+(?:need|have|want|plan)\s+to)?|do\s+not|won['’]?t|will\s+not|shouldn['’]?t|hold\s+off(?:\s+on)?|skip(?:ping)?)\s+(?!forget\b|hesitat\w+|delay\b)(?:[\w-]+\s+){0,3}?(?:address|fix|resolv\w*|appl\w*|incorporat\w*|handl\w*|evaluat\w*|reply|respond|rework|re-?run|re-?do|repeat|restart|perform|review(?:s|ing)?)\b/i;

/** True when the text explicitly DECLINES a review / address-review intent (see
 * {@link NEGATED_REVIEW_INTENT_CUE}); such a prompt must not open a phase. */
export function isNegatedReviewIntent(text: string): boolean {
  return NEGATED_REVIEW_INTENT_CUE.test(text);
}

/**
 * True when a human turn is an instruction to ADDRESS review findings (the strict
 * forward-proximity cue OR the split-clause PR-comment fallback) and is NOT a
 * declined intent. Exported so the review-intent detector can keep the
 * perform-review cue disjoint — an address-review (rework) prompt takes precedence.
 */
export function isReviewFixPrompt(text: string): boolean {
  if (isNegatedReviewIntent(text)) {
    return false;
  }
  return REVIEW_FIX_PROMPT_CUE.test(text) || hasProximateFixDirective(text);
}

/**
 * A frame that AUTHORS a comment rather than addressing one — "post a brief
 * comment on PR #1946 explaining why", "leave a comment on the PR".
 *
 * Writing a comment is an OUTPUT of the work, not a request to fix findings, but
 * it satisfies {@link REVIEW_COMMENT_REFERENCE_CUE} verbatim. In `c980bd56` this
 * fragment supplied half of a false rework span that erased the session's entire
 * implement/validate structure.
 */
const COMMENT_AUTHORING_FRAME_RE =
  /\b(?:post|leave|write|add|drop|put)\b(?:\W+\w+){0,3}?\W+comments?\s+on\b/i;

/**
 * The longest prompt the SPLIT-CLAUSE fallback will consider, and the furthest
 * apart its two halves may sit.
 *
 * The fallback exists for terse two-clause asks ("there's a comment on the PR,
 * please fix the issue it raised"). Applied to a long autonomous work order it
 * degenerates into "these two words both appear somewhere", which is exactly how
 * it fired: a 2,265-character kickoff matched `comment on PR #1946` inside a
 * contingency clause and `handling` inside an unrelated clause about other
 * agents, declaring the whole session rework from t0 and stripping every
 * implement and validate segment it contained. Two independent bounds, because
 * either alone is escapable — a short prompt can still pair unrelated clauses,
 * and a long one can still open with a genuine terse ask.
 */
const MAX_SPLIT_CLAUSE_PROMPT_CHARS = 600;
const MAX_SPLIT_CLAUSE_SEPARATION_CHARS = 160;

/**
 * Scanning forms of the two cues. The proximity test is about whether ANY
 * reference sits near ANY directive, so it needs every occurrence, not the first
 * of each: a prompt that opens with an unrelated `fix` and then makes its real
 * two-clause ask ("…, there's a comment on the PR — address it") was measured
 * only on that leading `fix`, and the intended pair inside the bound never got
 * compared. `matchAll` clones the regex per call, so sharing these is reentrant.
 */
const REVIEW_COMMENT_REFERENCE_SCAN_RE = new RegExp(
  REVIEW_COMMENT_REFERENCE_CUE.source,
  "gi"
);
const REVIEW_FIX_DIRECTIVE_SCAN_RE = new RegExp(
  REVIEW_FIX_DIRECTIVE_CUE.source,
  "gi"
);

/** The terse two-clause shape: a review-comment reference NEAR a fix directive. */
function hasProximateFixDirective(text: string): boolean {
  if (
    text.length > MAX_SPLIT_CLAUSE_PROMPT_CHARS ||
    COMMENT_AUTHORING_FRAME_RE.test(text)
  ) {
    return false;
  }
  const references = [...text.matchAll(REVIEW_COMMENT_REFERENCE_SCAN_RE)];
  if (references.length === 0) {
    return false;
  }
  for (const directive of text.matchAll(REVIEW_FIX_DIRECTIVE_SCAN_RE)) {
    const near = references.some(
      (reference) =>
        Math.abs(reference.index - directive.index) <=
        MAX_SPLIT_CLAUSE_SEPARATION_CHARS
    );
    if (near) {
      return true;
    }
  }
  return false;
}

// ── Internal shapes ──────────────────────────────────────────────────────────

/**
 * A closed, half-open `[startMs, endMs)` interval during which the session was
 * addressing review findings. `confidence`/`layers` come from the strongest
 * trigger that contributed to the span.
 */
export type ReworkSpan = {
  startMs: number;
  endMs: number;
  confidence: number;
  layers: EvidenceLayer[];
};

/** Ranked so an `exit` sorts before an `enter` at an identical ms (conservative:
 * close the open span before opening a new one → the boundary instant under-claims). */
const BOUNDARY_KIND_RANK = { exit: 0, enter: 1 } as const;

type BoundaryEvent =
  | { ms: number; kind: "enter"; confidence: number; layer: EvidenceLayer }
  | { ms: number; kind: "exit" };

/** Human turns with real text: an address-review prompt is an `enter`, any other
 * instruction is an `exit`. Tool-result turns encoded as `role: "human"` with no
 * text contribute nothing (they are not steering); a mis-detected exit only ends
 * rework early, which under-claims — the safe direction. */
function humanPromptEvents(session: NormalizedSession): BoundaryEvent[] {
  const events: BoundaryEvent[] = [];
  // `?? []`: the v3 bump backfills ALL history, and a session persisted before a
  // given collection field existed deserializes it as undefined despite the type
  // declaring a required array — iterating it unguarded would throw and fail the
  // whole session's re-derivation.
  for (const message of session.messages ?? []) {
    if (message.role !== "human") {
      continue;
    }
    const text = message.text?.trim();
    const ms = parseMsOrNull(message.timestamp);
    if (!text || ms === null) {
      continue;
    }
    if (isReviewFixPrompt(text)) {
      events.push({
        ms,
        kind: "enter",
        confidence: REWORK_CONFIDENCE_PROMPT,
        layer: EvidenceLayer.Declared,
      });
    } else {
      events.push({ ms, kind: "exit" });
    }
  }
  return events;
}

/** Total, engine-independent order: (ms, kind-rank, stable insertion index). */
function compareBoundaryEvents(
  a: { event: BoundaryEvent; index: number },
  b: { event: BoundaryEvent; index: number }
): number {
  if (a.event.ms !== b.event.ms) {
    return a.event.ms - b.event.ms;
  }
  const rankDelta =
    BOUNDARY_KIND_RANK[a.event.kind] - BOUNDARY_KIND_RANK[b.event.kind];
  return rankDelta === 0 ? a.index - b.index : rankDelta;
}

/** `rework` evidence layers, ranked declared-first (SSOT ordering); `structural`
 * is always present because every relabelled segment is active structural work. */
function spanLayers(hasDeclared: boolean): EvidenceLayer[] {
  return hasDeclared
    ? [EvidenceLayer.Declared, EvidenceLayer.Structural]
    : [EvidenceLayer.Structural];
}

/**
 * Compute the closed rework spans for a session. `sessionEndMs` (the tiling's
 * exclusive upper bound) closes a still-open span at session end. Pure: derives
 * every timestamp from parsed session fields, never the wall clock.
 */
export function computeReworkSpans(
  session: NormalizedSession,
  sessionEndMs: number
): ReworkSpan[] {
  const ordered = [...humanPromptEvents(session)]
    .map((event, index) => ({ event, index }))
    .sort(compareBoundaryEvents)
    .map((wrapped) => wrapped.event);

  const spans: ReworkSpan[] = [];
  let start: number | null = null;
  let confidence = 0;
  let hasDeclared = false;

  const close = (endMs: number): void => {
    if (start !== null && endMs > start) {
      spans.push({
        startMs: start,
        endMs,
        confidence,
        layers: spanLayers(hasDeclared),
      });
    }
    start = null;
    confidence = 0;
    hasDeclared = false;
  };

  for (const event of ordered) {
    if (event.kind === "enter") {
      if (start === null) {
        start = event.ms;
      }
      confidence = Math.max(confidence, event.confidence);
      hasDeclared ||= event.layer === EvidenceLayer.Declared;
    } else {
      close(event.ms);
    }
  }
  close(sessionEndMs);
  return spans;
}

/**
 * A span is confirmed rework only if a real EDIT — a mutation that touched a
 * WORKSPACE artifact, code or documentation — falls inside it (AC-003.3 honest
 * zero). Checked against the abstract evidence timeline rather than "an
 * `implement` SEGMENT overlaps the span", because a long implement window can
 * extend PAST its last edit into a later review-only span (e.g. `gh pr create`
 * with no follow-up edit) — that must stay zero, not inherit the earlier build's
 * edits.
 *
 * AA-09 (C1) is why this reads the workspace SET rather than `MutateCode` alone.
 * Documentation counts: answering review feedback by correcting the docs is a real
 * fix. `MutateScratch` does not, for exactly the honest-zero reason the gate
 * exists — a review span in which the agent only rewrote its own bookkeeping saw
 * no fix, and the corpus holds a review walk whose only writes are of that kind.
 */
function spanHasEdit(
  timeline: readonly EvidenceUnit[],
  span: ReworkSpan
): boolean {
  return timeline.some(
    (unit) =>
      WORKSPACE_MUTATION_CATEGORIES.has(unit.category) &&
      unit.ms >= span.startMs &&
      unit.ms < span.endMs
  );
}

/**
 * Relabel the review→fix subset of a session's activity tiling to `rework`.
 *
 * A non-`idle` segment (or the sub-slice of one) lying inside a CONFIRMED rework
 * span — a review-intent span (see {@link computeReworkSpans}) that also contains
 * a real edit — becomes `rework`, taking the span's confidence and
 * declared/structural provenance. Where a span boundary lands MID-segment (a
 * review prompt arriving inside an `implement` burst, or new work resuming
 * mid-window) the segment is split at that exact trigger/exit timestamp, so only
 * the fixing slice flips and the initial-build slice stays put. Splitting only
 * subdivides an existing interval — it never moves an FEA-2269 boundary,
 * reassigns a turn, or changes total spend, so complete-tiling and
 * Σ-reconciliation hold. Adjacent pieces that both flip to `rework` are then
 * coalesced ({@link coalesceAdjacentRuns}) so the output keeps FEA-2269's
 * maximal-same-phase-run shape. `idle` segments are never split or relabelled.
 *
 * `timeline` is FEA-2268's abstract evidence timeline (the same one the caller
 * classified from); only its WORKSPACE-mutation unit times are read, for the edit
 * gate — `mutate_code` and (since AA-09 C1) `mutate_document`, never
 * `mutate_scratch`. See {@link spanHasEdit}.
 * Generic over the concrete record type so this module never imports the
 * classifier (no import cycle).
 *
 * Cost is O(spans·timeline) for the edit gate plus O(segments·spans) for the
 * split/relabel. `spans` is bounded by the number of in-session review triggers
 * (small) and both other factors by one session's size, so the constant-factor
 * simplicity is preferred here over pre-indexing; revisit only if a pathological
 * many-trigger session is ever observed.
 */
export function applyReworkDetection<T extends RelabelableSegment>(
  segments: readonly T[],
  session: NormalizedSession,
  timeline: readonly EvidenceUnit[]
): T[] {
  const sessionEndMs = segments.at(-1)?.endMs;
  if (sessionEndMs === undefined) {
    return [...segments];
  }
  const confirmed = computeReworkSpans(session, sessionEndMs).filter((span) =>
    spanHasEdit(timeline, span)
  );
  if (confirmed.length === 0) {
    return [...segments];
  }
  const relabelled: T[] = [];
  for (const seg of segments) {
    if (seg.phase === ACTIVITY_PHASE.Idle) {
      relabelled.push(seg);
      continue;
    }
    for (const piece of splitAtCuts(seg, interiorCuts(seg, confirmed))) {
      const span = containingSpan(piece, confirmed);
      relabelled.push(
        span
          ? {
              ...piece,
              phase: ACTIVITY_PHASE.Rework,
              confidence: span.confidence,
              evidenceLayers: [...span.layers],
            }
          : piece
      );
    }
  }
  return coalesceAdjacentRuns(relabelled, sameRunByLabel);
}
