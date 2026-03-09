"use client";

import { analytics } from "@repo/analytics";
import type { EvaluationReportType } from "@repo/api/src/types/evaluation";
import type { PrTimelineRangeOption } from "@repo/api/src/types/judges-analytics";
import { useAuth } from "@repo/auth/client";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@repo/design-system/components/ui/tooltip";
import { InfoIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { usePrHealth } from "@/hooks/queries/use-judges-analytics";
import { formatDuration } from "@/lib/format-duration";
import { ApprovalDistributionChart } from "./approval-distribution-chart";

type PrActivitySectionProps = {
  promptName: string;
  rangeDays: PrTimelineRangeOption;
  reportType: EvaluationReportType;
};

export function PrActivitySection({
  promptName,
  rangeDays,
  reportType,
}: PrActivitySectionProps) {
  const { orgId, userId } = useAuth();
  const { data, isLoading, isError } = usePrHealth(
    promptName,
    reportType,
    rangeDays
  );
  const [tooltipOpen, setTooltipOpen] = useState(false);

  useEffect(() => {
    if (!data) {
      return;
    }
    analytics.capture("PR Activity Section Viewed", {
      organization_id: orgId,
      user_id: userId,
      judge_prompt_name: promptName,
      pr_count: data.totalPrs,
    });
  }, [data, orgId, userId, promptName]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <p className="text-muted-foreground text-sm">
        Unable to load PR activity data.
      </p>
    );
  }

  if (data.totalPrs === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No pull requests found for artifacts evaluated by this judge.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-lg">PR Activity</h2>
      <p className="text-muted-foreground text-sm">{data.confidenceNote}</p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Total PRs</p>
          <p className="font-semibold text-2xl">{data.totalPrs}</p>
        </div>
        <div className="space-y-1">
          <Tooltip
            onOpenChange={(open) => {
              setTooltipOpen(open);
              if (open) {
                analytics.capture("PR Health Metric Tooltip Viewed", {
                  organization_id: orgId,
                  user_id: userId,
                  judge_prompt_name: promptName,
                  metric: "comment_volume",
                });
              }
            }}
            open={tooltipOpen}
          >
            <TooltipTrigger asChild>
              <span className="flex cursor-pointer items-center gap-1">
                Avg comments/PR{" "}
                <InfoIcon className="h-3 w-3 text-muted-foreground" />
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                Includes all review comments and general PR comments on
                artifacts evaluated by this judge.
              </p>
            </TooltipContent>
          </Tooltip>
          <p className="font-semibold text-2xl">
            {data.avgCommentCount.toFixed(1)}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Avg time to approval</p>
          <p className="font-semibold text-2xl">
            {data.avgApprovalHours !== null
              ? formatDuration(data.avgApprovalHours)
              : "—"}
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-muted-foreground text-sm">Open PRs</p>
          <p className="font-semibold text-2xl">{data.openPrs}</p>
        </div>
      </div>
      <div className="space-y-2">
        <p className="font-medium text-muted-foreground text-sm">
          Time to approval distribution
        </p>
        <ApprovalDistributionChart distribution={data.approvalDistribution} />
      </div>
    </div>
  );
}
