import type { SessionMeshFeedbackKind } from "@repo/api/src/types/session-mesh";

/**
 * The persisted `event_type` for each feedback kind, and the ONLY place those
 * strings are spelled.
 *
 * An exhaustive `Record`, so adding a kind to `SESSION_MESH_FEEDBACK_KIND` fails
 * `tsc` here. The insights rollup reads THIS map rather than re-typing the
 * values in SQL — a literal list there would let a new kind persist and then be
 * silently dropped from `judged`, which the card presents as a hard denominator.
 */
export const FEEDBACK_EVENT_TYPE: Readonly<
  Record<SessionMeshFeedbackKind, string>
> = {
  useful: "delivery_useful",
  not_useful: "delivery_not_useful",
  cant_tell: "delivery_cant_tell",
  conflict_resolved: "conflict_resolved",
  coordination_overhead: "coordination_overhead",
};
