"use client";

import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  CloudSyncDisclosure,
  getCloudSyncDisclosureCopy,
} from "@repo/app/agents/components/sessions/cloud-sync-state-badge";
import {
  getSessionSyncStatus,
  type SessionSyncTone,
} from "@repo/app/agents/lib/session-sync-status";
// ISS-12529 (PR #8877 review): the upload-state tones live in shared/ so the
// upload queue view reads the same map; a slice may import shared/.
import {
  SESSION_UPLOAD_STATE_TONE,
  SessionUploadState,
} from "@repo/app/shared/lib/upload-state";
import { Button } from "@repo/design-system/components/ui/button";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { cn } from "@repo/design-system/lib/utils";
import { type ReactNode, useEffect, useRef } from "react";

/**
 * PRD-536 G1 (Phase 3): the per-session transcript freshness affordance on a
 * Sessions LIST row. Reuses the SSOT {@link getSessionSyncStatus} derivation
 * (never re-implementing the fold). Unconditional — ISS-5366 retired the
 * `sessions-transcript-sync-status` gate.
 *
 * It has no production render site today: ISS-5666 cleared the Name cell and
 * ISS-5770 deleted the `Signals` column that hosted it, so this currently
 * renders only in Storybook and its own tests. Restoring a host is a UI
 * decision for the Sessions surface, not a gate that can be flipped.
 *
 * On a dense list you show the exception, not the steady state: the healthy
 * `synced` verdict — and a freshness-only row whose `lastSyncedAt` on the cloud
 * list defaults to now() for effectively every row — would land a wall of grey
 * "Last synced …" strings in the primary name column, so the LIST renders ONLY
 * the attention verdicts (`stale` / `syncing` / `failed*`) as a colored
 * {@link ToneBadge}, saving ink for the rows that actually need a look. The
 * healthy "last synced" freshness stays in the detail Properties Sync row where
 * it already lives (design-critic, PR #3457). That keeps the list scannable and
 * gives the badge a single shape — the colored attention pill — rather than
 * inventing a nominal icon-plus-text treatment the detail never has.
 *
 * Renders nothing when the session carries no attention-worthy verdict
 * (nominal / freshness-only / no data), or when a version-skewed producer omits
 * both fields — the row is then unchanged, never an empty labeled affordance,
 * never a fabricated verdict for a row with no data.
 *
 * ISS-12532 extends the badge with a second form: pass `uploadState` (and its
 * copy) instead of `session` to show a session's upload state — see
 * {@link SessionUploadStateBadgeProps}. A `session` caller is unaffected.
 */
export function SessionSyncStatusBadge(
  props: SessionSyncStatusBadgeProps
): ReactNode {
  // ISS-12532: the upload-state form. Every existing caller passes `session`
  // only, so `uploadState` is undefined there and it takes the
  // transcript-verdict path below unchanged. (A value check, not `in`: both
  // union members declare the key now, so `in` would no longer narrow.)
  if (props.uploadState !== undefined) {
    return <SessionUploadStateBadge {...props} />;
  }
  const { session } = props;
  const verdict = resolveSessionSyncStatusVerdict(session);
  if (verdict === null) {
    return null;
  }

  const badge = (
    <ToneBadge
      className="shrink-0"
      data-testid="session-sync-status-badge"
      label={verdict.label}
      tone={verdict.tone}
    />
  );

  // ISS-5036: a still-uploading row's badge carries the SPECIFIC disclosure, not
  // just the bare vocabulary word.
  //
  // An uploading row carries the same fact twice — `transcriptDisposition ===
  // "syncing"` renders here, and `cloudSyncState === "pending"` renders a
  // `CloudSyncStateBadge` saying "Transcript still syncing". The Name cell
  // deduplicates them by dropping THIS badge and keeping the cloud chip (see
  // `disclosureNamesTheVerdict` in `useSessionRowQualifiers`), which is the right
  // way round: ISS-4647 / #4150 deliberately split "the session is not in the
  // cloud at all" (Local only) from "the session IS in the cloud, only its raw
  // transcript is behind", and it is the cloud chip that states which. Keeping
  // only this badge's bare `TRANSCRIPT_DISPOSITION_LABELS` word would have
  // narrowed the disclosure while removing the duplicate.
  //
  // This badge still renders wherever that dedupe is not in play — a
  // `stale`/`failedPermanent`/verdict-less row. Reading the tooltip from the canonical
  // `TranscriptSyncing` disclosure copy (the same source the Status pill's sync
  // presentation reads) keeps one sentence
  // behind all three surfaces, so whichever chip a row ends up showing says the
  // same thing.
  if (session.transcriptDisposition !== TranscriptDisposition.Syncing) {
    return badge;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{TRANSCRIPT_SYNCING_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}

const TRANSCRIPT_SYNCING_TOOLTIP = getCloudSyncDisclosureCopy(
  CloudSyncDisclosure.TranscriptSyncing
).tooltip;

/**
 * The verdict this badge renders, or `null` when it renders nothing, as a PURE
 * function of the row.
 *
 * ISS-5282 (review cids 3731452659 / 3731458698): the qualifier list has to be
 * derivable OUTSIDE a component. The Sessions card fallback drops a field whose
 * cell renders empty, and it decides that by inspecting the returned element —
 * so the qualifiers cell has to hand back the shared `GridEmptyValue` sentinel
 * ITSELF for a row with no qualifiers, not a component that will later render
 * one. That means the host has to know, before it renders anything, whether the
 * row has any qualifiers; a hook cannot answer that inside a per-row render
 * callback.
 *
 * Unconditional — ISS-5366 retired `sessions-transcript-sync-status`. ONE
 * derivation, so the badge and any future host cannot disagree about whether
 * this chip shows.
 */
export function resolveSessionSyncStatusVerdict(
  session: Pick<
    AgentSessionListItem,
    "lastSyncedAt" | "transcriptDisposition" | "transcriptDispositionReason"
  >
): { label: string; tone: SessionSyncTone } | null {
  const syncStatus = getSessionSyncStatus(session);
  // List rows surface only the attention verdicts (stale/syncing/failed*). A
  // nominal/synced or freshness-only row shows nothing here — that steady-state
  // freshness lives on the detail Properties Sync row, not on every list row.
  if (!(syncStatus.attention && syncStatus.dispositionLabel)) {
    return null;
  }
  return {
    label: syncStatus.dispositionLabel,
    tone: syncStatus.tone ?? "muted",
  };
}

type SessionTranscriptSyncBadgeProps = {
  session: Pick<
    AgentSessionListItem,
    "lastSyncedAt" | "transcriptDisposition" | "transcriptDispositionReason"
  >;
  /**
   * PR #8843 review: `never`, so the two forms are discriminated. Without it a
   * caller passing `session` and `uploadState` together typechecks against
   * this member and silently gets the upload form.
   */
  uploadState?: never;
};

/**
 * ISS-12532 (PRD-807): the upload-state form of this badge — whether ONE
 * session is local-only, uploading, shared, or failed to upload.
 *
 * The same badge, extended rather than duplicated: the same `ToneBadge` pill at
 * the same height, weight and type scale, chosen by passing `uploadState`
 * instead of `session`. The two forms answer different questions (is the
 * session in the cloud at all, versus is an uploaded transcript fresh), so they
 * never share a render — a host picks one per slot.
 *
 * Presentational only: the state, every string, and the retry handler come
 * from the host, and this component authors no copy (ISS-12532 ground rules).
 * No production host renders this form yet.
 */
export type SessionUploadStateBadgeProps = {
  /** The state's visible text. Supplied by the host. */
  label: string;
  className?: string;
  /** `never`: the upload form takes no session (see the transcript form). */
  session?: never;
} & (
  | {
      uploadState: Exclude<
        SessionUploadState,
        typeof SessionUploadState.Failed
      >;
    }
  | {
      uploadState: typeof SessionUploadState.Failed;
      /**
       * The failed state's retry path (AC-002). Required, so a failed badge
       * can never ship without a way out.
       */
      onRetry: () => void;
      /** The retry control's text. Supplied by the host. */
      retryLabel: string;
      /**
       * While a retry is in flight the control is disabled. The host flipping
       * this back to `false` is also what re-arms the retry latch (see
       * `UploadRetryButton`).
       */
      isRetrying?: boolean;
    }
);

export type SessionSyncStatusBadgeProps =
  | SessionTranscriptSyncBadgeProps
  | SessionUploadStateBadgeProps;

const UPLOAD_STATE_TONE: Record<SessionUploadState, SessionSyncTone> =
  SESSION_UPLOAD_STATE_TONE;

function SessionUploadStateBadge(props: SessionUploadStateBadgeProps) {
  const { uploadState, label, className } = props;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-2", className)}
      data-state={uploadState}
      data-testid="session-upload-state-badge"
    >
      {/* The dot pulses only while an upload is in flight; the pulse is
          decorative and stills under reduced motion, and the label carries the
          state either way. */}
      <ToneBadge
        label={label}
        pulse={uploadState === SessionUploadState.Uploading}
        tone={UPLOAD_STATE_TONE[uploadState]}
      />
      {props.uploadState === SessionUploadState.Failed ? (
        <UploadRetryButton
          isRetrying={props.isRetrying}
          label={props.retryLabel}
          onRetry={props.onRetry}
        />
      ) : null}
    </span>
  );
}

/**
 * PR #8843 review: the failed state's retry control, latched so one click
 * calls `onRetry` once.
 *
 * `isRetrying` comes from the host, so two fast clicks land before the host's
 * mutation can flip it, and both would call `onRetry`. Whether the upload
 * retry is idempotent server side is unknown (no upload-retry endpoint exists
 * yet), so the badge does not rely on it. Same one-outcome latch as the share
 * review sheet (ISS-12533, `endOnce`). It re-arms when the host reports the
 * retry settled (`isRetrying` is false again), and a state change away from
 * Failed unmounts this control, so a later failure starts unlatched.
 */
function UploadRetryButton({
  isRetrying,
  label,
  onRetry,
}: {
  isRetrying: boolean | undefined;
  label: string;
  onRetry: () => void;
}) {
  const latched = useRef(false);
  useEffect(() => {
    if (!isRetrying) {
      latched.current = false;
    }
  }, [isRetrying]);
  const retryOnce = () => {
    if (latched.current) {
      return;
    }
    latched.current = true;
    onRetry();
  };
  return (
    <Button
      disabled={isRetrying}
      onClick={retryOnce}
      size="sm"
      type="button"
      variant="outline"
    >
      {label}
    </Button>
  );
}
