/**
 * @file agent-component-sync-lane-contract.ts
 * @description The component-inventory sync lane's CONTRACT types: what it is
 * injected with, and the shape of each step its run hands to the next.
 *
 * Split out of `agent-session-sync-component-lane.ts`, which sat at 997 of the
 * 1,000-line `noExcessiveLinesPerFile` ceiling and is deliberately NOT
 * grandfathered - PLN-1961's risk list predicted this, and ISS-9418's telemetry
 * half is what pushed it over. A line-count slice would be the wrong fix; this
 * is a real seam, and the same one C1 took when it lifted the lane's durable
 * give-up bookkeeping into `agent-component-lane-give-up.ts`. Nothing here holds
 * state, executes a step, or reads the store: it is the vocabulary the lane's
 * methods speak, which is exactly the part a reader consults WITHOUT reading the
 * run loop.
 */

import type { ComponentSyncSendResult } from "./agent-component-sync-dead-letter.js";
import type { AgentSessionSyncServiceOptions } from "./agent-session-sync-service-options.js";
import type {
  AgentComponentCursorRow,
  AgentSessionSyncSource,
} from "./agent-session-sync-source.js";

/**
 * The narrow slice of {@link AgentSessionSyncServiceOptions} this lane reads. It
 * is deliberately a `Pick` of the canonical options type rather than a parallel
 * declaration, so the wiring contract cannot drift from the service's.
 */
export type AgentComponentSyncLaneOptions = Pick<
  AgentSessionSyncServiceOptions,
  | "getSource"
  | "getSyncComputeTargetId"
  | "listComponentCursorRows"
  | "loadComponentRows"
  | "onComponentSyncBatchTelemetry"
  | "sendComponents"
>;

/**
 * The two pieces of owning-service lifecycle state the lane must read LIVE (not
 * snapshot at construction): the source-state generation it guards its post-await
 * writes on, and whether the service is still started. Both are supplied as
 * accessors so the lane never holds a reference to the service itself.
 */
export type AgentComponentSyncLaneHost = {
  /**
   * The owning service's `sourceStateGeneration`. Bumped by `resetSourceState()`;
   * the lane captures it at the top of a run and refuses to write a superseded
   * run's boundary / ids / cursor back into freshly-cleared state.
   */
  getSourceStateGeneration: () => number;
  /** The owning service's `started` flag, re-read after every await. */
  isStarted: () => boolean;
};

/** Inputs for the drained-cursor dead-letter recovery step. */
export type ComponentDeadLetterRecoveryInput = {
  sendComponents: NonNullable<AgentComponentSyncLaneOptions["sendComponents"]>;
  loadComponentRows: NonNullable<
    AgentComponentSyncLaneOptions["loadComponentRows"]
  >;
  isCurrent: () => boolean;
  sinceTs: string;
  sinceId: string;
  /** ISS-8593 (whitlockk review): the durable row the post-recovery dead-letter
   * snapshot is written to. Recovery advances no cursor, so nothing else on this
   * path carries the identity that write belongs to. */
  sourceKey: string;
};

/** Inputs for the post-send outcome classification step. */
export type ComponentSendOutcomeInput = {
  sendResult: ComponentSyncSendResult;
  boundaryKey: string;
  lastRow: AgentComponentCursorRow | undefined;
  batchIds: string[];
  /** ISS-8593: the subset of `batchIds` whose row is already tombstoned, so the
   * tracker never evicts one at its size cap (nothing else can re-drive it). */
  tombstonedIds: ReadonlySet<string>;
  componentCount: number;
  sourceKey: string;
  source: AgentSessionSyncSource | null;
};

/**
 * ISS-5347 (whitlockk review): the identity stamp of ONE durable-cursor persist
 * attempt.
 *
 * The persist is fire-and-forget, so its outcome can land arbitrarily late -
 * after `clearCursorState()` re-scoped the lane to a different account, or after
 * a newer advance already issued its own persist. Without a stamp an OLD failure
 * dirties the NEW identity's flag and an OLD success clears a NEWER failure, and
 * `AgentComponentSyncLane.hasStaleDurableCursor` stops describing the durable
 * position at all. The lane accepts an outcome only from the attempt that is
 * still the current one for the still-current cursor identity.
 *
 * `watermark`/`lastId` are carried so a FAILED attempt can be re-driven: they
 * are the exact position that did not reach disk.
 */
export type ComponentCursorPersistAttempt = {
  sourceKey: string;
  seq: number;
  watermark: string;
  lastId: string;
};

/** What one `AgentComponentSyncLane` cursor hydration established. */
export const CursorHydration = {
  /** The durable cursor was read and adopted; the lane is hydrated. */
  Hydrated: "hydrated",
  /** No source (db host restarting): the in-memory position stands (ISS-5347). */
  SourceUnavailable: "source_unavailable",
  /** The durable read rejected: skip the tick, charge the environmental clock (ISS-10910). */
  ReadFailed: "read_failed",
} as const;
export type CursorHydration =
  (typeof CursorHydration)[keyof typeof CursorHydration];
