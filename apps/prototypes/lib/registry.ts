import { PrototypeStatus as SharedPrototypeStatus } from "@repo/app/shell/v2/components/prototypes-preview/prototype-status";

export const PrototypeStatus = SharedPrototypeStatus;

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
  // Durable delivery intent, so a standalone `/design-review <slug>` run with no
  // PR or brief in scope has something to classify from. Required (ISS-10198):
  // an optional field meant every prototype silently read as unrecorded, which
  // left `production-bound-prototype-route.ts`'s `findLocalSurfaceTag` gate
  // permanently `NotEnforced` — it never once evaluated a real prototype.
  // `ProductionBound` is the only value a new meta may carry (ISS-10267):
  // `scripts/lint/production-bound-prototype-route.test.ts` enforces the
  // shared-surface rule on it, and refuses the retired `DisposableSketch`
  // rather than letting it opt out of that check.
  deliveryMode: PrototypeDeliveryMode;
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

export const PrototypeDeliveryMode = {
  // The sandbox route is a mock host of the canonical prop-driven shared surface
  // production will mount; the surface itself lives outside `app/p/<slug>/`.
  ProductionBound: "production-bound",
  // Retired by ISS-10267 and kept only so an existing meta still parses. A meta
  // declaring it is refused by the route gate and by the design critic; it is
  // not a mode to select.
  DisposableSketch: "disposable-sketch",
} as const;

export type PrototypeDeliveryMode =
  (typeof PrototypeDeliveryMode)[keyof typeof PrototypeDeliveryMode];
