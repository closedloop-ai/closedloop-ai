"use client";

import type { LoopErrorCode, LoopStatus } from "@repo/api/src/types/loop";
import { LoopStatusBadge as SharedLoopStatusBadge } from "@repo/app/shared/components/status-badge";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";

/**
 * Loop status badge wired to the `ghost-loop-ux` feature flag. The remaining
 * status-badge primitives (DocumentStatusBadge, FeatureStatusBadge, the color
 * maps, etc.) are imported directly from
 * `@repo/app/shared/components/status-badge`.
 */
export function LoopStatusBadge({
  status,
  errorCode,
}: Readonly<{ status: LoopStatus; errorCode?: LoopErrorCode }>) {
  const ghostLoopUx = useFeatureFlagEnabled("ghost-loop-ux");
  return (
    <SharedLoopStatusBadge
      errorCode={errorCode}
      ghostLoopUx={ghostLoopUx}
      status={status}
    />
  );
}
