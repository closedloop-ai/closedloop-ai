import type { ArtifactSectionOrdering } from "./artifact-group-by-mode.ts";
// Project Tree types for API contract
// Hierarchical view of every artifact in a project, organized by artifact-link chains.

import { z } from "zod";
import type { Artifact, LinkType } from "./artifact";
import type { CustomFieldValueDetail } from "./custom-field";
import type { TagSummary } from "./tag";

/** A child entity in the tree, with its relationship to the parent chain. */
export type TreeChild = Artifact & {
  /** The link type that connects this child to the chain (PRODUCES, BLOCKS, RELATES_TO). */
  linkType: LinkType;
  /** Depth in the original chain (1 = direct child of root, 2 = grandchild, etc.). */
  depth: number;
  /** ID of the immediate parent artifact (the root's ID for depth-1 children). */
  parentId: string;
  /** Additive child-loading state for hierarchy-aware clients. */
  hierarchy?: ArtifactHierarchyState;
};

/** A root entity with its flattened children in depth-first order. */
export type TreeNode = {
  root: Artifact;
  children: TreeChild[];
  /** Additive child-loading state for the root artifact. */
  hierarchy?: ArtifactHierarchyState;
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
  /** Opaque version of the complete document tree used for manual placement. */
  projectVersion?: string;
  /** Opt-in revision of the complete hierarchy for legacy transaction clients. */
  hierarchyRevision?: string;
  /**
   * Parent context for the nodes a CATEGORY read returns flat
   * ({@link ProjectTreeQueryFilters.category}), keyed by the flat node's own id.
   *
   * A category read promotes every match to a root, so a promoted node carries
   * no `parentId` and sits in no `children` array — the two places a client
   * rebuilds an internal parent link from. Without this the Parent column loses
   * every value on a filtered tab and collapses as an all-empty column, which is
   * data the unfiltered tree renders and the filtered one silently would not
   * (whitlockk, PR #6745).
   *
   * Distinct from {@link externalParents} rather than folded into it because the
   * two make DIFFERENT claims: an external parent lives outside this project and
   * consumers deliberately narrow which of those they will render, while these
   * are in-project parents of rows the response is carrying. Omitted — never
   * `[]`, never `null` — whenever there is none, so an unfiltered read's shape is
   * exactly what it was before this field existed and a client that predates it
   * is unaffected.
   */
  flatParents?: ExternalParentLink[];
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
  /** Present only on an explicit hierarchy-aware read. */
  hierarchy?: ProjectTreeHierarchyMetadata;
  /**
   * Present ONLY on a ROOT-GROUP-paged read (ISS-10472). Omitted — never
   * `null` — on an unpaged one, so `GET /projects/:id/tree` and an older client
   * that predates the field see exactly the shape they saw before.
   *
   * The paged unit is the root GROUP, which is what the footer already counts
   * as "top-level tasks": `nodes.length` is the groups on this page, while
   * `total` counts the groups behind the whole predicate. The descendants in
   * each group's `children` are NOT paged and are not counted here.
   */
  page?: TreeRootPage;
};

/**
 * Paging state for one page of root groups.
 *
 * `total` is EXACT, not a floor, and that distinction is the point: it is read
 * by `count(*) OVER ()` in the same statement and the same snapshot as the
 * rows, so it cannot report `50 items, total 49` the way a separate `COUNT`
 * across a concurrent write can (`apps/api/AGENTS.md`). Contrast
 * {@link TreeTruncation.anchorsMatchedAtLeast}, which IS a floor and says so.
 */
export type TreeRootPage = {
  /**
   * Zero-based ROW offset of the first root group in `nodes`. Present only on a
   * ROW-paged read, and it means a row offset there and nowhere else.
   *
   * A SECTION-paged read reports {@link TreeRootPage.pageIndex} instead and
   * omits this. The two were one field until marisolashgrove's PR #9026 review:
   * anything reading `offset` generically — footer arithmetic, a log, a future
   * MCP tool — got a page index on a grouped read and could not tell, because
   * the only signal was whether `sections` happened to be present.
   */
  offset?: number;
  /**
   * Zero-based PAGE index of `nodes`. Present only on a SECTION-paged read,
   * where pages are variable-height — whole sections are kept together — so
   * there is no row offset to report and the index is what the caller pages
   * with.
   */
  pageIndex?: number;
  /** Root groups requested. The last page carries fewer. */
  limit: number;
  /** Exact count of root groups behind this read's predicate. */
  total: number;
  /**
   * Rows on every page BEFORE this one — the 0-based index of this page's first
   * root among all of them. Present only on a SECTION-paged read.
   *
   * The server sends it because the client cannot derive it: pages are
   * variable-height, so `pageIndex * limit` describes a window this read never
   * returned. A footer built on that arithmetic would state a range the page
   * does not hold.
   */
  rowsBefore?: number;
  /**
   * Pages the whole set was laid into. Present only on a SECTION-paged read:
   * a row-paged caller derives it from `total` and `limit`, which a
   * variable-height plan makes impossible.
   */
  totalPages?: number;
  /**
   * The section ordering this response was BUILT with (ISS-10472).
   *
   * Named rather than requested. Three orderings exist and two PostHog keys
   * select between them, and the server resolves them per request — asking the
   * client to state one would have the read honor an ordering the client
   * believes over the one the server evaluated, which is the request-contract
   * change ISS-9437 declined for the Branches list.
   */
  ordering?: ArtifactSectionOrdering;
  /**
   * The sections on THIS page, in render order. Present only on a
   * SECTION-paged read.
   *
   * Each carries its member root ids rather than a section KEY, deliberately:
   * the renderer derives its own `GroupSectionDescriptor.key` from the rows,
   * and a key spelled here too would be a second spelling of it that could
   * drift. The client maps a section to its key through the first row it holds.
   */
  sections?: TreeRootSection[];
};

/** One rendered section of a {@link TreeRootPage}. */
export type TreeRootSection = {
  /** This section's root ids on this page, in render order. */
  rootIds: string[];
  /**
   * The section's size over the WHOLE set, which is the population its header
   * states — never the slice this page took.
   */
  total: number;
  /**
   * This section's rows began on an earlier page, so its header is a
   * continuation. Only a section larger than one page can set it.
   */
  continued: boolean;
};

/**
 * Per-artifact view enrichment returned when the tree is requested with
 * `?include=details`. Tags are artifact-level (FEA-1763); versions apply only
 * to documents. Optional enrichment is omitted when it is unavailable.
 */
export type ArtifactViewDetails = {
  tags?: TagSummary[];
  /** Persisted document version; omitted for other types or an unavailable read. */
  currentVersion?: number;
  /** Successful document-field read, including empty; omitted if unavailable. */
  customFieldValues?: CustomFieldValueDetail[];
};

export type DetailedArtifact = Artifact & ArtifactViewDetails;

export type DetailedTreeChild = TreeChild & ArtifactViewDetails;

export type DetailedTreeNode = {
  root: DetailedArtifact;
  children: DetailedTreeChild[];
  hierarchy?: ArtifactHierarchyState;
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
  /** Same placement version as the non-enriched tree read. */
  projectVersion?: string;
  /** Same opt-in hierarchy revision as the plain tree read. */
  hierarchyRevision?: string;
  /**
   * Same flat-result parent context, and for the same reason, as
   * {@link ProjectTreeResponse.flatParents}: this is the variant the project
   * page's filtered tabs actually read, so a field only the plain response
   * carried would fix the Parent column on no real surface.
   */
  flatParents?: ExternalParentLink[];
  /**
   * Same partial-read contract as {@link ProjectTreeResponse.truncation}, and
   * for the same reason: `?limit=` (ISS-5307) bounds this response too, so the
   * detailed tree must be able to say it is incomplete. Omitted — never `false`,
   * never `null` — on a complete read, so a client that predates the field sees
   * exactly the response it saw before.
   */
  truncation?: TreeTruncation;
  /** Present only on an explicit hierarchy-aware read. */
  hierarchy?: ProjectTreeHierarchyMetadata;
};

/**
 * Wire contract for the tree route's `include` query parameter. Route, hook,
 * and tests all import these so the values can't silently drift apart.
 */
export const PROJECT_TREE_INCLUDE_PARAM = "include";
export const PROJECT_TREE_CONTRIBUTOR_USER_ID_PARAM = "contributorUserId";
export const PROJECT_TREE_CATEGORY_PARAM = "category";
export const PROJECT_TREE_HIERARCHY_PARAM = "hierarchy";
export const PROJECT_TREE_PARENT_ARTIFACT_ID_PARAM = "parentArtifactId";
export const PROJECT_TREE_CHILD_CURSOR_PARAM = "childCursor";
export const PROJECT_TREE_CHILD_LIMIT_PARAM = "childLimit";
export const PROJECT_TREE_ROOT_CURSOR_PARAM = "rootCursor";
export const PROJECT_TREE_HIERARCHY_REVISION_PARAM = "includeHierarchyRevision";

export const ProjectTreeInclude = {
  Details: "details",
} as const;
export type ProjectTreeInclude =
  (typeof ProjectTreeInclude)[keyof typeof ProjectTreeInclude];

/**
 * Server-side artifact-population filter for a tree read.
 *
 * Without it, `?limit=` bounds the FIRST N roots of the whole project and any
 * client-side type filter runs over that prefix — so a filtered tab both
 * under-fills its pages (a 100-row page holding the issues found among 100
 * mixed roots) and misses every match past the prefix ("no PRDs" in a project
 * whose PRDs sort after root 500). With a category, the server filters FIRST
 * and bounds the filtered population, so the bound and the pages count the
 * same thing the tab renders.
 *
 * A category read returns matching artifacts as FLAT roots (children: []),
 * wherever they sat in the link graph: the tabs that filter render flat rows,
 * so nesting is not information they consume, and keeping a match reachable
 * only through a non-matching parent would re-create the miss this filter
 * exists to fix.
 */
export const ProjectTreeCategory = {
  Prds: "prds",
  Features: "features",
  Plans: "plans",
  Branches: "branches",
} as const;
export type ProjectTreeCategory =
  (typeof ProjectTreeCategory)[keyof typeof ProjectTreeCategory];

export type ProjectTreeQueryFilters = {
  includeHierarchyRevision?: boolean;
  contributorUserId?: string;
  /**
   * Optional bound on how many ROOT nodes the response carries (ISS-5307).
   * Omitted means "every root", which is what every caller got before the
   * parameter existed. Clamped server-side to
   * [1, {@link PROJECT_TREE_MAX_ROOT_LIMIT}].
   */
  limit?: number;
  /**
   * Optional artifact-population filter, applied BEFORE `limit` so the bound
   * counts matching artifacts, not mixed roots. Omitted means the unfiltered
   * tree every caller got before the parameter existed.
   */
  category?: ProjectTreeCategory;
  /** Opts into the additive bounded hierarchy contract. */
  hierarchy?: boolean;
  /** Returns one direct-child page rooted at this artifact. */
  parentArtifactId?: string;
  /** Opaque direct-child page cursor, returned by the preceding read. */
  childCursor?: string;
  /** Direct-child page size, clamped by the server. */
  childLimit?: number;
  /** Opaque root page cursor, distinct from direct-child cursors. */
  rootCursor?: string;
};

/** Four rendered levels: root plus three descendant levels. */
export const PROJECT_TREE_MAX_VISIBLE_LEVELS = 4;
export const PROJECT_TREE_DEFAULT_CHILD_LIMIT = 100;
export const PROJECT_TREE_MAX_CHILD_LIMIT = 500;
export const PROJECT_TREE_CONTRACT_VERSION = 1;

/** What a hierarchy-aware row knows about its direct descendants. */
export type ArtifactHierarchyState = {
  childCount: number;
  availability: WireHierarchyAvailability;
  /** Server-authoritative root-to-node artifact lineage. */
  hierarchyPath?: string[];
  /** Server-authoritative move capability; absent preserves legacy clients. */
  canMove?: boolean;
  nextCursor?: string;
};

/** Distinct read states must not collapse into an empty child array. */
export const HierarchyAvailability = {
  Complete: "complete",
  Partial: "partial",
  Unavailable: "unavailable",
  PermissionHidden: "permission_hidden",
  Error: "error",
} as const;
export type HierarchyAvailability =
  (typeof HierarchyAvailability)[keyof typeof HierarchyAvailability];
export type WireHierarchyAvailability = HierarchyAvailability | (string & {});

/** Read capabilities advertised by a hierarchy-aware response. */
export type ProjectTreeHierarchyCapabilities = {
  childPaging: boolean;
  rootPaging?: boolean;
  exactPlacement: boolean;
  maxVisibleLevels: number;
  /** Opaque PRD-725 placement snapshot version. */
  mutationVersion: string;
};

/** Integrity fact surfaced by projection without mutating or repairing data. */
export type ProjectTreeIntegrityDiagnostic = {
  artifactId: string;
  relatedArtifactId?: string;
  kind: WireProjectTreeIntegrityDiagnosticKind;
};

export const ProjectTreeIntegrityDiagnosticKind = {
  CycleRejected: "cycle_rejected",
  DuplicateParent: "duplicate_parent",
  DepthCapped: "depth_capped",
  InvalidMetadata: "invalid_metadata",
} as const;
export type ProjectTreeIntegrityDiagnosticKind =
  (typeof ProjectTreeIntegrityDiagnosticKind)[keyof typeof ProjectTreeIntegrityDiagnosticKind];
export type WireProjectTreeIntegrityDiagnosticKind =
  | ProjectTreeIntegrityDiagnosticKind
  | (string & {});

/** Additive metadata for an explicit hierarchy read. */
export type ProjectTreeHierarchyMetadata = {
  contractVersion: number;
  capabilities: ProjectTreeHierarchyCapabilities;
  diagnostics: ProjectTreeIntegrityDiagnostic[];
  /** False when diagnostics cover only a bounded response scope. */
  diagnosticsComplete: boolean;
  parentArtifactId?: string;
  childCount?: number;
  nextCursor?: string;
  /** Cursor for the next root page; never reused for direct-child pages. */
  rootNextCursor?: string;
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
 * Every other query parameter the route reads, for the same reason
 * `assigneeId` above has a constant (marisolashgrove, PR #9091).
 *
 * The route's `.strict()` schema keys and the client's `URLSearchParams`
 * spellings are both built from this object. Hand-typed on both sides, a rename
 * on one is not a compile error on the other: the request would carry the old
 * name, the strict schema would 400 it or — for a facet dropped from the
 * object — answer 200 with rows nobody narrowed.
 */
export const AssignedArtifactTreeParam = {
  DateField: "dateField",
  DateFrom: "dateFrom",
  DateTo: "dateTo",
  FavoritesOnly: "favoritesOnly",
  GroupBy: "groupBy",
  HideCompletedItems: "hideCompletedItems",
  Limit: "limit",
  Offset: "offset",
  PageIndex: "pageIndex",
  Priority: "priority",
  ProjectId: "projectId",
  Search: "search",
  SortBy: "sortBy",
  SortDir: "sortDir",
  Status: "status",
  TagId: "tagId",
} as const;
export type AssignedArtifactTreeParam =
  (typeof AssignedArtifactTreeParam)[keyof typeof AssignedArtifactTreeParam];

/**
 * Ceiling on `?tagId=` occurrences the route will accept.
 *
 * Canonical here rather than in the route because a CLIENT has to honor it too:
 * the route answers a wider selection with a 400, which reaches a server-paged
 * reader as the load-failed board, so the browser holds its own request to this
 * bound (marisolashgrove, PR #9091). The tag vocabulary is open — tags are
 * user-created — so there is no derived count to bound the `IN` list with, and
 * this explicit cap is what keeps the bind-parameter budget `apps/api/AGENTS.md`
 * sets satisfied by construction.
 */
export const ASSIGNED_ARTIFACT_TREE_MAX_TAG_IDS = 100;

/**
 * Why a tree read stopped short of the full graph. Every bound the server
 * applies has its own reason so an operator reading a truncated response can
 * tell "this user has more anchors than we walk" apart from "this graph is
 * deeper than we walk".
 *
 * This is the set THIS BUILD'S PRODUCERS emit — closed, so a producer cannot
 * invent a reason without declaring it here. It is NOT the set a consumer may
 * assume it will receive; see {@link WireTreeTruncationReason}.
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
 * A truncation reason as it can arrive ON THE WIRE (FEA-1651, whitlockk).
 *
 * A server that has grown a fourth bound sends its reason to clients that were
 * built against three, and {@link orderTreeTruncationReasons} deliberately KEEPS
 * that value rather than dropping it — so a real wire value is reachable and a
 * consumer type that advertised the closed producer set would be lying, forcing
 * a cast to describe what the wire actually carries. The known members stay
 * literal for autocomplete; the open arm admits the one this build has not
 * heard of yet.
 *
 * The open arm is for READING. A producer in this build still emits only
 * {@link TreeTruncationReason}, and states that at the point it names members —
 * a `Set<TreeTruncationReason>`, or `satisfies TreeTruncationReason[]` on a
 * literal — so this type cannot be read as permission to invent a reason.
 */
export type WireTreeTruncationReason = TreeTruncationReason | (string & {});

/**
 * Each reason's position in the emitted order, as an EXHAUSTIVE `Record` rather
 * than a hand-written list of the three that exist today.
 *
 * A bare array would be a side inventory: it is typed
 * `readonly TreeTruncationReason[]`, so three valid members satisfy it and a
 * fourth added to {@link TreeTruncationReason} still compiles here — leaving a
 * reason THIS BUILD'S OWN PRODUCERS emit absent from the known set, sorted into
 * the unknown bucket by {@link orderTreeTruncationReasons}, and out of its
 * declared contract position. Silently, with `tsc` green. Keying the ranks by
 * the union is what makes the omission fail to compile instead.
 */
const TREE_TRUNCATION_REASON_RANK: Record<TreeTruncationReason, number> = {
  [TreeTruncationReason.AnchorCap]: 0,
  [TreeTruncationReason.DepthCap]: 1,
  [TreeTruncationReason.NodeBudget]: 2,
};

/**
 * The stable order every `TreeTruncation.reasons` is emitted in, server-side
 * and client-side alike, so the field is comparable across requests and a
 * merged tree cannot order its reasons differently from a single one. DERIVED
 * from the ranks above so the two cannot drift.
 */
const TREE_TRUNCATION_REASON_ORDER: readonly TreeTruncationReason[] =
  Object.values(TreeTruncationReason).sort(
    (left, right) =>
      TREE_TRUNCATION_REASON_RANK[left] - TREE_TRUNCATION_REASON_RANK[right]
  );

/** Membership test for the ordered set, widened so a wire value can be asked. */
const KNOWN_TREE_TRUNCATION_REASONS: ReadonlySet<string> = new Set(
  TREE_TRUNCATION_REASON_ORDER
);

/**
 * Dedupe and order the reasons of a truncated read, wherever they are folded
 * together — the server resolving one response's bounds, or a client merging
 * several responses into one.
 *
 * A reason this build does not know is KEPT, ordered last, never filtered out.
 * Dropping it would be the whole failure {@link TreeTruncation} exists to
 * prevent: a client running behind a server that has grown a fourth reason
 * would fold a truncated read down to an empty `reasons`, which
 * {@link isProjectTreeTruncated} reads as complete — so a bounded tree would
 * render as the whole truth. Ordering last is enough, because the order is for
 * comparability, not meaning.
 */
export function orderTreeTruncationReasons(
  reasons: Iterable<WireTreeTruncationReason>
): WireTreeTruncationReason[] {
  const unique = new Set<WireTreeTruncationReason>(reasons);
  const known = TREE_TRUNCATION_REASON_ORDER.filter((reason) =>
    unique.has(reason)
  );
  // Unknown reasons are sorted, not left in iteration order: a `Set` preserves
  // insertion order, so two responses carrying the same unknown reasons would
  // otherwise order them by which project's tree happened to be merged first —
  // and the whole point of a stable order is that the field is comparable
  // across requests. Code-unit order, so no host locale can move it.
  const unknown = Array.from(unique)
    .filter((reason) => !KNOWN_TREE_TRUNCATION_REASONS.has(reason))
    .sort();
  return [...known, ...unknown];
}

/**
 * The explicit partial-read contract for a tree response (FEA-1651, whitlockk).
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
  /**
   * Every bound that bound, in a stable order. Never empty.
   *
   * Typed against the WIRE set, not the producer set: a newer server's reason
   * reaches a consumer intact (see {@link orderTreeTruncationReasons}), so a
   * closed union here would make a value that really arrives look impossible.
   */
  reasons: WireTreeTruncationReason[];
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

/** Parse an untrusted project-tree payload while preserving additive fields. */
export function parseProjectTreeResponse(value: unknown): ProjectTreeResponse {
  return projectTreeResponseSchema.parse(value);
}

/** Parse the details variant through the same hierarchy and lineage boundary. */
export function parseProjectTreeDetailsResponse(
  value: unknown
): ProjectTreeDetailsResponse {
  return projectTreeResponseSchema.parse(value) as ProjectTreeDetailsResponse;
}

const artifactWireSchema = z
  .looseObject({
    assignee: z.unknown().nullable(),
    assigneeId: z.string().nullable(),
    createdAt: z.coerce.date(),
    createdById: z.string().nullable(),
    dueDate: z.coerce.date().nullable(),
    externalUrl: z.string().nullable(),
    id: z.string().min(1),
    name: z.string(),
    organizationId: z.string().min(1),
    priority: z.unknown().nullable(),
    projectId: z.string().nullable(),
    slug: z.string().nullable(),
    sortOrder: z.number().finite().nullable(),
    status: z.string(),
    // These are version-skewed wire values. Older Desktop builds must retain
    // an additive server member so downstream switches can use their fallback.
    subtype: z.string().min(1).nullable(),
    type: z.string().min(1),
    updatedAt: z.coerce.date(),
  })
  .transform((value) => value as Artifact);

const artifactHierarchyStateSchema = z.looseObject({
  availability: z.string().min(1),
  canMove: z.boolean().optional(),
  childCount: z.number().int().nonnegative(),
  hierarchyPath: z.array(z.string().min(1)).min(1).optional(),
  nextCursor: z.string().min(1).optional(),
});

const treeChildWireSchema = artifactWireSchema.and(
  z.looseObject({
    depth: z.number().int().positive(),
    hierarchy: artifactHierarchyStateSchema.optional(),
    linkType: z.string().min(1),
    parentId: z.string().min(1),
  })
);

const treeNodeWireSchema = z.looseObject({
  children: z.array(treeChildWireSchema),
  hierarchy: artifactHierarchyStateSchema.optional(),
  root: artifactWireSchema,
});

const externalParentLinkWireSchema = z.looseObject({
  childId: z.string().min(1),
  linkType: z.string().min(1),
  parent: artifactWireSchema,
});

const projectTreeHierarchyMetadataSchema = z.looseObject({
  capabilities: z.looseObject({
    childPaging: z.boolean(),
    exactPlacement: z.boolean(),
    maxVisibleLevels: z.number().int().positive(),
    mutationVersion: z.string().min(1).max(128),
    rootPaging: z.boolean().optional(),
  }),
  contractVersion: z.number().int().positive(),
  childCount: z.number().int().nonnegative().optional(),
  diagnostics: z.array(
    z.looseObject({
      artifactId: z.string().min(1),
      kind: z.string().min(1),
      relatedArtifactId: z.string().min(1).optional(),
    })
  ),
  diagnosticsComplete: z.boolean(),
  parentArtifactId: z.string().min(1).optional(),
  nextCursor: z.string().min(1).optional(),
  rootNextCursor: z.string().min(1).optional(),
});

const treeTruncationWireSchema = z.object({
  anchorsIncluded: z.number().int().nonnegative(),
  anchorsMatchedAtLeast: z.number().int().nonnegative(),
  reasons: z.array(z.string().min(1)).min(1),
});

/** Runtime boundary for both legacy and hierarchy-aware tree responses. */
export const projectTreeResponseSchema = z
  .looseObject({
    externalParents: z.array(externalParentLinkWireSchema),
    flatParents: z.array(externalParentLinkWireSchema).optional(),
    hierarchy: projectTreeHierarchyMetadataSchema.optional(),
    nodes: z.array(treeNodeWireSchema),
    truncation: treeTruncationWireSchema.optional(),
  })
  .transform((value) => value as ProjectTreeResponse);
