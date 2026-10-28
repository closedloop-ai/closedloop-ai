import {
  type AgentSessionFieldMutationError,
  staleSessionFieldsConflict,
} from "@repo/api/src/types/agent-session-field-mutation";
import type {
  ArtifactLink,
  ArtifactLinkPage,
  ArtifactParentProjection,
  BatchMoveArtifactsInput,
  BatchMoveArtifactsResult,
  CreateArtifactLinkInput,
} from "@repo/api/src/types/artifact";
import {
  type ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import { branchProductEligibilityService } from "@/app/branches/branch-product-eligibility-service";
import { lockProjectRank } from "@/app/documents/document-sort-order";
import type { BatchProjectChange } from "@/lib/artifact-activity-capture";
import { isAttributionEvidenceEnabledForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { getPrismaErrorCode, matchesPrismaP2002Target } from "@/lib/db-utils";
import {
  type RecordWriteInTransaction,
  writeInShape,
} from "@/lib/record-write-in-transaction";
import {
  deletedLinkImplementationBranchId,
  derivedImplementationBranchId,
  linkWriteRecord,
  refreshBranchImplementationEvidence,
} from "./link-implementation-evidence";
import {
  ARTIFACT_LINK_SELECT,
  artifactLinkInclude,
  collectBranchEndpointIds,
  hydrateLinksWithEndpoints,
  toArtifactLink,
  toArtifactLinkEndpoint,
  toArtifactLinkWithEndpoints,
} from "./link-projections";
import { reportOversizeLinkTree } from "./link-tree-oversize-log";
import {
  readLinkTreePage,
  saveLinkTreePages,
  sweepExpiredLinkTreePages,
} from "./link-tree-pages";
import { type AnnotatedLink, traverseLinkTree } from "./link-tree-traversal";
import {
  type ProducesLinkRefusal,
  refuseProducesLinkCycle,
  refuseProducesLinkDepth,
} from "./produces-link-admission";
import { nextProducesLinkSortOrder } from "./produces-link-sort-order";
import { attachSessionLinkEvidence } from "./resolved-link-evidence";
import { type ResolvedLinkWindow, splitPeekedPage } from "./resolved-page";

export const artifactLinksService = {
  sweepExpiredTreePages: sweepExpiredLinkTreePages,
  /**
   * Both endpoints must already be resolved artifact ids.
   *
   * The two failures a route maps to a 4xx are returned as values: a self-link
   * (`Status.BadRequest`) and a repeat of an existing
   * `@@unique([sourceId, targetId, linkType])` row (`Status.Conflict`).
   * `assertArtifactInOrg` still throws — that path is unchanged by ISS-7536.
   *
   * **A `Conflict` returned inside an ambient `withDb.tx` is terminal for that
   * transaction.** The value is recoverable to the CALLER, not to Postgres: the
   * constraint violation has already put the transaction in aborted state, so
   * every later statement on it fails with 25P02. A caller that handles
   * `Conflict` and keeps querying in the same transaction must open a new one —
   * see `decompose-handler.ts`, which rethrows for exactly this reason.
   */
  async createLink(
    organizationId: string,
    input: CreateArtifactLinkInput,
    recordCreated?: RecordWriteInTransaction<ArtifactLink>
  ): Promise<Result<ArtifactLink, CreateArtifactLinkFailure>> {
    // Ahead of the endpoint reads: the two ids are identical, so rejecting here
    // discloses nothing the caller did not already send.
    if (input.sourceId === input.targetId) {
      return Result.err(Status.BadRequest);
    }

    // ISS-12552 (PRD-800 "Rollout"): read before the link transaction
    // opens. With the flag off, or a link that changes no branch's
    // implementation, nothing is derived; with no receipt either, the link is
    // written exactly as on main (flag-off parity).
    const recordLink = linkWriteRecord(
      organizationId,
      await derivedImplementationBranchId(organizationId, input),
      recordCreated
    );
    try {
      return await writeInShape(recordLink, {
        unrecorded: async () => {
          const link =
            input.linkType === LinkType.Produces
              ? await createProducesLinkUnderPlacementLocks(
                  organizationId,
                  input
                )
              : await createOrdinaryLink(organizationId, input);
          if ("refusal" in link) {
            return Result.err(link.refusal);
          }
          return Result.ok(toArtifactLink(link));
        },
        recorded: async (record) => {
          const outcome = await withDb.tx(async (tx) => {
            const created =
              input.linkType === LinkType.Produces
                ? await createProducesLinkUnderPlacementLocks(
                    organizationId,
                    input
                  )
                : await createOrdinaryLink(organizationId, input);
            if ("refusal" in created) {
              return created;
            }
            const link = toArtifactLink(created);
            await record(tx, link);
            return { link };
          });
          if ("refusal" in outcome) {
            return Result.err(outcome.refusal);
          }
          return Result.ok(outcome.link);
        },
      });
    } catch (error) {
      if (isDuplicateArtifactLinkViolation(error)) {
        return Result.err(Status.Conflict);
      }
      throw error;
    }
  },

  /**
   * Find links where `artifactId` is either source or target.
   */
  findLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          OR: [
            { sourceId: artifactId, ...(linkType ? { linkType } : {}) },
            { targetId: artifactId, ...(linkType ? { linkType } : {}) },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: ARTIFACT_LINK_SELECT,
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links where the given artifact is the target.
   * Returns links whose source side "produced" (or otherwise relates to) it.
   */
  findSourceLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          targetId: artifactId,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: ARTIFACT_LINK_SELECT,
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links where the given artifact is the source.
   * Returns what the source "produces" or links to.
   */
  findTargetLinks(
    organizationId: string,
    artifactId: string,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    return withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          sourceId: artifactId,
          ...(linkType ? { linkType } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: ARTIFACT_LINK_SELECT,
      })
    ).then((links) => links.map(toArtifactLink));
  },

  /**
   * Find links by direction (source / target / both).
   */
  findLinksByDirection(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    linkType?: LinkType
  ): Promise<ArtifactLink[]> {
    if (direction === LinkDirection.Source) {
      return artifactLinksService.findSourceLinks(
        organizationId,
        artifactId,
        linkType
      );
    }
    if (direction === LinkDirection.Target) {
      return artifactLinksService.findTargetLinks(
        organizationId,
        artifactId,
        linkType
      );
    }
    return artifactLinksService.findLinks(organizationId, artifactId, linkType);
  },

  /**
   * One page of links, each with a resolved source/target endpoint object.
   * Pairs with the `/artifact-links/resolved` route.
   *
   * ISS-10102: reads `window` rows, never the whole match set. `createdAt desc`
   * alone is a PARTIAL order — two links written in the same millisecond can
   * swap places between two reads, which for an offset cursor means a row
   * served twice and another never served at all — so `id desc` breaks the tie
   * and makes the order total.
   */
  async findResolvedLinksPage(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    window: ResolvedLinkWindow,
    linkType?: LinkType
  ): Promise<ArtifactLinkPage> {
    const peeked = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          ...buildDirectionFilter(artifactId, direction),
          ...(linkType ? { linkType } : {}),
        },
        include: artifactLinkInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: window.skip,
        take: window.take,
      })
    );
    const { pageLinks, nextCursor } = splitPeekedPage(peeked, window);

    const eligibilityById = await branchProductEligibilityService.findByIds(
      organizationId,
      collectBranchEndpointIds(pageLinks)
    );
    const links = pageLinks.map((link) =>
      toArtifactLinkWithEndpoints(link, eligibilityById)
    );
    // ISS-12552 (Daveth Oakhurst, 2026-10-19): with
    // attribution-evidence-policy off for the organization (PRD-800),
    // SESSION rows carry no sessionEvidence.
    const items = (await isAttributionEvidenceEnabledForOrganization(
      organizationId
    ))
      ? await attachSessionLinkEvidence(organizationId, links)
      : links;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  },

  /**
   * Return one selected direct parent projection per requested target artifact.
   * This is a convenience view over ArtifactLink lineage; full lineage
   * traversal remains owned by the direct/tree artifact-link APIs.
   */
  async findSelectedParentProjections(
    organizationId: string,
    targetIds: string[],
    options: { linkType?: LinkType } = {}
  ): Promise<ArtifactParentProjection[]> {
    if (targetIds.length === 0) {
      return [];
    }

    const projectionsByTargetId = new Map<string, ArtifactParentProjection>();
    for (const targetId of targetIds) {
      projectionsByTargetId.set(targetId, {
        targetId,
        linkId: null,
        linkType: null,
        linkCreatedAt: null,
        parentArtifact: null,
      });
    }

    const rows = await withDb((db) =>
      db.artifactLink.findMany({
        where: {
          organizationId,
          targetId: { in: targetIds },
          linkType: options.linkType ?? LinkType.Produces,
        },
        include: artifactLinkInclude,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
    const eligibilityById = await branchProductEligibilityService.findByIds(
      organizationId,
      collectBranchEndpointIds(rows)
    );

    for (const row of rows) {
      const projection = projectionsByTargetId.get(row.targetId);
      if (!projection || projection.parentArtifact !== null) {
        continue;
      }
      projection.linkId = row.id;
      projection.linkType = row.linkType;
      projection.linkCreatedAt = row.createdAt;
      projection.parentArtifact = toArtifactLinkEndpoint(
        row.source,
        eligibilityById
      );
    }

    return targetIds.map((targetId) => ({
      ...(projectionsByTargetId.get(targetId) ?? {
        targetId,
        linkId: null,
        linkType: null,
        linkCreatedAt: null,
        parentArtifact: null,
      }),
    }));
  },

  async findResolvedLinkTreePage(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    maxDepth: number,
    window: ResolvedLinkWindow,
    linkType?: LinkType
  ): Promise<ArtifactLinkPage> {
    // ISS-12552 (Daveth Oakhurst, 2026-10-19): with
    // attribution-evidence-policy off for the organization (PRD-800),
    // SESSION rows carry no sessionEvidence, on the cached page and the
    // freshly traversed one alike.
    const sessionEvidenceEnabled =
      await isAttributionEvidenceEnabledForOrganization(organizationId);
    const scope = { organizationId, artifactId, direction, maxDepth, linkType };
    const cached = await readLinkTreePage(scope, window);
    if (cached) {
      const { pageLinks, ...continuation } = cached;
      const hydrated = await hydrateLinksWithEndpoints(
        organizationId,
        pageLinks
      );
      const items = sessionEvidenceEnabled
        ? await attachSessionLinkEvidence(organizationId, hydrated)
        : hydrated;
      return { items, ...continuation };
    }
    const annotated = await artifactLinksService.findLinkTree(
      organizationId,
      artifactId,
      direction,
      maxDepth,
      linkType
    );
    if (annotated.length === 0) {
      return { items: [] };
    }

    const links = annotated.map((entry) => entry.link);
    reportOversizeLinkTree({
      organizationId,
      artifactId,
      direction,
      maxDepth,
      linkType,
      links,
    });

    const { pageLinks, nextCursor } = splitPeekedPage(
      links.slice(window.skip, window.skip + window.take),
      window
    );
    const snapshotId = await saveLinkTreePages(scope, links, window);
    const hydrated = await hydrateLinksWithEndpoints(organizationId, pageLinks);
    const items = sessionEvidenceEnabled
      ? await attachSessionLinkEvidence(organizationId, hydrated)
      : hydrated;
    return nextCursor === undefined
      ? { items }
      : { items, nextCursor, ...(snapshotId ? { snapshotId } : {}) };
  },

  /**
   * Traverse the link graph breadth-first from `artifactId`.
   *
   * Delegates to {@link traverseLinkTree}, which reads one statement per depth
   * level rather than one per node. Kept on the service because `service.ts`
   * stays the only export a route consumes.
   */
  findLinkTree(
    organizationId: string,
    artifactId: string,
    direction: LinkDirection,
    maxDepth: number,
    linkType?: LinkType
  ): Promise<AnnotatedLink[]> {
    return traverseLinkTree(
      organizationId,
      artifactId,
      direction,
      maxDepth,
      linkType
    );
  },

  /**
   * Return all artifacts reachable downstream via PRODUCES links, deduplicated
   * (excludes the starting artifact).
   */
  async findDownstreamArtifactIds(
    organizationId: string,
    artifactId: string
  ): Promise<string[]> {
    const annotated = await artifactLinksService.findLinkTree(
      organizationId,
      artifactId,
      LinkDirection.Target,
      50,
      LinkType.Produces
    );

    const seen = new Set<string>();
    const out: string[] = [];
    for (const { link, fromArtifactId } of annotated) {
      const otherId = getOtherSide(link, fromArtifactId);
      if (otherId !== artifactId && !seen.has(otherId)) {
        seen.add(otherId);
        out.push(otherId);
      }
    }
    return out;
  },

  async batchMoveArtifacts(
    organizationId: string,
    input: BatchMoveArtifactsInput
  ): Promise<
    Result<
      BatchMoveArtifactsServiceResult,
      StatusCode | AgentSessionFieldMutationError
    >
  > {
    // Validation + graph traversal + write run inside a single transaction
    // so the downstream set and target project are read from the same
    // snapshot as the updateMany. Prevents TOCTOU where a concurrent caller
    // deletes the source artifact or reparents a downstream link between
    // our validation and our write.
    const result = await withDb.tx(
      async (
        tx
      ): Promise<
        Result<
          BatchMoveArtifactsServiceResult,
          StatusCode | AgentSessionFieldMutationError
        >
      > => {
        const [source, targetProject] = await Promise.all([
          tx.artifact.findFirst({
            where: { id: input.artifactId, organizationId },
            select: { id: true, type: true },
          }),
          input.targetProjectId === null
            ? Promise.resolve(null)
            : tx.project.findUnique({
                where: { id: input.targetProjectId, organizationId },
                select: { id: true },
              }),
        ]);
        if (!source) {
          return Result.err(Status.NotFound);
        }
        if (input.targetProjectId !== null && !targetProject) {
          return Result.err(Status.BadRequest);
        }

        const idsToMove = [source.id];
        if (input.includeDownstream) {
          // findDownstreamArtifactIds uses withDb(); inside this tx callback
          // the AsyncLocalStorage-backed tx propagates automatically, so the
          // BFS reads from the same snapshot.
          const downstream =
            await artifactLinksService.findDownstreamArtifactIds(
              organizationId,
              source.id
            );
          idsToMove.push(...downstream);
        }

        const rows = await lockArtifactRowsForMove(
          tx,
          idsToMove,
          organizationId
        );
        const conflict = staleMoveConflict(input, rows);
        if (conflict) {
          return Result.err(conflict);
        }
        await tx.artifact.updateMany({
          where: { id: { in: idsToMove }, organizationId },
          data: { projectId: input.targetProjectId },
        });
        const moved = rows.map((r) => ({
          id: r.id,
          type: r.type,
        }));

        if (moved.length === 0) {
          return Result.err(Status.NotFound);
        }

        return Result.ok({
          movedArtifacts: moved,
          projectChanges: rows.map((r) => ({
            artifactId: r.id,
            before: r.projectId,
            after: input.targetProjectId,
          })),
        });
      }
    );

    if (result.ok) {
      log.info("[artifact-links-service] Batch moved artifacts", {
        organizationId,
        targetProjectId: input.targetProjectId,
        actualCount: result.value.movedArtifacts.length,
      });
    }

    return result;
  },

  /**
   * Delete one link, and report the dependents whose blocker set just shrank.
   *
   * ISS-9632 counts a blocker as resolved when its source went terminal OR the
   * `BLOCKS` edge no longer exists, so removing the last live edge has to wake
   * the unblock resolver exactly as terminalizing the last live blocker does.
   * The caller passes `unblockCandidateIds` to `resolveBlocksForRemovedEdges`;
   * without it a dependent whose remaining blockers were already terminal stays
   * `BLOCKED` with nothing holding it.
   *
   * Empty for a non-`BLOCKS` link, and empty when the delete matched no row — a
   * link outside the caller's org must not name one of its artifacts.
   */
  async deleteLink(
    id: string,
    organizationId: string,
    recordDeleted?: RecordWriteInTransaction<{ deleted: boolean }>
  ): Promise<{ unblockCandidateIds: string[]; deleted: boolean }> {
    // ISS-12552 (PRD-800 "Rollout"): read before the delete transaction
    // opens, and the link only while the flag is on, so with it off the
    // delete reads exactly what it did on main (flag-off parity).
    const derivedBranchId = await deletedLinkImplementationBranchId(
      id,
      organizationId
    );
    return await withDb.tx(async (tx) => {
      const link = await tx.artifactLink.findFirst({
        where: { id, organizationId },
        select: { targetId: true, linkType: true },
      });
      const { count } = await tx.artifactLink.deleteMany({
        where: { id, organizationId },
      });
      // ISS-12552: `deleted` lets the operation receipt tell a real delete
      // from one that matched no row (already gone, or another org's link).
      const deleted = count > 0;
      if (deleted && derivedBranchId) {
        await refreshBranchImplementationEvidence(
          tx,
          organizationId,
          derivedBranchId
        );
      }
      await recordDeleted?.(tx, { deleted });
      if (!deleted || link?.linkType !== LinkType.Blocks) {
        return { unblockCandidateIds: [], deleted };
      }
      return { unblockCandidateIds: [link.targetId], deleted };
    });
  },
};

async function assertArtifactInOrg(
  organizationId: string,
  artifactId: string
): Promise<void> {
  const artifact = await withDb((db) =>
    db.artifact.findFirst({
      where: { id: artifactId, organizationId },
      select: { id: true },
    })
  );
  if (!artifact) {
    throw new Error(`Artifact ${artifactId} not found in organization`);
  }
}

async function createOrdinaryLink(
  organizationId: string,
  input: CreateArtifactLinkInput
) {
  await Promise.all([
    assertArtifactInOrg(organizationId, input.sourceId),
    assertArtifactInOrg(organizationId, input.targetId),
  ]);
  return withDb((db) =>
    db.artifactLink.create({
      data: {
        organizationId,
        sourceId: input.sourceId,
        targetId: input.targetId,
        linkType: input.linkType,
        metadata: input.metadata ?? Prisma.DbNull,
      },
    })
  );
}

function createProducesLinkUnderPlacementLocks(
  organizationId: string,
  input: CreateArtifactLinkInput
) {
  return withDb.tx(async (tx) => {
    const endpoints = await readLinkEndpoints(tx, organizationId, input);
    for (const projectId of [
      ...new Set(
        endpoints.flatMap((endpoint) =>
          endpoint.projectId ? [endpoint.projectId] : []
        )
      ),
    ].sort()) {
      await lockProjectRank(tx, projectId);
    }
    const lockedEndpoints = await readLinkEndpoints(tx, organizationId, input);
    assertLinkEndpointsPresent(lockedEndpoints, input);
    const sortOrder = await nextProducesLinkSortOrder(
      tx,
      organizationId,
      input.sourceId
    );
    const refusal =
      (await refuseProducesLinkCycle(
        tx,
        organizationId,
        input.sourceId,
        input.targetId
      )) ??
      (await refuseProducesLinkDepth(
        tx,
        organizationId,
        input,
        lockedEndpoints
      ));
    if (refusal) {
      return { refusal };
    }
    return tx.artifactLink.create({
      data: {
        organizationId,
        sourceId: input.sourceId,
        targetId: input.targetId,
        linkType: input.linkType,
        sortOrder,
        metadata: input.metadata ?? Prisma.DbNull,
      },
    });
  });
}

function readLinkEndpoints(
  tx: TransactionClient,
  organizationId: string,
  input: CreateArtifactLinkInput
) {
  return tx.artifact.findMany({
    where: {
      organizationId,
      id: { in: [input.sourceId, input.targetId] },
    },
    select: { id: true, projectId: true },
  });
}

function assertLinkEndpointsPresent(
  endpoints: { id: string }[],
  input: CreateArtifactLinkInput
): void {
  const endpointIds = new Set(endpoints.map((endpoint) => endpoint.id));
  for (const artifactId of [input.sourceId, input.targetId]) {
    if (!endpointIds.has(artifactId)) {
      throw new Error(`Artifact ${artifactId} not found in organization`);
    }
  }
}

function buildDirectionFilter(
  artifactId: string,
  direction: LinkDirection
): Prisma.ArtifactLinkWhereInput {
  if (direction === LinkDirection.Source) {
    return { targetId: artifactId };
  }
  if (direction === LinkDirection.Target) {
    return { sourceId: artifactId };
  }
  return { OR: [{ sourceId: artifactId }, { targetId: artifactId }] };
}

function getOtherSide(link: ArtifactLink, fromArtifactId: string): string {
  return link.sourceId === fromArtifactId ? link.targetId : link.sourceId;
}

/**
 * The only failures `createLink` reports as values. Narrower than `StatusCode`
 * on purpose: it makes the route's mapper exhaustive, so a third failure added
 * later fails typecheck instead of falling through to a 500 at runtime.
 */
export type CreateArtifactLinkFailure =
  | typeof Status.BadRequest
  | typeof Status.Conflict
  | ProducesLinkRefusal;

/**
 * The `@@unique([sourceId, targetId, linkType])` index from
 * `20260422180000_artifact_parent_additive`. Adapters disagree on what they put
 * in `meta.target` — some the index name, some the model fields, some the
 * columns — so every shape apps/api/AGENTS.md requires handling is listed, and
 * the real-database case is pinned by the integration suite.
 */
const ARTIFACT_LINK_UNIQUE_INDEX =
  "artifact_links_source_id_target_id_link_type_key";

const ARTIFACT_LINK_UNIQUE_COLUMNS = ["source_id", "target_id", "link_type"];
const ARTIFACT_LINK_UNIQUE_FIELDS = ["sourceId", "targetId", "linkType"];

/**
 * A P2002 whose target is NOT this index is a different constraint failing and
 * is re-thrown: reporting it as "this link already exists" would tell the
 * caller to stop retrying a write that never conflicted on the link itself.
 */
function isDuplicateArtifactLinkViolation(error: unknown): boolean {
  if (getPrismaErrorCode(error) !== "P2002") {
    return false;
  }
  return matchesPrismaP2002Target(error, matchesArtifactLinkUniqueTarget);
}

function matchesArtifactLinkUniqueTarget(target: unknown): boolean {
  if (typeof target === "string") {
    return target === ARTIFACT_LINK_UNIQUE_INDEX;
  }
  if (!Array.isArray(target)) {
    return false;
  }
  // The WHOLE field set, not any one member. Matching on a single field would
  // classify a future `@@unique([organizationId, sourceId, linkType])` — which
  // reports `["organization_id", "source_id", "link_type"]` — as this index and
  // report an unrelated conflict to the caller as a duplicate link.
  return (
    target.includes(ARTIFACT_LINK_UNIQUE_INDEX) ||
    coversEveryColumn(target, ARTIFACT_LINK_UNIQUE_COLUMNS) ||
    coversEveryColumn(target, ARTIFACT_LINK_UNIQUE_FIELDS)
  );
}

function coversEveryColumn(target: unknown[], required: string[]): boolean {
  return (
    target.length === required.length &&
    required.every((column) => target.includes(column))
  );
}

/**
 * `batchMoveArtifacts`'s internal answer: the wire `movedArtifacts` plus the
 * per-row project transition read in the same transaction as the write
 * (ISS-9158). The route feeds `projectChanges` to `captureBatchProjectChange`
 * and serializes only the declared {@link BatchMoveArtifactsResult}.
 */
export type BatchMoveArtifactsServiceResult = BatchMoveArtifactsResult & {
  projectChanges: BatchProjectChange[];
};

type LockedMoveRow = {
  id: string;
  type: ArtifactType;
  projectId: string | null;
};

/**
 * The before-`projectId` read is authoritative only if the row cannot move
 * between it and the `updateMany`: under READ COMMITTED an unlocked read lets
 * two concurrent moves both see project A and then record A→B and A→C, the
 * second of which never happened. Same `FOR NO KEY UPDATE`, same
 * `ORDER BY "id" ASC`, as the status and priority batches take on this table,
 * so none of them can deadlock against another (ISS-9440). No type filter: this
 * route moves any artifact type.
 */
/**
 * Refuse the move when the caller's `expectedProjectId` disagrees with the
 * project the SOURCE artifact actually holds, or `null` when no guard was sent.
 *
 * Decided against the LOCKED row, inside the same transaction as the
 * `updateMany`: a comparison against a value read before
 * {@link lockArtifactRowsForMove} would be a second read-then-write, the exact
 * defect ISS-10995 removed from `upsertBranchArtifact`. Only the artifact the
 * caller NAMED is guarded — a downstream row it never saw carries no
 * expectation.
 *
 * The conflict envelope is `PATCH /agent-sessions/{id}`'s, reused whole
 * (`stale_project_id`, `details.staleProjectIds`), so a client already parsing
 * that route's refusal parses this one (Cosimo Corrigan, 2026-10-12).
 */
function staleMoveConflict(
  input: BatchMoveArtifactsInput,
  rows: readonly LockedMoveRow[]
): AgentSessionFieldMutationError | null {
  const { expectedProjectId } = input;
  const source = rows.find((row) => row.id === input.artifactId);
  // `isStaleExpectation` owns both exemptions — an ABSENT expectation
  // (unguarded, which the bulk Move dialog and the documents batch path rely
  // on) and a write already at the requested value, so a retry cannot 409
  // against its own earlier success. The `undefined` arm here is not a second
  // copy of the first: it NARROWS for the conflict's `string | null` field
  // below, which cannot carry "no expectation".
  if (
    expectedProjectId === undefined ||
    !source ||
    !isStaleExpectation(
      source.projectId,
      input.targetProjectId,
      expectedProjectId
    )
  ) {
    return null;
  }
  return staleSessionFieldsConflict({
    projectId: {
      documentId: input.artifactId,
      currentProjectId: source.projectId,
      expectedProjectId,
    },
  });
}

function lockArtifactRowsForMove(
  tx: TransactionClient,
  artifactIds: string[],
  organizationId: string
): Promise<LockedMoveRow[]> {
  const artifactIdSql = Prisma.join(
    artifactIds.map((artifactId) => Prisma.sql`${artifactId}::uuid`)
  );
  return tx.$queryRaw<LockedMoveRow[]>(Prisma.sql`
    SELECT "id", "type", "project_id" AS "projectId"
    FROM "artifacts"
    WHERE "id" IN (${artifactIdSql})
      AND "organization_id" = ${organizationId}::uuid
    ORDER BY "id" ASC
    FOR NO KEY UPDATE
  `);
}
