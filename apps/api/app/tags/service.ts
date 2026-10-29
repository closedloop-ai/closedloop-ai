import type { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactFieldEditOutcome,
  type ArtifactFieldEditReceiptContext,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { AuditAction } from "@repo/api/src/types/audit";
import type {
  CreateTagInput,
  TagEntityType as TagEntityTypeValue,
  TagListPage,
  UpdateTagInput,
} from "@repo/api/src/types/tag";
import {
  TAG_COLORS,
  TAG_LIST_DEFAULT_LIMIT,
  TagEntityType,
} from "@repo/api/src/types/tag";
import { Prisma, withDb } from "@repo/database";
import { dispatchSingleArtifactMutationAudits } from "@/app/audit/single-artifact-mutation-audit";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import { basicUserSelect, getPrismaErrorCode } from "@/lib/db-utils";
import {
  reconcileLinkedPullRequestLabelsForArtifact,
  reconcileLinkedPullRequestLabelsForArtifacts,
} from "@/lib/github/artifact-tag-label-reconciliation";
import { fieldsThatMoved } from "@/lib/operation-receipts/changed-fields";
import {
  type RecordWriteInTransaction,
  writeInShape,
  writeRecorded,
} from "@/lib/record-write-in-transaction";
import { escapeSqlLikeLiteral } from "@/lib/sql-like";
import {
  captureSingleTagReceipt,
  emitSingleTagAnalytics,
  isReceiptArtifactType,
} from "./artifact-tag-field-edit-side-effects";
import type { RecordBatchTagReceipt } from "./batch-tag-locks";
import { isDuplicateArtifactTagRelationViolation } from "./tag-relation-unique-violation";

export class DuplicateNameError extends Error {
  constructor(name: string) {
    super(`A tag named "${name}" already exists in this organization.`);
    this.name = "DuplicateNameError";
  }
}

const TAG_INCLUDE = {
  createdBy: basicUserSelect,
  _count: {
    select: {
      tagProjects: true,
      tagArtifacts: true,
    },
  },
} as const;

export const tagService = {
  findByOrg(organizationId: string) {
    return withDb((db) =>
      db.tag.findMany({
        where: { organizationId },
        include: TAG_INCLUDE,
        orderBy: { name: "asc" },
      })
    );
  },

  /**
   * The filtered and bounded org read (ISS-7461).
   *
   * ALWAYS takes a bound. Every param that routes here — `limit`, `offset`,
   * `search` — is refused by the validator without a `limit`, so the route
   * cannot reach this method unbounded; the `?? TAG_LIST_DEFAULT_LIMIT` floor
   * is defense in depth for a direct service caller, the same posture (and the
   * same constant) as {@link findPageByOrg}. There is deliberately no
   * unbounded-but-filtered branch: an unindexed `name contains` over the whole
   * org is more work than the plain `findByOrg` it would look narrower than.
   */
  findManyByOrg(organizationId: string, query: TagListReadQuery) {
    const take = query.limit ?? TAG_LIST_DEFAULT_LIMIT;
    return withDb((db) =>
      db.tag.findMany({
        where: buildTagListWhere(organizationId, query.search),
        include: TAG_INCLUDE,
        // Stable ordering is a precondition for LIMIT/OFFSET, not decoration:
        // without a total order a page boundary can skip or repeat a row. The
        // `(organization_id, lower(name))` unique index forbids name ties
        // inside an org, so ordering by name alone is total here.
        orderBy: { name: "asc" },
        take,
        ...(query.offset === undefined ? {} : { skip: query.offset }),
      })
    );
  },

  /**
   * The page plus a real server-side total, for `?includeTotal=true`.
   *
   * Both statements run inside ONE `RepeatableRead` transaction so they observe
   * the same MVCC snapshot. Read separately, a tag created or deleted between
   * them yields an internally contradictory envelope — 25 items with a total of
   * 24, or `hasMore: false` while another matching row existed.
   *
   * `hasMore` derives from the real total rather than from "the page came back
   * full", which would claim a phantom next page whenever the last page happens
   * to fill exactly.
   */
  findPageByOrg(organizationId: string, query: TagListReadQuery) {
    // Defense in depth for a direct service caller. The route can never reach
    // here without a `limit` — the validator's `includeTotal requires limit`
    // refine rejects that combination — so this fallback is a floor, not the
    // mechanism.
    const take = query.limit ?? TAG_LIST_DEFAULT_LIMIT;
    const skip = query.offset ?? 0;
    return withDb.tx(
      async () => {
        const where = buildTagListWhere(organizationId, query.search);
        const items = await withDb((db) =>
          db.tag.findMany({
            where,
            include: TAG_INCLUDE,
            orderBy: { name: "asc" },
            take,
            skip,
          })
        );
        const total = await withDb((db) => db.tag.count({ where }));
        return {
          items,
          total,
          hasMore: skip + items.length < total,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
    );
  },

  /**
   * Resolve one tag by exact, case-insensitive name — the name-resolution path
   * behind `tag-artifact` / `untag-artifact` (ISS-7461).
   *
   * Raw SQL, deliberately. The guarantee this read needs comes from
   * `tags_organization_id_name_ci_key`, a UNIQUE index on the EXPRESSION
   * `(organization_id, lower(name))`, and the only predicate PostgreSQL can
   * match to it is `lower(name) = lower($n)`. Prisma cannot emit a function
   * call on the column side — its `mode: "insensitive"` compiles to a bare
   * `ILIKE`, which no expression index serves — and the index is
   * raw-migration-only, so Prisma does not know it exists. One statement, one
   * index scan, and the unique index makes the result 0-or-1 by construction.
   *
   * The `::uuid` cast is required: `organization_id` is `@db.Uuid` and the
   * driver binds a JS string as text.
   *
   * Columns are projected and aliased rather than hydrated through a second
   * `findUnique`, so this stays ONE round trip. `createdBy` is optional on
   * `Tag` and `_count` is a Prisma include extra rather than part of the type,
   * so the projection satisfies the contract without them — see the route
   * docstring, which records that this branch's row is the leaner one.
   */
  async findByExactName(
    organizationId: string,
    name: string
  ): Promise<ExactNameTagRow | null> {
    const rows = await withDb((db) =>
      db.$queryRaw<ExactNameTagRow[]>(Prisma.sql`
        SELECT id,
               organization_id AS "organizationId",
               name,
               color,
               created_by_id   AS "createdById",
               created_at      AS "createdAt",
               updated_at      AS "updatedAt"
        FROM tags
        WHERE organization_id = ${organizationId}::uuid
          AND lower(name) = lower(${name})
        LIMIT 1
      `)
    );
    return rows[0] ?? null;
  },

  async create(
    organizationId: string,
    userId: string,
    input: CreateTagInput,
    /**
     * Runs on the insert's transaction (ISS-12552). Without it the insert is
     * main's single autocommit statement.
     */
    recordWrite?: RecordWriteInTransaction<{ id: string }>
  ) {
    const existing = await withDb((db) =>
      db.tag.findFirst({
        where: {
          organizationId,
          name: { equals: input.name, mode: "insensitive" },
        },
        select: { id: true },
      })
    );
    if (existing) {
      throw new DuplicateNameError(input.name);
    }

    const color = input.color ?? (await pickDefaultColor(organizationId));

    try {
      return await writeRecorded(
        recordWrite,
        () =>
          withDb((db) =>
            db.tag.create({
              data: {
                organizationId,
                createdById: userId,
                name: input.name,
                color,
              },
              include: TAG_INCLUDE,
            })
          ),
        (tag) => tag
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name);
      }
      throw error;
    }
  },

  async update(
    id: string,
    organizationId: string,
    input: UpdateTagInput,
    /**
     * Runs on the update's transaction with the fields that moved
     * (ISS-12552). Without it the update is main's single autocommit statement.
     */
    recordWrite?: RecordWriteInTransaction<{ changedFields: string[] }>
  ) {
    if (input.name) {
      const existing = await withDb((db) =>
        db.tag.findFirst({
          where: {
            organizationId,
            name: { equals: input.name, mode: "insensitive" },
            id: { not: id },
          },
          select: { id: true },
        })
      );
      if (existing) {
        throw new DuplicateNameError(input.name);
      }
    }

    try {
      return await writeInShape(recordWrite, {
        unrecorded: () =>
          withDb((db) =>
            db.tag.update({
              where: { id, organizationId },
              data: {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.color === undefined ? {} : { color: input.color }),
              },
              include: TAG_INCLUDE,
            })
          ),
        recorded: (record) =>
          withDb.tx(async (tx) => {
            const previous = await tx.tag.findFirst({
              where: { id, organizationId },
              select: { name: true, color: true },
            });
            const tag = await tx.tag.update({
              where: { id, organizationId },
              data: {
                ...(input.name === undefined ? {} : { name: input.name }),
                ...(input.color === undefined ? {} : { color: input.color }),
              },
              include: TAG_INCLUDE,
            });
            await record(tx, {
              changedFields: fieldsThatMoved(
                TAG_DEFINITION_FIELDS,
                input,
                previous ?? {},
                tag
              ),
            });
            return tag;
          }),
      });
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        throw new EntityNotFoundError("Tag", id);
      }
      if (getPrismaErrorCode(error) === "P2002") {
        throw new DuplicateNameError(input.name ?? "");
      }
      throw error;
    }
  },

  async delete(
    id: string,
    organizationId: string,
    /**
     * Runs on the delete's transaction (ISS-12552). Without it the delete is
     * main's single autocommit statement.
     */
    recordWrite?: RecordWriteInTransaction<{ id: string }>
  ) {
    try {
      await writeRecorded(
        recordWrite,
        () => withDb((db) => db.tag.delete({ where: { id, organizationId } })),
        () => ({ id })
      );
    } catch (error) {
      if (getPrismaErrorCode(error) === "P2025") {
        throw new EntityNotFoundError("Tag", id);
      }
      throw error;
    }
  },

  async applyTag(
    tagId: string,
    entityType: TagEntityTypeValue,
    entityId: string,
    organizationId: string,
    actor: ActivityActor,
    context?: ArtifactFieldEditReceiptContext,
    /** Runs on the write's transaction once the tag row is inserted. */
    recordApplied?: RecordWriteInTransaction<{ tagId: string }>
  ): Promise<boolean> {
    let receiptArtifactType: ArtifactType | null = null;
    try {
      // Validate ownership/existence and write in one transaction so a
      // concurrently deleted entity cannot pass validation and then leave a
      // phantom row (TOCTOU). The inner withDb() calls in the validators join
      // this ambient transaction.
      const appliedToArtifact = await withDb.tx(async (tx) => {
        await validateTagOwnership(tagId, organizationId);
        const artifactType = await validateEntityExists(
          entityType,
          entityId,
          organizationId
        );
        receiptArtifactType = artifactType;

        switch (entityType) {
          case TagEntityType.Project:
            await withDb((db) =>
              db.tagProject.create({
                data: { tagId, projectId: entityId },
                select: { id: true },
              })
            );
            break;
          case TagEntityType.Artifact:
            await withDb((db) =>
              db.tagArtifact.create({
                data: { tagId, artifactId: entityId },
                select: { id: true },
              })
            );
            if (isReceiptArtifactType(artifactType)) {
              await captureSingleTagReceipt({
                tx,
                organizationId,
                artifactId: entityId,
                actor,
                before: null,
                after: tagId,
                ...(context === undefined ? {} : { context }),
              });
            }
            break;
          default:
            throw new Error(`Unknown entity type: ${entityType as string}`);
        }
        await recordApplied?.(tx, { tagId });
        return entityType === TagEntityType.Artifact;
      });
      if (appliedToArtifact) {
        dispatchSingleArtifactMutationAudits({
          organizationId,
          userId: actor.userId,
          changes: [
            {
              action: AuditAction.ArtifactTagApplied,
              objectId: entityId,
              tagId,
            },
          ],
        });
      }
    } catch (error) {
      const isDuplicateTag =
        entityType === TagEntityType.Artifact
          ? isDuplicateArtifactTagRelationViolation(error)
          : getPrismaErrorCode(error) === "P2002";
      if (isDuplicateTag) {
        // Already tagged. The write is a no-op, but the artifact's linked PRs
        // may still be missing the label (an earlier propagation could have
        // failed), so reconciliation is deliberately NOT skipped here — it is
        // idempotent and additive.
        await reconcileArtifactPullRequestLabels(
          entityType,
          entityId,
          organizationId
        );
        if (isReceiptArtifactType(receiptArtifactType)) {
          emitSingleTagAnalytics({
            organizationId,
            actor,
            context,
            result: ArtifactFieldEditOutcome.NoChange,
            before: tagId,
            after: tagId,
          });
        }
        return false;
      }
      // P2003: the entity was deleted between validation and insert, so the
      // foreign key no longer resolves. Fail gracefully as not-found.
      if (getPrismaErrorCode(error) === "P2003") {
        throw new EntityNotFoundError(entityType, entityId);
      }
      throw error;
    }

    // ISS-4760: the tag row is committed, so converge the artifact's linked PRs
    // now instead of waiting for someone to edit or reopen the PR on GitHub.
    // Best-effort — never fails the mutation the user asked for.
    await reconcileArtifactPullRequestLabels(
      entityType,
      entityId,
      organizationId
    );
    if (isReceiptArtifactType(receiptArtifactType)) {
      emitSingleTagAnalytics({
        organizationId,
        actor,
        context,
        result: ArtifactFieldEditOutcome.Committed,
        before: null,
        after: tagId,
      });
    }
    // ISS-12552: true only when this call created the tag row.
    return true;
  },

  async batchApplyTag(
    tagId: string,
    // Artifact-only: this writes `tagArtifact` rows. The validator and the
    // shared `BatchApplyTagInput` contract both pin `entityType` to Artifact,
    // so non-artifact ids can never reach this write against the wrong relation.
    _entityType: typeof TagEntityType.Artifact,
    entityIds: string[],
    organizationId: string,
    recordReceipt?: RecordBatchTagReceipt
  ) {
    await validateTagOwnership(tagId, organizationId);

    const uniqueIds = [...new Set(entityIds)];

    // Validate all entities exist in the org before writing. Any artifact
    // type is taggable.
    const existing = await withDb((db) =>
      db.artifact.findMany({
        where: {
          id: { in: uniqueIds },
          organizationId,
        },
        select: { id: true },
      })
    );
    if (existing.length !== uniqueIds.length) {
      const foundIds = new Set(existing.map((e) => e.id));
      const missing = uniqueIds.filter((id) => !foundIds.has(id));
      throw new EntityNotFoundError("Artifact", missing.join(", "));
    }

    // `createMany` with `skipDuplicates` reports a COUNT and discards row
    // identity — it knows it tagged 12 of 50 and not which 12 — so the insert
    // RETURNS the rows it wrote and the receipt is driven off those (ISS-9465
    // ruling 1). Not off a read taken before the insert: `skipDuplicates` is
    // `ON CONFLICT DO NOTHING`, so under READ COMMITTED a concurrent identical
    // batch commits in between, the insert skips the row, and a pre-read's
    // difference still names it — a ledger entry for a row this call did not
    // write. The alternative, one upsert per artifact, is refused because
    // `reconcileLinkedPullRequestLabelsForArtifacts` is bounded below precisely
    // so a 50-artifact batch cannot become 50 GitHub writes; `RETURNING` keeps
    // it one statement and so keeps that bound.
    // The insert and the receipt are ONE transaction (ISS-10993), so a receipt
    // that cannot be written rolls the tag back with it. The reconcile below
    // stays OUTSIDE it: `withDb.tx` joins an ambient transaction rather than
    // nesting, so a caller that wrapped this call would hold the tag's row
    // locks across the GitHub round trips that reconcile makes.
    const newlyTaggedIds = await withDb.tx(async (tx) => {
      const inserted = await tx.tagArtifact.createManyAndReturn({
        data: uniqueIds.map((entityId) => ({
          tagId,
          artifactId: entityId,
        })),
        skipDuplicates: true,
        select: { artifactId: true },
      });
      const ids = inserted.map((row) => row.artifactId);
      await recordReceipt?.(
        tx,
        ids,
        existing.map((artifact) => artifact.id)
      );
      return ids;
    });
    const appliedCount = newlyTaggedIds.length;

    // ISS-4760: same convergence for the batch path, bounded by the helper so a
    // 50-artifact batch cannot fan out into an unbounded GitHub write storm.
    await reconcileLinkedPullRequestLabelsForArtifacts({
      organizationId,
      artifactIds: uniqueIds,
    });

    return { appliedCount, newlyTaggedIds };
  },

  async removeTag(
    tagId: string,
    entityType: TagEntityTypeValue,
    entityId: string,
    organizationId: string,
    actor: ActivityActor,
    context?: ArtifactFieldEditReceiptContext,
    /** Runs on the write's transaction, whether or not a row was removed. */
    recordRemoved?: RecordWriteInTransaction<{ removed: boolean }>
  ): Promise<boolean> {
    await validateTagOwnership(tagId, organizationId);
    let removedFromArtifact = false;
    // ISS-12552: whether a tag row was actually removed.
    let removedFromProject = false;
    switch (entityType) {
      case TagEntityType.Project: {
        const removed = await writeRecorded(
          recordRemoved,
          () =>
            withDb((db) =>
              db.tagProject.deleteMany({
                where: { tagId, projectId: entityId },
              })
            ),
          (deleted) => ({ removed: deleted.count > 0 })
        );
        removedFromProject = removed.count > 0;
        break;
      }
      case TagEntityType.Artifact: {
        let removedCount = 0;
        let receiptArtifactType: ArtifactType | null = null;
        removedFromArtifact = await withDb.tx(async (tx) => {
          const artifact = await tx.artifact.findFirst({
            where: { id: entityId, organizationId },
            select: { type: true },
          });
          if (artifact) {
            receiptArtifactType = artifact.type;
            const removed = await tx.tagArtifact.deleteMany({
              where: { tagId, artifactId: entityId },
            });
            removedCount = removed.count;
            if (removed.count > 0 && isReceiptArtifactType(artifact.type)) {
              await captureSingleTagReceipt({
                tx,
                organizationId,
                artifactId: entityId,
                actor,
                before: tagId,
                after: null,
                ...(context === undefined ? {} : { context }),
              });
            }
          }
          await recordRemoved?.(tx, { removed: removedCount > 0 });
          return removedCount > 0;
        });
        if (isReceiptArtifactType(receiptArtifactType)) {
          emitSingleTagAnalytics({
            organizationId,
            actor,
            context,
            result:
              removedCount > 0
                ? ArtifactFieldEditOutcome.Committed
                : ArtifactFieldEditOutcome.NoChange,
            before: removedCount > 0 ? tagId : null,
            after: null,
          });
        }
        break;
      }
      default:
        throw new Error(`Unknown entity type: ${entityType as string}`);
    }

    if (removedFromArtifact) {
      dispatchSingleArtifactMutationAudits({
        organizationId,
        userId: actor.userId,
        changes: [
          {
            action: AuditAction.ArtifactTagRemoved,
            objectId: entityId,
            tagId,
          },
        ],
      });
    }

    // ISS-4760: a removal reconciles too. Reconciliation is ADDITIVE, so this
    // does not strip the label from GitHub — it re-applies the artifact's
    // REMAINING tags, which is what keeps a PR converged after any tag edit.
    await reconcileArtifactPullRequestLabels(
      entityType,
      entityId,
      organizationId
    );
    return removedFromArtifact || removedFromProject;
  },
};

async function pickDefaultColor(organizationId: string): Promise<string> {
  const count = await withDb((db) =>
    db.tag.count({ where: { organizationId } })
  );
  return TAG_COLORS[count % TAG_COLORS.length];
}

async function validateEntityExists(
  entityType: TagEntityTypeValue,
  entityId: string,
  organizationId: string
): Promise<ArtifactType | null> {
  let exists = false;
  let artifactType: ArtifactType | null = null;

  switch (entityType) {
    case TagEntityType.Project:
      exists = !!(await withDb((db) =>
        db.project.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true },
        })
      ));
      break;
    // Any artifact type is taggable (documents, branches, deployments,
    // sessions) — tags are common artifact plumbing, so validation is
    // existence + org-scoping only.
    case TagEntityType.Artifact: {
      const artifact = await withDb((db) =>
        db.artifact.findFirst({
          where: { id: entityId, organizationId },
          select: { id: true, type: true },
        })
      );
      exists = Boolean(artifact);
      artifactType = artifact?.type ?? null;
      break;
    }
    default:
      throw new Error(`Unknown entity type: ${entityType as string}`);
  }

  if (!exists) {
    throw new EntityNotFoundError(entityType, entityId);
  }
  return artifactType;
}

async function validateTagOwnership(
  tagId: string,
  organizationId: string
): Promise<void> {
  const tag = await withDb((db) =>
    db.tag.findFirst({
      where: { id: tagId, organizationId },
      select: { id: true },
    })
  );
  if (!tag) {
    throw new EntityNotFoundError("Tag", tagId);
  }
}

export class EntityNotFoundError extends Error {
  constructor(entityType: string, entityId: string) {
    super(`${entityType} ${entityId} not found in this organization`);
    this.name = "EntityNotFoundError";
  }
}

/**
 * ISS-4760: converge the artifact's linked PR labels after a tag mutation.
 * Only ARTIFACT tags can become PR labels — a project tag reaches no
 * pull request, so those entity types make no GitHub call at all.
 */
async function reconcileArtifactPullRequestLabels(
  entityType: TagEntityTypeValue,
  entityId: string,
  organizationId: string
): Promise<void> {
  if (entityType !== TagEntityType.Artifact) {
    return;
  }
  await reconcileLinkedPullRequestLabelsForArtifact({
    organizationId,
    artifactId: entityId,
  });
}

/**
 * The narrowing dimensions the org tag reads share.
 *
 * `TagListQuery` from the validator also carries `includeTotal`, which selects
 * the RESPONSE SHAPE and must never reach a `where` — the route destructures it
 * off before calling either read.
 */
export type TagListReadQuery = {
  limit?: number;
  offset?: number;
  search?: string;
};

/**
 * Org scoping plus the optional substring filter.
 *
 * `search` is escaped with the shared {@link escapeSqlLikeLiteral} because
 * Prisma's insensitive matching compiles to a bare `ILIKE $n` with NO `ESCAPE`
 * clause, so an unescaped user-typed `%` or `_` would silently become a pattern
 * operator instead of the literal character the user searched for.
 */
function buildTagListWhere(organizationId: string, search: string | undefined) {
  if (search === undefined) {
    return { organizationId };
  }
  return {
    organizationId,
    name: {
      contains: escapeSqlLikeLiteral(search),
      mode: Prisma.QueryMode.insensitive,
    },
  };
}

/**
 * The row {@link tagService.findByExactName} projects.
 *
 * Its own type rather than `Tag` for two honest reasons. It carries no
 * `createdBy` and no `_count` — the one-statement projection is the whole point
 * of that read — and `color` is `string` because `tags.color` is an
 * unconstrained column, while the shared `Tag.color` is the closed `TagColor`
 * union. Annotating this as `Tag` would need a cast asserting a narrowing the
 * database does not enforce.
 */
export type ExactNameTagRow = {
  id: string;
  organizationId: string;
  name: string;
  color: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Compile-time proof that the paged read still produces the envelope
 * `apps/mcp` and `openapi.json` document, so the two cannot drift.
 *
 * Checked structurally on the count/flag fields rather than by annotating
 * `findPageByOrg` with `TagListPage` directly: `items` comes back with Prisma's
 * `color: string`, which the shared `Tag.color` union does not accept, and the
 * fix for that divergence is to correct `Tag` across every consumer — not to
 * cast here.
 *
 * `AssertTrue` is what makes the guard able to FAIL — a conditional type that
 * resolves to `never` on mismatch still compiles, so the assertion has to be a
 * constrained type parameter. Same idiom as `documents/document-list-query.ts`.
 */
type AssertTrue<T extends true> = T;
type PagedEnvelopeShape = Awaited<ReturnType<typeof tagService.findPageByOrg>>;

export type PagedEnvelopeMatchesTagListPage = AssertTrue<
  PagedEnvelopeShape extends {
    items: readonly unknown[];
    total: TagListPage["total"];
    hasMore: TagListPage["hasMore"];
  }
    ? true
    : false
>;

/** The tag definition columns `PATCH /tags/[id]` can write (ISS-12552). */
const TAG_DEFINITION_FIELDS = ["name", "color"] as const;
