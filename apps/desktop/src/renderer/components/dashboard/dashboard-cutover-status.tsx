import {
  CloudReadCutoverBlocker,
  type CloudReadCutoverDecision,
  DesktopAppCoreMode,
} from "../../shared-agent-sessions/desktop-app-core-mode";
import { useDesktopCloudReadCutover } from "../../shared-agent-sessions/desktop-app-core-provider";

/**
 * ISS-5477: the VISIBLE half of the read-source hold.
 *
 * A small muted chip identical to steady-state `Local`, explained only on
 * hover, is thin for the one moment this feature exists for — someone who just
 * signed in and cannot find their history is not going to hover a badge to
 * learn why. The header row already does the visible version of exactly this:
 * `ScanStatus` renders "Analyzing locally · 1,204 sessions" as plain inline
 * text with a live region. This reuses that shape for the upload drain and
 * leaves the badge as the source-of-truth chip.
 *
 * Deliberately narrow about when it speaks:
 *
 *  - Only while the reader is still on Local. Once the cutover has happened the
 *    badge's own detail covers the catching-up case; a header banner there would
 *    be nagging about a view that is already the workspace.
 *  - Only for the two states that are genuinely "we are working on it". Offline
 *    and readiness-unknown are not progress, and a signed-out device has nothing
 *    to drain — a spinner-ish line for any of those would be a lie about work.
 *  - Never while the import is still being scanned: `ScanStatus` owns that phase
 *    and says the same thing better, so the two never stack in one row.
 */
export function DashboardCutoverStatus({
  analyzing,
  cutover: cutoverOverride,
}: {
  analyzing: boolean;
  /**
   * Story/test seam; overrides the `DesktopAppCoreProvider`-injected decision
   * (same convention as `agents-view.tsx`'s `dataSource`). This state only
   * exists during a live first-run sync drain, which is a narrow window to hit
   * in the running app, so the branch matrix needs to be drivable directly.
   */
  cutover?: CloudReadCutoverDecision;
}) {
  const injected = useDesktopCloudReadCutover();
  const cutover = cutoverOverride ?? injected;

  if (analyzing || cutover.mode !== DesktopAppCoreMode.Local) {
    return null;
  }
  if (
    cutover.blocker !== CloudReadCutoverBlocker.SyncDraining &&
    cutover.blocker !== CloudReadCutoverBlocker.SyncNotEstablished
  ) {
    return null;
  }

  return (
    <span
      aria-live="polite"
      className="inline-flex items-center gap-2 font-mono text-[var(--muted-foreground)] text-xs"
      data-testid="dashboard-cutover-status"
      role="status"
    >
      <span
        className="size-1.5 rounded-full bg-[var(--ai,var(--primary))]"
        style={{ animation: "ob-pulse 1.1s ease-in-out infinite" }}
      />
      Uploading history
      {/* The remainder refetches while the drain runs; keep it out of the live
          region so only the static "Uploading history" is announced, matching
          ScanStatus. A lane that cannot measure its own remainder reports null,
          and an unmeasured remainder is not a zero — so it says nothing rather
          than "0 to go". */}
      {cutover.itemsRemaining === null ? null : (
        <span aria-hidden="true">
          {" "}
          · {cutover.itemsRemaining.toLocaleString()} to go
        </span>
      )}
    </span>
  );
}
