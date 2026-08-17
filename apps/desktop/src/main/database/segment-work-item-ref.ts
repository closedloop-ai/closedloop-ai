/**
 * @file segment-work-item-ref.ts
 * @description FEA-2272 (PRD-488, PLN-1197): the PURE resolver that projects a
 * session's already-persisted artifact links onto its activity segments,
 * choosing an optional `work_item_ref` per segment. This module adds NO detection
 * logic — no regexes, transcript scans, or tool classification. It consumes the
 * rows the existing artifact/PR linker (`artifact-ref-extractor` →
 * `persistArtifactLinks`) already wrote and picks the best work-item reference per
 * segment time window.
 *
 * ── Hard contract (PLN-1196 SSOT) ────────────────────────────────────────────
 * `work_item_ref` is STRICTLY OPTIONAL metadata. This resolver only ever returns
 * a value-or-null PER EXISTING SEGMENT; it never adds, drops, merges, or reshapes
 * segments. The caller writes the value onto the already-persisted row, so an
 * unlinked session and a linked session produce byte-for-byte identical segment
 * geometry — only the optional column differs.
 *
 * ── Precedence (§2.3, revised by FEA-4010 / AA-10) ───────────────────────────
 * A session that works SEVERAL artifacts is the normal case, so "which artifact
 * is this session's" has no correct answer. The question is per segment. When the
 * caller supplies the per-occurrence mention stream, each segment resolves as:
 *   1. the dominant mention INSIDE the segment's [startMs, endMs) span, else
 *   2. the ref carried forward from the preceding segment — work continues
 *      between mentions, the same way `phase-carry.ts` carries a phase — except
 *   3. an `idle` segment, which never originates or inherits a label: nobody was
 *      working, so a work item there is a claim about time that was not spent,
 *   4. else the FIRST mention, filled backwards over the opening run — work on an
 *      item routinely starts before the item is named (the ticket often first
 *      appears at commit or PR time), and leaving that run null measured as a
 *      loss of 32 of 35 correctly-labelled segments on one golden session,
 *   5. else null, when the session has no linked work item to name at all.
 *
 * With NO occurrences the session-level path still applies, so a session
 * identified only by its cwd / branch / launch metadata — which produce a link but
 * no transcript mention — keeps its label: the best reference (a ClosedLoop slug,
 * primary first, then a deterministic code-point tie-break), else (only when the
 * PR/branch gate is enabled) the session's PR, else its branch, else null.
 *
 * Rule 3 — idle claims nothing — holds on BOTH paths. It is a statement about
 * what a segment can honestly assert, not an artifact of how the label was
 * derived, so the session-level fan-out skips idle segments for exactly the
 * reason the occurrence path does.
 *
 * WHY (AA-10, measured). The session-level path fell through to its code-point
 * tie-break whenever a session touched more than one work item — 11 of 24 golden
 * sessions — so `FEA-1189`, mentioned once incidentally, beat `FEA-1224`,
 * mentioned 97 times, purely because `FEA-11…` sorts before `FEA-12…`. That
 * winner was then stamped on every segment, idle included; the audit found it
 * wrong on 8 of 21 sessions. Occurrence-scoped resolution reproduces the ground
 * truth on the exemplar (`3d624f34`: a FEA-2215 stretch, then FEA-2402), which no
 * single-value-per-session rule can express.
 *
 * Occurrences never INVENT a reference. They are intersected with the persisted
 * candidates, so the linker stays the authority on what a session is linked to and
 * this module keeps its "no detection logic" contract — the stream only says WHEN
 * each existing link was exercised.
 *
 * Determinism: every ordering/tie-break is explicit and locale-independent
 * (code-point comparison, never `localeCompare`), so the same links + segments
 * yield a byte-identical map regardless of input order or host OS.
 */
import {
  type ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { ACTIVITY_PHASE } from "../collectors/parsing/activity-taxonomy.js";
import type { WorkItemOccurrence } from "../collectors/parsing/work-item-occurrences.js";

/**
 * One persisted activity segment's span, in epoch-ms — the shape of a
 * `session_activity_segments` row's `id`/`start_ms`/`end_ms`/`phase` (FEA-2267).
 * Kept schema-agnostic so this pure module never binds to the concrete table.
 *
 * `phase` is read for one rule only: an `idle` segment never carries a work item
 * (AA-10). It is required rather than optional so a caller cannot silently opt out
 * of that rule and re-label idle time.
 */
export type SegmentSpan = {
  id: string;
  startMs: number;
  endMs: number;
  phase: string;
};

/**
 * One candidate work-item link for a session, projected from
 * `session_artifact_links` joined to `artifacts`. Carries only what the
 * precedence rules read; the caller maps DB columns to these fields.
 */
export type WorkItemCandidate = {
  slug: string | null;
  kind: ArtifactRefTargetKind;
  relation: ArtifactRefRelation;
  isPrimary: boolean;
  /**
   * A TRUSTWORTHY per-occurrence timestamp (epoch-ms) that places this link at a
   * point inside the session, or null when the link is only session-level. For
   * the currently-included kinds (slug/PR/branch) the store carries no
   * per-occurrence transcript time, so the read path supplies null and the
   * session-level fan-out applies; the field keeps the resolver correct if a
   * future producer ever records one (AC-006.4).
   */
  occurredAtMs: number | null;
  prNumber: number | null;
  branchName: string | null;
  repoFullName: string | null;
};

/**
 * PLN-1197 Open Q #2: whether a segment's `work_item_ref` may fall back to a
 * PR / branch identifier when the session has NO ClosedLoop slug link. Default
 * OFF — slug-only is the conservative, high-precision default. Flip to `true` to
 * also label slug-less sessions by the PR/branch they touched. NOTE: this changes
 * only the RESOLVER. Pre-existing `session_artifact_links` writers that insert
 * PR/branch links WITHOUT calling `stampSegmentWorkItemRefs` (the branch↔PR
 * propagation and enrichment sweeps) would leave sessions linked solely via those
 * paths unstamped until an unrelated re-import/backfill re-stamps them.
 */
export const WORK_ITEM_REF_INCLUDE_PR_BRANCH_FALLBACK = false;

/**
 * Relative kind priority for the session-level tie-break: a ClosedLoop slug
 * always outranks a PR, which outranks a branch. Lower is stronger. `commit` is
 * never a candidate (commits label rail dots, not segments) and is excluded by
 * the reader, so it is absent here.
 */
const KIND_PRIORITY: Record<string, number> = {
  [ArtifactRefTargetKind.ClosedloopArtifact]: 0,
  [ArtifactRefTargetKind.PullRequest]: 1,
  [ArtifactRefTargetKind.Branch]: 2,
};

/** True when this kind may label a segment given the PR/branch gate. */
function isInScopeKind(
  kind: ArtifactRefTargetKind,
  includePrBranch: boolean
): boolean {
  if (kind === ArtifactRefTargetKind.ClosedloopArtifact) {
    return true;
  }
  return (
    includePrBranch &&
    (kind === ArtifactRefTargetKind.PullRequest ||
      kind === ArtifactRefTargetKind.Branch)
  );
}

/**
 * The ClosedLoop slug families that constitute a WORK ITEM for labeling: PLN-1197
 * §1 names FEA, PLN, and PRD as the work-item slugs. A `closedloop_artifact` link
 * to any other family — a PRO project, a SES session, a WRK — is not a work item
 * and is never stamped as `work_item_ref`, even when it is the session's only
 * link.
 *
 * This gates the FAMILY only; the digit run is deliberately unbounded. The linker
 * that produced the link is the source of truth on what counts as a valid slug —
 * re-imposing a width cap here would silently drop a legitimately-linked session
 * the day slug numbering crosses that bound.
 */
const WORK_ITEM_SLUG_RE = /^(FEA|PLN|PRD)-\d+$/;

/**
 * The string stored in `work_item_ref` for a candidate: the slug for a ClosedLoop
 * work-item artifact, a stable `repo#number` for a PR, or the branch name.
 * Returns null when the identifying fields are absent, or when a ClosedLoop slug
 * is not a work-item family (the candidate then labels nothing).
 */
function refValue(candidate: WorkItemCandidate): string | null {
  switch (candidate.kind) {
    case ArtifactRefTargetKind.ClosedloopArtifact:
      return candidate.slug && WORK_ITEM_SLUG_RE.test(candidate.slug)
        ? candidate.slug
        : null;
    case ArtifactRefTargetKind.PullRequest:
      return candidate.repoFullName && candidate.prNumber != null
        ? `${candidate.repoFullName}#${candidate.prNumber}`
        : null;
    case ArtifactRefTargetKind.Branch:
      return candidate.branchName;
    default:
      return null;
  }
}

/** Locale-independent code-point comparison (never `localeCompare`). */
function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}

/**
 * Total order over usable candidates (best first): in-scope kind priority
 * (slug > PR > branch), then primary before non-primary, then a deterministic
 * code-point tie-break on the ref value. Every comparison is explicit so ties
 * resolve identically across hosts and input orderings.
 */
function compareCandidates(
  a: WorkItemCandidate,
  aValue: string,
  b: WorkItemCandidate,
  bValue: string
): number {
  const kindDelta =
    (KIND_PRIORITY[a.kind] ?? Number.POSITIVE_INFINITY) -
    (KIND_PRIORITY[b.kind] ?? Number.POSITIVE_INFINITY);
  if (kindDelta !== 0) {
    return kindDelta;
  }
  if (a.isPrimary !== b.isPrimary) {
    return a.isPrimary ? -1 : 1;
  }
  return compareStrings(aValue, bValue);
}

/** A candidate paired with its (non-null) resolved ref value. */
type UsableCandidate = { candidate: WorkItemCandidate; value: string };

/** The in-scope candidates that resolve to a non-null ref value, best first. */
function usableCandidates(
  candidates: readonly WorkItemCandidate[],
  includePrBranch: boolean
): UsableCandidate[] {
  const usable: UsableCandidate[] = [];
  for (const candidate of candidates) {
    if (!isInScopeKind(candidate.kind, includePrBranch)) {
      continue;
    }
    const value = refValue(candidate);
    if (value !== null) {
      usable.push({ candidate, value });
    }
  }
  return usable.sort((a, b) =>
    compareCandidates(a.candidate, a.value, b.candidate, b.value)
  );
}

/**
 * The tightest time-scoped reference for one segment: the best scoped candidate
 * whose per-occurrence timestamp falls inside `[startMs, endMs)`, or null when
 * none does. `scoped` is already sorted best-first, so the first match wins.
 */
function scopedRef(
  segment: SegmentSpan,
  scoped: readonly UsableCandidate[]
): string | null {
  for (const { candidate, value } of scoped) {
    const ms = candidate.occurredAtMs;
    if (ms !== null && ms >= segment.startMs && ms < segment.endMs) {
      return value;
    }
  }
  return null;
}

/**
 * The dominant linked slug mentioned inside `[startMs, endMs)`, or null.
 *
 * Dominance is by mention COUNT, so one incidental mention cannot outvote the
 * work actually being discussed; ties break on the code-point-lowest slug purely
 * for determinism. `linked` gates the stream to slugs the linker actually
 * persisted, so a mention never invents a reference.
 */
function dominantOccurrence(
  segment: SegmentSpan,
  occurrences: readonly WorkItemOccurrence[],
  linked: ReadonlySet<string>
): string | null {
  const counts = new Map<string, number>();
  for (const occurrence of occurrences) {
    if (
      occurrence.occurredAtMs < segment.startMs ||
      occurrence.occurredAtMs >= segment.endMs ||
      !linked.has(occurrence.slug)
    ) {
      continue;
    }
    counts.set(occurrence.slug, (counts.get(occurrence.slug) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [slug, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && best !== null && slug < best)
    ) {
      best = slug;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Per-segment resolution from the occurrence stream: the dominant in-span mention,
 * else the preceding segment's ref carried forward, except that `idle` segments
 * neither originate nor inherit one. Segments are walked in start order so carry
 * follows transcript time regardless of the caller's row order.
 */
function resolveFromOccurrences(
  segments: readonly SegmentSpan[],
  occurrences: readonly WorkItemOccurrence[],
  linked: ReadonlySet<string>
): Map<string, string | null> {
  const ordered = [...segments].sort(
    (a, b) => a.startMs - b.startMs || compareStrings(a.id, b.id)
  );
  const result = new Map<string, string | null>();
  // Seed with the FIRST mention so the run before it is labelled too: work on an
  // item routinely starts before the item is named (the ticket often first
  // appears at commit or PR time), and leaving that opening run null discarded 32
  // of 35 correctly-labelled segments on one measured session. This is a backward
  // fill of one known item, not the old session-level winner — it cannot smear a
  // second item's stretch, because the next mention takes over from its own
  // segment onward.
  //
  // "First" means EARLIEST, scanned rather than taken from array position: every
  // production caller hands over a time-sorted stream, but this module sorts the
  // segments it is given rather than trusting their order, and the seed is the one
  // place where an unsorted stream would silently change the answer instead of
  // failing. Slug breaks a same-millisecond tie so the result stays byte-identical
  // across input orderings.
  let carried: string | null = null;
  let carriedAtMs = Number.POSITIVE_INFINITY;
  for (const occurrence of occurrences) {
    if (!linked.has(occurrence.slug)) {
      continue;
    }
    if (
      occurrence.occurredAtMs < carriedAtMs ||
      (occurrence.occurredAtMs === carriedAtMs &&
        carried !== null &&
        occurrence.slug < carried)
    ) {
      carried = occurrence.slug;
      carriedAtMs = occurrence.occurredAtMs;
    }
  }
  for (const segment of ordered) {
    if (segment.phase === ACTIVITY_PHASE.Idle) {
      // Idle is not a gap in the label, it is the absence of work. Carry survives
      // ACROSS it — the segment after a lunch break continues the same item — but
      // the idle span itself claims nothing.
      result.set(segment.id, null);
      continue;
    }
    const dominant = dominantOccurrence(segment, occurrences, linked);
    if (dominant !== null) {
      carried = dominant;
    }
    result.set(segment.id, carried);
  }
  return result;
}

/**
 * Resolve each segment's optional `work_item_ref` from a session's existing
 * artifact-link candidates, refined per segment by the mention stream. Pure and
 * deterministic: no IO, no clock, no randomness. Returns a map from segment id to
 * its ref value (or null). An empty candidate set — or one with no in-scope kind —
 * maps every segment to null (the strict no-op: the caller then clears the column,
 * leaving the tiling untouched).
 *
 * `occurrences` is the session's work-item mentions in transcript order. When it
 * contains at least one mention of a LINKED slug, resolution is per segment
 * (AA-10). When it does not — a session identified only by cwd / branch / launch
 * metadata, which link without ever being mentioned — the session-level reference
 * applies to every segment, which for a single-artifact session is the correct
 * fan-out rather than a degradation.
 *
 * `options.includePrBranchFallback` overrides the module default
 * ({@link WORK_ITEM_REF_INCLUDE_PR_BRANCH_FALLBACK}); the production caller omits
 * it (slug-only) and tests pass it explicitly to exercise both gate states.
 */
export function resolveSegmentWorkItemRefs(
  segments: readonly SegmentSpan[],
  candidates: readonly WorkItemCandidate[],
  occurrences: readonly WorkItemOccurrence[],
  options: { includePrBranchFallback?: boolean } = {}
): Map<string, string | null> {
  const includePrBranch =
    options.includePrBranchFallback ?? WORK_ITEM_REF_INCLUDE_PR_BRANCH_FALLBACK;
  const usable = usableCandidates(candidates, includePrBranch);
  // Only ClosedLoop slugs can be matched against the mention stream; a PR or
  // branch candidate has no slug to mention, so it stays on the session-level path.
  const linked = new Set<string>();
  for (const { candidate, value } of usable) {
    if (candidate.kind === ArtifactRefTargetKind.ClosedloopArtifact) {
      linked.add(value);
    }
  }
  if (
    linked.size > 0 &&
    occurrences.some((occurrence) => linked.has(occurrence.slug))
  ) {
    return resolveFromOccurrences(segments, occurrences, linked);
  }
  // The session-level fallback is drawn from UNSCOPED candidates only: a
  // candidate pinned to one segment's time window (occurredAtMs set) must refine
  // that segment alone, never become the label for the whole session.
  const sessionRef =
    usable.find((u) => u.candidate.occurredAtMs === null)?.value ?? null;
  const scoped = usable.filter((u) => u.candidate.occurredAtMs !== null);
  const result = new Map<string, string | null>();
  for (const segment of segments) {
    if (segment.phase === ACTIVITY_PHASE.Idle) {
      // Same rule as the occurrence path: nobody was working, so no work item.
      result.set(segment.id, null);
      continue;
    }
    // Skip the per-segment candidate scan entirely when nothing is time-scoped —
    // the production shape (occurredAtMs is always null) — so resolution is
    // O(segments + candidates), not O(segments × candidates).
    const scopedMatch = scoped.length > 0 ? scopedRef(segment, scoped) : null;
    result.set(segment.id, scopedMatch ?? sessionRef);
  }
  return result;
}
