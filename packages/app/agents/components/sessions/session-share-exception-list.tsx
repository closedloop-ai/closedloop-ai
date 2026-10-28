"use client";

import { SessionSyncStatusBadge } from "@repo/app/agents/components/sessions/session-sync-status-badge";
import type { ShareAudience } from "@repo/app/shared/lib/share-audience";
import { SessionUploadState } from "@repo/app/shared/lib/upload-state";
import { Badge } from "@repo/design-system/components/ui/badge";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import { cn } from "@repo/design-system/lib/utils";
import { useId } from "react";

/**
 * ISS-12535 (PRD-807): which rule wins when a session shared as a one-off
 * exception lives in a directory the policy excludes.
 *
 * PRD-796 leaves this open. The prototype takes `ExceptionWins` (ISS-12535
 * thread th_wpRwGGsAXdk-RIqbzgatA, open to Marisol / Kaito overruling it): an
 * exception confirmed through the ISS-12533 share review sheet applies to that
 * one session, the row says it comes from an excluded directory, and the
 * exclusion still applies to every other session there.
 *
 * `ExclusionWins` is the other answer: the same row renders as blocked
 * instead. Flipping the ruling is this one value; the list's shape and data
 * do not change.
 */
export const ShareExceptionPrecedence = {
  ExceptionWins: "exception-wins",
  ExclusionWins: "exclusion-wins",
} as const;
export type ShareExceptionPrecedence =
  (typeof ShareExceptionPrecedence)[keyof typeof ShareExceptionPrecedence];

/** What one row shows once the precedence rule is applied (AC-003). */
export const ShareExceptionOutcome = {
  /** Not in an excluded directory: the rule does not come into it. */
  Applies: "applies",
  /** In an excluded directory, and the exception wins for this session. */
  AppliesDespiteExclusion: "applies-despite-exclusion",
  /** In an excluded directory, and the exclusion wins: the share is blocked. */
  BlockedByExclusion: "blocked-by-exclusion",
} as const;
export type ShareExceptionOutcome =
  (typeof ShareExceptionOutcome)[keyof typeof ShareExceptionOutcome];

/** One session shared as an exception to the default policy. */
export type SessionShareException = {
  /** Stable and unique across the list (the session id). */
  id: string;
  /** The session's name, as the host shows it elsewhere. */
  sessionName: string;
  /** Who the session was shared with, as confirmed on the share review sheet. */
  audience: ShareAudience;
  /** Where the session's upload stands (ISS-12532). */
  uploadState: SessionUploadState;
  /**
   * Set when the session lives in a directory the policy excludes. The label
   * is shown on the row so the interaction with the exclusion is visible.
   */
  excludedDirectory?: { id: string; label: string };
};

/**
 * Every visible string, all supplied by the host: this component authors no
 * copy (ISS-12535 ground rules). Proposed wording is on ISS-12535.
 */
export type SessionShareExceptionListCopy = {
  /** The list's heading, which also names the list. */
  heading: string;
  /** Shown instead of the list when no session is shared as an exception. */
  emptyText: string;
  /** The audience's visible name, one per audience. */
  audienceLabel: Record<ShareAudience, string>;
  /** The upload state's visible text, one per state (ISS-12532's badge). */
  uploadStateLabel: Record<SessionUploadState, string>;
  /** The failed state's retry control. */
  retryLabel: string;
  /** Marks a row whose session lives in an excluded directory. */
  excludedDirectoryLabel: string;
  /** The state shown, instead of the upload state, on a blocked row. */
  blockedLabel: string;
};

export type SessionShareExceptionListProps = {
  exceptions: readonly SessionShareException[];
  /**
   * The precedence ruling. Required, with no default: PRD-796 has not ruled,
   * and a default would make that product choice for any host that omits it.
   */
  precedence: ShareExceptionPrecedence;
  copy: SessionShareExceptionListCopy;
  /**
   * A failed row's retry. Required, as on the badge: a failed upload never
   * renders without a way out.
   */
  onRetryUpload: (exceptionId: string) => void;
  /** Rows whose retry is in flight; their retry control is disabled. */
  retryingIds?: readonly string[];
  className?: string;
};

/** AC-003: what a row shows under the precedence rule, as a pure function. */
export function resolveShareExceptionOutcome(
  exception: Pick<SessionShareException, "excludedDirectory">,
  precedence: ShareExceptionPrecedence
): ShareExceptionOutcome {
  if (!exception.excludedDirectory) {
    return ShareExceptionOutcome.Applies;
  }
  return precedence === ShareExceptionPrecedence.ExclusionWins
    ? ShareExceptionOutcome.BlockedByExclusion
    : ShareExceptionOutcome.AppliesDespiteExclusion;
}

/**
 * The one-session exceptions in the policy view (ISS-12535): a list of its own
 * under its own heading, apart from the default policy (AC-001). Each row
 * names the session, its audience and its upload state (AC-002), and a
 * session in an excluded directory is marked as such, or shown as blocked,
 * per `precedence` (AC-003).
 *
 * The upload state is the shipped `SessionSyncStatusBadge` upload form
 * (ISS-12532), retry included. A blocked row has no upload to describe, so it
 * shows the shared `ToneBadge` in its place, with the host's blocked label.
 *
 * Presentational only: the rows, every string and the retry handler come from
 * the host. No production host renders it: nothing records one-session
 * exceptions yet.
 */
export function SessionShareExceptionList({
  exceptions,
  precedence,
  copy,
  onRetryUpload,
  retryingIds = NO_IDS,
  className,
}: SessionShareExceptionListProps) {
  const headingId = useId();
  // Not a named region: the list carries the heading's name, and naming the
  // section too would make it a landmark and read the heading twice.
  return (
    <section
      className={cn("flex flex-col gap-2", className)}
      data-precedence={precedence}
      data-testid="session-share-exception-list"
    >
      {/* Not a heading element: the host owns the page outline. */}
      <p className="font-medium text-sm" id={headingId}>
        {copy.heading}
      </p>
      {exceptions.length === 0 ? (
        <p
          className="text-muted-foreground text-sm"
          data-testid="session-share-exception-list-empty"
        >
          {copy.emptyText}
        </p>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col divide-y">
          {exceptions.map((exception) => (
            <ShareExceptionRow
              copy={copy}
              exception={exception}
              isRetrying={retryingIds.includes(exception.id)}
              key={exception.id}
              onRetryUpload={onRetryUpload}
              outcome={resolveShareExceptionOutcome(exception, precedence)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ShareExceptionRow({
  exception,
  outcome,
  copy,
  onRetryUpload,
  isRetrying,
}: {
  exception: SessionShareException;
  outcome: ShareExceptionOutcome;
  copy: SessionShareExceptionListCopy;
  onRetryUpload: (exceptionId: string) => void;
  isRetrying: boolean;
}) {
  const { excludedDirectory } = exception;
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
      data-outcome={outcome}
      data-testid="session-share-exception-row"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm">{exception.sessionName}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          <span data-slot="share-exception-audience">
            {copy.audienceLabel[exception.audience]}
          </span>
          {excludedDirectory ? (
            <>
              {" "}
              <Badge data-slot="share-exception-excluded" variant="neutral">
                {copy.excludedDirectoryLabel}
              </Badge>{" "}
              <span
                className="truncate"
                data-slot="share-exception-excluded-directory"
              >
                {excludedDirectory.label}
              </span>
            </>
          ) : null}
        </span>
      </div>
      {outcome === ShareExceptionOutcome.BlockedByExclusion ? (
        <ToneBadge
          className="shrink-0"
          data-testid="session-share-exception-blocked"
          label={copy.blockedLabel}
          tone="warning"
        />
      ) : (
        <UploadStateCell
          copy={copy}
          exception={exception}
          isRetrying={isRetrying}
          onRetryUpload={onRetryUpload}
        />
      )}
    </li>
  );
}

function UploadStateCell({
  exception,
  copy,
  onRetryUpload,
  isRetrying,
}: {
  exception: SessionShareException;
  copy: SessionShareExceptionListCopy;
  onRetryUpload: (exceptionId: string) => void;
  isRetrying: boolean;
}) {
  const { uploadState } = exception;
  const label = copy.uploadStateLabel[uploadState];
  if (uploadState === SessionUploadState.Failed) {
    return (
      <SessionSyncStatusBadge
        isRetrying={isRetrying}
        label={label}
        onRetry={() => onRetryUpload(exception.id)}
        retryLabel={copy.retryLabel}
        uploadState={uploadState}
      />
    );
  }
  return <SessionSyncStatusBadge label={label} uploadState={uploadState} />;
}

const NO_IDS: readonly string[] = [];
