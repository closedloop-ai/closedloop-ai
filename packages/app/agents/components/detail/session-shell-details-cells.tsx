"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { DurationCell } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-cells";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { useSessionDurationValue } from "./values/session-duration-value";

/**
 * The Session Details rows whose value needs a hook (PLN-2169 M3). A config
 * row's `render` is a plain function, so the live clock and the flag read live
 * in these components and the host mounts them.
 */

/** Duration from the one clock the Properties row reads, in the shared cell. */
export function SessionDetailsDurationCell({
  session,
}: Readonly<{ session: AgentSessionDetail }>) {
  const discloseEvidence =
    useFeatureFlagEnabledOptional(
      SESSION_TIMELINE_COVERAGE_DISCLOSURE_FEATURE_FLAG_KEY
    ) === true;
  const { explanation, wallClock } = useSessionDurationValue({
    discloseEvidence,
    session,
  });
  if (wallClock === null) {
    return <GridEmptyValue />;
  }
  return <DurationCell evidence={explanation ?? ""} text={wallClock} />;
}
