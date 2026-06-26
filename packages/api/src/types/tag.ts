import type { BasicUser } from "./user.js";

export const TagColor = {
  Red: "red",
  Rose: "rose",
  Orange: "orange",
  Amber: "amber",
  Yellow: "yellow",
  Lime: "lime",
  Green: "green",
  Emerald: "emerald",
  Teal: "teal",
  Cyan: "cyan",
  Sky: "sky",
  Blue: "blue",
  Indigo: "indigo",
  Violet: "violet",
  Purple: "purple",
  Pink: "pink",
} as const;
export type TagColor = (typeof TagColor)[keyof typeof TagColor];

export const TAG_COLORS: TagColor[] = Object.values(TagColor);

export const TagEntityType = {
  Project: "PROJECT",
  Artifact: "ARTIFACT",
  Loop: "LOOP",
} as const;
export type TagEntityType = (typeof TagEntityType)[keyof typeof TagEntityType];

export type TagSummary = {
  id: string;
  name: string;
  color: TagColor;
};

export type Tag = {
  id: string;
  organizationId: string;
  name: string;
  color: TagColor;
  createdById: string;
  createdBy?: BasicUser;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateTagInput = {
  name: string;
  color?: TagColor;
};

export type UpdateTagInput = {
  name?: string;
  color?: TagColor;
};

export type ApplyTagInput = {
  tagId: string;
  entityType: TagEntityType;
  entityId: string;
};

/**
 * Batch apply is artifact-only: `tagService.batchApplyTag` writes `tagArtifact`
 * rows exclusively, so the contract is narrowed to `TagEntityType.Artifact`
 * rather than the full `TagEntityType` union (which would let a caller send
 * `PROJECT`/`LOOP` and have ids written against the wrong relation). Widen this
 * only alongside project/loop batch support in the service and validator.
 */
export type BatchApplyTagInput = {
  tagId: string;
  entityType: typeof TagEntityType.Artifact;
  entityIds: string[];
};
