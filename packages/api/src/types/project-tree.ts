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
  /**
   * Present ONLY when the server could not walk the whole graph it was asked
   * for. Omitted (never `false`, never `null`) on a complete read, so an older
   * client that does not know the field sees exactly what it saw before.
   *
   * A tree without this field is a claim of completeness. A tree with it is a
   * claim that some rows are missing and the caller must say so rather than
   * render a plausible-but-wrong complete tree (root `AGENTS.md`, "never let
   * the UI lie about state or data").
   */
  truncation?: TreeTruncation;
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
  /**
   * Same partial-read contract as {@link ProjectTreeResponse.truncation}, and
   * for the same reason: `?limit=` (ISS-5307) bounds this response too, so the
   * detailed tree must be able to say it is incomplete. Omitted — never `false`,
   * never `null` — on a complete read, so a client that predates the field sees
   * exactly the response it saw before.
   */
  truncation?: TreeTruncation;
};

/**
 * Wire contract for the tree route's `include` query parameter. Route, hook,
 * and tests all import these so the values can't silently drift apart.
 */
export const PROJECT_TREE_INCLUDE_PARAM = "include";
export const PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM = "contributorUserId";

export const ProjectTreeInclude = {
  Details: "details",
} as const;
export type ProjectTreeInclude =
  (typeof ProjectTreeInclude)[keyof typeof ProjectTreeInclude];

export type ProjectTreeQueryFilters = {
  contributorUserId?: string;
  /**
   * Optional bound on how many ROOT nodes the response carries (ISS-5307).
   * Omitted means "every root", which is what every caller got before the
   * parameter existed. Clamped server-side to
   * [1, {@link PROJECT_TREE_MAX_ROOT_LIMIT}].
   */
  limit?: number;
};

/**
 * Wire contract for `GET /artifacts/assigned-tree` (FEA-1651, parent FEA-908).
 * The route answers with the same {@link ProjectTreeResponse} shape as the
 * per-project tree — merged across every project the assignee holds an
 * artifact in — so tree consumers work against one contract instead of a
 * second parallel response type. Route, hook, and tests import these constants
 * so the query param and path cannot drift apart.
 */
export const ASSIGNED_ARTIFACT_TREE_PATH = "/artifacts/assigned-tree" as const;
export const ASSIGNED_ARTIFACT_TREE_ASSIGNEE_ID_PARAM = "assigneeId" as const;

/**
 * Why a tree read stopped short of the full graph. Every bound the server
 * applies has its own reason so an operator reading a truncated response can
 * tell "this user has more anchors than we walk" apart from "this graph is
 * deeper than we walk".
 */
export const TreeTruncationReason = {
  /** More anchor artifacts matched the scope than the server walks. */
  AnchorCap: "anchor_cap",
  /** A parent or child chain was still going at the depth bound. */
  DepthCap: "depth_cap",
  /** The total node budget for one response was reached. */
  NodeBudget: "node_budget",
} as const;
export type TreeTruncationReason =
  (typeof TreeTruncationReason)[keyof typeof TreeTruncationReason];

/**
 * The explicit partial-read contract for a tree response (FEA-1651, wongk).
 *
 * A bounded server walk that silently drops rows produces a tree that LOOKS
 * complete: the depth bound promotes a mid-chain ancestor to a root, and the
 * anchor cap drops whole task streams. Both are indistinguishable from "that
 * is all there is" unless the response says otherwise, so it says otherwise.
 */
export type TreeTruncation = {
  /** Anchor artifacts the server actually walked. Exact. */
  anchorsIncluded: number;
  /**
   * A FLOOR on how many anchors matched the scope, not an exact total: the
   * server probes one row past its cap to detect overflow rather than paying
   * for a full count it would only use to render "and more". Named for what it
   * is so no caller renders it as a precise "of N".
   */
  anchorsMatchedAtLeast: number;
  /** Every bound that bound, in a stable order. Never empty. */
  reasons: TreeTruncationReason[];
};

/**
 * Wire contract for the tree route's optional root-node bound (ISS-5307).
 *
 * The project detail page's artifact tabs used to read EVERY artifact in the
 * project and slice the result in the browser, so a large project paid its full
 * payload before rendering its first screen. This parameter lets the caller ask
 * for a bounded prefix of the root ordering instead.
 *
 * It is additive and optional in the strict sense the repo's cross-repo rule
 * requires: a request that omits it gets the complete tree, byte-for-byte what
 * every caller got before the parameter existed, and a server that predates it
 * simply ignores an unknown query param and answers with the whole tree — whose
 * absent `truncation` {@link isProjectTreeTruncated} then reads as the honest
 * "nothing was truncated" it is.
 */
export const PROJECT_TREE_LIMIT_PARAM = "limit";

/**
 * Ceiling on `?limit=`, mirroring `DOCUMENT_LIST_MAX_LIMIT` so the two bounded
 * artifact reads cannot drift apart. A caller asking for more is clamped to
 * this rather than rejected — the bound exists to protect the server, and a
 * clamped read is still a correct read as long as the response says it was
 * bounded, which {@link TreeTruncation} does.
 */
export const PROJECT_TREE_MAX_ROOT_LIMIT = 500;

/**
 * Read a tree response's truncation as a definite answer, including from a
 * server that predates the field (ISS-5307).
 *
 * `undefined` is the wire encoding of "this tree is complete", so callers must
 * not render "and maybe more" merely because the field is absent. Centralized
 * here so the several surfaces that show a truncation note cannot each invent
 * their own reading of an absent field.
 */
export function isProjectTreeTruncated(
  response: Pick<ProjectTreeResponse, "truncation"> | null | undefined
): boolean {
  return (response?.truncation?.reasons.length ?? 0) > 0;
}
