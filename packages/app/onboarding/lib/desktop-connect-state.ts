import { DesktopDeviceSessionStatus } from "@repo/api/src/types/onboarding";
import type { DesktopDeviceSessionDetails } from "../types";

/**
 * The states the Desktop-first browser approval page can render (FEA-2218).
 *
 * `OrgRequired` is produced by the bare (no-org-slug) route rather than by
 * {@link deriveDesktopConnectState} — a signed-in user with no active org never
 * reaches the org-scoped approval page, so it is surfaced where that gap is
 * detected. The remaining kinds are derived from the pending-session detail and
 * the outcome of an approve/deny action, so they can be unit-tested without
 * React. `SessionExpired`, `AlreadyUsed`, `Denied`, and `Forbidden` are the
 * spec's typed failure states; `OrgRequired` is the fifth.
 */
export const DesktopConnectStateKind = {
  /** No verification code entered/derived yet. */
  Idle: "idle",
  /** Loading the pending-session detail. */
  Loading: "loading",
  /** Live pending session: show approve/deny. */
  Pending: "pending",
  /** Approved in this browser; show return-to-desktop completion. */
  ApprovedComplete: "approved_complete",
  /** Signed in but no internal org resolved (set by the bare route). */
  OrgRequired: "org_required",
  /** Pending session TTL elapsed. */
  SessionExpired: "session_expired",
  /** Pending session was already approved/consumed. */
  AlreadyUsed: "already_used",
  /** Request was denied. */
  Denied: "denied",
  /** This user/org may not approve this session. */
  Forbidden: "forbidden",
  /** No session matched the code (unknown/cleaned up). */
  NotFound: "not_found",
} as const;
export type DesktopConnectStateKind =
  (typeof DesktopConnectStateKind)[keyof typeof DesktopConnectStateKind];

export type DesktopConnectState = {
  kind: DesktopConnectStateKind;
  detail?: DesktopDeviceSessionDetails | null;
};

/** Outcome of the most recent approve/deny mutation, if any. */
export type DesktopConnectActionOutcome =
  | { kind: "approved" }
  | { kind: "denied" }
  | { kind: "error"; status: number; code?: string }
  | null
  | undefined;

export type DeriveDesktopConnectStateInput = {
  /** Whether a verification code is present (query enabled). */
  hasCode: boolean;
  isLoading: boolean;
  detail?: DesktopDeviceSessionDetails | null;
  /** Detail-query error, if the lookup failed. */
  detailError?: { status?: number } | null;
  actionOutcome?: DesktopConnectActionOutcome;
  /** Injectable clock for deterministic tests; defaults to `Date.now()`. */
  now?: number;
};

const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;

/**
 * Whether an approve/deny action error of this HTTP status renders a dedicated
 * failure state (`Forbidden` for 403, `SessionExpired`/`AlreadyUsed` for 404)
 * rather than leaving the request retryable. The approval page suppresses the
 * shared default-error toast, so it uses this to decide when a transient error
 * still needs an explicit toast instead.
 */
export function actionErrorRendersState(status: number): boolean {
  return status === FORBIDDEN_STATUS || status === NOT_FOUND_STATUS;
}

function isExpired(
  detail: DesktopDeviceSessionDetails | null | undefined,
  now: number
): boolean {
  if (!detail) {
    return false;
  }
  return new Date(detail.expiresAt).getTime() <= now;
}

/**
 * Pure reducer from the approval page's data + last action to a render state.
 *
 * A just-completed action takes precedence over the (possibly stale) detail:
 * an approve/deny success is terminal, and an approve error maps a 403 to
 * `Forbidden` and a 404 to `SessionExpired`/`AlreadyUsed` depending on whether
 * the locally known expiry has passed. Other action errors fall through to the
 * detail-derived state so the user can retry a transient failure.
 */
export function deriveDesktopConnectState(
  input: DeriveDesktopConnectStateInput
): DesktopConnectState {
  const now = input.now ?? Date.now();
  const { actionOutcome, detail, detailError, hasCode, isLoading } = input;

  if (actionOutcome) {
    const fromAction = stateFromActionOutcome(actionOutcome, detail, now);
    if (fromAction) {
      return fromAction;
    }
  }

  if (!hasCode) {
    return { kind: DesktopConnectStateKind.Idle };
  }
  if (isLoading) {
    return { kind: DesktopConnectStateKind.Loading };
  }

  if (detailError) {
    return {
      kind:
        detailError.status === NOT_FOUND_STATUS
          ? DesktopConnectStateKind.SessionExpired
          : DesktopConnectStateKind.NotFound,
    };
  }

  if (!detail) {
    return { kind: DesktopConnectStateKind.NotFound };
  }

  return stateFromDetailStatus(detail, now);
}

function stateFromActionOutcome(
  outcome: NonNullable<DesktopConnectActionOutcome>,
  detail: DesktopDeviceSessionDetails | null | undefined,
  now: number
): DesktopConnectState | null {
  if (outcome.kind === "approved") {
    return { kind: DesktopConnectStateKind.ApprovedComplete, detail };
  }
  if (outcome.kind === "denied") {
    return { kind: DesktopConnectStateKind.Denied, detail };
  }
  if (outcome.status === FORBIDDEN_STATUS) {
    return { kind: DesktopConnectStateKind.Forbidden, detail };
  }
  if (outcome.status === NOT_FOUND_STATUS) {
    return {
      kind:
        !detail || isExpired(detail, now)
          ? DesktopConnectStateKind.SessionExpired
          : DesktopConnectStateKind.AlreadyUsed,
      detail,
    };
  }
  // Transient/unknown action error: defer to the detail-derived state so the
  // pending session can be retried.
  return null;
}

function stateFromDetailStatus(
  detail: DesktopDeviceSessionDetails,
  now: number
): DesktopConnectState {
  switch (detail.status) {
    case DesktopDeviceSessionStatus.Pending:
      return isExpired(detail, now)
        ? { kind: DesktopConnectStateKind.SessionExpired, detail }
        : { kind: DesktopConnectStateKind.Pending, detail };
    case DesktopDeviceSessionStatus.Approved:
      return { kind: DesktopConnectStateKind.AlreadyUsed, detail };
    case DesktopDeviceSessionStatus.Denied:
      return { kind: DesktopConnectStateKind.Denied, detail };
    case DesktopDeviceSessionStatus.Expired:
      return { kind: DesktopConnectStateKind.SessionExpired, detail };
    default:
      return { kind: DesktopConnectStateKind.NotFound, detail };
  }
}

export type DesktopConnectStateCopy = {
  title: string;
  description: string;
};

const STATE_COPY: Record<DesktopConnectStateKind, DesktopConnectStateCopy> = {
  [DesktopConnectStateKind.Idle]: {
    title: "Connect Desktop",
    description: "Enter the verification code shown in the desktop app.",
  },
  [DesktopConnectStateKind.Loading]: {
    title: "Connect Desktop",
    description: "Loading the connection request…",
  },
  [DesktopConnectStateKind.Pending]: {
    title: "Connect Desktop",
    description: "Review the request below, then approve or deny it.",
  },
  [DesktopConnectStateKind.ApprovedComplete]: {
    title: "Desktop connected",
    description:
      "You can return to the Closedloop desktop app — it will detect the approval automatically.",
  },
  [DesktopConnectStateKind.OrgRequired]: {
    title: "Organization required",
    description:
      "Create or select an organization before connecting Desktop, then reopen the connection link from the desktop app.",
  },
  [DesktopConnectStateKind.SessionExpired]: {
    title: "Request expired",
    description:
      "This connection request is no longer valid. Start a new connection from the desktop app.",
  },
  [DesktopConnectStateKind.AlreadyUsed]: {
    title: "Request already handled",
    description:
      "This connection request was already approved. If this wasn't you, start a new connection from the desktop app.",
  },
  [DesktopConnectStateKind.Denied]: {
    title: "Request denied",
    description:
      "This connection request was denied. Start a new connection from the desktop app to try again.",
  },
  [DesktopConnectStateKind.Forbidden]: {
    title: "Can't approve this request",
    description:
      "Your account isn't permitted to approve this desktop connection. Contact your administrator if you believe this is an error.",
  },
  [DesktopConnectStateKind.NotFound]: {
    title: "Request not found",
    description:
      "We couldn't find a connection request for this code. It may have expired or already completed. Start a new connection from the desktop app.",
  },
};

/** Actionable title + description for a given approval-page state. */
export function getDesktopConnectStateCopy(
  kind: DesktopConnectStateKind
): DesktopConnectStateCopy {
  return STATE_COPY[kind];
}
