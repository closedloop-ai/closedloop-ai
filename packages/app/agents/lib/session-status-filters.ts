import {
  SESSION_STATUS,
  type SessionStatus,
} from "@closedloop-ai/loops-api/session-status";

/**
 * Canonical Agent Sessions status-filter contract (single source of truth for
 * every shared surface — Sessions filter menu, monitoring analytics toolbar,
 * and the kanban columns).
 *
 * The wire value is ALWAYS the canonical cross-runtime `SESSION_STATUS` string.
 * Both data sources reconcile that single value at their own boundary:
 *   • cloud HTTP filters `artifact.status` directly (stores "error"), and
 *   • the desktop-local adapter canonicalizes its legacy "error"→"failed" rows
 *     and the requested filter through the same alias map.
 * No surface may send a non-canonical literal (e.g. "failed"), which matched
 * zero rows on the cloud source and split the contract across surfaces.
 *
 * The user-facing label stays "Failed" for the ERROR value to preserve the
 * existing UX vocabulary.
 */
export type SessionStatusFilterOption = {
  value: string;
  label: string;
};

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  [SESSION_STATUS.ACTIVE]: "Active",
  [SESSION_STATUS.WAITING]: "Waiting",
  [SESSION_STATUS.COMPLETED]: "Completed",
  [SESSION_STATUS.ERROR]: "Failed",
  [SESSION_STATUS.ABANDONED]: "Abandoned",
};

export const SESSION_STATUS_FILTER_OPTIONS: readonly SessionStatusFilterOption[] =
  [
    {
      value: SESSION_STATUS.ACTIVE,
      label: SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
    },
    {
      value: SESSION_STATUS.WAITING,
      label: SESSION_STATUS_LABELS[SESSION_STATUS.WAITING],
    },
    {
      value: SESSION_STATUS.COMPLETED,
      label: SESSION_STATUS_LABELS[SESSION_STATUS.COMPLETED],
    },
    {
      value: SESSION_STATUS.ERROR,
      label: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
    },
    {
      value: SESSION_STATUS.ABANDONED,
      label: SESSION_STATUS_LABELS[SESSION_STATUS.ABANDONED],
    },
  ];
