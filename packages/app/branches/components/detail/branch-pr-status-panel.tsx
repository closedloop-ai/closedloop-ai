"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import type { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { ReviewDecision as ReviewDecisionEnum } from "@repo/api/src/types/branch-checks";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { useLivePrStatus } from "../../hooks/use-live-pr-status";
import {
  deriveLifecycleBadge,
  type LifecycleBadge,
  LifecycleTone,
} from "../../lib/live-overlays/merge-status-derivation";
import { applyStatusOverlay } from "../../lib/live-overlays/status-overlay-adapter";
import { ConnectGitHubIndicator } from "../connect-github-indicator";

/**
 * F2 — live merge + check status panel (Epic F / FEA-1952).
 *
 * Only rendered when a PR is linked. Reads live `reviewDecision` + approval/
 * changes-requested counts from the GitHub gateway (`/pr/reviews`) and patches
 * them over the persisted shape: the lifecycle badge refines to Approved /
 * Changes requested, and the approvals line lights up. Check status
 * (`statusCheckRollup`/`mergeStateStatus`) has no gateway producer yet, so it
 * reads "not available yet"; Behind/Ahead likewise have no v1 producer.
 *
 * Degrades to a connect-GitHub affordance (with the PERSISTED lifecycle badge
 * still shown) when not connected, when there is no clean owner/name identity,
 * or when multiple PRs are linked (ambiguous attribution) — never a thrown error
 * and never a fabricated review state.
 */

export type BranchPrStatusPanelProps = {
  detail: BranchPageDetail;
  allowLive?: boolean;
  connectHref?: string;
  onConnect?: () => void;
};

const TONE_VARIANT: Record<
  LifecycleTone,
  "info" | "accent" | "success" | "muted" | "destructive"
> = {
  [LifecycleTone.Open]: "info",
  [LifecycleTone.Review]: "accent",
  [LifecycleTone.Merged]: "success",
  [LifecycleTone.Draft]: "muted",
  [LifecycleTone.Blocked]: "destructive",
  [LifecycleTone.Closed]: "muted",
  [LifecycleTone.Gated]: "muted",
};

function LifecycleBadgeChip({ badge }: { badge: LifecycleBadge }) {
  return (
    <Chip size="sm" variant={TONE_VARIANT[badge.tone]}>
      {badge.label}
    </Chip>
  );
}

const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
  [ReviewDecisionEnum.Approved]: "Approved",
  [ReviewDecisionEnum.ChangesRequested]: "Changes requested",
  [ReviewDecisionEnum.Commented]: "Commented",
  [ReviewDecisionEnum.Dismissed]: "Dismissed",
};

function approvalsText(input: {
  approvalCount: number | null;
  changesRequestedCount: number | null;
}): string {
  const approvals = input.approvalCount ?? 0;
  const changes = input.changesRequestedCount ?? 0;
  const parts = [`${approvals} approval${approvals === 1 ? "" : "s"}`];
  if (changes > 0) {
    parts.push(`${changes} change request${changes === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

export function BranchPrStatusPanel({
  detail,
  allowLive = true,
  connectHref,
  onConnect,
}: BranchPrStatusPanelProps) {
  const liveStatus = useLivePrStatus(
    allowLive
      ? {
          repoFullName: detail.repoFullName,
          prUrl: detail.prUrl,
          prNumber: detail.prNumber,
          multiPrWarning: detail.multiPrWarning,
        }
      : {
          repoFullName: null,
          prUrl: null,
          prNumber: null,
          multiPrWarning: true,
        }
  );
  const data = allowLive ? liveStatus.data : null;
  const isLoading = allowLive ? liveStatus.isLoading : false;
  const reason = allowLive ? liveStatus.reason : null;

  // No PR → no PR status block (the branch status lives in Properties).
  if (detail.prNumber == null) {
    return null;
  }

  const overlay = applyStatusOverlay(
    {
      checksStatus: detail.checksStatus,
      checksPassed: detail.checksPassed,
      checksTotal: detail.checksTotal,
      reviewDecision: detail.reviewDecision,
    },
    data
  );
  const badge = deriveLifecycleBadge({
    persisted: { prState: detail.prState, status: detail.status },
    live: data,
  });
  const checksValue =
    overlay.checksTotal == null
      ? "Not available yet"
      : `${overlay.checksPassed ?? 0}/${overlay.checksTotal} passing`;
  // Persisted review/check fallback (shown when live is unavailable). Both have
  // no v1 producer (enrichment-gated null), so this renders nothing today and
  // lights up when enrichment lands.
  const persistedReviewLabel =
    overlay.reviewDecision == null
      ? null
      : REVIEW_DECISION_LABEL[overlay.reviewDecision];

  return (
    <section className="mt-2">
      <div className="bq-sec-head">
        <span className="bq-sec-title">Checks &amp; review</span>
        <span className="ml-auto">
          <LifecycleBadgeChip badge={badge} />
        </span>
      </div>
      {renderBody({
        connected: overlay.connected,
        isLoading,
        multiPr: detail.multiPrWarning,
        reason,
        approvals: approvalsText(overlay),
        checksValue,
        persistedReviewLabel,
        hasPersistedChecks: overlay.checksTotal != null,
        liveDisabled: !allowLive,
        connectHref,
        onConnect,
      })}
    </section>
  );
}

function renderBody({
  connected,
  isLoading,
  multiPr,
  reason,
  approvals,
  checksValue,
  persistedReviewLabel,
  hasPersistedChecks,
  liveDisabled,
  connectHref,
  onConnect,
}: {
  connected: boolean;
  isLoading: boolean;
  multiPr: boolean;
  reason: unknown;
  approvals: string;
  checksValue: string;
  persistedReviewLabel: string | null;
  hasPersistedChecks: boolean;
  liveDisabled: boolean;
  connectHref?: string;
  onConnect?: () => void;
}) {
  if (connected) {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        <StatusRow label="Review" value={approvals} />
        <StatusRow label="Checks" value={checksValue} />
        <StatusRow label="Behind / ahead" value="Not available yet" />
      </div>
    );
  }
  if (isLoading && reason === null) {
    return (
      <div className="flex flex-col gap-1.5 py-1">
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-1/3" />
      </div>
    );
  }
  // Live unavailable: still render any PERSISTED review/check values (none in v1,
  // populated once enrichment lands), then the gating affordance.
  const persistedRows =
    persistedReviewLabel || hasPersistedChecks ? (
      <div className="flex flex-col gap-1.5">
        {persistedReviewLabel ? (
          <StatusRow label="Review" value={persistedReviewLabel} />
        ) : null}
        {hasPersistedChecks ? (
          <StatusRow label="Checks" value={checksValue} />
        ) : null}
      </div>
    ) : null;
  if (liveDisabled) {
    return (
      <div className="flex flex-col gap-2 py-1">
        {persistedRows}
        {persistedRows ? null : (
          <p className="text-muted-foreground text-xs">
            Cloud GitHub data has not synced review or check status yet.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 py-1">
      {persistedRows}
      <p className="text-muted-foreground text-xs">
        {multiPr
          ? "Multiple PRs are linked — live review status is ambiguous and not shown."
          : "Connect GitHub to see live review and check status."}
      </p>
      {multiPr ? null : (
        <ConnectGitHubIndicator
          compact
          connectHref={connectHref}
          onConnect={onConnect}
        />
      )}
    </div>
  );
}
