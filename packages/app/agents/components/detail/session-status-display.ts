import {
  type DisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import {
  CheckCircle2Icon,
  CircleXIcon,
  LoaderIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * How one {@link DisplayedSessionStatus} renders on the session-detail Status
 * row.
 *
 * ISS-5999 dropped `color` and `ariaLabel`. Their only reader was the collapsed
 * Properties strip's status dot, which ISS-5818 removed. ISS-10364 then
 * retired `tooltip` along with the only entries that ever set it (Unknown,
 * Stale) — every remaining state is an outcome the run itself reported, which
 * needs no hover explanation.
 */
export type StatusDisplay = {
  label: string;
  icon: LucideIcon;
};

/**
 * ISS-7019: the detail Status row renders the SAME vocabulary the Sessions list
 * does. It used to render `AgentSessionState`, a second axis that has been
 * deleted — four of its members duplicated these values one-for-one, and the
 * other two (`Blocked`, `InReview`) had no producer anywhere in the repo.
 *
 * Every label reads from the canonical {@link SESSION_STATUS_LABELS}, so a word
 * cannot drift between list and detail — the map below decides only the GLYPH,
 * which is the one signal the list badge (colour + word) does not carry. The
 * `Record<DisplayedSessionStatus, …>` is exhaustive, so a new member fails
 * typecheck here until it is given one.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) retired the `waiting`/`stale`/
 * `unknown` entries this map used to carry, with them their tooltips and the
 * `CircleDashedIcon`/`CircleSlashIcon`/`CircleHelpIcon` glyphs — all three now
 * fold to one of the three lifecycle values before this map is ever consulted.
 */
const STATUS_DISPLAY_BY_STATUS: Record<DisplayedSessionStatus, StatusDisplay> =
  {
    [SESSION_STATUS.ACTIVE]: {
      label: SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE],
      icon: LoaderIcon,
    },
    [SESSION_STATUS.INACTIVE]: {
      label: SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE],
      icon: CheckCircle2Icon,
    },
    /* A terminal failure reads destructive with an X glyph (FEA-4287) — a failed
     * run never sits beside a success checkmark. */
    [SESSION_STATUS.ERROR]: {
      label: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
      icon: CircleXIcon,
    },
  };

/**
 * ISS-4654 (PR #4630 review): the display for a status this build cannot
 * interpret — a version-skewed session serving a word this map has no entry
 * for. ISS-10364 retired the dedicated Unknown entry this used to point at;
 * an unrecognized status now reads as Active, the same fail-open every other
 * fold in this vocabulary takes, rather than a disclaiming "Unknown".
 */
export const FALLBACK_STATUS_DISPLAY: StatusDisplay =
  STATUS_DISPLAY_BY_STATUS[SESSION_STATUS.ACTIVE];

export function getStatusDisplay(status: string): StatusDisplay {
  return (
    (status && STATUS_DISPLAY_BY_STATUS[status as DisplayedSessionStatus]) ||
    FALLBACK_STATUS_DISPLAY
  );
}
