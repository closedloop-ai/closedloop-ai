"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  FlameIcon,
  GitMergeIcon,
  type LucideIcon,
  TrophyIcon,
  ZapIcon,
} from "lucide-react";
import { type Badge as BadgeData, BadgeIcon, BadgeTone } from "../mock";

// Shared badge presentation for the profile prototype. Both the in-app
// Achievements list (flair.tsx) and the public share card (public-share-page.tsx)
// render the same milestone badges, so the icon and tone maps live here once
// instead of being copied into each surface.

const BADGE_ICONS: Record<BadgeIcon, LucideIcon> = {
  [BadgeIcon.Flame]: FlameIcon,
  [BadgeIcon.Trophy]: TrophyIcon,
  [BadgeIcon.Zap]: ZapIcon,
  [BadgeIcon.GitMerge]: GitMergeIcon,
};

// Tone-to-token map. One warm accent per tone, pulled from design-system
// semantic tokens so it tracks the theme (no hardcoded colors).
const TONE_TEXT_CLASS: Record<BadgeTone, string> = {
  [BadgeTone.Gold]: "text-warning-foreground",
  [BadgeTone.Streak]: "text-destructive",
  [BadgeTone.Milestone]: "text-primary",
};

// A single inline badge pill: tone-tinted icon at the head, then the title.
// Matches the public-card treatment (inline icon, no icon-in-a-disc chip).
export function BadgeChip({ badge }: { badge: BadgeData }) {
  const Icon = BADGE_ICONS[badge.icon];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-xs">
      <Icon
        aria-hidden="true"
        className={cn("size-3.5", TONE_TEXT_CLASS[badge.tone])}
      />
      {badge.title}
    </span>
  );
}

export { BADGE_ICONS, TONE_TEXT_CLASS };
