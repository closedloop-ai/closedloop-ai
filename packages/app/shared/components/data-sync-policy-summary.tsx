"use client";

import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { findDataSyncLevelCopy } from "../lib/data-sync-copy";

/**
 * ISS-12525 AC-001: how many directories the policy covers. The count and its
 * label both come from the host: this component authors no new copy (PRD-806
 * ground rules), so pluralisation stays with whoever supplies the label.
 *
 * No desktop host passes it yet: there is no persisted per-directory scope
 * model to count (ISS-12688).
 *
 * `count` must be a non-negative safe integer. Anything else (NaN, Infinity,
 * -1, 2.5) is bad data from the host, and the row is dropped rather than
 * rendering it (packages/design-system/AGENTS.md: reject non-finite values at
 * a shared boundary before formatting). A host that has not computed the count
 * omits the prop: 0 reads as a real zero.
 */
export type DataSyncPolicySummaryDirectoryScope = {
  label: string;
  count: number;
};

/**
 * ISS-12525 AC-001: the machine and/or organization the policy applies to.
 * Either name may be absent; the row is dropped when both are.
 */
export type DataSyncPolicySummaryAppliesTo = {
  label: string;
  machineName?: string;
  orgName?: string;
};

export type DataSyncPolicySummaryProps = {
  level: DataSyncLevel | null;
  directoryScope?: DataSyncPolicySummaryDirectoryScope;
  appliesTo?: DataSyncPolicySummaryAppliesTo;
};

/**
 * The active policy summary (ISS-12523, extended by ISS-12525).
 *
 * With only `level`, it renders exactly what ISS-12523 shipped: the unset
 * message, or "Current level" and the level's badge label. `directoryScope`
 * and `appliesTo` each add one row beneath a saved level; hosts that pass
 * neither render unchanged. While the level is unset only the ISS-12523 unset
 * message renders, scope rows included: whether they show before a choice is
 * saved is an open product question on ISS-12525.
 */
export function DataSyncPolicySummary({
  level,
  directoryScope,
  appliesTo,
}: DataSyncPolicySummaryProps) {
  const levelRow = <LevelRow level={level} />;
  const machineName = appliesTo?.machineName?.trim() || undefined;
  const orgName = appliesTo?.orgName?.trim() || undefined;
  const showAppliesTo = Boolean(appliesTo && (machineName || orgName));
  const showDirectoryScope = Boolean(
    directoryScope && isDirectoryCount(directoryScope.count)
  );

  if (level === null || !(showDirectoryScope || showAppliesTo)) {
    return levelRow;
  }

  return (
    <div className="flex flex-col gap-1" data-testid="data-sync-policy-summary">
      {levelRow}
      {showDirectoryScope && directoryScope ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{directoryScope.label}</span>
          <span className="tabular-nums">{directoryScope.count}</span>
        </div>
      ) : null}
      {showAppliesTo ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{appliesTo?.label}</span>
          {machineName ? <span>{machineName}</span> : null}
          {machineName && orgName ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {orgName ? <span>{orgName}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function isDirectoryCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

/** ISS-12523 AC-002: an unanswered policy is not an explicit Off choice. */
function LevelRow({ level }: { level: DataSyncLevel | null }) {
  if (level === null) {
    return (
      <p className="text-muted-foreground text-sm">
        This device has not saved a sync choice yet. Choose a level below, then
        save it for this workspace.
      </p>
    );
  }
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Current level</span>
      <span>{findDataSyncLevelCopy(level).badgeLabel}</span>
    </div>
  );
}
