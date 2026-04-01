"use client";

import type { FeatureWithWorkstream } from "@repo/api/src/types/feature";
import { isDisplayableSlug } from "@repo/api/src/types/slug";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Card } from "@repo/design-system/components/ui/card";
import { PriorityIcon } from "@repo/design-system/components/ui/priority-icon";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";
import { BoxIcon, CheckSquareIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { AssigneeAvatar } from "@/components/assignee-avatar";
import { EmptyState } from "@/components/empty-state";
import { useFeatures } from "@/hooks/queries/use-features";
import { FEATURE_STATUS_TO_ICON } from "@/lib/project-constants";
import type { MyTasksFeatureFilters } from "../types";
import {
  applyClientFilters,
  buildFeatureListParams,
  DISPLAY_GROUPS,
} from "../utils";

type MyTasksKanbanProps = {
  assigneeId: string | null;
  isUserLoading: boolean;
  featureFilters?: MyTasksFeatureFilters;
};

export function MyTasksKanban({
  assigneeId,
  isUserLoading,
  featureFilters,
}: Readonly<MyTasksKanbanProps>) {
  const listFilters = useMemo(
    () => buildFeatureListParams(assigneeId),
    [assigneeId]
  );
  const { data: rawFeatures = [], isLoading } = useFeatures(listFilters, {
    enabled: !!assigneeId && !isUserLoading,
  });
  const features = useMemo(
    () =>
      featureFilters
        ? applyClientFilters(rawFeatures, featureFilters)
        : rawFeatures,
    [rawFeatures, featureFilters]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, FeatureWithWorkstream[]>();
    for (const group of DISPLAY_GROUPS) {
      const items = features.filter((i: FeatureWithWorkstream) =>
        group.statuses.includes(i.status)
      );
      map.set(group.key, items);
    }
    return map;
  }, [features]);

  if (isUserLoading || (assigneeId && isLoading)) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        Loading...
      </div>
    );
  }

  if (!assigneeId) {
    return (
      <EmptyState
        description="Sign in to see your assigned tasks."
        icon={CheckSquareIcon}
        title="My Tasks"
      />
    );
  }

  if (features.length === 0) {
    return (
      <EmptyState
        description="Tasks assigned to you will appear here."
        icon={CheckSquareIcon}
        title="No assigned tasks"
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
      {DISPLAY_GROUPS.map((group) => {
        const items = grouped.get(group.key) ?? [];
        return (
          <KanbanColumn
            groupKey={group.key}
            groupLabel={group.label}
            items={items}
            key={group.key}
          />
        );
      })}
    </div>
  );
}

type KanbanColumnProps = {
  groupKey: string;
  groupLabel: string;
  items: FeatureWithWorkstream[];
};

function KanbanColumn({
  groupKey,
  groupLabel,
  items,
}: Readonly<KanbanColumnProps>) {
  return (
    <div
      className="flex flex-col rounded-lg border bg-muted/30"
      data-key={groupKey}
    >
      <div className="border-b px-2.5 py-1.5">
        <span className="font-medium text-sm">{groupLabel}</span>
        <span className="ml-1.5 text-muted-foreground text-sm">
          {items.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 p-1.5">
        {items.map((feature) => (
          <MyTasksCard feature={feature} key={feature.id} />
        ))}
      </div>
    </div>
  );
}

function KanbanCardContent({
  feature,
}: Readonly<{
  feature: FeatureWithWorkstream;
}>) {
  const workstreamOrProject =
    feature.workstream?.title ?? feature.project?.name ?? null;

  return (
    <div className="px-3 py-1">
      <div className="flex min-w-0 items-start gap-2">
        <BoxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1.5">
            {isDisplayableSlug(feature.slug) && (
              <span className="shrink-0 font-mono text-muted-foreground text-xs">
                {feature.slug}
              </span>
            )}
            <p className="min-w-0 truncate font-medium text-sm">
              {feature.title}
            </p>
          </div>
        </div>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0 shrink-0">
          {workstreamOrProject ? (
            <Badge
              className="rounded-md border-border px-2 py-1 font-normal text-muted-foreground"
              variant="outline"
            >
              {workstreamOrProject}
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex size-6 shrink-0 items-center justify-center">
            <PriorityIcon priority={feature.priority} size={14} />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <AssigneeAvatar
              assignee={feature.assignee}
              className="size-4 shrink-0"
            />
          </div>
          <div className="flex size-6 shrink-0 items-center justify-center">
            <StatusIcon
              size={16}
              status={FEATURE_STATUS_TO_ICON[feature.status]}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function MyTasksCard({
  feature,
}: Readonly<{ feature: FeatureWithWorkstream }>) {
  return (
    <Link href={`/features/${feature.slug}`}>
      <Card className="py-3 transition-colors hover:bg-accent/50">
        <KanbanCardContent feature={feature} />
      </Card>
    </Link>
  );
}
