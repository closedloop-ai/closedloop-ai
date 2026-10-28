/**
 * Wire message and code for retired API routes kept as tombstones — 410 by
 * default (`apps/api/AGENTS.md`), except where noted. One place per retirement so every tombstone route and
 * its test agree.
 */

/**
 * ISS-8943: the GENERATE_PRD capability is retired, but the two endpoints that
 * drove it are kept as 410 tombstones because a stale browser bundle or an
 * `sk_live_*` integration can still call them.
 */
export const GeneratePrdEndpointRemoval = {
  Message: "PRD generation is no longer available",
  Code: "generate_prd_removed",
} as const;
export type GeneratePrdEndpointRemoval =
  (typeof GeneratePrdEndpointRemoval)[keyof typeof GeneratePrdEndpointRemoval];

/**
 * ISS-12435 (PRD-795): Loops are removed. The documented `/loops*` and
 * `/documents/{id}/run-loop` routes, and the loop-only document, plan, catalog
 * and settings routes, stay as 410 tombstones until a human approves deleting
 * them, because installed Desktop builds and `sk_live_*` integrations can still
 * call them.
 */
export const LoopsEndpointRemoval = {
  Message: "This feature is no longer available.",
  Code: "loops_removed",
} as const;
export type LoopsEndpointRemoval =
  (typeof LoopsEndpointRemoval)[keyof typeof LoopsEndpointRemoval];

/**
 * PRD-797: Routines are removed. `POST /desktop/routines/sync` stays because
 * installed Desktop builds still post their routine outbox to it. Unlike the
 * 410 tombstones above it answers 400: those builds read 404/410/501 as
 * "protocol unavailable" and retry on a flat delay without ever charging the
 * row, while a 400 charges the row's retry budget, so each row dead-letters
 * once that budget is spent (and re-pends only when its local task is edited).
 * Do not convert it to 410.
 */
export const RoutinesEndpointRemoval = {
  Message: LoopsEndpointRemoval.Message,
  Code: "routines_removed",
} as const;
export type RoutinesEndpointRemoval =
  (typeof RoutinesEndpointRemoval)[keyof typeof RoutinesEndpointRemoval];

/**
 * ISS-12617: compute targets are no longer shared with the organization. The
 * `PATCH /compute-targets/{id}/sharing` route stays as a 410 tombstone because a
 * web tab opened before the deploy, or an `sk_live_*` integration, can still
 * call it.
 */
export const ComputeTargetSharingEndpointRemoval = {
  Message: LoopsEndpointRemoval.Message,
  Code: "compute_target_sharing_removed",
} as const;
export type ComputeTargetSharingEndpointRemoval =
  (typeof ComputeTargetSharingEndpointRemoval)[keyof typeof ComputeTargetSharingEndpointRemoval];
