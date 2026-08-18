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
import { ToneBadge } from "@repo/design-system/components/ui/primitives/status-badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * PRD-536 G1 (Phase 3): the per-session transcript freshness affordance on a
 * Sessions LIST row. Reuses the SSOT {@link getSessionSyncStatus} derivation
 * (never re-implementing the fold). ISS-5366 retired the
 * `sessions-transcript-sync-status` gate this and the detail Properties Sync row
 * shared, so both now ship unconditionally.
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
 * Renders nothing when the flag is off, when the session carries no
 * attention-worthy verdict (nominal / freshness-only / no data), or when a
 * version-skewed producer omits both fields — the row is then unchanged, never
 * an empty labeled affordance, never a fabricated verdict for a row with no data.
 */
export function SessionSyncStatusBadge({
  session,
}: {
  session: Pick<AgentSessionListItem, "lastSyncedAt" | "transcriptDisposition">;
}): ReactNode {
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
 * ISS-5366 retired `sessions-transcript-sync-status` to its enabled state, so
 * this no longer takes a resolved flag and there is no hook wrapper left to keep
 * in step with it. ONE derivation — the badge, the row's qualifier list, and the
 * overflow counter cannot disagree about whether this chip shows.
 */
export function resolveSessionSyncStatusVerdict(
  session: Pick<AgentSessionListItem, "lastSyncedAt" | "transcriptDisposition">
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
