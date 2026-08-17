import { Button } from "@repo/design-system/components/ui/button";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import type { LucideIcon } from "lucide-react";
import {
  FileWarningIcon,
  FileXIcon,
  LockIcon,
  LogInIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { TRACE_UNAVAILABLE_COPY, TraceUnavailableReason } from "../mock";

const REASON_ICON: Record<TraceUnavailableReason, LucideIcon> = {
  [TraceUnavailableReason.Authentication]: LogInIcon,
  [TraceUnavailableReason.Permission]: LockIcon,
  [TraceUnavailableReason.PageFailure]: TriangleAlertIcon,
  [TraceUnavailableReason.Malformed]: FileWarningIcon,
  // FileX, not a clock: legacy data is permanently unrenderable (and has no
  // retry), while a clock reads as "pending, check back later" — the opposite
  // of what the copy says.
  [TraceUnavailableReason.LegacyResponse]: FileXIcon,
  [TraceUnavailableReason.Unknown]: TriangleAlertIcon,
};

// The full-failure disclosure: the honest replacement for the empty timeline.
// It states the branch still has real sessions (so the count above is not a
// lie), then explains why their combined events couldn't load. The action is
// present only when acting can help: a primary "Sign in" CTA for an expired
// session (matching the sign-in page's default-variant Button treatment), an
// outline "Retry" for transient failures, nothing for permission/legacy
// failures that would fail again identically.
export function TraceUnavailableDisclosure({
  reason,
  sessionCount,
  onRetry,
}: {
  reason: TraceUnavailableReason;
  sessionCount: number;
  onRetry: () => void;
}) {
  const copy = TRACE_UNAVAILABLE_COPY[reason];
  const Icon = REASON_ICON[reason];
  const isSignIn = reason === TraceUnavailableReason.Authentication;
  // Per-reason flag (see the copy map): append the session-count
  // reconciliation so the header's total is explained, not contradicted —
  // skipped where the description already stands alone or already names the
  // branch's sessions.
  const description = copy.reconcileSessionCount
    ? `${copy.description} This branch has ${sessionCount} session${
        sessionCount === 1 ? "" : "s"
      } — only their combined timeline is unavailable.`
    : copy.description;

  return (
    // Border and surface ride on Empty itself (it already ships rounded-lg);
    // no wrapper re-declaring the radius. The disclosure is the only content
    // in the tab panel, so the title is a real heading (`titleAs`) — the DS
    // added it for exactly this case (WCAG 2.4.6).
    <EmptyState
      action={resolveAction(copy.retryLabel, isSignIn, onRetry)}
      className="border border-solid bg-card"
      description={description}
      icon={Icon}
      size="compact"
      title={copy.title}
      titleAs="h2"
    />
  );
}

function resolveAction(
  retryLabel: string | null,
  isSignIn: boolean,
  onRetry: () => void
) {
  if (!retryLabel) {
    return;
  }
  if (isSignIn) {
    // The sign-in CTA treatment: the default (primary) Button, same as the
    // sign-in page's card — not an outline retry with a refresh icon.
    return (
      <Button onClick={onRetry} type="button">
        {retryLabel}
      </Button>
    );
  }
  return (
    <Button onClick={onRetry} size="sm" type="button" variant="outline">
      <RefreshCwIcon aria-hidden />
      {retryLabel}
    </Button>
  );
}
