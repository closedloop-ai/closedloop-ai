import type { ArtifactStatusEditSurface } from "./artifact-status-contract.js";
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

/**
 * Whether a producer actually loaded the generic `TagArtifact` relation for an
 * artifact-backed row. `Available` with `tags: []` is a real, computed "this
 * artifact carries no tags"; `Unavailable` with no `tags` is "this producer
 * never asked" — two different claims a bare empty array collapses into one.
 *
 * Owned here, in the canonical tag module, because it describes the generic
 * artifact-tag relation rather than any one surface: Branches (ISS-4760) and
 * Sessions (ISS-8712) both project the same join and must not answer the
 * question with two independently-declared vocabularies.
 */
export const ArtifactTagAvailability = {
  Available: "available",
  Unavailable: "unavailable",
} as const;
export type ArtifactTagAvailability =
  (typeof ArtifactTagAvailability)[keyof typeof ArtifactTagAvailability];

/**
 * Association-level tag capabilities for an authenticated artifact read.
 * Applying includes batch apply; removal is separate because API keys enforce
 * `write` and `delete` scopes independently.
 *
 * These describe what the CALLER may ask for — they are a display affordance,
 * never the security boundary. `POST`/`DELETE /entity-tags` re-checks scope and
 * org ownership server-side regardless of what a client was told here.
 */
export type ArtifactTagPermissions = {
  canApply: boolean;
  canRemove: boolean;
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
  surface?: ArtifactStatusEditSurface;
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

/**
 * The tag-name contract, shared by the API validator and the MCP tag tools.
 *
 * These are plain values rather than a Zod schema because this module is
 * imported by `"use client"` components (tag chips, the colour picker, the
 * settings tab); the schema built from them lives in the `tag-validators.ts`
 * sibling so a bundle-sensitive consumer never pulls Zod in for a colour
 * constant.
 */
export const TAG_NAME_MAX_LENGTH = 40;
export const TAG_NAME_PATTERN = /^[a-zA-Z0-9 -]+$/;
export const TAG_NAME_RULE_MESSAGE =
  "Name may only contain letters, numbers, spaces, and hyphens";

/**
 * Default page size for the bounded `GET /tags` read, and the largest page a
 * caller may request.
 *
 * Shared rather than app-local because they are ONE wire contract with two
 * enforcement points: `apps/api` validates the incoming `limit` against
 * {@link TAG_LIST_MAX_LIMIT}, and the `list-tags` MCP tool validates its own
 * input against the same value before it ever sends the request. Two
 * independent copies across that deploy boundary drift, and an API max below
 * the MCP max means the MCP sends a limit the API rejects.
 *
 * Deliberately plain numbers, no Zod: this module is imported by `"use client"`
 * components (tag chips, the colour picker) and keeping schemas out of it is
 * why the name-rule constants above are plain values too.
 */
export const TAG_LIST_DEFAULT_LIMIT = 25;
export const TAG_LIST_MAX_LIMIT = 100;
/**
 * Ceiling on `offset`: without one, a deep offset is an unbounded scan on the
 * very endpoint the bound exists to protect.
 */
export const TAG_LIST_MAX_OFFSET = 10_000;

/**
 * Paged envelope for `GET /tags?includeTotal=true`.
 *
 * The bare `Tag[]` remains the default response; a caller that pages opts into
 * this shape because a page alone cannot answer "how many are there?". Same
 * three fields as the sibling `SourceOccurrenceListResponse` /
 * `AgentComponentListResponse` envelopes.
 *
 * Narrower than `DocumentListPage`, which also carries `limit`/`offset`: those
 * exist there to report what the server applied after CLAMPING, and this
 * endpoint rejects an out-of-range bound instead of clamping it, so the caller
 * already knows the window it asked for.
 */
export type TagListPage = {
  /** The requested page, in the same order the bare-array response returns. */
  items: Tag[];
  /**
   * REAL count of every tag matching the query, counted server-side
   * independently of `limit`/`offset`. Never derived from `items`.
   */
  total: number;
  /** True when tags matching the query exist beyond this page. */
  hasMore: boolean;
};
