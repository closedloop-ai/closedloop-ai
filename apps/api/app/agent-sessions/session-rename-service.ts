import {
  type AgentSessionFieldMutationError,
  staleSessionFieldsConflict,
} from "@repo/api/src/types/agent-session-field-mutation";
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  ArtifactActivityAction,
  SessionMetadataActivityField,
} from "@repo/api/src/types/artifact-activity";
import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
  type ArtifactFieldEditOutcome as ArtifactFieldEditOutcomeValue,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import { Result, Status, type StatusCode } from "@repo/api/src/types/result";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { searchIndexService } from "@/app/search/search-index-service";
import {
  type ActivityActor,
  resolveActorType,
} from "@/lib/artifact-activity-capture";
import { createArtifactFieldEditAnalyticsContext } from "@/lib/artifact-field-edit-analytics-context";
import { captureArtifactMetadataChange } from "@/lib/artifact-field-edit-capture";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { isUuid } from "./service/coercion";
import {
  SESSION_NAME_CHANGED_FIELD,
  type SessionFieldsWrite,
} from "./session-operation-receipt";

type RenameSessionInput = {
  id: string;
  organizationId: string;
  /** The CALLER. Not the session's owner — that is what is being checked. */
  actorUserId: string;
  authMethod: ActivityActor["authMethod"];
  surface?: ArtifactStatusEditSurface;
  /**
   * ISS-8733: whether the caller holds an admin role in this org, resolved from
   * their Clerk membership by the route. A boolean rather than a role string
   * because the policy — which roles count — belongs to `OrgAdminRole`, and
   * restating it here would give the authorization boundary two owners.
   */
  actorIsOrgAdmin: boolean;
  name: string;
  /**
   * ISS-9486 optimistic guard, compared with the RENDERED name
   * (`nameOverride ?? artifacts.name`). Omitted is unguarded; a `name` the
   * session already renders is never refused.
   */
  expectedName?: string;
};

/**
 * Rename one agent session, authorized to its OWNER or an ORG ADMIN (ISS-8717,
 * widened by ISS-8733). OWNER is the session artifact's assignee (ISS-12251 D-6,
 * operator ruling, Kerensa Whitlock, 2026-10-12; GAP-004 resolved: not widened to every
 * org member).
 *
 * The write lands on `SessionDetail.nameOverride`, never on `artifacts.name`:
 * ingest rewrites that column from the collector's derivation on every sync, so
 * a rename stored there is reverted by the next re-import. Keeping the two apart
 * is also what leaves the collected placeholder recoverable.
 */
export const sessionRenameService = {
  /**
   * `recordWrite` runs on the rename's own transaction for a rename and for a
   * same-name no-op, never for a refusal (ISS-12552).
   */
  async rename(
    input: RenameSessionInput,
    recordWrite?: RecordWriteInTransaction<SessionFieldsWrite>
  ): Promise<Result<void, StatusCode | AgentSessionFieldMutationError>> {
    // The id is a ROUTE SEGMENT, not a validated body field, so a non-uuid
    // reaches here. `session_detail.artifact_id` is `@db.Uuid`, so handing one
    // to the query engine raises before any predicate is evaluated and the
    // route reports an input error as a 500. Refusing up front keeps a
    // malformed path a 404 — the same guard, and the same refusal, that
    // `updateSessionInTx` applies to the sibling write.
    if (!isUuid(input.id)) {
      return Result.err(Status.NotFound);
    }
    const analytics = renameAnalyticsContext(input);
    const receipt = analytics.receiptContext;

    // AUTHORIZE IN THE WRITE'S OWN PREDICATE, not in a preceding read. Tenancy
    // (org, which lives on the parent artifact because session detail is
    // join-reached), artifact type, and — for a non-admin — ownership all ride
    // this one `where`, so no row the caller is not entitled to can be updated
    // even if it changed between statements. A read-then-write would decompose
    // exactly the check the write depends on, which `apps/api/AGENTS.md` forbids.
    const outcome = await withDb.tx(
      async (
        db
      ): Promise<Result<RenameWrite, AgentSessionFieldMutationError>> => {
        const current = await readRenderedName(db, input);
        if (current !== null && current === input.name) {
          await recordWrite?.(db, { changedFields: [] });
          return Result.ok(RenameWrite.Unchanged);
        }
        const conflict = staleNameConflict(input, current);
        if (conflict) {
          return Result.err(conflict);
        }
        const written = await db.sessionDetail.updateMany({
          where: {
            artifactId: input.id,
            // OWNER OR ORG ADMIN, and still not "any org member": a colleague who
            // can READ this session must not be able to rename it (ISS-8711, Marisol
            // 2026-08-31). ISS-8733 admitted admins because a session whose owner
            // was deleted (`assignee_id` SetNull) matches no caller at all, so the
            // owner-only rule stranded it permanently.
            //
            // The ownership narrowing is DROPPED for an admin rather than ORed in,
            // so the widened predicate still carries org and type and cannot match
            // a row outside the caller's tenancy. `actorIsOrgAdmin` is a fact about
            // the caller, resolved before this call. The locked read above
            // (ISS-9486) carries this same predicate and only supplies the
            // comparison value, so it authorizes nothing this write does not.
            //
            // ISS-8648 (PR #6330) settled the shape of this predicate for the
            // sibling session writes and it binds here identically:
            // `session_detail.artifact_id` is a plain FK with NO storage
            // constraint on the parent artifact's TYPE, so org+owner alone would
            // let a same-org, same-owner NON-session artifact that carries a
            // detail row be renamed through the Sessions endpoint.
            artifact: {
              is: {
                organizationId: input.organizationId,
                type: ArtifactType.Session,
                ...(input.actorIsOrgAdmin
                  ? {}
                  : { assigneeId: input.actorUserId }),
              },
            },
          },
          data: { nameOverride: input.name },
        });
        if (written.count > 0) {
          if (current === null) {
            throw new Error("renamed session lacked its locked prior name");
          }
          await captureArtifactMetadataChange({
            tx: db,
            organizationId: input.organizationId,
            artifactId: input.id,
            actorType: resolveActorType(input.authMethod),
            actorId: input.actorUserId,
            action: ArtifactActivityAction.FieldChange,
            field: SessionMetadataActivityField.Name,
            before: current,
            after: input.name,
            context: receipt,
          });
          await recordWrite?.(db, {
            changedFields: [SESSION_NAME_CHANGED_FIELD],
          });
        }
        return Result.ok(
          written.count > 0 ? RenameWrite.Renamed : RenameWrite.Refused
        );
      }
    );

    if (!outcome.ok) {
      emitRenameAnalytics(input, analytics, ArtifactFieldEditOutcome.Conflict);
      return outcome;
    }
    if (outcome.value === RenameWrite.Unchanged) {
      emitRenameAnalytics(input, analytics, ArtifactFieldEditOutcome.NoChange);
      return Result.ok(undefined);
    }
    if (outcome.value === RenameWrite.Renamed) {
      emitRenameAnalytics(input, analytics, ArtifactFieldEditOutcome.Committed);
      // Post-commit, fail-open, and UPDATE-ONLY (ISS-8717 review: whitlockk +
      // codex). The unified-search projection materializes a session's TITLE
      // into its own row, and `transcriptSearchIndexService` refreshes that row
      // only when a transcript is archived or finalized — so without this a
      // session renamed after its transcript landed keeps answering search
      // under the collector's placeholder indefinitely, and global search
      // contradicts the Sessions surface the rename was made on. It cannot
      // CREATE the row (see `updateTitle`): a session is projected only for an
      // org that opted into transcript search, so a rename must never be what
      // puts one in the index.
      searchIndexService.updateTitleAfterCommit(
        {
          organizationId: input.organizationId,
          entityType: SearchEntityType.AgentSession,
          entityId: input.id,
        },
        input.name
      );
      return Result.ok(undefined);
    }

    // Refused. Only now is a read worth paying for, and only to tell the caller
    // WHICH refusal it was: a session they may read but do not own is Forbidden,
    // and anything they cannot even read is NotFound — so a cross-org id never
    // confirms the session exists. An ADMIN never reaches Forbidden, because the
    // only predicate that can have failed for them is org-or-type.
    const readable = await withDb((db) =>
      db.sessionDetail.findFirst({
        where: {
          artifactId: input.id,
          // Same type filter as the write above, and for the same reason: a
          // same-org non-session artifact must read as NotFound here, not as a
          // Forbidden that confirms a session exists at that id.
          artifact: {
            is: {
              organizationId: input.organizationId,
              type: ArtifactType.Session,
            },
          },
        },
        select: { artifactId: true },
      })
    );

    return Result.err(readable ? Status.Forbidden : Status.NotFound);
  },
};

/**
 * What `rename`'s transaction did. `Unchanged` is a session that already
 * renders the requested name: the write is skipped (ISS-9486 ruling 2, a
 * same-value write is a no-op), so no `nameOverride` is pinned over the
 * collector's name and no retitle is queued.
 */
const RenameWrite = {
  Renamed: "renamed",
  Unchanged: "unchanged",
  Refused: "refused",
} as const;
type RenameWrite = (typeof RenameWrite)[keyof typeof RenameWrite];

/**
 * ISS-9486 — the name the session renders (`nameOverride ?? artifacts.name`),
 * or `null` when the caller may not rename it or it does not exist.
 *
 * Read under the SAME predicate the write authorizes with (org, type, and the
 * assignee unless admin), and read only to compare. It authorizes nothing: a
 * caller the write would refuse gets `null` here and reaches the unchanged
 * 403/404 in `rename`, so a refusal always outranks a conflict and a 409 never
 * tells a non-owner the current name. `FOR NO KEY UPDATE OF sd` holds the row
 * until the write in the same transaction, so the value compared is the value
 * overwritten.
 *
 * The ARTIFACT row is locked first, in its own statement: authorization reads
 * `a.assignee_id`, so a reassignment committing between this read and the write
 * would otherwise make the write refuse a row this read admitted (a 500), or
 * admit a caller the reassignment removed. Artifact-then-detail is the order
 * ingest (`writeSessionArtifactMetadata`, then the detail upsert) and the
 * PATCH/bulk owner writes (artifact only) already take, so it cannot deadlock
 * against them; one `FOR NO KEY UPDATE OF sd, a` would leave the order to the
 * planner.
 */
async function readRenderedName(
  tx: TransactionClient,
  input: RenameSessionInput
): Promise<string | null> {
  await tx.$queryRaw(Prisma.sql`
    SELECT a."id"
    FROM "artifacts" a
    WHERE a."id" = ${input.id}::uuid
      AND a."organization_id" = ${input.organizationId}::uuid
      AND a."type" = ${ArtifactType.Session}::"ArtifactType"
    FOR NO KEY UPDATE
  `);
  const [row] = await tx.$queryRaw<{ currentName: string }[]>(Prisma.sql`
    SELECT COALESCE(sd."name_override", a."name") AS "currentName"
    FROM "session_detail" sd
    JOIN "artifacts" a ON a."id" = sd."artifact_id"
    WHERE sd."artifact_id" = ${input.id}::uuid
      AND a."organization_id" = ${input.organizationId}::uuid
      AND a."type" = ${ArtifactType.Session}::"ArtifactType"
      ${input.actorIsOrgAdmin ? Prisma.empty : Prisma.sql`AND a."assignee_id" = ${input.actorUserId}::uuid`}
    FOR NO KEY UPDATE OF sd
  `);
  return row?.currentName ?? null;
}

function staleNameConflict(
  input: RenameSessionInput,
  currentName: string | null
): AgentSessionFieldMutationError | null {
  const { expectedName } = input;
  if (
    currentName === null ||
    expectedName === undefined ||
    !isStaleExpectation(currentName, input.name, expectedName)
  ) {
    return null;
  }
  return staleSessionFieldsConflict({
    name: { documentId: input.id, currentName, expectedName },
  });
}

function emitRenameAnalytics(
  input: RenameSessionInput,
  context: ReturnType<typeof renameAnalyticsContext>,
  result: ArtifactFieldEditOutcomeValue
): void {
  context.capture({
    field: ArtifactFieldEditField.Name,
    result,
    artifactCount: 1,
    after: input.name,
  });
}

function renameAnalyticsContext(input: RenameSessionInput) {
  return createArtifactFieldEditAnalyticsContext({
    organizationId: input.organizationId,
    userId: input.actorUserId,
    surface: input.surface,
    authMethod: input.authMethod,
  });
}
