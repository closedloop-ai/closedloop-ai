/**
 * @file idle-concepts.ts
 * @description FEA-3572 — canonical vocabulary that disambiguates the four
 * distinct things the overloaded word **"idle"** has meant across the Sessions
 * surface. Before this module they were all just called "idle", so a reader (or a
 * new contributor grepping for "idle") could not tell which concept a given call
 * site meant. This is the ONE place that names them, documents the exact
 * condition and rationale for each, and points to the single source of truth
 * that implements each — the vocabulary registry, not a second implementation.
 *
 * Only concept #1 ({@link IdleConcept.PhantomSession}) is an actual persisted
 * `sessionDetail` record and the only thing counted as a "session"; it is the one
 * and only *session-level* idle concept. The other three are derived/presentation
 * artifacts that are recomputed at read/render time and are NOT separate session
 * records or counters — this module names them so they are no longer conflated
 * with #1, but it deliberately does NOT reclassify them (FEA-3572 verified scope:
 * naming disambiguation + UI surfacing only, not a session-model change).
 *
 * Define the vocabulary as a const object + type alias (never a TS `enum`, never
 * bare string literals) so every surface — the cloud query builder, the desktop
 * sync gate, and the shared session UI — references the same named member instead
 * of the ambiguous string.
 */

import { ACTIVITY_PHASE_LABEL } from "../activity-phase-labels";

/**
 * The four canonical, mutually-distinct "idle" concepts. Each member is the
 * stable name for one concept; the human-readable condition, rationale, and the
 * SSOT that implements it live in {@link IDLE_CONCEPTS}.
 */
export const IdleConcept = {
  /**
   * #1 — an idle ("phantom") **session** record: a persisted `sessionDetail` row
   * with no substantive work. The ONLY session-level idle concept and the only
   * one counted as a session. SSOT: `isSubstantiveSession`
   * (`@repo/api/src/agent-session-filters`).
   */
  PhantomSession: "phantom_session",
  /**
   * #2 — an idle **activity-timeline gap**: an inter-turn span of at least
   * `ACTIVITY_IDLE_GAP_MS` that the versioned activity classifier emits as a
   * first-class `idle` segment (evidence-free active spans are `other`, not
   * idle). These segments are persisted and synced as classifier-versioned rows,
   * so a threshold/rule change is a version bump + backfill, not a live re-derive.
   * A timeline phase, never a session. SSOT: `classifyActivitySegments`
   * (`apps/desktop/.../collectors/parsing/activity-segment-classifier.ts`,
   * `ACTIVITY_IDLE_GAP_MS` + `ACTIVITY_CLASSIFIER_VERSION`); read-time aggregation
   * via `IDLE_PHASE_KEY` (`@repo/lib/sessions/activity-segment-aggregation`).
   */
  ActivityGap: "activity_gap",
  /**
   * #3 — a **stalled run**: a *running* session whose latest genuine activity is
   * older than the stall window. A derived in-memory phase computed 1:1 from a
   * running session's list row on every render; never a new record. SSOT:
   * `ACTIVE_RUN_PHASE_KIND.Stalled` (`@repo/app/agents/lib/active-runs`).
   */
  StalledRun: "stalled_run",
  /**
   * #4 — a **trace gap**: an idle marker synthesized at render time to visualize
   * a pause between two stamped items in the cross-session merged trace. A
   * presentational trace element, never a session. SSOT: `buildMergedTrace`
   * (`@repo/lib/branches/merged-trace`), which synthesizes the `idle`
   * `MergedTraceItem` wherever consecutive items gap by the idle threshold. (The
   * per-session `session-trace.tsx` view *discards* the dormant
   * `{ type: "idle"; gap }` `TurnItem` variant in `buildTraceGroups`, so that
   * variant is not the rendered gap.)
   */
  TraceGap: "trace_gap",
} as const;

export type IdleConcept = (typeof IdleConcept)[keyof typeof IdleConcept];

/**
 * True iff the concept is the one and only *session-level* idle concept (#1,
 * {@link IdleConcept.PhantomSession}) — the only "idle" that is a persisted
 * session record and is counted. The other three are derived/presentation
 * artifacts. Kept as a helper (rather than an inline `=== IdleConcept.PhantomSession`)
 * so the "only #1 is a session" invariant reads the same at every call site.
 */
export function isSessionLevelIdleConcept(concept: IdleConcept): boolean {
  return concept === IdleConcept.PhantomSession;
}

/** The reference metadata carried for each idle concept (see {@link IDLE_CONCEPTS}). */
export type IdleConceptDescriptor = {
  /** Stable canonical id, one of {@link IdleConcept}. */
  concept: IdleConcept;
  /** Short user-facing label for badges/filters. */
  label: string;
  /** The precise condition under which this concept applies. */
  condition: string;
  /** Why this concept is distinct — kept so the four are never re-conflated. */
  rationale: string;
  /** The single source of truth module that implements/derives this concept. */
  ssot: string;
  /**
   * Whether this concept is a persisted, counted session record. Only #1 is;
   * mirrors {@link isSessionLevelIdleConcept}.
   */
  isSession: boolean;
};

/**
 * The KEPT reference documentation of all four idle categories — the condition +
 * rationale for each, plus the SSOT that owns it. This is the durable record that
 * replaces the four scattered, same-named "idle" usages with one disambiguated
 * table. Do not delete; extend it (with an exhaustive-key guard, see below) if a
 * fifth "idle" concept ever appears.
 */
export const IDLE_CONCEPTS: Readonly<
  Record<IdleConcept, IdleConceptDescriptor>
> = {
  [IdleConcept.PhantomSession]: {
    concept: IdleConcept.PhantomSession,
    label: "Idle session",
    condition:
      "A persisted sessionDetail row that is NOT substantive: 0 turns AND 0 tokens (input + output + cache read + cache write) AND 0 tool uses; nulls coalesce to 0.",
    rationale:
      "The desktop live-hook INSERTs a 0-turn/0-token row on SessionStart before any real activity. This is the only session-level idle concept and the only thing counted as a session (the idleCount reveal, the quality filter).",
    ssot: "@repo/api/src/agent-session-filters (isSubstantiveSession); SQL twin SESSION_SUBSTANTIVE_WHERE/SESSION_IDLE_WHERE; desktop sync twin synced-session-substantive.ts",
    isSession: true,
  },
  [IdleConcept.ActivityGap]: {
    // ISS-4790: read from the canonical activity-taxonomy label map rather than
    // re-declaring the string, so this concept and the phase band it describes
    // cannot drift. It reads distinctly from the "Idle session" badge because it
    // renders in a different context — a timeline phase band, not a session row.
    concept: IdleConcept.ActivityGap,
    label: ACTIVITY_PHASE_LABEL.idle,
    condition:
      "An inter-turn span of at least ACTIVITY_IDLE_GAP_MS that the versioned activity classifier opens as a first-class `idle` segment (evidence-free active spans are `other`, not idle).",
    rationale:
      "A timeline phase within a single session, classified and persisted as classifier-versioned rows (a threshold/rule change is a version bump + backfill, not a live re-derive), then aggregated for display. Not a session, not counted; needs no reclassification.",
    ssot: "classifyActivitySegments (apps/desktop collectors/parsing/activity-segment-classifier.ts — ACTIVITY_IDLE_GAP_MS + ACTIVITY_CLASSIFIER_VERSION); read-time aggregation via @repo/lib/sessions/activity-segment-aggregation (IDLE_PHASE_KEY)",
    isSession: false,
  },
  [IdleConcept.StalledRun]: {
    concept: IdleConcept.StalledRun,
    label: "Stalled",
    condition:
      "A currently-running session whose latest genuine activity (lastActivityAt) is older than ACTIVE_RUN_STALL_TIMEOUT_MS and is not awaiting user input.",
    rationale:
      "A derived in-memory Active-runs phase computed 1:1 from a running session's list row on every render. Never a new record; needs no reclassification.",
    ssot: "@repo/app/agents/lib/active-runs (ACTIVE_RUN_PHASE_KIND.Stalled)",
    isSession: false,
  },
  [IdleConcept.TraceGap]: {
    concept: IdleConcept.TraceGap,
    label: "Idle gap",
    condition:
      "An idle MergedTraceItem synthesized at render time to visualize a pause wherever two consecutive stamped items in the cross-session merged trace gap by the idle threshold.",
    rationale:
      "A presentational trace element synthesized for the merged trace; never persisted, never a session, not counted; needs no reclassification. (The per-session session-trace.tsx view discards the dormant `{ type: 'idle'; gap }` TurnItem variant, so that variant is not the rendered gap.)",
    ssot: "@repo/lib/branches/merged-trace (buildMergedTrace — synthesized `idle` MergedTraceItem)",
    isSession: false,
  },
};

/**
 * The user-facing label for an idle concept, read from the canonical
 * {@link IDLE_CONCEPTS} map so no surface duplicates the label string. Uses an
 * exhaustive lookup — a member added to {@link IdleConcept} without an
 * {@link IDLE_CONCEPTS} entry fails typecheck at the `Record<IdleConcept, …>`
 * above, so this can never return an unmapped concept.
 */
export function idleConceptLabel(concept: IdleConcept): string {
  return IDLE_CONCEPTS[concept].label;
}
