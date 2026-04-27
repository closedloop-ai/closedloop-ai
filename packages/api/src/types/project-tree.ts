// Project Tree types for API contract
// Hierarchical view of every artifact in a project, organized by artifact-link chains.

import type { LinkType } from "./artifact";
import type { DocumentStatus, DocumentType } from "./document";
import type { BasicUser } from "./user";

/**
 * Wire-level discriminator for the project tree. After the artifact cutover
 * every row is an artifact, but the tree's legacy shape still groups
 * PR/DEPLOYMENT entries under a single `EXTERNAL_LINK` bucket so the
 * frontend can render them uniformly.
 */
export const TreeEntityType = {
  Document: "DOCUMENT",
  ExternalLink: "EXTERNAL_LINK",
} as const;
export type TreeEntityType =
  (typeof TreeEntityType)[keyof typeof TreeEntityType];

export const TreeExternalLinkType = {
  PullRequest: "PULL_REQUEST",
  PreviewDeployment: "PREVIEW_DEPLOYMENT",
} as const;
export type TreeExternalLinkType =
  (typeof TreeExternalLinkType)[keyof typeof TreeExternalLinkType];

/** Lightweight representation of any entity in the project tree. */
export type TreeEntity =
  | {
      entityType: typeof TreeEntityType.Document;
      id: string;
      slug: string;
      title: string;
      type: DocumentType;
      status: DocumentStatus;
      assignee: BasicUser | null;
      createdAt: Date;
    }
  | {
      entityType: typeof TreeEntityType.ExternalLink;
      id: string;
      title: string;
      externalUrl: string;
      type: TreeExternalLinkType;
      createdAt: Date;
    };

/** A child entity in the tree, with its relationship to the parent chain. */
export type TreeChild = TreeEntity & {
  /** The link type that connects this child to the chain (PRODUCES, BLOCKS, RELATES_TO). */
  linkType: LinkType;
  /** Depth in the original chain (1 = direct child of root, 2 = grandchild, etc.). */
  depth: number;
};

/** A root entity with its flattened children in depth-first order. */
export type TreeNode = {
  root: TreeEntity;
  children: TreeChild[];
};

/** Response shape for GET /projects/:id/tree. */
export type ProjectTreeResponse = {
  nodes: TreeNode[];
};
