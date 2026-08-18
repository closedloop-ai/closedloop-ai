import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  isDisplayOnlySessionStatus,
  normalizeDisplayedSessionStatus,
  SESSION_STATUS,
} from "@repo/api/src/types/session-status";
// ISS-4848: the Zod-FREE constants leaf, NOT `desktop-transcripts`. That module
// imports `zod` on its first line, so the original import pulled Zod straight
// into the dashboard/insights/telemetry bundles that embed the Sessions table —
// the exact cost this module's "Zod-free" claim existed to avoid (#3449).
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import type { SessionTableRow } from "@repo/app/agents/components/sessions/sessions-table";
import { SessionSyncPresentation } from "@repo/app/agents/lib/session-sync-presentation";
import {
  agentSessionToSessionTableRow,
  resolveSessionRepoLabel,
  type SessionRowResolutionOptions,
} from "@repo/app/agents/lib/session-table-row";
import { SESSIONS_STATUS_COLUMN_ID } from "./sessions-table-columns";

/**
 * ISS-4774 / ISS-4847: the single derivation of the Sessions "sync-state fold" —
 * whether a row's still-uploading sync state is surfaced in the Status column
 * instead of as inline pills beside the Session Name.
 *
 * Extracted out of `synced-sessions-table.tsx` (ISS-4847) because the fold has
 * TWO adapters, not one: the shared `SyncedSessionsTable` (dashboard/telemetry
 * embeds + the desktop Sessions page) and the primary web `/sessions` table
 * (`apps/app/components/agent-sessions/sessions-table.tsx`). Those adapters had
 * drifted — the fold flag only reached the shared one, so turning the PostHog
 * flag on left the main web Sessions list unchanged. One exported predicate
 * means the two adapters cannot disagree about which rows fold.
 *
 * This module is deliberately React-free and Zod-free so both adapters (and the
 * bundle-sensitive embeds) can import it without pulling a component runtime in.
 */

/**
 * Whether a row's transcript is genuinely mid-upload — the ONE state that earns
 * the Status pill's pulse and its "still uploading to the cloud … syncs
 * automatically" tooltip (ISS-5279).
 *
 * ISS-4846: this reads `transcriptDisposition` directly rather than the wider
 * `cloudSyncState === "pending"` the original fold (#4202) used. That indirection
 * dropped verdicts, because `reconcileCloudSyncState` maps BOTH `syncing` and
 * `failedTransient` onto `pending`:
 *
 *  - A `failedTransient` row (an upload attempt FAILED and is being re-queued
 *    with backoff) folded, its inline "Sync failed" badge was suppressed, and it
 *    rendered the same calm blue "Syncing" pill as a healthy in-flight row. The
 *    retry verdict vanished — exactly the silent-drop the fold promised never to
 *    do for `stale`/`failedPermanent`.
 *  - A `pending` row carrying NO transcript verdict is "Local only" — not in the
 *    cloud AT ALL — which is a different fact from "the transcript is still
 *    uploading". #4150 deliberately split those two messages apart; folding both
 *    into one "Syncing" pill flattened them back together.
 *
 * Keying on the verdict itself keeps the pill's label, tone, and tooltip true of
 * every row it renders on. Every other disposition — and an absent one — keeps
 * its own inline badge instead.
 */
export function isSessionRowUploading(item: AgentSessionListItem): boolean {
  return item.transcriptDisposition === TranscriptDisposition.Syncing;
}

/**
 * ISS-4774 / ISS-4846: whether this row's sync state is folded into the Status
 * column. Two guards keep the fold honest:
 *
 * 1. The flag must be on and the row's transcript verdict must be `syncing`
 *    (see {@link isSessionRowUploading} for why the verdict, not `cloudSyncState`).
 * 2. The row's DISPLAYED run status must be `ACTIVE`. Sync state and run state
 *    answer two different questions, and the Status column has only ever carried
 *    the run state. Since ISS-5279 the treatment no longer REPLACES that
 *    outcome — the lifecycle word stays and only the presentation changes — but
 *    the Active-only rule holds for a different reason: a pulse reads as "this
 *    is still moving", which is truthful over a live run and misleading over a
 *    Failed or Inactive row whose outcome is settled. A non-Active uploading row
 *    keeps its inline sync badge instead (see the name-cell suppression in each
 *    adapter).
 *
 *    ISS-4846: this reads {@link normalizeDisplayedSessionStatus}, NOT
 *    `normalizeSessionStatus`. The latter collapses `waiting` into `active`, so
 *    the original predicate (#4202) folded awaiting-input rows despite its own
 *    docstring excluding them — and, while the pill still REPLACED the run
 *    status, that erased "Waiting" from the only column carrying it. The
 *    displayed vocabulary is also exactly what the Status facet offers and what
 *    the server-side Status sort ranks, so gating on it keeps the fold aligned
 *    with both.
 *
 *    wongk (#4324): the status this reads is the row's DISPLAYED one, passed in
 *    by the caller, NOT the raw stored column. With the honest-unknown flag on
 *    the mapper can turn a stale `active` row into "Stale", and judging the fold
 *    on the raw value then folded a row whose badge says the opposite — so the
 *    cell showed a pulsing "Stale" pill while the name cell dropped
 *    its inline sync disclosure, which is the one outcome this predicate's
 *    Active-only rule exists to prevent. `isDisplayOnlySessionStatus` is checked
 *    FIRST because `normalizeDisplayedSessionStatus` deliberately fail-opens the
 *    display-only members to `active`, so it alone would answer "running" for a
 *    row displaying "Stale".
 *
 * Every other transcript verdict — `stale`, `failedTransient`, `failedPermanent`,
 * `neverExpected`, or none at all — does NOT fold: it never pulses and it KEEPS
 * its inline disposition badge, so no verdict is silently dropped and none of
 * them is restated on the pill. See {@link resolveSessionSyncPresentation} for
 * why the pill's claim stops at "in flight".
 */
export function isSessionSyncStateFolded(
  item: AgentSessionListItem,
  foldActive: boolean,
  displayedStatus: string = item.status
): boolean {
  // ISS-5279: this predicate answers "is the Name cell's inline sync badge
  // suppressed for this row?", which is exactly the in-flight case it has
  // always been — a `stale` or `failed*` row still needs that badge, and it is
  // the only place those verdicts are stated now that the pill no longer
  // restates them.
  return (
    resolveSessionSyncPresentation(item, foldActive, displayedStatus) ===
    SessionSyncPresentation.Syncing
  );
}

/**
 * ISS-4848 (wongk): the fold is only honest while the Status column is actually
 * on screen.
 *
 * Both adapters let the user hide columns from the View menu. When Status is
 * hidden the grid never renders the Status cell, so a folded row's sync pill has
 * nowhere to live — and because the fold ALSO suppresses that row's inline
 * badge in the Name cell, an actively-uploading session ended up with no sync
 * signal anywhere in the grid. Gating the fold on Status visibility means
 * hiding the column simply hands sync state back to the Name cell, which is
 * where it lives with the flag off.
 *
 * `visibleColumns` is optional across the adapters and `undefined` means "no
 * column filter applied — everything is visible", so an absent set folds.
 */
export function isSyncStateFoldActive(visibleColumns?: Set<string>): boolean {
  return (
    visibleColumns === undefined ||
    visibleColumns.has(SESSIONS_STATUS_COLUMN_ID)
  );
}

/**
 * Map a cloud session row onto the shared presentational `SessionTableRow`,
 * marking it `syncing` when (and only when) {@link isSessionSyncStateFolded}
 * holds.
 *
 * ISS-4996 / ISS-4997 / ISS-4998 (gate retired by ISS-5366): the mapper always
 * carries the DISPLAYED status — an unrecognized run reads "Unknown" and a
 * long-silent one reads "Stale", two different facts that keep two different
 * words — and the reason a repository has no label. That is orthogonal to the
 * sync fold below.
 *
 * The sync fold's own `status` guarantee is unaffected: only the presentational
 * `syncPresentation` marker is added here. That matters for ISS-4846: `status` is the value the Status facet
 * filter (`session-status-filters.ts`) and the server-side Status column sort key
 * off, so no surface has to learn a "syncing" run-status value that the facet
 * vocabulary and the sort ranking do not have.
 *
 * ISS-5279 made that guarantee total: the DISPLAYED label no longer narrows to
 * "Syncing" either. The pill keeps its lifecycle word and THROBS, so the Status
 * column reads the same value the facet filtered on and the sort ranked — the
 * two label-level artifacts ISS-5036 recorded as the price of narrowing
 * ("filter Active, cell says Syncing"; "Active, Active, Syncing, Active" under a
 * Status sort) are both gone. The fold stays scoped to Active rows regardless:
 * "still uploading" is a truthful reading of an in-flight run, and painting the
 * treatment over a Failed row would imply the outcome is still moving.
 *
 * ISS-4998 / ISS-5366: the server-side half has LANDED, so the divergence this
 * note used to record is gone. Retiring `sessions-honest-unknown-states` made
 * the `stale`/`unknown` badges unconditional, which turned a contained
 * flag-gated gap into every user seeing a "Stale" row that the Status facet
 * bucketed as Active and offered no way to gather. Three things now read one
 * derivation: `projectDisplayedSessionStatus` (`apps/api`) delegates to the
 * shared `resolveDisplayedSessionStatus`, so the SERVED status carries the fold;
 * `buildStatusFacetPredicate` PARTITIONS the old Active population into Active
 * and Stale against the same cutoff (and matches Unknown by exclusion over
 * `RECOGNIZED_SESSION_STATUS_VALUES`); and `SessionStatusFacetValue` offers both
 * as options. The desktop-local `matchesStatusFilter` mirrors the same split.
 *
 * So the badge, the filter, and the sort no longer make three claims about one
 * row. If you add another display-only status, add its predicate and facet
 * option in the same change — that symmetry is the invariant here.
 */
export function toSessionTableRowWithSyncFold(
  item: AgentSessionListItem,
  foldActive: boolean,
  options: SessionRowResolutionOptions = {}
): SessionTableRow {
  const row = agentSessionToSessionTableRow(
    item,
    resolveSessionRepoLabel(item),
    options
  );
  // Judge the fold on the status the row will actually DISPLAY (wongk, #4324),
  // not the raw stored column — see `isSessionSyncStateFolded`.
  const syncPresentation = resolveSessionSyncPresentation(
    item,
    foldActive,
    row.status
  );
  if (syncPresentation) {
    return { ...row, syncPresentation };
  }
  return row;
}

/**
 * ISS-5279: the single derivation of a row's {@link SessionSyncPresentation},
 * or `undefined` when the Status pill says nothing about sync at all.
 *
 * Guarded identically to {@link isSessionSyncStateFolded} — same flag, same
 * display-only exclusion, same Active-only rule.
 *
 * The claim this makes is deliberately NARROW, and PR review is what narrowed
 * it. The pill marks an upload that is IN FLIGHT and says nothing about
 * transport for any other row: a `stale`, `failedTransient`, or
 * `failedPermanent` verdict yields `undefined` here, exactly like `synced`,
 * `neverExpected`, an unrecognized wire value, and no verdict at all. Those are
 * not the same fact, and the pill does not pretend to tell them apart — the Name
 * cell's inline disposition badge does, and this fold never suppresses it for a
 * row that is not uploading. An earlier revision marked the not-finished
 * verdicts on the pill as well; that both duplicated a badge already on the row
 * and, for `failedTransient`, contradicted `isTranscriptBlobBehind` in
 * `@repo/api` — the exported SSOT for "is an upload still coming", which counts
 * that verdict as still coming because the desktop re-queues it with backoff.
 */
export function resolveSessionSyncPresentation(
  item: AgentSessionListItem,
  foldActive: boolean,
  displayedStatus: string = item.status
): SessionSyncPresentation | undefined {
  // The fold still stands down when the Status column is off screen — there is
  // nowhere to render it, and the sync signal goes back to the Name cell rather
  // than being dropped from the grid. See `isSyncStateFoldActive`.
  if (!foldActive) {
    return undefined;
  }
  if (
    isDisplayOnlySessionStatus(displayedStatus) ||
    normalizeDisplayedSessionStatus(displayedStatus) !== SESSION_STATUS.ACTIVE
  ) {
    return undefined;
  }
  if (isSessionRowUploading(item)) {
    return SessionSyncPresentation.Syncing;
  }
  return undefined;
}
