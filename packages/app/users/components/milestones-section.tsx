"use client";

import type {
  UserMilestone,
  UserProfileMilestones,
} from "@repo/api/src/types/user";
import { Alert, AlertTitle } from "@repo/design-system/components/ui/alert";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import {
  FileTextIcon,
  GitMergeIcon,
  type LucideIcon,
  ZapIcon,
} from "lucide-react";
import {
  formatMilestoneEarned,
  MilestoneIcon,
  milestoneDetail,
  milestoneIcon,
  milestoneTitle,
} from "./milestone-display";

// FEA-4108: Milestones section — lifetime achievements the user has earned.
// Faithful to the profile prototype's Achievements list (flair.tsx). The whole
// section is gated on real data: it renders nothing when the user has earned no
// milestone, so the profile never shows a fabricated empty state. Each row uses
// the same plain-row treatment as the prototype (tone-tinted lucide icon, title,
// lifetime detail, earned month) — no icon-in-a-disc chip.

// One warm accent for milestone icons, from a design-system semantic token so
// it tracks the theme (no hardcoded colors), mirroring the prototype's milestone
// tone. Lifetime milestones share a single tone, so this is one token rather
// than a per-kind map that would be all the same value.
const MILESTONE_ICON_TONE = "text-primary";

const MILESTONE_ICON_COMPONENT: Record<MilestoneIcon, LucideIcon> = {
  [MilestoneIcon.GitMerge]: GitMergeIcon,
  [MilestoneIcon.FileText]: FileTextIcon,
  [MilestoneIcon.Zap]: ZapIcon,
};

type MilestonesSectionProps = {
  milestones: UserProfileMilestones | null;
  isLoading: boolean;
  isError: boolean;
};

export function MilestonesSection({
  milestones,
  isLoading,
  isError,
}: MilestonesSectionProps) {
  // Widget independence (FEA-4108): most users have earned no milestone, so
  // this section renders nothing for them. Staying quiet while the read is in
  // flight avoids promising an "Achievements" card + skeleton that then yanks
  // itself away once the query resolves to nothing. The section is optional by
  // design, so nothing is lost by waiting until there is real data to show.
  if (isLoading) {
    return null;
  }

  // A failing read surfaces an inline error rather than an infinite skeleton,
  // and never blocks the other profile widgets.
  if (isError) {
    return (
      <MilestonesShell>
        <Alert variant="error">
          <AlertTitle>Couldn't load milestones</AlertTitle>
        </Alert>
      </MilestonesShell>
    );
  }

  // Real-data gate: with no earned milestone there is nothing true to show, so
  // the whole section is hidden rather than rendering a fabricated empty state.
  const earned = milestones?.milestones ?? [];
  if (earned.length === 0) {
    return null;
  }

  return (
    <MilestonesShell>
      <MilestonesCard>
        <div className="divide-y divide-border">
          {earned.map((milestone) => (
            <AchievementRow
              key={`${milestone.kind}-${milestone.threshold}`}
              milestone={milestone}
            />
          ))}
        </div>
      </MilestonesCard>
    </MilestonesShell>
  );
}

function MilestonesShell({ children }: { children: React.ReactNode }) {
  return (
    <section aria-labelledby="milestones-heading" className="space-y-4">
      <div className="space-y-1">
        <h2
          className="font-semibold text-lg tracking-tight"
          id="milestones-heading"
        >
          Milestones
        </h2>
        <p className="text-muted-foreground text-sm">
          Lifetime milestones earned across all sessions
        </p>
      </div>
      {children}
    </section>
  );
}

function MilestonesCard({ children }: { children: React.ReactNode }) {
  // One card, one heading: the section's "Milestones" h2 above already titles
  // this list (mirroring how Activity's panel title sits above its card), so the
  // card carries no second, larger title. Capped near half the page so rows
  // scan as title/date pairs instead of stretching the full viewport.
  return (
    <Card className="min-w-0 max-w-2xl">
      <CardContent className="min-w-0 px-4 py-4 sm:px-6">
        {children}
      </CardContent>
    </Card>
  );
}

function AchievementRow({ milestone }: { milestone: UserMilestone }) {
  const Icon = MILESTONE_ICON_COMPONENT[milestoneIcon(milestone.kind)];
  const earnedLabel = formatMilestoneEarned(milestone.earnedAt);
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm">
          <Icon
            aria-hidden="true"
            className={cn("size-3.5 shrink-0", MILESTONE_ICON_TONE)}
          />
          <span className="truncate">{milestoneTitle(milestone)}</span>
        </p>
        <p className="text-muted-foreground text-xs">
          {milestoneDetail(milestone.kind)}
        </p>
      </div>
      {earnedLabel ? (
        <p className="shrink-0 text-muted-foreground text-xs">{earnedLabel}</p>
      ) : null}
    </div>
  );
}
