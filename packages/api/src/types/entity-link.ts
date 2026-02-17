// EntityLink types for API contract
// Polymorphic relationships between Artifact, Issue, and ExternalLink entities.

import type { Artifact } from "./artifact";
import type { JsonObject } from "./common";
import type { ExternalLink } from "./external-link";
import type { Issue } from "./issue";

export const EntityType = {
  Artifact: "ARTIFACT",
  Issue: "ISSUE",
  ExternalLink: "EXTERNAL_LINK",
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];
export const ENTITY_TYPE_OPTIONS = Object.values(EntityType);

export const LinkType = {
  Produces: "PRODUCES",
  Blocks: "BLOCKS",
  RelatesTo: "RELATES_TO",
} as const;
export type LinkType = (typeof LinkType)[keyof typeof LinkType];
export const LINK_TYPE_OPTIONS = Object.values(LinkType);

export type EntityLink = {
  id: string;
  sourceId: string;
  sourceType: EntityType;
  sourceVersion: number | null;
  targetId: string;
  targetType: EntityType;
  targetVersion: number | null;
  linkType: LinkType;
  metadata: JsonObject | null;
  createdAt: Date;
};

export type CreateEntityLinkInput = {
  sourceId: string;
  sourceType: EntityType;
  sourceVersion?: number;
  targetId: string;
  targetType: EntityType;
  targetVersion?: number;
  linkType: LinkType;
  metadata?: JsonObject | null;
};

/** A hydrated entity resolved from an EntityLink source or target. */
export type ResolvedEntity =
  | { type: "ARTIFACT"; entity: Artifact }
  | { type: "ISSUE"; entity: Issue }
  | { type: "EXTERNAL_LINK"; entity: ExternalLink };
