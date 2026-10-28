"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { TranscriptAvailability } from "@repo/api/src/types/desktop-transcripts";
import { SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY } from "@repo/api/src/types/session-transcript-never-expected-flag";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import {
  claudeReportedCost,
  costLabelIsFigure,
  deriveCostAvailability,
} from "@repo/app/agents/lib/cost-availability";
import { getSessionSyncStatus } from "@repo/app/agents/lib/session-sync-status";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import {
  SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY,
  SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY,
} from "@repo/app/shared/lib/feature-flags";
import { formatCost } from "@repo/app/shared/lib/format-utils";
import { LaunchThreadSource } from "@repo/lib/harness/launch-attribution";
import {
  HammerIcon,
  HashIcon,
  IdCardIcon,
  MessageSquareIcon,
  NetworkIcon,
  RefreshCcwIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { MAIN_TRANSCRIPT_FILE_KEY } from "../../lib/session-transcript-href";
import { PropertyValue } from "./property-values";
import { deriveCacheWriteTtlBreakdown } from "./session-cache-write-ttl";
import {
  extractSessionLaunchAttribution,
  formatAttributedSkill,
  formatPromptSource,
  LAUNCH_THREAD_SOURCE_LABELS,
  LAUNCH_THREAD_SOURCE_UNKNOWN_EXPLANATION,
  SESSION_LAUNCH_ATTRIBUTION_SKILL_LABEL,
} from "./session-launch-attribution-view";

/**
 * The self-gating rows of the session-detail Properties panel, split out of
 * `agent-session-detail-view.tsx` (file-size ceiling, AGENTS.md → "File Size and
 * Organization"). Each row owns its own presence check so
 * `SessionPropertiesExpanded` stays inside its cognitive-complexity budget and
 * so a new conditional row lands here rather than growing the view further.
 */

/**
 * FEA-3529: the per-session transcript sync-state row (gate retired by
 * ISS-5366, shipped ON). Its inputs (`transcriptDisposition` + `lastSyncedAt`)
 * already ride the contract (FEA-3479); when a version-skewed producer omits
 * both, this renders nothing rather than an empty labeled row, so the panel is
 * unchanged on an older peer.
 */
export function SessionSyncProperty({
  session,
  transcriptNeverExpected,
}: Readonly<{
  session: AgentSessionDetail;
  /** ISS-7516: see `SessionTranscriptPanel`'s prop of the same name. */
  transcriptNeverExpected?: boolean;
}>) {
  // The row states the verdict the shared hook derives; the ISS-7516 rationale
  // lives there, with the decision.
  const valueLabel = useSessionSyncValueLabel(session, transcriptNeverExpected);

  if (!valueLabel) {
    return null;
  }
  return (
    <PropertyValue icon={RefreshCcwIcon} label="Sync">
      {valueLabel}
    </PropertyValue>
  );
}

/**
 * The Sync verdict both surfaces speak, label or nothing.
 *
 * ISS-12269 moved Sync onto the Details tab of the new Session surface, so two
 * surfaces now state this verdict — the legacy page's Properties row and that
 * tab. Both read it here, which is what keeps the ISS-7516 correction below
 * from applying on one and not the other; and a caller deciding whether to draw
 * a row at all gets the real answer, not a flag-blind approximation of it.
 *
 * ISS-7516: the cloud folds a zero-row session to `syncing`, because it has
 * no representation of the source machine's data-sync level. When the shell
 * DOES know that level, this row must not go on reading "Syncing" about a
 * transcript the panel says is never coming — one record, one fact, two
 * opposite claims is the exact defect that ticket is about.
 *
 * It corrects that ONE false verdict and no other, because a data-sync level
 * is not retroactive. Sessions uploaded while this machine was on `full` keep
 * real archived bytes after the level changes to `metadata`, and their
 * `synced` / `stale` / failed dispositions are all still true of them —
 * `transcriptNeverExpected` describes the CURRENT tier, so overriding those
 * would print "No transcript" over a conversation that renders fine below.
 *
 * The override reuses `TranscriptDisposition.NeverExpected`, which already
 * carries a label ("No transcript"), a muted tone, and `attention: false` in
 * the shared fold. Nothing new is declared here, so the row cannot drift from
 * the vocabulary the list badge will speak the day a cloud producer can emit
 * that verdict.
 *
 * ISS-7516 (web half): the gate is the MAIN TRANSCRIPT BEING ABSENT, which is
 * the panel's own precondition (it swaps in the never-expected copy only under
 * `availability === Missing`), so the row and the panel now speak under the
 * same one rather than two that merely coincided. Gating on the cloud's
 * `syncing` disposition instead only LOOKS equivalent: it is the fold the
 * cloud applies to a zero-row session, so it agrees in the common case and
 * disagrees in both edge directions — it would state the verdict over a
 * transcript that demonstrably exists (a `metadata`-level session whose
 * transcript later uploaded, which is exactly what the panel's own remedy
 * tells the reader to make happen), and it would leave the row reading
 * "Synced" beside a panel saying the transcript is not coming whenever a
 * disposition and its file summary disagree. A level says what was QUEUED;
 * only the summary says what ARRIVED, and the row must not outrank it.
 */
export function useSessionSyncValueLabel(
  session: AgentSessionDetail,
  /** ISS-7516: see `SessionTranscriptPanel`'s prop of the same name. */
  transcriptNeverExpected?: boolean
): string | null {
  const neverExpectedDisclosureEnabled = useFeatureFlagEnabledOptional(
    SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY
  );
  const correctsFalseSyncingVerdict =
    neverExpectedDisclosureEnabled === true &&
    transcriptNeverExpected === true &&
    isMainTranscriptAbsent(session);
  const syncStatus = getSessionSyncStatus(
    correctsFalseSyncingVerdict
      ? {
          lastSyncedAt: session.lastSyncedAt,
          transcriptDisposition: TranscriptDisposition.NeverExpected,
          cloudSyncState: session.cloudSyncState,
        }
      : session
  );
  return syncStatus.valueLabel ?? null;
}

/**
 * ISS-7229: the Cost row's VALUE — our estimate, and Claude's own reported
 * figure beside it when there is one.
 *
 * ONE row, not two, and that is the whole point of this component. Until
 * ISS-7229 these were sibling `PropertyValue` rows, and `.prd-props` is a
 * multi-column `auto-fit` grid — so the two figures were INDEPENDENT grid items.
 * At two columns the estimate sat in the right column while "Claude reported"
 * landed in the LEFT column one line below, reading as a property of nothing.
 * Sharing one row is what makes that unrepresentable, rather than a width the
 * layout happens to survive.
 *
 * A session Claude reported nothing for renders the estimate ALONE, with no
 * source sub-label. Never `estimatedCost` under a label saying Claude reported
 * it; and never a lone "ClosedLoop estimate" qualifier, which would disambiguate
 * a figure from nothing on the MAJORITY of sessions. The sub-labels earn their
 * place only when there are two numbers to tell apart.
 *
 * A CAPTION NAMES A FIGURE, NEVER A DASH (davetho on #6980). Claude reporting
 * a cost does not make OUR side a number: `deriveSessionCostLabel` returns `—`
 * for every non-`Available`/`Subscription` availability, so an unpriced model
 * beside a reported Claude cost would have put "ClosedLoop estimate" under a
 * dash — presenting an unknown as an estimate, which is the exact rule this
 * component exists to hold. The pair still renders (Claude's figure is real and
 * dropping it would cost the reader a number we have), but the estimate's
 * caption is gated on the canonical {@link costLabelIsFigure} predicate, so the
 * dash stands unqualified.
 *
 * That absence is the common case, and for a reason worth stating: ISS-7229
 * sources this from Claude Code's OTel export, whose env is injected PER SPAWN
 * (`claude-code-env.ts`), so a session the desktop did not spawn exports
 * nothing. An earlier revision of this note blamed the `-p` stdout `result`
 * envelope, which was the rejected source, not the shipped one.
 *
 * Presence is {@link claudeReportedCost}'s explicit null/finite read, the same
 * one the Session Details host draws its Cost row from.
 */
export function SessionCostValue({
  estimate,
  session,
}: Readonly<{ estimate: ReactNode; session: AgentSessionDetail }>) {
  const enabled = useFeatureFlagEnabledOptional(
    SESSION_CLAUDE_REPORTED_COST_FEATURE_FLAG_KEY
  );
  const reported = claudeReportedCost(session);
  if (!(enabled && reported !== null)) {
    return estimate;
  }
  const estimateIsFigure = costLabelIsFigure(deriveCostAvailability(session));
  return (
    <span className="prd-cost-pair">
      <span className="prd-cost-figure">
        <span>{estimate}</span>
        {estimateIsFigure ? (
          <span className="prd-cost-source">ClosedLoop estimate</span>
        ) : null}
      </span>
      <span className="prd-cost-figure">
        <span>{formatCost(reported)}</span>
        <span className="prd-cost-source">Claude reported</span>
      </span>
    </span>
  );
}

/**
 * ISS-7259: the harness-stamped launch-attribution rows — how this thread came
 * to run, as the harness itself stated it.
 *
 * ONE component behind one gate, rendering up to four rows, because the two
 * harnesses state DISJOINT halves of the same question: Codex stamps genuine
 * spawn facts on `session_meta` (thread source, agent role, depth), Claude stamps
 * a per-turn skill and a prompt source and no spawn word at all. A session
 * therefore shows the Codex rows or the Claude rows, never both — and each row
 * self-gates on presence, so a harness that stated nothing renders nothing rather
 * than a column of em-dashes.
 *
 * The skill row is NOT a "launched by" row and its label says so; the reasoning
 * is on {@link SESSION_LAUNCH_ATTRIBUTION_SKILL_LABEL}.
 */
export function SessionLaunchAttributionProperties({
  session,
}: Readonly<{ session: AgentSessionDetail }>) {
  const enabled = useFeatureFlagEnabledOptional(
    SESSION_LAUNCH_ATTRIBUTION_FEATURE_FLAG_KEY
  );
  const attribution = extractSessionLaunchAttribution(session.metadata);
  if (!(enabled && attribution)) {
    return null;
  }
  const skill = formatAttributedSkill(attribution);
  return (
    <>
      {attribution.threadSource === null ? null : (
        <PropertyValue
          explanation={
            attribution.threadSource === LaunchThreadSource.Unknown
              ? LAUNCH_THREAD_SOURCE_UNKNOWN_EXPLANATION
              : undefined
          }
          icon={NetworkIcon}
          label="Thread"
        >
          {LAUNCH_THREAD_SOURCE_LABELS[attribution.threadSource]}
          {attribution.depth === null ? "" : ` (depth ${attribution.depth})`}
        </PropertyValue>
      )}
      {attribution.agentRole === null ? null : (
        <PropertyValue icon={IdCardIcon} label="Agent role" mono>
          {attribution.agentRole}
          {attribution.agentNickname === null
            ? ""
            : ` (${attribution.agentNickname})`}
        </PropertyValue>
      )}
      {skill === null ? null : (
        <PropertyValue
          explanation={skill.explanation}
          icon={HammerIcon}
          label={SESSION_LAUNCH_ATTRIBUTION_SKILL_LABEL}
          mono
        >
          {skill.value}
        </PropertyValue>
      )}
      {attribution.promptSource === null ? null : (
        <PropertyValue icon={MessageSquareIcon} label="Prompt source">
          {formatPromptSource(attribution.promptSource)}
        </PropertyValue>
      )}
    </>
  );
}

/**
 * FEA-3419: surfaces the cache-write TTL split (ephemeral 5-minute vs 1-hour
 * cache-creation tokens) derived from the TYPED per-model token usage — the
 * split's single source of truth on both surfaces (the FEA-3528 metadata-blob
 * reader is gone). Renders nothing when the session reports no subdivision.
 *
 * ISS-5820 retired the `sessions-cache-write-ttl` gate ON, so the row is now
 * unconditional on web and desktop, in dev and packaged builds alike. It stays
 * self-gating on presence: a session whose models reported no split (older
 * Claude sessions, Codex) renders nothing rather than a `0|0` line.
 */
export function CacheWriteTtlProperty({
  session,
}: Readonly<{ session: AgentSessionDetail }>) {
  const breakdown = deriveCacheWriteTtlBreakdown(session.tokenUsageByModel);
  if (!breakdown) {
    return null;
  }
  return (
    <PropertyValue icon={HashIcon} label="Cache Write" mono>
      {breakdown.ephemeral5mInputTokens.toLocaleString()} (5m TTL) |{" "}
      {breakdown.ephemeral1hInputTokens.toLocaleString()} (1h TTL)
    </PropertyValue>
  );
}

/**
 * ISS-7516 — whether the session's MAIN transcript is absent from the cloud.
 *
 * The gate on the never-expected Sync-row override, and it exists so that row
 * can never outrank the evidence beside it. A served data-sync level says what
 * the recording machine QUEUED; the transcript summary says what actually
 * ARRIVED, and the two disagree whenever a level is stale — most obviously
 * after a reader follows the panel's own remedy, switches to Full transcripts,
 * and the sweep uploads the very transcript the row would still be calling
 * absent.
 *
 * `Missing` is the exact state `SessionTranscriptPanel` renders the
 * never-expected copy under, so the row and the panel now speak under the same
 * precondition rather than two that merely coincided. A session carrying NO main
 * summary at all is also absent — the cloud synthesizes one today, so this is
 * the defensive arm rather than a reachable state.
 */
function isMainTranscriptAbsent(session: AgentSessionDetail): boolean {
  const main = session.transcripts?.find(
    (summary) => summary.fileKey === MAIN_TRANSCRIPT_FILE_KEY
  );
  return (
    main === undefined || main.availability === TranscriptAvailability.Missing
  );
}
