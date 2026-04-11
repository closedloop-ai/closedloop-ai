"use client";

import { ArtifactType } from "@repo/api/src/types/artifact";
import { ChecksStatus, ReviewDecision } from "@repo/api/src/types/branch-view";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { BoxIcon, CheckCircle2, Clock, XCircle } from "lucide-react";
import Link from "next/link";
import { useCurrentUser } from "@/hooks/queries/use-users";
import { ARTIFACT_TYPE_ICONS } from "@/lib/project-constants";
import { getUserInitials } from "@/lib/user-utils";
import type { BranchViewData } from "../types";

const PlanIcon = ARTIFACT_TYPE_ICONS[ArtifactType.ImplementationPlan];

const PLAN_TITLE_PREFIX = "Implementation plan: ";

function formatPlanBadgeLabel(title: string | null): string {
  if (!title) {
    return "Plan";
  }
  const trimmed = title.trimStart();
  return trimmed.startsWith(PLAN_TITLE_PREFIX)
    ? trimmed.slice(PLAN_TITLE_PREFIX.length).trimStart()
    : trimmed;
}

type PrStatus =
  | "checks_failing"
  | "checks_pending"
  | "changes_requested"
  | "commented"
  | "review_required"
  | "approved"
  | "checks_passing";

function getPrStatus(
  reviewDecision: BranchViewData["reviewDecision"],
  checksStatus: BranchViewData["checksStatus"]
): PrStatus | null {
  if (checksStatus === ChecksStatus.Failing) {
    return "checks_failing";
  }
  if (checksStatus === ChecksStatus.Pending) {
    return "checks_pending";
  }
  if (reviewDecision === ReviewDecision.ChangesRequested) {
    return "changes_requested";
  }
  if (reviewDecision === null) {
    return "review_required";
  }
  if (reviewDecision === ReviewDecision.Approved) {
    return "approved";
  }
  if (reviewDecision === ReviewDecision.Commented) {
    return "commented";
  }
  if (checksStatus === ChecksStatus.Passing) {
    return "checks_passing";
  }
  return null;
}

const PR_STATUS_LABELS: Record<PrStatus, string> = {
  checks_failing: "Checks failing",
  checks_pending: "Checks pending",
  changes_requested: "Changes requested",
  commented: "Commented",
  review_required: "Review required",
  approved: "Approved",
  checks_passing: "Checks passing",
};

type BranchPropertiesBarProps = {
  data: BranchViewData;
};

/**
 * Metadata bar under the title. Design: Properties Inline -- only bottom border,
 * no outer box. Chips in order: plan (if linked), feature (link to issue), You (if author), one PR status (if PR). Same chip style: rounded 6px, bg, 1px border, py-1.5 px-2, gap-2, text 12px font-medium.
 */
export function BranchPropertiesBar({
  data,
}: Readonly<BranchPropertiesBarProps>) {
  const { data: currentUser } = useCurrentUser();
  const ownerInitials = currentUser
    ? getUserInitials(currentUser.firstName, currentUser.lastName) || "You"
    : "You";
  const prStatus = data.prState
    ? getPrStatus(data.reviewDecision, data.checksStatus)
    : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-border border-b py-3">
      {data.producedByPlanSlug ? (
        <Link
          className="inline-flex h-8 max-w-[240px] items-center gap-2 truncate rounded-md border border-border bg-background px-2 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent"
          href={`/implementation-plans/${data.producedByPlanSlug}`}
          title={data.producedByPlanTitle ?? undefined}
        >
          <PlanIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">
            {formatPlanBadgeLabel(data.producedByPlanTitle)}
          </span>
        </Link>
      ) : null}
      {data.featureSlug && data.featureTitle ? (
        <Link
          className="inline-flex h-8 max-w-[240px] items-center gap-2 truncate rounded-md border border-border bg-background px-2 py-1.5 font-medium text-foreground text-xs transition-colors hover:bg-accent"
          href={`/features/${data.featureSlug}`}
          title={data.featureTitle}
        >
          <BoxIcon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate">{data.featureTitle}</span>
        </Link>
      ) : null}
      {data.isAuthor ? (
        <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
          <Avatar className="h-4 w-4 shrink-0">
            {currentUser?.avatarUrl ? (
              <AvatarImage alt="You" src={currentUser.avatarUrl} />
            ) : null}
            <AvatarFallback className="text-[10px]">
              {ownerInitials}
            </AvatarFallback>
          </Avatar>
          <span className="font-medium text-foreground text-xs">You</span>
        </span>
      ) : null}
      {prStatus ? (
        <span className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5">
          <PrStatusIcon status={prStatus} />
          <span className="font-medium text-foreground text-xs">
            {PR_STATUS_LABELS[prStatus]}
          </span>
        </span>
      ) : null}
    </div>
  );
}

function PrStatusIcon({ status }: { status: PrStatus }) {
  if (status === "checks_failing" || status === "changes_requested") {
    return <XCircle className="h-4 w-4 text-destructive" />;
  }
  if (status === "approved" || status === "checks_passing") {
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  }
  return <Clock className="h-4 w-4 text-warning" />;
}
