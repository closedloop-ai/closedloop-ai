/**
 * Result types for `loopsService.ingestRunnerEvent`.
 *
 * Co-located in `apps/api/app/loops/` because they are consumed exclusively
 * by the backend (the service method and its route layer). They are not part
 * of the shared frontend/backend contract — per `packages/api/CLAUDE.md`,
 * such types belong with their owner, not in `@repo/api`.
 */

export const IngestRunnerEventErrorCode = {
  LoopNotFound: "LOOP_NOT_FOUND",
  Replay: "REPLAY",
} as const;
export type IngestRunnerEventErrorCode =
  (typeof IngestRunnerEventErrorCode)[keyof typeof IngestRunnerEventErrorCode];

/**
 * The `inserted` outcome means "approved for orchestration" — the orchestrator
 * is the sole writer of the canonical `LoopEvent` row.
 */
export type IngestRunnerEventSuccess = {
  ok: true;
  outcome: "inserted" | "ignored";
};

export type IngestRunnerEventError = {
  ok: false;
  code: IngestRunnerEventErrorCode;
};

/**
 * Discriminated on `ok` to match the codebase's Result<T> convention.
 *
 * The route maps each outcome/code to an HTTP status:
 *   { ok: true,  outcome: "inserted" } → 200 (caller proceeds to orchestrator)
 *   { ok: true,  outcome: "ignored"  } → 200 { received: true, ignored: true }
 *   { ok: false, code:    LoopNotFound } → 403 (forbidden, not 404, to avoid
 *     leaking loop existence across tenants)
 *   { ok: false, code:    Replay      } → 409
 *
 * JTI mismatches are rejected earlier by `authenticateLoopRunnerRequest`
 * and never reach this service method.
 */
export type IngestRunnerEventResult =
  | IngestRunnerEventSuccess
  | IngestRunnerEventError;
