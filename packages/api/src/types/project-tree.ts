// Project Tree types for API contract
// Hierarchical view of all documents, features, and external links in a project,
// organized by entity link chains.

import type { DocumentStatus, DocumentType } from "./document";
import type { EntityType, LinkType } from "./entity-link";
import type { ExternalLinkType } from "./external-link";
import type { BasicUser } from "./user";

/** Lightweight representation of any entity in the project tree. */
export type TreeEntity =
  | {
      entityType: typeof EntityType.Document;
      id: string;
      slug: string;
      title: string;
      type: DocumentType;
      status: DocumentStatus;
      assignee: BasicUser | null;
      createdAt: Date;
    }
  | {
      entityType: typeof EntityType.ExternalLink;
      id: string;
      title: string;
      externalUrl: string;
      type: ExternalLinkType;
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
