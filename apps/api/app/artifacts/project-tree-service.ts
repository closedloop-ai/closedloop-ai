import { ArtifactSubtype, LinkType } from "@repo/api/src/types/artifact";
import type {
  ArtifactViewDetails,
  DetailedTreeNode,
  ExternalParentLink,
  ProjectTreeDetailsResponse,
  ProjectTreeQueryFilters,
  ProjectTreeResponse,
  TreeNode,
} from "@repo/api/src/types/project-tree";
import {
  ProjectTreeCategory,
  TreeTruncationReason,
} from "@repo/api/src/types/project-tree";
import {
  ArtifactType,
  Prisma,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { branchContributorExistsSql } from "@/app/branches/branch-contribution-sql";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { branchProviderFallbackService } from "@/app/branches/branch-provider-fallback-service";
import { readDocumentFieldValues } from "@/app/documents/document-field-values-read";
import { buildDocumentStatusMutation } from "@/app/documents/document-status-mutation-capability";
import { readProjectPlacementVersion } from "@/app/documents/project-artifact-placement-state";
import { fetchDocumentVersionsByArtifact } from "@/app/documents/project-tree-version-read";
import { mapTagRelations } from "@/app/tags/tag-projection-select";
import { basicUserSelect } from "@/lib/db-utils";
import {
  type ArtifactWithAssignee,
  applyBranchProductEligibility,
  applyBranchProviderFallbackAvailability,
  applySessionDisplayedStatus,
  compareByStackRank,
  compareParentRankedArtifacts,
  flattenCanonicalSubtree,
  groupChildIdsByParent,
  normalizeArtifactRowSubtype,
  type ParentEdge,
} from "./artifact-tree-shared";
import {
  type CanonicalParentLinkRow,
  resolveCanonicalParents,
} from "./project-tree-service/canonical-parents";
import {
  buildHierarchyResponse,
  flattenHierarchyWindow,
  hierarchyWindowTruncationReasons,
  type ProjectHierarchyReadError,
  projectHierarchyReadError,
} from "./project-tree-service/hierarchy-projection";
import { readBoundedProjectHierarchy } from "./project-tree-service/project-hierarchy-read";
import {
  fetchTagRelationsByArtifact,
  type TagRelationRow,
} from "./project-tree-service/tag-relations-read";
import { sessionDisplayedStatusService } from "./session-displayed-status-service";

export const projectTreeService = {
  async getProjectTree(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeResponse> {
    if (options.hierarchy) {
      return withDb.tx(
        async (tx) =>
          (
            await buildBoundedHierarchySnapshot(
              tx,
              projectId,
              organizationId,
              options
            )
          ).tree,
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    }
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    const cohort = await loadProjectTreeCohort(
      projectId,
      organizationId,
      contributorBranchIds
    );
    const artifacts = cohort.artifacts;
    return buildProjectTree(
      projectId,
      organizationId,
      artifacts,
      options.contributorUserId,
      options.limit,
      options.category
    );
  },

  async getManuallyOrderedProjectTree(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeResponse> {
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    const cohort = await loadProjectTreeCohort(
      projectId,
      organizationId,
      contributorBranchIds
    );
    return buildManuallyOrderedProjectTree(
      projectId,
      organizationId,
      cohort.artifacts,
      options.contributorUserId,
      options.limit,
      options.category
    );
  },

  /**
   * `getProjectTree` with every artifact node enriched in place with
   * artifact-level view details (tags and document versions) — the
   * `?include=details` contract (FEA-1763, PLN-874). The tree shape is
   * untouched and no parallel flat collection is returned.
   *
   * ISS-8857: the enrichment used to re-select the whole project scope a second
   * time just to reach `tagArtifacts`, then re-join the two row sets in
   * JavaScript. The scope is now read ONCE and both the tree and the details map
   * are built from those same rows; every remaining query either has a genuinely
   * different scope (links, external parents, branch eligibility) or is keyed by
   * the ids this read already holds (tags), and they all run
   * concurrently with the tree assembly.
   */
  async getProjectTreeWithDetails(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeDetailsResponse> {
    if (options.hierarchy) {
      return withDb.tx(
        async (tx) => {
          const snapshot = await buildBoundedHierarchySnapshot(
            tx,
            projectId,
            organizationId,
            options
          );
          return attachTreeDetails(
            snapshot.tree,
            snapshot.artifacts,
            organizationId
          );
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
      );
    }
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    const cohort = await loadProjectTreeCohort(
      projectId,
      organizationId,
      contributorBranchIds
    );
    const artifacts = cohort.artifacts;
    const [tree, detailsById] = await Promise.all([
      buildProjectTree(
        projectId,
        organizationId,
        artifacts,
        options.contributorUserId,
        options.limit,
        options.category
      ),
      buildArtifactViewDetails(artifacts, organizationId, cohort.tagRelations),
    ]);

    return attachProjectTreeDetails(tree, detailsById);
  },

  async getManuallyOrderedProjectTreeWithDetails(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeDetailsResponse> {
    const contributorBranchIds = await fetchContributorBranchIds(
      projectId,
      organizationId,
      options.contributorUserId
    );
    const cohort = await loadProjectTreeCohort(
      projectId,
      organizationId,
      contributorBranchIds
    );
    const [tree, detailsById] = await Promise.all([
      buildManuallyOrderedProjectTree(
        projectId,
        organizationId,
        cohort.artifacts,
        options.contributorUserId,
        options.limit,
        options.category
      ),
      buildArtifactViewDetails(
        cohort.artifacts,
        organizationId,
        cohort.tagRelations
      ),
    ]);

    return attachProjectTreeDetails(tree, detailsById);
  },

  /** Route-facing read contract: expected hierarchy refusals are values. */
  getProjectTreeResult(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeReadResult<ProjectTreeResponse>> {
    return projectTreeReadResult(() =>
      projectTreeService.getProjectTree(projectId, organizationId, options)
    );
  },

  /** Detailed route-facing sibling of {@link getProjectTreeResult}. */
  getProjectTreeWithDetailsResult(
    projectId: string,
    organizationId: string,
    options: ProjectTreeQueryFilters = {}
  ): Promise<ProjectTreeReadResult<ProjectTreeDetailsResponse>> {
    return projectTreeReadResult(() =>
      projectTreeService.getProjectTreeWithDetails(
        projectId,
        organizationId,
        options
      )
    );
  },
};

export type ProjectTreeReadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProjectHierarchyReadError };

async function projectTreeReadResult<T>(
  read: () => Promise<T>
): Promise<ProjectTreeReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    const expected = projectHierarchyReadError(error);
    if (expected) {
      return { error: expected, ok: false };
    }
    throw error;
  }
}

async function attachTreeDetails(
  tree: ProjectTreeResponse,
  artifacts: ArtifactRow[],
  organizationId: string
): Promise<ProjectTreeDetailsResponse> {
  const detailsById = await buildArtifactViewDetails(artifacts, organizationId);
  return attachProjectTreeDetails(tree, detailsById);
}

function attachProjectTreeDetails(
  tree: ProjectTreeResponse,
  detailsById: Map<string, ArtifactViewDetails>
): ProjectTreeDetailsResponse {
  const nodes: DetailedTreeNode[] = tree.nodes.map((node) => ({
    root: attachViewDetails(node.root, detailsById),
    children: node.children.map((child) =>
      attachViewDetails(child, detailsById)
    ),
    ...(node.hierarchy && { hierarchy: node.hierarchy }),
  }));

  return {
    nodes,
    externalParents: tree.externalParents,
    ...(tree.projectVersion && { projectVersion: tree.projectVersion }),
    ...(tree.hierarchyRevision && {
      hierarchyRevision: tree.hierarchyRevision,
    }),
    ...(tree.flatParents && { flatParents: tree.flatParents }),
    ...(tree.truncation && { truncation: tree.truncation }),
    ...(tree.hierarchy && { hierarchy: tree.hierarchy }),
  };
}

type BoundedHierarchySnapshot = {
  artifacts: ArtifactRow[];
  tree: ProjectTreeResponse;
};

/** Hydrate only one hierarchy window from PRD-725's minimal placement index. */
async function buildBoundedHierarchySnapshot(
  tx: TransactionClient,
  projectId: string,
  organizationId: string,
  options: ProjectTreeQueryFilters
): Promise<BoundedHierarchySnapshot> {
  const { childCountsByParent, state, window } =
    await readBoundedProjectHierarchy(tx, projectId, organizationId, options);
  const flatCategoryRead =
    options.parentArtifactId === undefined && options.category !== undefined;
  const flatParentIds = flatCategoryRead
    ? [...window.includedArtifactIds].flatMap((artifactId) => {
        const parentId = state.canonicalParents.get(artifactId)?.parentId;
        return parentId ? [parentId] : [];
      })
    : [];
  const artifactIds = [
    ...new Set([...window.includedArtifactIds, ...flatParentIds]),
  ];
  const artifacts =
    artifactIds.length === 0
      ? []
      : await tx.artifact.findMany({
          where: { id: { in: artifactIds }, organizationId, projectId },
          include: { assignee: basicUserSelect },
        });
  const artifactsById = new Map<string, ArtifactWithAssignee>(
    artifacts.map((artifact) => [
      artifact.id,
      normalizeArtifactRowSubtype(artifact),
    ])
  );
  await enrichArtifactRows(organizationId, artifacts, artifactsById);

  const links = await fetchArtifactLinks(organizationId, artifactIds);
  const incomingExternalLinks = links.filter(
    (link) =>
      link.linkType === LinkType.Produces &&
      artifactsById.has(link.targetId) &&
      !artifactsById.has(link.sourceId)
  );
  const externalParents = await buildExternalParents(
    projectId,
    organizationId,
    incomingExternalLinks,
    undefined
  );
  const nodes = window.rootIds.flatMap((rootId): TreeNode[] => {
    const root = artifactsById.get(rootId);
    if (!root) {
      return [];
    }
    return [
      {
        root,
        children: flattenHierarchyWindow(rootId, artifactsById, state),
      },
    ];
  });
  const reasons = hierarchyWindowTruncationReasons(window);
  const legacyResponse: ProjectTreeResponse = {
    nodes,
    externalParents,
    projectVersion: window.mutationVersion ?? window.version,
    ...(reasons.length > 0 && {
      truncation: {
        anchorsIncluded: nodes.length,
        anchorsMatchedAtLeast: nodes.length + (window.rootNextCursor ? 1 : 0),
        reasons,
      },
    }),
  };
  const flatParents = flatCategoryRead
    ? buildFlatParents(nodes, state.canonicalParents, artifactsById)
    : [];
  return {
    artifacts,
    tree: buildHierarchyResponse({
      canonicalParents: flatCategoryRead
        ? new Map<string, ParentEdge>()
        : state.canonicalParents,
      childCountsByParent,
      childIdsByParent: state.childrenByParent,
      legacyResponse: withFlatParents(legacyResponse, flatParents),
      window,
    }),
  };
}

async function buildProjectTree(
  projectId: string,
  organizationId: string,
  artifacts: ArtifactRow[],
  contributorUserId: string | undefined,
  limit?: number,
  category?: ProjectTreeCategory
): Promise<ProjectTreeResponse> {
  if (artifacts.length === 0) {
    return { nodes: [], externalParents: [] };
  }

  const prepared = await prepareProjectTree(
    projectId,
    organizationId,
    artifacts,
    contributorUserId
  );
  return assembleProjectTree(
    prepared,
    groupChildIdsByParent(prepared.canonicalParents),
    limit,
    category
  );
}

async function buildManuallyOrderedProjectTree(
  projectId: string,
  organizationId: string,
  artifacts: ArtifactRow[],
  contributorUserId: string | undefined,
  limit?: number,
  category?: ProjectTreeCategory
): Promise<ProjectTreeResponse> {
  const projectVersion = await readProjectPlacementVersion(
    projectId,
    organizationId
  );
  if (artifacts.length === 0) {
    return { nodes: [], externalParents: [], projectVersion };
  }

  const prepared = await prepareProjectTree(
    projectId,
    organizationId,
    artifacts,
    contributorUserId
  );
  const childIdsByParent = groupChildIdsByParent(prepared.canonicalParents);
  for (const [parentId, childIds] of childIdsByParent) {
    const children = childIds
      .map((id) => prepared.artifactsById.get(id))
      .filter((artifact): artifact is ArtifactWithAssignee =>
        Boolean(artifact)
      );
    children.sort((left, right) =>
      compareParentRankedArtifacts(left, right, prepared.canonicalParents)
    );
    childIdsByParent.set(
      parentId,
      children.map((artifact) => artifact.id)
    );
  }
  return {
    ...assembleProjectTree(prepared, childIdsByParent, limit, category),
    projectVersion,
  };
}

async function prepareProjectTree(
  projectId: string,
  organizationId: string,
  artifacts: ArtifactRow[],
  contributorUserId: string | undefined
) {
  const artifactsById = new Map<string, ArtifactWithAssignee>(
    artifacts.map((a) => [a.id, normalizeArtifactRowSubtype(a)])
  );
  await enrichArtifactRows(organizationId, artifacts, artifactsById);

  const links = await fetchArtifactLinks(
    organizationId,
    Array.from(artifactsById.keys())
  );

  const internalLinks: CanonicalParentLinkRow[] = [];
  const incomingExternalLinks: CanonicalParentLinkRow[] = [];
  for (const link of links) {
    // Only PRODUCES links express a parent-child relationship. BLOCKS and
    // RELATES_TO are peer/sibling links and must not drive tree nesting or
    // surface as external parents — artifacts joined solely by those links
    // remain independent (sibling) roots.
    if (link.linkType !== LinkType.Produces) {
      continue;
    }
    const sourceInProject = artifactsById.has(link.sourceId);
    const targetInProject = artifactsById.has(link.targetId);
    if (sourceInProject && targetInProject) {
      internalLinks.push(link);
    } else if (targetInProject && !sourceInProject) {
      incomingExternalLinks.push(link);
    }
  }

  const externalParents = await buildExternalParents(
    projectId,
    organizationId,
    incomingExternalLinks,
    contributorUserId
  );

  return {
    artifactsById,
    canonicalParents: resolveCanonicalParents(internalLinks),
    externalParents,
  };
}

function assembleProjectTree(
  prepared: Awaited<ReturnType<typeof prepareProjectTree>>,
  childIdsByParent: Map<string, string[]>,
  limit?: number,
  category?: ProjectTreeCategory
): ProjectTreeResponse {
  const { artifactsById, canonicalParents, externalParents } = prepared;

  const nodes: TreeNode[] = [];

  for (const artifact of artifactsById.values()) {
    // A root is an artifact no surviving edge parents. Reading it off the
    // RESOLVED map rather than off raw in-degree is what keeps a cycle member
    // eligible: it can hold a real incoming edge and still be canonically
    // parentless because its only candidate closed the cycle.
    if (canonicalParents.has(artifact.id)) {
      continue;
    }
    nodes.push({
      root: artifact,
      children: flattenCanonicalSubtree(
        artifact.id,
        artifactsById,
        childIdsByParent,
        canonicalParents
      ),
    });
  }

  nodes.sort(compareByStackRank);

  const filtered = filterTreeToCategory(
    nodes,
    externalParents,
    canonicalParents,
    artifactsById,
    category
  );

  const response = withFlatParents(
    boundRootNodes(filtered.nodes, filtered.externalParents, limit),
    filtered.flatParents
  );
  return response;
}

/**
 * Narrow an assembled tree to one artifact category, BEFORE the root bound —
 * ordering is what makes the bound honest. Bounding first and filtering after
 * (what the client used to do) makes `?limit=` count MIXED roots, so a
 * filtered tab both under-fills its pages and reports "no matches" for a
 * project whose matches all sort past the bound.
 *
 * Matching artifacts are collected from ANYWHERE in the tree — a PRD nested
 * under a feature chain is still a PRD the tab must find — and returned as
 * FLAT roots, deduped by id (an artifact can be reachable through more than
 * one chain). The tabs that filter render flat rows, so nesting carries no
 * information for them, and a promoted child sheds its chain-position fields
 * (`linkType`/`depth`/`parentId`) rather than serializing a chain the response
 * no longer contains. Re-sorted by the same stack-rank order the unfiltered
 * tree uses, so the bound returns the same prefix on every read.
 *
 * Shedding the chain-position fields does NOT shed the parent itself: the
 * survivors' in-project parents come back as `flatParents`, because the Parent
 * column is rebuilt from `parentId` plus a `children` array and a promoted root
 * has neither. Dropping them here would make a filtered tab render an empty
 * Parent column — and, once every visible row is empty, no Parent column at all
 * — for rows whose parents the unfiltered tree shows (whitlockk, PR #6745).
 *
 * `externalParents` is narrowed to surviving ids for the same contract reason
 * `boundRootNodes` narrows it: an entry's `childId` must be present in
 * `nodes`.
 */
function filterTreeToCategory(
  nodes: TreeNode[],
  externalParents: ExternalParentLink[],
  canonicalParents: Map<string, ParentEdge>,
  artifactsById: Map<string, ArtifactWithAssignee>,
  category?: ProjectTreeCategory
): {
  nodes: TreeNode[];
  externalParents: ExternalParentLink[];
  flatParents: ExternalParentLink[];
} {
  if (category === undefined) {
    return { externalParents, flatParents: [], nodes };
  }
  const flat: TreeNode[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    if (!seen.has(node.root.id) && matchesTreeCategory(node.root, category)) {
      seen.add(node.root.id);
      flat.push({ children: [], root: node.root });
    }
    for (const child of node.children) {
      if (seen.has(child.id) || !matchesTreeCategory(child, category)) {
        continue;
      }
      seen.add(child.id);
      const {
        linkType: _linkType,
        depth: _depth,
        parentId: _parentId,
        ...root
      } = child;
      flat.push({ children: [], root });
    }
  }
  flat.sort(compareByStackRank);
  return {
    externalParents: externalParents.filter((entry) => seen.has(entry.childId)),
    flatParents: buildFlatParents(flat, canonicalParents, artifactsById),
    nodes: flat,
  };
}

/**
 * The in-project canonical parent of every node the category filter promoted to
 * a root, in the same order the nodes come back.
 *
 * Only the CANONICAL parent, so this cannot disagree with the lineage the
 * unfiltered tree nests by — both read `resolveCanonicalParents`. A node whose
 * parent lies outside the project is absent here and already covered by
 * `externalParents`; a genuine root is absent from both, which is the honest
 * "no parent" the Parent column renders as an em-dash.
 */
function buildFlatParents(
  nodes: TreeNode[],
  canonicalParents: Map<string, ParentEdge>,
  artifactsById: Map<string, ArtifactWithAssignee>
): ExternalParentLink[] {
  const links: ExternalParentLink[] = [];
  for (const node of nodes) {
    const edge = canonicalParents.get(node.root.id);
    const parent = edge && artifactsById.get(edge.parentId);
    if (edge && parent) {
      links.push({ childId: node.root.id, linkType: edge.linkType, parent });
    }
  }
  return links;
}

/**
 * Attach the flat result's parent context to the bounded response, narrowed to
 * the roots that survived the bound.
 *
 * Narrowed for the contract reason `boundRootNodes` narrows `externalParents`:
 * an entry names a `childId` the response promises to carry, and an entry whose
 * child was bounded away would leave the client holding a parent link to a row
 * it never received. Omitted rather than emitted empty, so the response an
 * unfiltered read has always produced is unchanged key-for-key.
 */
function withFlatParents(
  response: ProjectTreeResponse,
  flatParents: ExternalParentLink[]
): ProjectTreeResponse {
  const keptIds = new Set(response.nodes.map((node) => node.root.id));
  const kept = flatParents.filter((entry) => keptIds.has(entry.childId));
  if (kept.length === 0) {
    return response;
  }
  return { ...response, flatParents: kept };
}

/**
 * The server-side twin of the client's `filterByCategory` tab predicates
 * (`packages/app/documents/lib/table-view-pipeline.ts`): PRDs, issues, and
 * plans are DOCUMENT artifacts split by persisted subtype; branches are the
 * BRANCH artifact type. Subtypes here are post-`normalizeArtifactRowSubtype`,
 * so the input-only `ISSUE` alias has already been folded to `FEATURE`.
 */
function matchesTreeCategory(
  artifact: Pick<TreeNode["root"], "type" | "subtype">,
  category: ProjectTreeCategory
): boolean {
  switch (category) {
    case ProjectTreeCategory.Prds:
      return (
        artifact.type === ArtifactType.DOCUMENT &&
        artifact.subtype === ArtifactSubtype.Prd
      );
    case ProjectTreeCategory.Features:
      return (
        artifact.type === ArtifactType.DOCUMENT &&
        artifact.subtype === ArtifactSubtype.Feature
      );
    case ProjectTreeCategory.Plans:
      return (
        artifact.type === ArtifactType.DOCUMENT &&
        artifact.subtype === ArtifactSubtype.ImplementationPlan
      );
    case ProjectTreeCategory.Branches:
      return artifact.type === ArtifactType.BRANCH;
    default: {
      const exhaustive: never = category;
      return exhaustive;
    }
  }
}

/**
 * Per-artifact view details for the rows the tree read ALREADY loaded: tag
 * summaries for all artifacts.
 *
 * ISS-8857: this used to re-run the project scope against `artifacts` purely to
 * reach `tagArtifacts`, so every row crossed the wire twice. It now takes the
 * rows and reads the tag JOIN keyed by the ids already in hand. Keying it by id
 * is what puts the artifact COUNT into that statement's width, so the read owns
 * its own bind-parameter bound — see `TAG_RELATION_ID_CHUNK_SIZE` in
 * `project-tree-service/tag-relations-read.ts`. Nesting the tag relation inside the artifact
 * `include` would also select each row once, but it chains
 * `artifacts -> assignee -> tag_artifacts -> tags` into ONE serial round-trip
 * train ahead of everything else; measured on a 2000-artifact project that cost
 * ~44ms -> ~50ms, so the tag read is kept as its own query that runs CONCURRENTLY
 * with the tree assembly.
 */
async function buildArtifactViewDetails(
  rows: ArtifactRow[],
  organizationId: string,
  prefetchedTagRelations?: Map<string, TagRelationRow[]>
): Promise<Map<string, ArtifactViewDetails>> {
  const documentIds = rows
    .filter((row) => row.type === ArtifactType.DOCUMENT)
    .map((row) => row.id);
  const [tagRelationsByArtifact, versionsByArtifact, fieldValuesByArtifact] =
    await Promise.all([
      prefetchedTagRelations ??
        fetchTagRelationsByArtifact(rows.map((row) => row.id)),
      fetchDocumentVersionsByArtifact(organizationId, documentIds),
      readDocumentFieldValues(organizationId, documentIds),
    ]);

  const detailsById = new Map<string, ArtifactViewDetails>();
  for (const row of rows) {
    const tagRelations = tagRelationsByArtifact.get(row.id);
    const tags = tagRelations ? mapTagRelations(tagRelations) : [];
    const currentVersion = versionsByArtifact.get(row.id);
    const customFieldValues =
      row.type === ArtifactType.DOCUMENT && fieldValuesByArtifact !== null
        ? (fieldValuesByArtifact.get(row.id) ?? [])
        : undefined;
    if (
      tags.length > 0 ||
      currentVersion !== undefined ||
      customFieldValues !== undefined
    ) {
      detailsById.set(row.id, {
        ...(tags.length > 0 ? { tags } : {}),
        ...(currentVersion === undefined ? {} : { currentVersion }),
        ...(customFieldValues === undefined ? {} : { customFieldValues }),
      });
    }
  }
  return detailsById;
}

async function fetchContributorBranchIds(
  projectId: string,
  organizationId: string,
  contributorUserId: string | undefined
): Promise<string[] | null> {
  if (!contributorUserId) {
    return null;
  }
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.project_id = ${projectId}::uuid
        AND a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${branchContributorExistsSql(contributorUserId)}
    `)
  );
  return rows.map((row) => row.id);
}

async function fetchContributorBranchIdsById(
  organizationId: string,
  branchIds: string[],
  contributorUserId: string
): Promise<Set<string>> {
  if (branchIds.length === 0) {
    return new Set();
  }
  const rows = await withDb((db) =>
    db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT a.id
      FROM artifacts a
      WHERE a.id IN (${Prisma.join(branchIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND a.organization_id = ${organizationId}::uuid
        AND a.type = ${ArtifactType.BRANCH}::"ArtifactType"
        AND ${branchContributorExistsSql(contributorUserId)}
    `)
  );
  return new Set(rows.map((row) => row.id));
}

/**
 * The ONE read of a project's artifact scope, shared by the plain and the
 * detailed tree (ISS-8857). Both used to spell this `where` out for themselves,
 * which is how the scope came to be selected twice; a single owner also means a
 * predicate — above all `organizationId`, whose absence would be a cross-tenant
 * read — cannot be present on one spelling of the scope and missing from
 * another.
 */
function fetchProjectArtifacts(
  projectId: string,
  organizationId: string,
  contributorBranchIds: string[] | null
): Promise<ArtifactRow[]> {
  const contributorFilter =
    contributorBranchIds === null
      ? {}
      : {
          OR: [
            { type: { not: ArtifactType.BRANCH } },
            { id: { in: contributorBranchIds } },
          ],
        };
  return withDb((db) =>
    db.artifact.findMany({
      where: { projectId, organizationId, ...contributorFilter },
      include: { assignee: basicUserSelect },
    })
  );
}

function attachViewDetails<T extends { id: string }>(
  artifact: T,
  detailsById: Map<string, ArtifactViewDetails>
): T & ArtifactViewDetails {
  const details = detailsById.get(artifact.id);
  return details ? { ...artifact, ...details } : artifact;
}

function applyDocumentStatusMutation(
  artifactsById: Map<string, ArtifactWithAssignee>
): void {
  for (const [id, artifact] of artifactsById) {
    if (artifact.type === ArtifactType.DOCUMENT) {
      artifactsById.set(id, {
        ...artifact,
        statusMutation: buildDocumentStatusMutation(artifact.subtype),
      });
    }
  }
}

async function enrichArtifactRows(
  organizationId: string,
  artifacts: ArtifactRow[],
  artifactsById: Map<string, ArtifactWithAssignee>
): Promise<void> {
  const branchIds = artifacts
    .filter((artifact) => artifact.type === ArtifactType.BRANCH)
    .map((artifact) => artifact.id);
  const sessionIds = artifacts
    .filter((artifact) => artifact.type === ArtifactType.SESSION)
    .map((artifact) => artifact.id);
  const [eligibilityById, branchIdsWithFallback, displayedSessionStatusById] =
    await Promise.all([
      branchProductEligibilityService.findByIds(organizationId, branchIds),
      branchProviderFallbackService.findByIds(organizationId, branchIds),
      sessionDisplayedStatusService.findByIds(organizationId, sessionIds),
    ]);
  applyBranchProductEligibility(artifactsById, eligibilityById);
  applyBranchProviderFallbackAvailability(artifactsById, branchIdsWithFallback);
  applySessionDisplayedStatus(artifactsById, displayedSessionStatusById);
  applyDocumentStatusMutation(artifactsById);
}

function fetchArtifactLinks(
  organizationId: string,
  artifactIds: string[]
): Promise<CanonicalParentLinkRow[]> {
  if (artifactIds.length === 0) {
    return Promise.resolve([]);
  }

  return withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId,
        OR: [
          { sourceId: { in: artifactIds } },
          { targetId: { in: artifactIds } },
        ],
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: CANONICAL_PARENT_LINK_SELECT,
    })
  );
}

/**
 * Resolve cross-project incoming links into `ExternalParentLink` entries by
 * fetching each distinct external source artifact once and joining back to
 * the link rows. Skips links whose source artifact cannot be located in the
 * organization (defensive: handles soft-deletes or stale rows).
 */
async function buildExternalParents(
  projectId: string,
  organizationId: string,
  incomingExternalLinks: CanonicalParentLinkRow[],
  contributorUserId: string | undefined
): Promise<ExternalParentLink[]> {
  if (incomingExternalLinks.length === 0) {
    return [];
  }

  const externalSourceIds = Array.from(
    new Set(incomingExternalLinks.map((link) => link.sourceId))
  );

  const parents = await withDb((db) =>
    db.artifact.findMany({
      where: { id: { in: externalSourceIds }, organizationId },
      include: { assignee: basicUserSelect },
    })
  );

  const parentsById = new Map<string, ArtifactWithAssignee>(
    parents.map((p) => [p.id, normalizeArtifactRowSubtype(p)])
  );
  const externalBranchParentIds = parents
    .filter(
      (parent) =>
        parent.type === ArtifactType.BRANCH && parent.projectId !== projectId
    )
    .map((parent) => parent.id);
  const visibleContributorBranchIds = contributorUserId
    ? await fetchContributorBranchIdsById(
        organizationId,
        externalBranchParentIds,
        contributorUserId
      )
    : new Set<string>();

  const result: ExternalParentLink[] = [];
  for (const link of incomingExternalLinks) {
    const parent = parentsById.get(link.sourceId);
    if (!parent) {
      continue;
    }
    if (parent.projectId === projectId) {
      continue;
    }
    if (
      contributorUserId &&
      parent.type === ArtifactType.BRANCH &&
      !visibleContributorBranchIds.has(parent.id)
    ) {
      continue;
    }
    result.push({
      childId: link.targetId,
      parent,
      linkType: link.linkType,
    });
  }
  return result;
}

/**
 * Apply the optional `?limit=` root bound to an already-ordered tree
 * (ISS-5307), and say so when it bit.
 *
 * The bound is applied to ROOT NODES, not to artifacts: a root carries its
 * whole subtree, so slicing roots keeps every returned node's nesting intact
 * rather than stranding children whose parent fell off the end. `nodes` must
 * already be sorted by {@link compareByStackRank}, whose id tiebreaker is what
 * makes the same prefix come back on every read.
 *
 * `externalParents` is narrowed to the roots that survived. An external-parent
 * entry names a `childId` the contract promises is present in `nodes`; keeping
 * an entry whose child was bounded away would break that promise and leave the
 * client resolving a parent link to a row it never received.
 */
function boundRootNodes(
  nodes: TreeNode[],
  externalParents: ExternalParentLink[],
  limit?: number
): ProjectTreeResponse {
  if (limit === undefined || nodes.length <= limit) {
    // Complete read: OMIT `truncation` entirely. Returning it as `undefined`
    // would still emit the key for some serializers, and the contract reserves
    // absence as the claim of completeness.
    return { nodes, externalParents };
  }

  const boundedNodes = nodes.slice(0, limit);
  const keptIds = new Set<string>();
  for (const node of boundedNodes) {
    keptIds.add(node.root.id);
    for (const child of node.children) {
      keptIds.add(child.id);
    }
  }

  return {
    nodes: boundedNodes,
    externalParents: externalParents.filter((entry) =>
      keptIds.has(entry.childId)
    ),
    truncation: {
      anchorsIncluded: boundedNodes.length,
      // The whole graph was built in memory to find the roots, so this is the
      // exact root count — reported under a field named as a FLOOR, which an
      // exact value satisfies. No caller may render it as a precise "of N"
      // (the field name is the contract), and none does.
      anchorsMatchedAtLeast: nodes.length,
      // `satisfies` the PRODUCER set, not the wire set the field is typed
      // against: the open arm on `TreeTruncation.reasons` exists so a CONSUMER
      // can hold a reason a newer server invented, never so this build can
      // emit one it never declared.
      reasons: [
        TreeTruncationReason.AnchorCap,
      ] satisfies TreeTruncationReason[],
    },
  };
}

/** An artifact row as the tree read selects it: its columns plus its assignee. */
type ArtifactRow = Prisma.ArtifactGetPayload<{
  include: { assignee: typeof basicUserSelect };
}>;

const CANONICAL_PARENT_LINK_SELECT = {
  id: true,
  sourceId: true,
  targetId: true,
  linkType: true,
  sortOrder: true,
  metadata: true,
  createdAt: true,
} as const satisfies Record<keyof CanonicalParentLinkRow, true>;

async function loadProjectTreeCohort(
  projectId: string,
  organizationId: string,
  contributorBranchIds: string[] | null
): Promise<{
  artifacts: ArtifactRow[];
  tagRelations?: Map<string, TagRelationRow[]>;
}> {
  return {
    artifacts: await fetchProjectArtifacts(
      projectId,
      organizationId,
      contributorBranchIds
    ),
  };
}
