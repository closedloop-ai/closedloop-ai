// EntityLink types for API contract
// Polymorphic relationships between Document and ExternalLink entities.

import type { JsonObject } from "./common";
import type { Document } from "./document";
import type { ExternalLink } from "./external-link";

export const EntityType = {
  Document: "DOCUMENT",
  ExternalLink: "EXTERNAL_LINK",
} as const;
export type EntityType = (typeof EntityType)[keyof typeof EntityType];

export const LinkType = {
  Produces: "PRODUCES",
  Blocks: "BLOCKS",
  RelatesTo: "RELATES_TO",
} as const;
export type LinkType = (typeof LinkType)[keyof typeof LinkType];

export const LinkDirection = {
  Source: "source",
  Target: "target",
  Both: "both",
} as const;
export type LinkDirection = (typeof LinkDirection)[keyof typeof LinkDirection];

export const LinkQueryMode = {
  Direct: "direct",
  Tree: "tree",
} as const;
export type LinkQueryMode = (typeof LinkQueryMode)[keyof typeof LinkQueryMode];

export type EntityLink = {
  id: string;
  organizationId: string;
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
  | { type: "DOCUMENT"; entity: Document }
  | { type: "EXTERNAL_LINK"; entity: ExternalLink };

/** An EntityLink with the "other" entity (opposite end from the queried entity) resolved. */
export type LinkedEntity = EntityLink & {
  resolvedEntity: ResolvedEntity | null;
};

export type BatchMoveEntitiesInput = {
  entityId: string;
  entityType: EntityType;
  targetProjectId: string;
  includeDownstream: boolean;
};

export type BatchMoveEntitiesResult = {
  movedEntities: { id: string; type: EntityType }[];
};
