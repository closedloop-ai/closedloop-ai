"use client";

import type { LoopStatus } from "@repo/api/src/types/loop";
import { LoopStatusBadge as SharedLoopStatusBadge } from "@repo/app/shared/components/status-badge";
import { useFeatureFlagEnabled } from "../../shared/feature-flags/use-feature-flag-enabled";

/**
 * Loop status badge wired to the `ghost-loop-ux` feature flag. The remaining
 * status-badge primitives (DocumentStatusBadge, IssueStatusBadge, the color
 * maps, etc.) are imported directly from
 * `@repo/app/shared/components/status-badge`.
 */
export function LoopStatusBadge({
  status,
  errorCode,
  // Open `string` to match `LoopError.code` on the wire -- see the note on the
  // shared badge for why this is deliberately not the closed union.
}: Readonly<{ status: LoopStatus; errorCode?: string }>) {
  const ghostLoopUx = useFeatureFlagEnabled("ghost-loop-ux");
  return (
    <SharedLoopStatusBadge
      errorCode={errorCode}
      ghostLoopUx={ghostLoopUx}
      status={status}
    />
  );
}
