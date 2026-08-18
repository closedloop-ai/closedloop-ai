import type { ActivityMarker } from "./session-timeline-axis";

/**
 * The three dot lanes the activity strip stacks, keyed by the single-letter
 * token the rendered cell uses (`b` steering, `g` delivery, `r` trouble).
 */
export type DotColor = "b" | "g" | "r";

/**
 * Which lane a marker belongs to, or `null` for a marker kind the strip does not
 * plot as a dot.
 *
 * The grouping is by what a reader is scanning FOR, not by event provenance:
 * commits and PRs are both "the session shipped something", failures and rate
 * limits are both "the session was blocked", and prompts and frustration signals
 * are both "a human intervened". Three lanes keep the strip readable at the
 * density a long session produces.
 */
export function getMarkerDotColor(
  kind: ActivityMarker["kind"]
): DotColor | null {
  if (kind === "commit" || kind === "pr") {
    return "g";
  }
  if (kind === "fail" || kind === "limit") {
    return "r";
  }
  if (kind === "prompt" || kind === "frust") {
    return "b";
  }
  return null;
}

/** The theme token a lane paints with, so dots track light/dark like the rest. */
export function getDotColorToken(color: DotColor): string {
  if (color === "g") {
    return "var(--success)";
  }
  if (color === "r") {
    return "var(--destructive)";
  }
  return "var(--primary)";
}

/**
 * The dot's accessible name, which must not promise a jump the dot cannot make.
 *
 * Mirrors `getBucketButtonLabel` in `activity-bucket-rendering.ts` — the bar
 * already drops "Jump to" when it carries no row, and ISS-5479 found the dot six
 * pixels away still claiming it.
 *
 * `withdrawn` is the resolved no-jump state rather than the raw "this marker
 * has no `tl`" fact, so the caller decides it once and the name, the affordance
 * and the click all answer from the same value. ISS-6006 retired the gate that
 * used to hold this false, so the withdrawn name is now unconditional — matching
 * the bar's equivalent, which has been un-gated since ISS-4821.
 */
export function getDotButtonLabel(color: DotColor, withdrawn: boolean): string {
  if (withdrawn) {
    return getDotLabel(color);
  }
  return `Jump to ${getDotLabel(color)}`;
}

/** The lane's human name, used by the dot tooltip and its accessible label. */
export function getDotLabel(color: DotColor): string {
  if (color === "g") {
    return "Commits & PRs";
  }
  if (color === "r") {
    return "Failures & limits";
  }
  return "Human steering";
}

/**
 * The inverse direction of {@link getMarkerDotColor}: which marker KIND a
 * persisted timeline row's single-letter `dot` token stands for. Moved here from
 * `agent-session-detail-view.tsx` (grandfathered shrink-only) because it is the
 * other half of this module's job — one place owns the mapping between dot
 * tokens and marker semantics, so the two directions cannot drift apart.
 *
 * `dot` arrives from a synced/persisted row, so it is untrusted at this
 * boundary: an unrecognized or absent token degrades to `prompt` rather than
 * throwing or dropping the marker, which keeps a version-skewed producer's
 * events on the strip instead of silently losing them.
 */
export function getEventMarkerKind(
  dot: string | undefined
): ActivityMarker["kind"] {
  if (dot === "g") {
    return "commit";
  }
  if (dot === "r") {
    return "fail";
  }
  return "prompt";
}
