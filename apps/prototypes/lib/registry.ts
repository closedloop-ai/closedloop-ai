export const PrototypeStatus = {
  Draft: "draft",
  InProgress: "in-progress",
  ReadyForReview: "ready-for-review",
  HandedOff: "handed-off",
} as const;

export type PrototypeStatus =
  (typeof PrototypeStatus)[keyof typeof PrototypeStatus];

export const PrototypeTag = {
  UiKit: "ui-kit",
  Master: "master",
  Feature: "feature",
  BugFix: "bug-fix",
} as const;

export type PrototypeTag = (typeof PrototypeTag)[keyof typeof PrototypeTag];

export type PrototypeMeta = {
  slug: string;
  title: string;
  summary: string;
  author: string;
  status: PrototypeStatus;
  tags: readonly PrototypeTag[];
  createdAt: string;
  linearIssue: string | null;
  closedloopDoc: string | null;
};

export const prototypeStatusLabel: Record<PrototypeStatus, string> = {
  [PrototypeStatus.Draft]: "Draft",
  [PrototypeStatus.InProgress]: "In progress",
  [PrototypeStatus.ReadyForReview]: "Ready for review",
  [PrototypeStatus.HandedOff]: "Handed off",
};

// Display order for the gallery status filter submenu.
export const prototypeStatusOrder: readonly PrototypeStatus[] = [
  PrototypeStatus.Draft,
  PrototypeStatus.InProgress,
  PrototypeStatus.ReadyForReview,
  PrototypeStatus.HandedOff,
];

export const prototypeTagLabel: Record<PrototypeTag, string> = {
  [PrototypeTag.UiKit]: "UI Kit",
  [PrototypeTag.Master]: "Master",
  [PrototypeTag.Feature]: "Feature",
  [PrototypeTag.BugFix]: "Bug Fix",
};

// Display order for the gallery filter toggle group.
export const prototypeTagOrder: readonly PrototypeTag[] = [
  PrototypeTag.UiKit,
  PrototypeTag.Master,
  PrototypeTag.Feature,
  PrototypeTag.BugFix,
];
