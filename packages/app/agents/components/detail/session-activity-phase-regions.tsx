import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { SessionActivitySegments } from "../activity/session-activity-segments";
import { SessionActivityBreakdown } from "./session-activity-breakdown";

/**
 * ISS-5841 (supersedes FEA-3906): the two activity-phase regions on the Session
 * detail page, and the one gate over both.
 *
 * FEA-3705's strip ("when did each phase happen") and FEA-2275's breakdown
 * ("how much did each phase cost") are two views of the same phase model, so
 * they share one switch — showing either alone leaves the page half-committed
 * to a concept product is taking off it.
 *
 * Their own module rather than more lines inside `agent-session-detail-view.tsx`,
 * which is grandfathered shrink-only under the file-size ceiling — the same
 * reason `session-timeline-controls.tsx` lives beside it. Reads the key itself,
 * matching how every other gate in this view resolves.
 */
export function SessionActivityPhaseRegions({
  session,
}: Readonly<{ session: AgentSessionDetail }>) {
  const activityPhasesEnabled = useFeatureFlagEnabledOptional(
    SESSION_ACTIVITY_PHASES_FEATURE_FLAG_KEY
  );
  if (!activityPhasesEnabled) {
    return null;
  }
  return (
    <>
      <SessionActivitySegments
        rows={session.activitySegmentRows}
        rowsTruncated={session.activitySegmentRowsTruncated}
      />
      <SessionActivityBreakdown session={session} />
    </>
  );
}
