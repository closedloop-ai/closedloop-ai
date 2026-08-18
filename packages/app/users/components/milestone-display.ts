import { MilestoneKind, type UserMilestone } from "@repo/api/src/types/user";
import { formatTokenCount } from "../../shared/lib/format-utils";

// FEA-4108: canonical display map for lifetime milestones. Kept in a lightweight
// module (no component runtime, no heavy parsers) so both the in-app Milestones
// section and any future public projection can read the same title/detail
// without duplicating the copy at each call site. The icon is a lucide icon
// NAME resolved by the rendering component, keeping this module presentation-
// agnostic.

export const MilestoneIcon = {
  GitMerge: "git-merge",
  FileText: "file-text",
  Zap: "zap",
} as const;
export type MilestoneIcon = (typeof MilestoneIcon)[keyof typeof MilestoneIcon];

type MilestoneDisplay = {
  /** Lucide icon name, resolved by the component. */
  icon: MilestoneIcon;
  /** Short lifetime-metric detail line (the same for every threshold). */
  detail: string;
  /** Format the crossed threshold into the milestone title. */
  formatTitle: (threshold: number) => string;
};

const MILESTONE_DISPLAY: Record<MilestoneKind, MilestoneDisplay> = {
  [MilestoneKind.PrsLanded]: {
    icon: MilestoneIcon.GitMerge,
    detail: "Lifetime merged pull requests",
    formatTitle: (threshold) => `${threshold.toLocaleString()} PRs landed`,
  },
  [MilestoneKind.DocumentsCreated]: {
    icon: MilestoneIcon.FileText,
    detail: "Lifetime documents created",
    formatTitle: (threshold) =>
      `${threshold.toLocaleString()} documents created`,
  },
  [MilestoneKind.TokensUsed]: {
    icon: MilestoneIcon.Zap,
    detail: "Lifetime tokens across all models",
    formatTitle: (threshold) => `${formatTokenCount(threshold)} tokens`,
  },
};

/** Resolve the icon name for a milestone kind. */
export function milestoneIcon(kind: MilestoneKind): MilestoneIcon {
  return MILESTONE_DISPLAY[kind].icon;
}

/** Resolve the lifetime-metric detail line for a milestone kind. */
export function milestoneDetail(kind: MilestoneKind): string {
  return MILESTONE_DISPLAY[kind].detail;
}

/** Build the milestone title (e.g. "500 PRs landed") from kind + threshold. */
export function milestoneTitle(milestone: UserMilestone): string {
  return MILESTONE_DISPLAY[milestone.kind].formatTitle(milestone.threshold);
}

/**
 * Short month-year label for when a milestone was earned (e.g. "Jun 2026").
 *
 * `earnedAt` is a `Date` at runtime (useApiClient revives the ISO wire string),
 * but this accepts a raw ISO string too for any non-revived caller. The label
 * is formatted in UTC: the server pins the crossing to a UTC instant, so
 * rendering in the viewer's local zone could shift a first-of-month timestamp
 * (2026-06-01T00:00:00Z) back into the previous month west of UTC.
 */
export function formatMilestoneEarned(earnedAt: Date | string): string {
  const date = earnedAt instanceof Date ? earnedAt : new Date(earnedAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
