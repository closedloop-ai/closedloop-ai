"use client";

import { SESSION_DETAIL_LOADING_SLOT } from "@repo/app/agents/lib/session-detail-slots";
import { ApiError } from "@repo/app/shared/api/api-error";
import { PageHeading } from "@repo/app/shared/components/page-heading";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Presentational loading / not-found / provider-error states for
 * AgentSessionDetailView, extracted out of the oversized detail body (FEA-3984)
 * so the states are testable in isolation and mirror the sibling
 * BranchDetailPage contract (NotPresent vs ProviderError).
 */

export const SessionDetailErrorKind = {
  NotPresent: "not-present",
  ProviderError: "provider-error",
} as const;
export type SessionDetailErrorKind =
  (typeof SessionDetailErrorKind)[keyof typeof SessionDetailErrorKind];

/**
 * Classify a session-detail read failure. A 404 (the missing, deleted, or
 * never-synced id both the HTTP and desktop local-DB sources reject with) is
 * NotPresent, a genuine "not found". Anything else (gateway down, db-host worker
 * died, 5xx) is a transient ProviderError we must not report as a missing
 * session. Mirrors `classifyBranchDetailError`.
 */
export function classifySessionDetailError(
  error: unknown
): SessionDetailErrorKind {
  if (error instanceof ApiError && error.isNotFound()) {
    return SessionDetailErrorKind.NotPresent;
  }
  return SessionDetailErrorKind.ProviderError;
}

export function SessionDetailLoading() {
  return (
    <div
      className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6"
      data-slot={SESSION_DETAIL_LOADING_SLOT}
    >
      <PageHeading>{SESSION_PAGE_HEADING}</PageHeading>
      <Skeleton
        aria-label={SESSION_LOADING_LABEL}
        aria-live="polite"
        className="h-[520px] w-full"
        role="status"
      />
    </div>
  );
}

/**
 * The accessible name of the pending session-detail read.
 *
 * The desktop route's Suspense fallback (`DetailRouteFallback`) already wraps
 * the IDENTICAL 520px slab in a polite live region named "Loading session", then
 * hands off to this component once the lazy chunk resolves. Until ISS-5593 this
 * side announced nothing, so the handoff read as "Loading session" → silence →
 * content arriving with no signal: two treatments of one state on one route.
 * Naming it here with the SAME string makes the swap continuous rather than a
 * gap.
 *
 * On the live region rather than a wrapper element deliberately — the skeleton's
 * geometry is load-bearing (it exists so the fallback→view swap moves nothing),
 * so this adds attributes to the existing node instead of a new one.
 *
 * The sibling `BranchDetailLoading` still has this gap. Left alone: it belongs
 * to the branches slice, which this Sessions-detail change does not otherwise
 * touch.
 */
const SESSION_LOADING_LABEL = "Loading session";

export function SessionDetailNotFound({ backHref }: { backHref: string }) {
  return (
    <SessionDetailStateShell>
      <EmptyState
        action={<BackToSessionsLink backHref={backHref} />}
        className="py-16"
        description="This session isn't in your history. It may have been deleted, or it hasn't synced yet."
        icon={AlertCircleIcon}
        title="Session not found"
      />
    </SessionDetailStateShell>
  );
}

export function SessionDetailProviderError({ backHref }: { backHref: string }) {
  return (
    <SessionDetailStateShell>
      <EmptyState
        action={<BackToSessionsLink backHref={backHref} />}
        className="py-16"
        description="This session couldn't be loaded right now. It still exists — refresh to try again."
        icon={AlertCircleIcon}
        title="Session unavailable"
      />
    </SessionDetailStateShell>
  );
}

function SessionDetailStateShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <PageHeading>{SESSION_PAGE_HEADING}</PageHeading>
      <div className="w-full">{children}</div>
    </div>
  );
}

/**
 * The route's page heading for every state that is not a loaded session.
 *
 * The route opts out of the app shell's own page heading because the loaded
 * detail owns a visible `<h1>` — but that `h1` sits below the loading and both
 * error early-returns, so on first load, on a 404, and on a provider outage the
 * page shipped no heading at all (ISS-5008 review). Naming the subject here
 * keeps the heading outline independent of the read succeeding; the specific
 * state is already the EmptyState's own title.
 */
const SESSION_PAGE_HEADING = "Session";

function BackToSessionsLink({ backHref }: { backHref: string }) {
  return (
    <Link className="sd3-back" href={backHref}>
      <ArrowLeftIcon aria-hidden className="size-3.5" />
      Back to Sessions
    </Link>
  );
}
