// The prototype review lifecycle. The sandbox registry (`apps/prototypes/lib/registry.ts`)
// aliases this const so its metas and the shared Prototypes preview read one vocabulary.
export const PrototypeStatus = {
  Draft: "draft",
  InProgress: "in-progress",
  ReadyForReview: "ready-for-review",
  HandedOff: "handed-off",
} as const;

export type PrototypeStatus =
  (typeof PrototypeStatus)[keyof typeof PrototypeStatus];
