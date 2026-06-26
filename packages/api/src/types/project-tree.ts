// Project Tree types for API contract
// Hierarchical view of every artifact in a project, organized by artifact-link chains.

import type { Artifact, LinkType } from "./artifact";
import type { GenerationStatus } from "./document";
import type { TagSummary } from "./tag";

/** A child entity in the tree, with its relationship to the parent chain. */
export type TreeChild = Artifact & {
  /** The link type that connects this child to the chain (PRODUCES, BLOCKS, RELATES_TO). */
  linkType: LinkType;
  /** Depth in the original chain (1 = direct child of root, 2 = grandchild, etc.). */
  depth: number;
  /** ID of the immediate parent artifact (the root's ID for depth-1 children). */
  parentId: string;
};

/** A root entity with its flattened children in depth-first order. */
export type TreeNode = {
  root: Artifact;
  children: TreeChild[];
};

/**
 * A direct link from an out-of-project artifact (`parent`) into an artifact
 * inside this project (`childId`). The child is always present in
 * `ProjectTreeResponse.nodes`.
 */
export type ExternalParentLink = {
  childId: string;
  parent: Artifact;
  linkType: LinkType;
};

/** Response shape for GET /projects/:id/tree. */
export type ProjectTreeResponse = {
  nodes: TreeNode[];
  externalParents: ExternalParentLink[];
};

/**
 * Per-artifact view enrichment returned when the tree is requested with
 * `?include=details`. These concepts are artifact-level, not document-level
 * (FEA-1763): any artifact type can carry tags or a generation status. Today
 * the server populates them for DOCUMENT artifacts; other types pick them up
 * as they gain support, with no contract change.
 */
export type ArtifactViewDetails = {
  generationStatus?: GenerationStatus;
  tags?: TagSummary[];
};

export type DetailedArtifact = Artifact & ArtifactViewDetails;

export type DetailedTreeChild = TreeChild & ArtifactViewDetails;

export type DetailedTreeNode = {
  root: DetailedArtifact;
  children: DetailedTreeChild[];
};

/**
 * Response shape for GET /projects/:id/tree?include=details — the same tree,
 * with every artifact node enriched in place. Structurally assignable to
 * `ProjectTreeResponse`, so tree consumers work on either shape. There is
 * deliberately no parallel flat array: the tree already contains every
 * artifact exactly once, and flat views derive from it client-side (PLN-874).
 */
export type ProjectTreeDetailsResponse = {
  nodes: DetailedTreeNode[];
  externalParents: ExternalParentLink[];
};

/**
 * Wire contract for the tree route's `include` query parameter. Route, hook,
 * and tests all import these so the values can't silently drift apart.
 */
export const PROJECT_TREE_INCLUDE_PARAM = "include";

export const ProjectTreeInclude = {
  Details: "details",
} as const;
export type ProjectTreeInclude =
  (typeof ProjectTreeInclude)[keyof typeof ProjectTreeInclude];
