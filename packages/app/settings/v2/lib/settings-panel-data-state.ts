/**
 * @file settings-panel-data-state.ts
 * @description How a Settings v2 panel BODY classifies its own read (ISS-8369).
 *
 * The sibling `settings-panel-resolution.ts` decides whether a panel opens at
 * all; this decides what an opened panel shows. Both exist to refuse the same
 * collapse, one layer apart: a read that is still in flight, a read that came
 * back with nothing, a read the server refused, a read the server could not
 * answer, and a read that failed are FIVE facts, and PRD-692 forbids folding any
 * of them into another. The legacy panels fold three of them — an errored list
 * query leaves `data` undefined, and `apps/app`'s API-keys panel renders that
 * as "no keys yet", which is a failed read shown as a completed one.
 *
 * Pure and hook-free so every branch is reachable from a unit test without
 * standing up a query client.
 */
import { ApiError } from "../../../shared/api/api-error";

export const SettingsPanelDataState = {
  /** The read has not answered yet. Never a value, never an absence. */
  Loading: "loading",
  /** The read answered and there is something to show. */
  Ready: "ready",
  /** The read answered and the collection is genuinely empty. */
  Empty: "empty",
  /** The server decided: this actor may not have it. */
  Forbidden: "forbidden",
  /** The server could not decide. Retryable, and NOT a denial. */
  Unavailable: "unavailable",
  /** Anything else that went wrong. Retryable. */
  Failed: "failed",
} as const;

export type SettingsPanelDataState =
  (typeof SettingsPanelDataState)[keyof typeof SettingsPanelDataState];

export type SettingsPanelReadInput = {
  /** True while the read has produced neither data nor an error. */
  isPending: boolean;
  /** The read's error, or null/undefined when it has not failed. */
  error: unknown;
  /** Whether a response body is actually held. */
  hasData: boolean;
  /** Whether that body represents an empty collection. */
  isEmpty: boolean;
};

/**
 * Which state an error puts a panel in.
 *
 * 403 and 503 are kept apart because the API already keeps them apart: a 403 is
 * an authorization DECISION, while 503 is reserved for the case where nothing
 * about the caller's access was decided at all (`AuthErrorCode.OrgUnverifiable`
 * ships that way today, and an unresolved organization role is the same shape).
 * Rendering the second as the first tells a user they lack access the server
 * never checked, and sends them to ask an admin for a permission they may
 * already hold.
 *
 * A non-`ApiError` throw carries no status, so it can only be `Failed`; it must
 * not fall through to a denial.
 */
export function classifySettingsPanelError(
  error: unknown
): SettingsPanelDataState {
  if (error instanceof ApiError) {
    if (error.isForbidden()) {
      return SettingsPanelDataState.Forbidden;
    }
    if (error.isServiceUnavailable()) {
      return SettingsPanelDataState.Unavailable;
    }
  }
  return SettingsPanelDataState.Failed;
}

/**
 * Precedence, highest first: error, pending, absent-body, empty, ready.
 *
 * An error outranks held data on purpose. A query that has failed keeps its last
 * successful body in cache, and rendering that body while the current read is
 * failing presents stale keys and stale connection statuses as the live answer —
 * the same lie as an empty state over a failed read, only harder to notice.
 *
 * `hasData === false` with no error and nothing pending is `Failed`, NOT `Empty`.
 * A settled read that produced no body did not observe an empty collection; it
 * observed nothing, and the two must not read alike.
 */
export function classifySettingsPanelRead(
  input: SettingsPanelReadInput
): SettingsPanelDataState {
  if (input.error !== null && input.error !== undefined) {
    return classifySettingsPanelError(input.error);
  }
  if (input.isPending) {
    return SettingsPanelDataState.Loading;
  }
  if (!input.hasData) {
    return SettingsPanelDataState.Failed;
  }
  return input.isEmpty
    ? SettingsPanelDataState.Empty
    : SettingsPanelDataState.Ready;
}

/**
 * Whether a mutation failed because the server's view of the resource has moved
 * on since this client read it — another admin revoked the same key, or
 * disconnected the same plugin, from another session or an older build.
 *
 * The remedy is to re-read and show what is actually true, not to report the
 * user's action as broken: the outcome they asked for has already happened.
 *
 * Scoped to API-key revocation, which is the one owned mutation that can answer
 * this way: `/api-keys/[id]` DELETE returns `notFoundResponse` for a key that is
 * missing OR already revoked. 409 is covered because a
 * concurrent write is the same fact arriving as a conflict.
 */
export function isStaleResourceError(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 404 || error.status === 409)
  );
}

/**
 * What a body shows when its controls also depend on a SECOND read — the
 * actor's capability for the domain (ISS-10316). An unsettled capability read
 * outranks the body's own read, so a control is never drawn while it is
 * unknown whether this actor may use it.
 */
export function resolveGatedSettingsPanelState(
  accessState: SettingsPanelDataState,
  readState: SettingsPanelDataState
): SettingsPanelDataState {
  return accessState === SettingsPanelDataState.Ready ? readState : accessState;
}
