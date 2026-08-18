"use client";

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { getSessionSyncStatus } from "@repo/app/agents/lib/session-sync-status";
import { HashIcon, RefreshCcwIcon } from "lucide-react";
import { deriveCacheWriteTtlBreakdown } from "./detail-content";
import { PropertyValue } from "./property-values";

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
}: Readonly<{ session: AgentSessionDetail }>) {
  const syncStatus = getSessionSyncStatus(session);
  if (!syncStatus.valueLabel) {
    return null;
  }
  return (
    <PropertyValue icon={RefreshCcwIcon} label="Sync">
      {syncStatus.valueLabel}
    </PropertyValue>
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
