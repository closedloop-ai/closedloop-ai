// Shared IPC-payload contract for the Activity panel (FEA-3258 / FEA-3259).
//
// The renderer's ActivityPanel renders three IPC payloads:
//   - desktop:get-activity-events   → ActivityEvent[]   (activity-log-store)
//   - desktop:list-running-jobs     → ActivityJobSnapshot[] (symphony-job-snapshot)
//   - desktop:list-completed-jobs   → ActivityJob[]      (job-store)
//
// These shapes live here — a dependency-free contract module under `src/shared`
// — so the renderer TS program imports the canonical types WITHOUT following a
// type-only edge into the main/server implementation files (job-store.ts pulls
// in electron-store + @closedloop-ai/loops-api; symphony-job-snapshot.ts pulls in
// agent-utils, symphony-utils, security, telemetry). Those implementation
// modules re-export from here, so the shapes stay a single source of truth
// while the renderer stays decoupled from main/server-only dependencies.

/**
 * Compile-time assertion that `T` is assignable to `U`. Purely type-level (no
 * runtime statement), used by the store/operation modules to prove their
 * persisted/enriched shapes remain structural supersets of these renderer-facing
 * contract types — so the renderer can render them through the shared type
 * without importing main/server-only implementation files.
 */
export type AssertAssignable<T extends U, U> = T;

/** Persisted job lifecycle status. SSOT for `LocalJobStatus` in job-store.ts. */
export type LocalJobStatus =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "AWAITING_USER"
  | "STOPPED"
  | "CANCEL_PENDING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "UNKNOWN"
  | "TIMED_OUT";

/** Loop command a job was launched for. SSOT for `LocalJobCommand`. */
export type LocalJobCommand =
  | "PLAN"
  | "EXECUTE"
  | "REQUEST_CHANGES"
  | "DECOMPOSE"
  | "GENERATE_PRD";

/**
 * The subset of a persisted job the Activity panel renders. `LocalJob` (main)
 * is a structural superset of this — enforced by a compile-time assignability
 * check in job-store.ts — so the renderer sees only the fields it uses without
 * importing the full persisted record or its main-only dependencies.
 */
export type ActivityJob = {
  id: string;
  command: LocalJobCommand;
  status: LocalJobStatus;
  loopId: string;
  ticketId?: string;
  artifactSlug?: string;
};

/**
 * A running-job snapshot: `ActivityJob` plus the live fields enrichment adds.
 * `JobSnapshot` (server) is a structural superset — enforced in
 * symphony-job-snapshot.ts — so the two IPC list payloads share one row type.
 */
export type ActivityJobSnapshot = ActivityJob & {
  processRunning: boolean;
};

/** A gateway-request / security activity-log row. SSOT for `ActivityEvent`. */
export type ActivityEvent = {
  id: string;
  type?: "request" | "security";
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  detail?: string;
  requestSizeBytes?: number;
  responseSizeBytes?: number;
};
