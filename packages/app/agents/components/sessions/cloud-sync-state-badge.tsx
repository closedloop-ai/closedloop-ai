import { AgentSessionCloudSyncState } from "@repo/api/src/types/agent-session-cloud-sync-state-constants";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";

/**
 * PRD-536 E6 (#3449 review): a DEDICATED per-row cloud-sync-state disclosure,
 * distinct from `ReadSourceBadge`. `ReadSourceBadge` means read-PROVENANCE
 * ("we read this row from the local store" — FEA-3120), and in desktop/local
 * mode EVERY row is read locally, so reusing its "Local" label to also mean
 * "still uploading to the cloud" conflated two separate concepts and left the
 * real meaning buried in a hover-only tooltip. This badge exists solely to
 * disclose that a row's cloud copy may be behind, with a visible label that
 * states the state rather than a bare "Local".
 *
 * ISS-4647: it now says WHICH copy is behind. Different gaps reach
 * `cloudSyncState: pending`, and the original "Local only" vocabulary only
 * described the first:
 *
 * - the whole session is still in the desktop sync outbox — it is genuinely not
 *   in the cloud yet ("Local only");
 * - the session IS in the cloud and only its raw transcript is still uploading
 *   ("Transcript still syncing"). Telling that user their session is "local only"
 *   is simply false — the row they are looking at was served FROM the cloud;
 * - the session IS in the cloud and the last transcript upload FAILED
 *   ("Transcript sync failed"). #4150: the detail transcript panel shows this row
 *   as a destructive "Transcript upload failed" with a Retry, so the list must not
 *   reuse the in-flight "syncs automatically" copy and tell the user to relax.
 *
 * The producer distinguishes them: it publishes `transcriptDisposition` only
 * when the row itself is in the cloud, so an in-flight/failed transcript verdict
 * on a pending row means the transcript is the only gap.
 *
 * Only a `pending` row renders anything — `synced`/absent rows render nothing,
 * so the table isn't a wall of redundant "synced" chips.
 *
 * Domain component (encodes the cloud-sync-state vocabulary), so it lives in the
 * agents feature slice and composes the generic design-system `ToneBadge` +
 * `Tooltip` — not a hand-rolled badge, no off-token colors. Presentational only
 * (no `window`/`localStorage`), so it renders identically in the web shell and
 * the Electron renderer.
 */

/** Which copy in the pending disclosure — see the module doc. */
export const CloudSyncDisclosure = {
  LocalOnly: "localOnly",
  TranscriptSyncing: "transcriptSyncing",
  TranscriptFailedTransient: "transcriptFailedTransient",
} as const;
export type CloudSyncDisclosure =
  (typeof CloudSyncDisclosure)[keyof typeof CloudSyncDisclosure];

type CloudSyncDisclosureCopy = {
  label: string;
  /** Screen-reader text is customer-facing — plain comma, no em dash (#3449). */
  ariaLabel: string;
  tooltip: string;
};

const DISCLOSURE_COPY: Record<CloudSyncDisclosure, CloudSyncDisclosureCopy> = {
  [CloudSyncDisclosure.LocalOnly]: {
    label: "Local only",
    ariaLabel: "Local only, not yet synced to cloud.",
    // ISS-4647 copy pass: "so the cloud copy may be behind" moved out — that is
    // the transcript variant's claim. A local-only row has no cloud copy to be
    // behind, so keeping it here made the label and the tooltip say two
    // different things about the same row. Tooltip no longer repeats the label
    // word-for-word (#4150 review) — it starts where the label left off.
    tooltip:
      "This session is still uploading to the cloud. It syncs automatically.",
  },
  [CloudSyncDisclosure.TranscriptSyncing]: {
    // Label matches the detail transcript panel's title for the same state
    // (`Transcript still syncing`, session-transcript-panel.tsx) so the list
    // chip, the detail Sync row, and the panel do not read as three different
    // states for one fact (#4150 review).
    label: "Transcript still syncing",
    // Names the correction the split exists for — the SESSION is in the cloud —
    // so a screen-reader user can tell the two pending states apart from the
    // announcement alone, not just from the label.
    ariaLabel:
      "Transcript still syncing, the session is in the cloud but its transcript is not yet.",
    // No "full" qualifier: nothing partial is readable while the blob uploads.
    // No label-word prefix — the hover starts where the label ran out (#4150).
    tooltip:
      "This session is in the cloud, but its transcript is still uploading. It syncs automatically.",
  },
  [CloudSyncDisclosure.TranscriptFailedTransient]: {
    // The last upload ATTEMPT failed. The list previously reused the in-flight
    // "syncs automatically" copy here, which told the user to relax while the
    // detail transcript panel showed "Transcript upload failed" in destructive
    // red with a Retry — the list and detail contradicted each other (#4150
    // review). This copy admits the failure while noting the retry, matching the
    // detail panel's `UploadFailed` wording without dropping the fact that the
    // desktop re-queues it.
    label: "Transcript sync failed",
    ariaLabel:
      "Transcript sync failed, the session is in the cloud but the last transcript upload failed and will retry.",
    tooltip:
      "This session is in the cloud, but the last transcript upload failed. It retries automatically.",
  },
};

export type CloudSyncStateBadgeProps = {
  /**
   * The per-row sync state. Only `pending` renders the badge; `synced`,
   * `undefined` (a version-skewed producer that omits the field), or any
   * unrecognized value render nothing rather than guessing a disclosure.
   */
  cloudSyncState: AgentSessionCloudSyncState | undefined;
  /**
   * The row's transcript verdict, when its producer computed one. An in-flight
   * verdict on a pending row scopes the copy to the transcript; anything else
   * (including a version-skewed producer that omits it) keeps the original
   * "Local only" wording, which is the safe reading when the gap is unknown.
   */
  transcriptDisposition?: TranscriptDisposition;
  className?: string;
};

export function CloudSyncStateBadge({
  cloudSyncState,
  transcriptDisposition,
  className,
}: CloudSyncStateBadgeProps) {
  if (cloudSyncState !== AgentSessionCloudSyncState.Pending) {
    return null;
  }
  const copy =
    DISCLOSURE_COPY[resolveCloudSyncDisclosure(transcriptDisposition)];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToneBadge
          aria-label={copy.ariaLabel}
          className={className}
          data-cloud-sync-state={cloudSyncState}
          data-testid="cloud-sync-state-badge"
          label={copy.label}
          tone="muted"
        />
      </TooltipTrigger>
      <TooltipContent>{copy.tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * ISS-4647 / #4150: which pending copy a row earns. The two dispositions that
 * mark the blob still-behind (`reconcileCloudSyncState` routes exactly these to
 * `pending`) each earn DISTINCT copy, because the detail transcript panel already
 * distinguishes them and the list must not contradict it:
 *
 * - `syncing` (the blob is still uploading) ⇒ "Transcript still syncing", the
 *   panel's in-flight wording — "syncs automatically" is honest here.
 * - `failedTransient` (the last upload ATTEMPT failed, desktop re-queues it) ⇒
 *   "Transcript sync failed". The panel shows this row as "Transcript upload
 *   failed" with a Retry, so a list chip claiming "syncs automatically" told the
 *   user to relax while the detail told them to act. This copy admits the failure
 *   while noting the retry.
 *
 * Every other value — a settled verdict, or none at all (the desktop-outbox case
 * or a version-skewed producer that omits the field) — falls back to the broader
 * "Local only" statement, the safe reading when the gap is the session itself or
 * is unknown.
 *
 * `reconcileCloudSyncState` and this switch read the SAME `TranscriptDisposition`
 * const. #4150 (wongk): the settled members are spelled out and the `default`
 * is a `never`-checked fallback for runtime-unknown strings ONLY — so a NEWLY
 * added "behind" disposition fails typecheck here (it is not in the `case`
 * arms) rather than silently compiling into "Local only" while
 * `reconcileCloudSyncState` reports `pending`. The two cannot drift.
 */
export function resolveCloudSyncDisclosure(
  transcriptDisposition: TranscriptDisposition | undefined
): CloudSyncDisclosure {
  if (transcriptDisposition === undefined) {
    return CloudSyncDisclosure.LocalOnly;
  }
  switch (transcriptDisposition) {
    case TranscriptDisposition.Syncing:
      return CloudSyncDisclosure.TranscriptSyncing;
    case TranscriptDisposition.FailedTransient:
      return CloudSyncDisclosure.TranscriptFailedTransient;
    case TranscriptDisposition.Synced:
    case TranscriptDisposition.Stale:
    case TranscriptDisposition.FailedPermanent:
    case TranscriptDisposition.NeverExpected:
      return CloudSyncDisclosure.LocalOnly;
    default: {
      // The `never` binding proves every KNOWN member above is handled; the
      // runtime fallback exists only for a wire-unknown/legacy string a newer
      // producer might emit, which degrades to the broad "Local only" statement.
      const _exhaustive: never = transcriptDisposition;
      return CloudSyncDisclosure.LocalOnly;
    }
  }
}

/**
 * ISS-4848: the SSOT for what we tell a user about a still-behind cloud copy.
 * Exported so the folded Sessions Status pill (`SessionStatusBadge`'s sync presentation) can
 * read the SAME sentence this chip and the detail transcript panel use rather
 * than keeping a second, contradicting copy of it. Before this, the folded list
 * pill said the SESSION was still uploading while this chip said the session was
 * in the cloud and only its transcript was behind — about the very same row,
 * since ISS-4846 narrowed the fold to `transcriptDisposition === syncing`.
 */
export function getCloudSyncDisclosureCopy(
  disclosure: CloudSyncDisclosure
): CloudSyncDisclosureCopy {
  return DISCLOSURE_COPY[disclosure];
}
