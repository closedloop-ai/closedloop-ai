import {
  type AgentSessionDetail,
  AgentSessionState,
} from "@repo/api/src/types/agent-session";
import {
  DISPLAYED_SESSION_STATUS,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
import {
  SESSION_STATUS_LABELS,
  SESSION_UNKNOWN_TOOLTIP,
} from "@repo/api/src/types/session-status-display";
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleXIcon,
  EyeIcon,
  LoaderIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * How one `AgentSessionState` renders on the session-detail Status row.
 *
 * `tooltip` mirrors the Sessions LIST badge's own `StatusBadgeConfig`
 * (`session-status-badges.tsx`): it is set only for a label that is a HEDGE
 * rather than a state.
 *
 * ISS-5999 dropped `color` and `ariaLabel`. Their only reader was the collapsed
 * Properties strip's status dot, which ISS-5818 removed — the title one line up
 * carries a chip off the SESSION_STATUS lifecycle axis, and restating
 * `AgentSessionState` below it could put two legitimately-different words in one
 * viewport. The expanded row renders the label as visible text with the tooltip
 * beside it in an `sr-only` span, so it needs neither a swatch nor a composed
 * accessible name.
 */
export type StatusDisplay = {
  label: string;
  icon: LucideIcon;
  /** Hover copy explaining a label that names our limitation, not the run. */
  tooltip?: string;
};

/**
 * FEA-4287: single source of truth for how each terminal/nonterminal
 * `AgentSessionState` renders on the detail Status row — label and icon in ONE
 * exhaustive `Record`, so a state can never have an icon that argues with the
 * word beside it, and a newly added `AgentSessionState` fails typecheck here
 * until it is mapped.
 *
 * `Error` reads its label from the canonical {@link SESSION_STATUS_LABELS} map
 * (the same vocabulary the Sessions LIST badge renders) so the failure word
 * cannot drift between list and detail: `Error → "Failed"`.
 *
 * ISS-4654 (review, #4651) — KNOWN, DELIBERATE, and NOT resolved here: the one
 * terminal-not-failed outcome now has TWO words. The Sessions LIST badge folds
 * an `inactive` row to the neutral muted "Inactive" (ISS-4586's point being that
 * finished is not a success claim), while this row projects the same row through
 * `toAgentSessionState` to {@link AgentSessionState.Completed} and renders
 * "Completed" in `var(--success)` with a checkmark. A run that was orphan-swept
 * rather than finished therefore reads as a success on its detail page.
 *
 * That divergence was effected by the merged backfill
 * (`20260808120000_iss4654_backfill_legacy_session_status`), which collapsed the
 * `abandoned` rows this map used to render distinctly; it is not a delta from
 * the diff that deleted the now-unreachable `AgentSessionState.Abandoned` entry.
 * The remedy is OPEN, and it is NOT "add `AgentSessionState.Inactive`".
 * ISS-4654 section A proposed exactly that and was RESOLVED AS NOT NEEDED
 * (2026-08-08): `AgentSessionState` is OUTCOME vocabulary (did the run finish,
 * or die), `SESSION_STATUS` is stored LIFECYCLE, and an `Inactive` outcome would
 * put a lifecycle word into a vocabulary that does not speak lifecycle. The
 * version-skew argument that once blocked it is moot too — nothing new is
 * emitted on the wire. So this divergence has no scheduled fix, and closing it
 * means deciding something else: render this row from the LIST's vocabulary
 * rather than from `state`, or distinguish "finished" from "succeeded" inside
 * the outcome set, or accept the success tone as correct for a swept run.
 * Tracked on ISS-5695. Until that decision lands, do not "fix" the word here by
 * hand: the list and this row must move together, off one vocabulary.
 *
 * ISS-4654 — the exhaustiveness above is a COMPILE-time guarantee, and `state`
 * is an UNVERSIONED wire value, so it does not hold at runtime. An installed
 * Desktop build in Cloud mode indexes this map by whatever the cloud sends; a
 * server emitting a member added after that build shipped finds no entry here.
 * {@link getStatusDisplay} therefore falls back on a MISSING ENTRY, not merely
 * on a falsy `state` — its previous form guarded the wrong condition, so an
 * unrecognized non-empty value indexed to `undefined` and the caller crashed
 * dereferencing `.label`. That is exactly the version-skew ship-blocker that
 * deferred `AgentSessionState.Inactive` out of #4112; the guard existed but
 * never fired.
 *
 * ISS-4654 (PR #4630 review) — split out of `agent-session-detail-view.tsx`, a
 * grandfathered over-ceiling file, so the label/icon/copy decisions live in one
 * small module the parity tests can address directly instead of growing the
 * view further.
 */
const STATUS_DISPLAY_BY_STATE: Record<AgentSessionState, StatusDisplay> = {
  [AgentSessionState.Completed]: {
    /* ISS-4654: this borrowed SESSION_STATUS_LABELS[COMPLETED], which is gone
     * with that status. The word belongs to the STATE, not to a retired status
     * spelling — an `inactive` row projects here too and still reads
     * "Completed" (see toAgentSessionState). */
    label: "Completed",
    icon: CheckCircle2Icon,
  },
  [AgentSessionState.Running]: {
    label: "Running",
    icon: LoaderIcon,
  },
  [AgentSessionState.PendingApproval]: {
    label: "Awaiting your approval",
    icon: CircleDashedIcon,
  },
  [AgentSessionState.Blocked]: {
    label: "Blocked",
    icon: CircleAlertIcon,
  },
  [AgentSessionState.InReview]: {
    label: "In review",
    icon: EyeIcon,
  },
  /* FEA-4287: a terminal failure reads as destructive (like Blocked's danger
   * tone) with an X glyph — a failed run never sits beside a success checkmark.
   * ISS-4654 retired the sibling Abandoned entry along with
   * `AgentSessionState.Abandoned`; a run that used to land there is `inactive`
   * now and reads Completed — see the known divergence noted on
   * STATUS_DISPLAY_BY_STATE above. */
  [AgentSessionState.Error]: {
    label: SESSION_STATUS_LABELS[SESSION_STATUS.ERROR],
    icon: CircleXIcon,
  },
};

/**
 * ISS-4654 (PR #4630 review): the display for a `state` this build cannot
 * interpret. Every field here is deliberate, and none of it is a second copy of
 * something the Sessions LIST already decided:
 *
 *  • `label` reads {@link SESSION_STATUS_LABELS} like every terminal entry
 *    above, rather than restating the word. It is the SAME word today, which is
 *    exactly when wiring it is cheap.
 *  • `tooltip` is the canonical {@link SESSION_UNKNOWN_TOOLTIP} the list pill
 *    carries (ISS-4997), so a version-skewed session cannot read
 *    explained-unknown in the list and unexplained-unknown on its own detail
 *    page. A bare one-word hedge invites the question it refuses to answer.
 *  • `icon` is CircleHelp, NOT the CircleDashed that `PendingApproval` owns
 *    above. In the expanded Status row the glyph is the one non-text signal, so
 *    unknown and awaiting-you must not share it.
 */
export const UNKNOWN_STATUS_DISPLAY: StatusDisplay = {
  label: SESSION_STATUS_LABELS[DISPLAYED_SESSION_STATUS.UNKNOWN],
  icon: CircleHelpIcon,
  tooltip: SESSION_UNKNOWN_TOOLTIP,
};

export function getStatusDisplay(
  state: AgentSessionDetail["state"]
): StatusDisplay {
  return (state && STATUS_DISPLAY_BY_STATE[state]) || UNKNOWN_STATUS_DISPLAY;
}
