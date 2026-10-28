/**
 * Bulk root-artifact rank contract for `GET`/`POST
 * /projects/:id/artifacts/rank` (ISS-8999).
 *
 * The single-item primitive is `project-artifact-move.ts`. This module is the
 * whole-project counterpart: the caller sends the COMPLETE desired order of a
 * project's root DOCUMENT artifacts plus the epoch it read that order at, and
 * the server either commits every rank in one transaction or commits none.
 *
 * Shared by `apps/api` (validator + service + route) and `packages/app` (the
 * stack-ranking client hooks), so it lives in `@repo/api` rather than
 * co-located in either.
 */

import { z } from "zod";
import { postgresStorableTextSchema } from "./postgres-text.ts";

/**
 * Who or what asked for a bulk rank rewrite. Persisted verbatim to the
 * freeform `source` column on `project_rank_events`, so this const object is
 * the single source of truth for the vocabulary and it can grow additively
 * without a schema migration per value (same precedent as
 * `ArtifactActivityActorType` and `Artifact.status`).
 *
 * - `dependency_rank`      — the dependency-constrained stack ranker that
 *                            computes a whole-project order offline.
 * - `manual_bulk_reorder`  — a person reordering many roots in one gesture
 *                            (multi-select drag, paste-an-order).
 * - `api`                  — a programmatic caller (MCP / API key / script).
 */
export const BulkRankMutationSource = {
  DependencyRank: "dependency_rank",
  ManualBulkReorder: "manual_bulk_reorder",
  Api: "api",
} as const;
export type BulkRankMutationSource =
  (typeof BulkRankMutationSource)[keyof typeof BulkRankMutationSource];

/**
 * Upper bound on roots one bulk request may carry. Sized well above the
 * 1,252-root reorder in ISS-8999 so the real workload never hits it, and low
 * enough that a single `UPDATE … FROM (VALUES …)` stays inside Postgres'
 * bind-parameter budget.
 */
export const BULK_RANK_MAX_ARTIFACTS = 5000;

/** Why the server refused to apply a bulk rank rewrite. */
export const BulkRankConflictReason = {
  /**
   * The set of root artifacts changed since the caller read it: roots were
   * added, removed, or reparented under another artifact.
   */
  PopulationMismatch: "population_mismatch",
  /**
   * The root population still matches exactly, but their order changed since
   * the caller read it (another reorder landed in between).
   */
  StaleEpoch: "stale_epoch",
} as const;
export type BulkRankConflictReason =
  (typeof BulkRankConflictReason)[keyof typeof BulkRankConflictReason];

/**
 * Current rank state of one project's root DOCUMENT artifacts —
 * `GET /projects/:id/artifacts/rank`.
 *
 * `rankEpoch` is an opaque server-computed token over the ordered roots and
 * their stack-rank values. It is NOT a counter and carries no ordering: the
 * only supported operation is equality against a later read. Feed it straight
 * back as `expectedRankEpoch`; never parse or synthesize it client-side.
 */
export type ProjectRankStateResponse = {
  rankEpoch: string;
  orderedArtifactIds: string[];
};

/** Request body for `POST /projects/:id/artifacts/rank`. */
export type BulkRankArtifactsRequest = {
  /**
   * The COMPLETE desired order of the project's root DOCUMENT artifacts, top
   * first. Must be exactly the current root population — no additions, no
   * omissions, no duplicates.
   */
  orderedArtifactIds: string[];
  /** The `rankEpoch` the caller read `orderedArtifactIds` at. */
  expectedRankEpoch: string;
  source: BulkRankMutationSource;
  /**
   * Caller-chosen replay key. Retrying a timed-out request with the same key
   * either applies the rewrite once (the first attempt rolled back) or replays
   * the committed result — never applies it twice.
   */
  idempotencyKey: string;
};

/** Success body for `POST /projects/:id/artifacts/rank`. */
export type BulkRankArtifactsResponse = {
  ranked: true;
  /** Epoch committed by this operation; pass as `expectedRankEpoch` next time. */
  rankEpoch: string;
  /** The committed order, top first. */
  orderedArtifactIds: string[];
  /**
   * `true` when this response replayed an earlier commit for the same
   * `idempotencyKey` rather than applying the request. The body is the earlier
   * commit's result, which may differ from the order just sent.
   */
  replayed: boolean;
};

/**
 * 409 body for a rejected bulk rank rewrite, carried as the typed `data` field
 * of `ApiConflictBody`. Every id list is present (possibly empty) so a client
 * never has to distinguish "absent" from "none".
 */
export type BulkRankConflictDetail = {
  reason: BulkRankConflictReason;
  expectedRankEpoch: string;
  actualRankEpoch: string;
  /** Roots that exist now but were missing from the request. */
  addedArtifactIds: string[];
  /** Requested ids that are no longer root DOCUMENT artifacts of this project. */
  removedArtifactIds: string[];
  /** Requested ids that are still in the project but now nest under a parent. */
  reparentedArtifactIds: string[];
};

const bulkRankMutationSourceSchema = z.enum([
  BulkRankMutationSource.DependencyRank,
  BulkRankMutationSource.ManualBulkReorder,
  BulkRankMutationSource.Api,
]);

/**
 * Shape map for {@link bulkRankArtifactsValidator}. Typed as an exhaustive
 * `Record<keyof BulkRankArtifactsRequest, …>` so adding a field to the request
 * type without teaching the `.strict()` boundary schema fails `tsc` here
 * instead of silently rejecting the whole payload in production.
 */
const bulkRankArtifactsShape = {
  orderedArtifactIds: z.array(z.uuid()).max(BULK_RANK_MAX_ARTIFACTS),
  expectedRankEpoch: z.string().min(1).max(128),
  source: bulkRankMutationSourceSchema,
  idempotencyKey: postgresStorableTextSchema(z.string().min(1).max(255)),
} satisfies Record<keyof BulkRankArtifactsRequest, z.ZodTypeAny>;

/**
 * Boundary validator for the bulk rank request. `.strict()` so an unknown key
 * is rejected rather than silently dropped, and duplicate ids are refused here
 * (a 400) rather than reaching the service, where a repeated id would make the
 * requested order ambiguous.
 */
export const bulkRankArtifactsValidator = z
  .object(bulkRankArtifactsShape)
  .strict()
  .refine(
    (value) =>
      new Set(value.orderedArtifactIds).size ===
      value.orderedArtifactIds.length,
    { message: "orderedArtifactIds must not contain duplicate ids" }
  );
