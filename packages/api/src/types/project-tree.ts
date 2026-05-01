// Project Tree types for API contract
// Hierarchical view of every artifact in a project, organized by artifact-link chains.

import type { Artifact, LinkType } from "./artifact";

/** A child entity in the tree, with its relationship to the parent chain. */
export type TreeChild = Artifact & {
  /** The link type that connects this child to the chain (PRODUCES, BLOCKS, RELATES_TO). */
  linkType: LinkType;
  /** Depth in the original chain (1 = direct child of root, 2 = grandchild, etc.). */
  depth: number;
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
