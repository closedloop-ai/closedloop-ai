"use client";

import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { Link } from "@repo/navigation/link";
import { AlertCircleIcon, ArrowLeftIcon } from "lucide-react";
import { PageHeading } from "../../shared/components/page-heading";
import type { BranchBackLabel } from "../lib/branch-back-href";

/**
 * Presentational loading / not-found / provider-error states for
 * {@link BranchDetailPage}, extracted out of it (ISS-5008 review) so each one
 * is mountable on its own — the branch route's heading outline in those three
 * states is exactly what could not be asserted while they were module-private.
 * Mirrors the sibling `agent-session-detail-states` / `agent-detail-states`
 * split.
 */

export function BranchDetailLoading() {
  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
        <PageHeading>{BRANCH_PAGE_HEADING}</PageHeading>
        <Skeleton className="h-[520px] w-full" />
      </div>
    </div>
  );
}

/**
 * The route's page heading for every state that is not a loaded branch.
 *
 * The route sets `suppressPageHeading` because the loaded detail owns the
 * page's `<h1>` — but that heading sits below the loading and both error
 * early-returns, so those states shipped none (ISS-5008 review). This is the
 * same string the crumb falls back to when the branch name is not yet known.
 */
const BRANCH_PAGE_HEADING = "Branch";

export function BranchDetailNotFound({
  backHref,
  backLabel,
}: {
  backHref: string;
  backLabel: BranchBackLabel;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <PageHeading>{BRANCH_PAGE_HEADING}</PageHeading>
      <div className="w-full">
        <EmptyState
          className="py-16"
          description="The branch may not exist, or it has no captured sessions yet."
          icon={AlertCircleIcon}
          title="Branch not found"
        />
        <div className="mt-4 flex justify-center">
          <Link className="sd3-back" href={backHref}>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Back to {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}

export function BranchDetailProviderError({
  backHref,
  backLabel,
}: {
  backHref: string;
  backLabel: BranchBackLabel;
}) {
  return (
    <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
      <PageHeading>{BRANCH_PAGE_HEADING}</PageHeading>
      <div className="w-full">
        <EmptyState
          className="py-16"
          description="The branch provider could not be reached. Retry refresh, or check the provider connection."
          icon={AlertCircleIcon}
          title="Branch provider unavailable"
        />
        <div className="mt-4 flex justify-center">
          <Link className="sd3-back" href={backHref}>
            <ArrowLeftIcon aria-hidden className="size-3.5" />
            Back to {backLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
