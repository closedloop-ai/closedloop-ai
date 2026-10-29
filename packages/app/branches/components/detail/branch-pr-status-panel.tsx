"use client";

import type { BranchPageDetail } from "@repo/api/src/types/branch";
import {
  isUnobservedPullRequest,
  observedPullRequestState,
} from "@repo/api/src/types/branch-associated-pull-request";
import type { ReviewDecision } from "@repo/api/src/types/branch-checks";
import { ReviewDecision as ReviewDecisionValue } from "@repo/api/src/types/branch-checks";
import {
  BranchSelectedPullRequestChecksAvailability,
  type BranchSelectedPullRequestChecksResponse,
  BranchSelectedPullRequestChecksSummary,
} from "@repo/api/src/types/branch-selected-pull-request-checks";
import {
  type BranchSelectedPullRequestChecksQuery,
  branchSelectedPullRequestChecksQueryForDetail,
} from "@repo/api/src/types/branch-selected-pull-request-files";
import {
  type SelectedPullRequestCheck,
  SelectedPullRequestCheckCategory,
} from "@repo/api/src/types/selected-pull-request-checks-evidence";
import { useFeatureFlagEnabledOptional } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Chip } from "@repo/design-system/components/ui/chip";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { ToneLabel } from "@repo/design-system/components/ui/tone-label";
import { ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import { useBranchSelectedPullRequestChecks } from "../../hooks/use-branch-selected-pull-request-checks";
import {
  deriveLifecycleBadge,
  type LifecycleBadge,
  LifecycleTone,
} from "../../lib/merge-status-derivation";
import { BranchPrMeasuredChecks } from "./branch-pr-measured-checks";
import { BranchPrStatusRow } from "./branch-pr-status-row";

export type BranchPrStatusPanelProps = {
  detail: BranchPageDetail;
};

const ToneVariant: Record<
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

/** Also the Details tab's Review decision row (ISS-12252). */
export const ReviewDecisionLabel: Record<ReviewDecision, string> = {
  [ReviewDecisionValue.Approved]: "Approved",
  [ReviewDecisionValue.ChangesRequested]: "Changes requested",
  [ReviewDecisionValue.Commented]: "Commented",
  [ReviewDecisionValue.Dismissed]: "Dismissed",
};

/** Lifecycle, review decision, and selected-head check evidence. */
export function BranchPrStatusPanel({ detail }: BranchPrStatusPanelProps) {
  const selected = detail.selectedPullRequest;
  if (!selected) {
    return null;
  }
  // ISS-8422, two mechanisms and one defect. `prState` must not be
  // `selected.state`: that is the placeholder OPEN an unobserved row reads off
  // its column default. And `status` must not be `detail.status` for such a row
  // either — this badge renders ONLY when a pull request is selected and is
  // presented as that pull request's lifecycle, while `persistedBadge` reads
  // `status` FIRST and `BranchPageDetail.status` is never null. So the
  // branch-level word ("Open" on web, "Draft" on desktop) printed as a confident
  // claim about a pull request nobody observed, inches from a box reading
  // "Unconfirmed", and the Gated "Status unavailable" tone that exists for
  // exactly this case was unreachable. Nulling both reaches it.
  const observedState = observedPullRequestState(selected);
  const badge = deriveLifecycleBadge({
    persisted: {
      prState: observedState,
      status: isUnobservedPullRequest(selected) ? null : detail.status,
    },
  });
  const reviewLabel = selected.reviewDecision
    ? ReviewDecisionLabel[selected.reviewDecision]
    : null;

  return (
    <section className="mt-2">
      <div className="bq-sec-head">
        <span className="bq-sec-title">Checks &amp; review</span>
        <span className="ml-auto">
          <LifecycleBadgeChip badge={badge} />
        </span>
      </div>
      <div className="flex flex-col gap-2 py-1">
        {reviewLabel ? (
          <BranchPrStatusRow label="Review" value={reviewLabel} />
        ) : null}
        <SelectedPullRequestChecks detail={detail} />
      </div>
    </section>
  );
}

/**
 * ISS-8241 Half A: which checks question this box answers.
 *
 * ON, the selected pull request's OWN measured projection. OFF, the live
 * provider read that shipped, byte-identical. The two never render together —
 * one box, one answer — so a reader is never shown a fresh number and a measured
 * one side by side with nothing to say which is the pull request's.
 */
function SelectedPullRequestChecks({ detail }: { detail: BranchPageDetail }) {
  const measured = useFeatureFlagEnabledOptional(
    BRANCH_DETAIL_MEASURED_CHECKS_FEATURE_FLAG_KEY
  );
  return measured ? (
    <BranchPrMeasuredChecks detail={detail} />
  ) : (
    <ChecksEvidence detail={detail} />
  );
}

/**
 * ISS-12278 (Marisol Ashgrove ruling, 2026-10-08, PRD-792 open question 2): checks
 * no longer ride inside the cloud detail read, so they load after it. A detail
 * that still carries them inline — the desktop local source, or an older
 * server — renders exactly that value.
 */
function ChecksEvidence({ detail }: { detail: BranchPageDetail }) {
  const inline = detail.selectedPullRequestChecks;
  if (inline) {
    return <ChecksEvidenceResponse response={inline} />;
  }
  const query = branchSelectedPullRequestChecksQueryForDetail(detail);
  return query ? (
    <LazyChecksEvidence branchId={detail.id} query={query} />
  ) : (
    <UnavailableChecks />
  );
}

function LazyChecksEvidence({
  branchId,
  query,
}: {
  branchId: string;
  query: BranchSelectedPullRequestChecksQuery;
}) {
  const checks = useBranchSelectedPullRequestChecks(branchId, query);
  if (checks.isPending) {
    return <LoadingChecks />;
  }
  return checks.data ? (
    <ChecksEvidenceResponse response={checks.data} />
  ) : (
    <UnavailableChecks />
  );
}

function ChecksEvidenceResponse({
  response,
}: {
  response: BranchSelectedPullRequestChecksResponse;
}) {
  const [open, setOpen] = useState(false);
  if (
    response.status === BranchSelectedPullRequestChecksAvailability.Unavailable
  ) {
    return <UnavailableChecks />;
  }
  const { value } = response;
  const incomplete =
    value.summary === BranchSelectedPullRequestChecksSummary.Partial;
  const summary = checksSummary(value.summary, value.counts, incomplete);
  const statusCounts = checkStatusCounts(value.checks);

  return (
    <div>
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <ChevronRightIcon
          aria-hidden
          className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="text-muted-foreground">Checks</span>
        <ToneLabel className="ml-auto tabular-nums" variant={summary.variant}>
          {summary.label}
        </ToneLabel>
      </button>
      <p className="mt-1 pl-5 text-muted-foreground text-xs">
        Passed {statusCounts.successful} · Failed {statusCounts.failing} ·
        Pending {statusCounts.pending} · Skipped {statusCounts.skipped} ·
        Canceled {statusCounts.canceled}
        {statusCounts.neutral > 0 ? ` · Neutral ${statusCounts.neutral}` : ""}
        {incomplete ? "*" : ""}
      </p>
      {open ? (
        <div className="mt-2 divide-y border-t">
          {value.checks.map((check) => (
            <div
              className="flex items-center gap-3 py-2 text-xs"
              key={check.sourceIdentity}
            >
              <span className="min-w-0 flex-1 truncate">{check.name}</span>
              <ToneLabel variant={checkTone(check.category)}>
                {checkLabel(check.category)}
              </ToneLabel>
              {check.targetUrl ? (
                <a
                  aria-label={`Open ${check.name} check`}
                  className="text-muted-foreground hover:text-foreground"
                  href={check.targetUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  <ExternalLinkIcon aria-hidden className="size-3.5" />
                </a>
              ) : null}
            </div>
          ))}
          {incomplete ? (
            <p className="py-2 text-muted-foreground text-xs">
              * {value.counts.providerReturned} of{" "}
              {value.counts.providerExpected} provider checks returned. Counts
              reflect the checks we could verify.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type CheckStatusCounts = {
  canceled: number;
  failing: number;
  neutral: number;
  pending: number;
  skipped: number;
  successful: number;
};

function checkStatusCounts(
  checks: readonly SelectedPullRequestCheck[]
): CheckStatusCounts {
  const counts: CheckStatusCounts = {
    canceled: 0,
    failing: 0,
    neutral: 0,
    pending: 0,
    skipped: 0,
    successful: 0,
  };
  for (const check of checks) {
    const conclusion = check.providerConclusion?.toLowerCase();
    if (conclusion === "skipped") {
      counts.skipped += 1;
    } else if (conclusion === "cancelled" || conclusion === "canceled") {
      counts.canceled += 1;
    } else {
      counts[check.category] += 1;
    }
  }
  return counts;
}

function LoadingChecks() {
  return (
    <BranchPrStatusRow
      label="Checks"
      value={<Skeleton className="inline-block h-4 w-16 align-middle" />}
    />
  );
}

function UnavailableChecks() {
  return (
    <BranchPrStatusRow
      label="Checks"
      value={<span className="text-muted-foreground">Unavailable</span>}
    />
  );
}

/** The pull request lifecycle chip; also the Details tab's Pull request row (ISS-12252). */
export function LifecycleBadgeChip({ badge }: { badge: LifecycleBadge }) {
  return (
    <Chip size="sm" variant={ToneVariant[badge.tone]}>
      {badge.label}
    </Chip>
  );
}

function checksSummary(
  summary: BranchSelectedPullRequestChecksSummary,
  counts: {
    failing: number;
    pending: number;
    successful: number;
    total: number;
  },
  incomplete: boolean
): { label: string; variant: "error" | "warning" | "success" | "default" } {
  const suffix = incomplete ? "*" : "";
  switch (summary) {
    case BranchSelectedPullRequestChecksSummary.Failing:
      return { label: `${counts.failing} failing`, variant: "error" };
    case BranchSelectedPullRequestChecksSummary.Pending:
      return { label: `${counts.pending} pending`, variant: "warning" };
    case BranchSelectedPullRequestChecksSummary.Successful:
      return {
        label: `${counts.successful}/${counts.total} passing`,
        variant: "success",
      };
    case BranchSelectedPullRequestChecksSummary.NotApplicable:
      return { label: "N/A", variant: "default" };
    case BranchSelectedPullRequestChecksSummary.Partial:
      return {
        label: `${counts.successful}/${counts.total} observed${suffix}`,
        variant: "default",
      };
    default:
      return assertNever(summary);
  }
}

function checkTone(
  category: SelectedPullRequestCheckCategory
): "error" | "warning" | "success" | "default" {
  switch (category) {
    case SelectedPullRequestCheckCategory.Failing:
      return "error";
    case SelectedPullRequestCheckCategory.Pending:
      return "warning";
    case SelectedPullRequestCheckCategory.Successful:
      return "success";
    case SelectedPullRequestCheckCategory.Neutral:
      return "default";
    default:
      return assertNever(category);
  }
}

function checkLabel(category: SelectedPullRequestCheckCategory): string {
  switch (category) {
    case SelectedPullRequestCheckCategory.Failing:
      return "Failed";
    case SelectedPullRequestCheckCategory.Pending:
      return "Pending";
    case SelectedPullRequestCheckCategory.Successful:
      return "Passed";
    case SelectedPullRequestCheckCategory.Neutral:
      return "Neutral";
    default:
      return assertNever(category);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled selected pull request check state: ${value}`);
}
