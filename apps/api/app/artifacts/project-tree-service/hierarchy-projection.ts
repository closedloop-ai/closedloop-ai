import type {
  ArtifactHierarchyState,
  ProjectTreeIntegrityDiagnostic,
  ProjectTreeQueryFilters,
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import {
  HierarchyAvailability,
  PROJECT_TREE_CONTRACT_VERSION,
  PROJECT_TREE_DEFAULT_CHILD_LIMIT,
  PROJECT_TREE_MAX_CHILD_LIMIT,
  PROJECT_TREE_MAX_ROOT_LIMIT,
  PROJECT_TREE_MAX_VISIBLE_LEVELS,
  ProjectTreeIntegrityDiagnosticKind,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import { z } from "zod";
import type { PlacementState } from "@/app/documents/project-artifact-placement-service-support";
import {
  type ArtifactWithAssignee,
  compareStackRankKeys,
  flattenCanonicalSubtree,
  type ParentEdge,
} from "../artifact-tree-shared";

const PROJECT_TREE_MAX_WINDOW_ARTIFACTS = 5000;

export type ProjectHierarchyWindow = {
  diagnostics: ProjectTreeIntegrityDiagnostic[];
  diagnosticsComplete: boolean;
  includedArtifactIds: Set<string>;
  nextCursor?: string;
  nodeBudgetHit: boolean;
  parentArtifactId?: string;
  rootIds: string[];
  rootNextCursor?: string;
  totalChildCount?: number;
  mutationVersion?: string;
  version: string;
};

/**
 * Select one root or direct-child page from PRD-725's canonical placement
 * snapshot. Only the selected window is hydrated into full artifact rows.
 */
export function selectProjectHierarchyWindow(
  state: PlacementState,
  projectId: string,
  options: ProjectTreeQueryFilters
): ProjectHierarchyWindow {
  const version = state.projectVersions[projectId];
  if (!version) {
    throw new ProjectHierarchyParentUnavailableError();
  }
  const parentArtifactId = options.parentArtifactId;
  if (parentArtifactId !== undefined) {
    return selectChildWindow(
      state,
      projectId,
      parentArtifactId,
      options,
      version
    );
  }
  return selectRootWindow(state, projectId, options, version);
}

/** Build hierarchy metadata and row state over one hydrated bounded window. */
export function buildHierarchyResponse({
  canonicalParents,
  childCountsByParent,
  childIdsByParent,
  legacyResponse,
  window,
}: {
  canonicalParents: ReadonlyMap<string, ParentEdge>;
  childCountsByParent?: ReadonlyMap<string, number>;
  childIdsByParent: ReadonlyMap<string, string[]>;
  legacyResponse: ProjectTreeResponse;
  window: ProjectHierarchyWindow;
}): ProjectTreeResponse {
  const nodes = legacyResponse.nodes.map((node) =>
    decorateHierarchyNode(
      node,
      childIdsByParent,
      canonicalParents,
      window.includedArtifactIds,
      childCountsByParent
    )
  );
  const hierarchy = {
    capabilities: {
      childPaging: true,
      exactPlacement: true,
      maxVisibleLevels: PROJECT_TREE_MAX_VISIBLE_LEVELS,
      mutationVersion: window.mutationVersion ?? window.version,
      rootPaging: true,
    },
    contractVersion: PROJECT_TREE_CONTRACT_VERSION,
    diagnostics: window.diagnostics,
    diagnosticsComplete: window.diagnosticsComplete,
    ...(window.parentArtifactId !== undefined && {
      childCount: window.totalChildCount ?? 0,
      parentArtifactId: window.parentArtifactId,
    }),
    ...(window.nextCursor && { nextCursor: window.nextCursor }),
    ...(window.rootNextCursor && { rootNextCursor: window.rootNextCursor }),
  };
  return {
    ...legacyResponse,
    hierarchy,
    nodes,
  };
}

/** Stable expected read failures returned to route adapters as values. */
export const ProjectHierarchyReadErrorCode = {
  InvalidCursor: "invalid_cursor",
  ParentUnavailable: "parent_unavailable",
  StaleCursor: "stale_cursor",
} as const;
export type ProjectHierarchyReadErrorCode =
  (typeof ProjectHierarchyReadErrorCode)[keyof typeof ProjectHierarchyReadErrorCode];

export type ProjectHierarchyReadError =
  | {
      code: typeof ProjectHierarchyReadErrorCode.StaleCursor;
      version: string;
    }
  | {
      code: Exclude<
        ProjectHierarchyReadErrorCode,
        typeof ProjectHierarchyReadErrorCode.StaleCursor
      >;
    };

/** Narrow an internal read abort to the expected route-level result contract. */
export function projectHierarchyReadError(
  error: unknown
): ProjectHierarchyReadError | undefined {
  const parsed = projectHierarchyReadErrorSchema.safeParse(error);
  return parsed.success ? parsed.data : undefined;
}

/** A keyset cursor no longer names the current project hierarchy revision. */
export class ProjectHierarchyStaleCursorError extends Error {
  readonly code = ProjectHierarchyReadErrorCode.StaleCursor;
  readonly version: string;

  constructor(version: string) {
    super("Project hierarchy cursor is stale");
    this.name = "ProjectHierarchyStaleCursorError";
    this.version = version;
  }
}

/** A hierarchy cursor was not a valid opaque cursor. */
export class ProjectHierarchyInvalidCursorError extends Error {
  readonly code = ProjectHierarchyReadErrorCode.InvalidCursor;

  constructor() {
    super("Invalid project hierarchy cursor");
    this.name = "ProjectHierarchyInvalidCursorError";
  }
}

/** The requested child-page parent is not visible in this project. */
export class ProjectHierarchyParentUnavailableError extends Error {
  readonly code = ProjectHierarchyReadErrorCode.ParentUnavailable;

  constructor() {
    super("Project hierarchy parent is unavailable");
    this.name = "ProjectHierarchyParentUnavailableError";
  }
}

function selectRootWindow(
  state: PlacementState,
  projectId: string,
  options: ProjectTreeQueryFilters,
  version: string
): ProjectHierarchyWindow {
  const roots = state.artifacts
    .filter(
      (artifact) =>
        artifact.projectId === projectId &&
        !state.canonicalParents.has(artifact.id)
    )
    .sort(compareIndexedArtifacts);
  const offset = resolveCursorOffset(
    options.rootCursor,
    version,
    roots,
    "root"
  );
  const pageSize = Math.min(
    PROJECT_TREE_MAX_ROOT_LIMIT,
    Math.max(1, options.limit ?? PROJECT_TREE_MAX_ROOT_LIMIT)
  );
  const peeked = roots.slice(offset, offset + pageSize + 1);
  const pageRoots = peeked.slice(0, pageSize);
  const last = pageRoots.at(-1);
  const rootNextCursor =
    peeked.length > pageSize && last
      ? encodeProjectHierarchyCursor({
          artifactId: last.id,
          createdAt: last.createdAt,
          kind: "root",
          sortOrder: last.sortOrder,
          version,
        })
      : undefined;
  const collected = collectVisibleWindow(
    pageRoots.map((artifact) => artifact.id),
    state
  );
  const diagnostics = buildHierarchyDiagnostics(
    state,
    new Set(pageRoots.map((artifact) => artifact.id))
  );
  return {
    diagnostics,
    diagnosticsComplete:
      offset === 0 && rootNextCursor === undefined && !collected.nodeBudgetHit,
    includedArtifactIds: collected.ids,
    nodeBudgetHit: collected.nodeBudgetHit,
    rootIds: pageRoots.map((artifact) => artifact.id),
    ...(rootNextCursor && { rootNextCursor }),
    version,
  };
}

function selectChildWindow(
  state: PlacementState,
  projectId: string,
  parentArtifactId: string,
  options: ProjectTreeQueryFilters,
  version: string
): ProjectHierarchyWindow {
  const parent = state.artifactsById.get(parentArtifactId);
  if (parent?.projectId !== projectId) {
    throw new ProjectHierarchyParentUnavailableError();
  }
  const children = (state.childrenByParent.get(parentArtifactId) ?? [])
    .map((id) => state.artifactsById.get(id))
    .filter(isDefined);
  const offset = resolveCursorOffset(
    options.childCursor,
    version,
    children,
    "child",
    parentArtifactId
  );
  const pageSize = Math.min(
    PROJECT_TREE_MAX_CHILD_LIMIT,
    Math.max(1, options.childLimit ?? PROJECT_TREE_DEFAULT_CHILD_LIMIT)
  );
  const peeked = children.slice(offset, offset + pageSize + 1);
  const pageChildren = peeked.slice(0, pageSize);
  const last = pageChildren.at(-1);
  const nextCursor =
    peeked.length > pageSize && last
      ? encodeProjectHierarchyCursor({
          artifactId: last.id,
          createdAt: last.createdAt,
          kind: "child",
          parentArtifactId,
          sortOrder: last.sortOrder,
          version,
        })
      : undefined;
  const collected = collectVisibleWindow(
    pageChildren.map((artifact) => artifact.id),
    state
  );
  return {
    diagnostics: buildHierarchyDiagnostics(
      state,
      new Set(pageChildren.map((artifact) => artifact.id))
    ),
    diagnosticsComplete: false,
    includedArtifactIds: collected.ids,
    nextCursor,
    nodeBudgetHit: collected.nodeBudgetHit,
    parentArtifactId,
    rootIds: pageChildren.map((artifact) => artifact.id),
    totalChildCount: children.length,
    version,
  };
}

function collectVisibleWindow(
  rootIds: string[],
  state: PlacementState
): { ids: Set<string>; nodeBudgetHit: boolean } {
  const ids = new Set<string>();
  const queue = rootIds.map((id) => ({ depth: 0, id }));
  let nodeBudgetHit = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || ids.has(current.id)) {
      continue;
    }
    if (ids.size >= PROJECT_TREE_MAX_WINDOW_ARTIFACTS) {
      nodeBudgetHit = true;
      break;
    }
    ids.add(current.id);
    if (current.depth >= PROJECT_TREE_MAX_VISIBLE_LEVELS - 1) {
      continue;
    }
    const childIds = state.childrenByParent.get(current.id) ?? [];
    for (const childId of childIds.slice(0, PROJECT_TREE_DEFAULT_CHILD_LIMIT)) {
      queue.push({ depth: current.depth + 1, id: childId });
    }
  }
  return { ids, nodeBudgetHit };
}

function decorateHierarchyNode(
  node: TreeNode,
  childIdsByParent: ReadonlyMap<string, readonly string[]>,
  canonicalParents: ReadonlyMap<string, ParentEdge>,
  includedArtifactIds: ReadonlySet<string>,
  childCountsByParent?: ReadonlyMap<string, number>
): TreeNode {
  const maxChildDepth = PROJECT_TREE_MAX_VISIBLE_LEVELS - 1;
  return {
    root: node.root,
    hierarchy: hierarchyStateFor(
      node.root.id,
      0,
      childIdsByParent,
      maxChildDepth,
      canonicalParents,
      includedArtifactIds,
      childCountsByParent
    ),
    children: node.children
      .filter((child) => child.depth <= maxChildDepth)
      .map((child) => ({
        ...child,
        hierarchy: hierarchyStateFor(
          child.id,
          child.depth,
          childIdsByParent,
          maxChildDepth,
          canonicalParents,
          includedArtifactIds,
          childCountsByParent
        ),
      })),
  };
}

function hierarchyStateFor(
  artifactId: string,
  depth: number,
  childIdsByParent: ReadonlyMap<string, readonly string[]>,
  maxChildDepth: number,
  canonicalParents: ReadonlyMap<string, ParentEdge>,
  includedArtifactIds: ReadonlySet<string>,
  childCountsByParent?: ReadonlyMap<string, number>
): ArtifactHierarchyState {
  const childIds = childIdsByParent.get(artifactId) ?? [];
  const childCount = childCountsByParent?.get(artifactId) ?? childIds.length;
  const includedChildCount = childIds.filter((id) =>
    includedArtifactIds.has(id)
  ).length;
  const incomplete =
    childCount > includedChildCount ||
    (childCount > 0 && depth >= maxChildDepth);
  return {
    availability: incomplete
      ? HierarchyAvailability.Partial
      : HierarchyAvailability.Complete,
    childCount,
    hierarchyPath: hierarchyPathFor(artifactId, canonicalParents),
  };
}

/** Follow canonical parents once to expose the authoritative root-to-node path. */
export function hierarchyPathFor(
  artifactId: string,
  canonicalParents: ReadonlyMap<string, ParentEdge>
): string[] {
  const path = [artifactId];
  let currentId = artifactId;
  const seen = new Set(path);
  while (canonicalParents.has(currentId)) {
    const parentId = canonicalParents.get(currentId)?.parentId;
    if (!parentId || seen.has(parentId)) {
      break;
    }
    seen.add(parentId);
    path.unshift(parentId);
    currentId = parentId;
  }
  return path;
}

function buildHierarchyDiagnostics(
  state: PlacementState,
  selectedRootIds: ReadonlySet<string>
): ProjectTreeIntegrityDiagnostic[] {
  const diagnostics: ProjectTreeIntegrityDiagnostic[] = [];
  for (const [targetId, sourceIds] of state.incomingProduces) {
    if (
      !isWithinSelectedRoots(targetId, selectedRootIds, state.canonicalParents)
    ) {
      continue;
    }
    for (const sourceId of sourceIds) {
      if (!state.artifactsById.has(sourceId)) {
        continue;
      }
      const canonical = state.canonicalParents.get(targetId);
      if (canonical?.parentId === sourceId) {
        continue;
      }
      diagnostics.push({
        artifactId: targetId,
        kind: canonical
          ? ProjectTreeIntegrityDiagnosticKind.DuplicateParent
          : ProjectTreeIntegrityDiagnosticKind.CycleRejected,
        relatedArtifactId: sourceId,
      });
    }
  }
  for (const artifact of state.artifacts) {
    if (
      hierarchyPathFor(artifact.id, state.canonicalParents).length >
        PROJECT_TREE_MAX_VISIBLE_LEVELS &&
      isWithinSelectedRoots(
        artifact.id,
        selectedRootIds,
        state.canonicalParents
      )
    ) {
      diagnostics.push({
        artifactId: artifact.id,
        kind: ProjectTreeIntegrityDiagnosticKind.DepthCapped,
        ...(state.canonicalParents.get(artifact.id)?.parentId && {
          relatedArtifactId: state.canonicalParents.get(artifact.id)?.parentId,
        }),
      });
    }
  }
  return diagnostics;
}

function isWithinSelectedRoots(
  artifactId: string,
  selectedRootIds: ReadonlySet<string>,
  canonicalParents: ReadonlyMap<string, ParentEdge>
): boolean {
  return hierarchyPathFor(artifactId, canonicalParents).some((id) =>
    selectedRootIds.has(id)
  );
}

function resolveCursorOffset(
  cursor: string | undefined,
  version: string,
  orderedArtifacts: readonly IndexedArtifact[],
  kind: "child" | "root",
  parentArtifactId?: string
): number {
  if (!cursor) {
    return 0;
  }
  const parsed = decodeProjectHierarchyCursor(cursor);
  if (
    parsed.version !== version ||
    parsed.kind !== kind ||
    parsed.parentArtifactId !== parentArtifactId
  ) {
    throw new ProjectHierarchyStaleCursorError(version);
  }
  const index = orderedArtifacts.findIndex(
    (artifact) => artifact.id === parsed.artifactId
  );
  if (index < 0 || orderedArtifacts[index]?.sortOrder !== parsed.sortOrder) {
    throw new ProjectHierarchyStaleCursorError(version);
  }
  return index + 1;
}

/** Encode the storage-level keyset and hierarchy revision into an opaque cursor. */
export function encodeProjectHierarchyCursor(
  cursor: ProjectHierarchyCursorInput
): string {
  return Buffer.from(
    JSON.stringify({
      ...cursor,
      createdAt: cursor.createdAt.toISOString(),
    })
  ).toString("base64url");
}

/** Decode and validate an opaque hierarchy cursor at the API trust boundary. */
export function decodeProjectHierarchyCursor(
  cursor: string
): ProjectHierarchyCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return projectHierarchyCursorSchema.parse(value);
  } catch {
    throw new ProjectHierarchyInvalidCursorError();
  }
}

function compareIndexedArtifacts(
  left: IndexedArtifact,
  right: IndexedArtifact
): number {
  return compareStackRankKeys(left, right);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

type IndexedArtifact = {
  createdAt: Date;
  id: string;
  sortOrder: number | null;
};

const projectHierarchyCursorSchema = z.object({
  artifactId: z.string().uuid(),
  createdAt: z.coerce.date().optional(),
  kind: z.enum(["child", "root"]),
  parentArtifactId: z.string().uuid().optional(),
  sortOrder: z.number().int().nullable(),
  version: z.string().min(1).max(128),
});

const projectHierarchyReadErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal(ProjectHierarchyReadErrorCode.InvalidCursor) }),
  z.object({
    code: z.literal(ProjectHierarchyReadErrorCode.ParentUnavailable),
  }),
  z.object({
    code: z.literal(ProjectHierarchyReadErrorCode.StaleCursor),
    version: z.string().min(1).max(128),
  }),
]);

export type ProjectHierarchyCursor = z.infer<
  typeof projectHierarchyCursorSchema
>;

type ProjectHierarchyCursorInput = Omit<ProjectHierarchyCursor, "createdAt"> & {
  createdAt: Date;
};

/** Truncation reasons contributed by the hierarchy window itself. */
export function hierarchyWindowTruncationReasons(
  window: ProjectHierarchyWindow
): TreeTruncationReason[] {
  const reasons: TreeTruncationReason[] = [];
  if (window.rootNextCursor) {
    reasons.push(TreeTruncationReason.AnchorCap);
  }
  if (window.nodeBudgetHit) {
    reasons.push(TreeTruncationReason.NodeBudget);
  }
  return reasons;
}

/** Build flattened children from the hydrated subset without following omitted rows. */
export function flattenHierarchyWindow(
  rootId: string,
  artifactsById: Map<string, ArtifactWithAssignee>,
  state: PlacementState
) {
  return flattenCanonicalSubtree(
    rootId,
    artifactsById,
    state.childrenByParent,
    state.canonicalParents
  );
}
