import { ArtifactType } from "@repo/api/src/types/artifact";
import type { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { type Result, Status } from "@repo/api/src/types/result";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { Prisma, SessionOrigin, type TransactionClient } from "@repo/database";
import type { ActivityActor } from "@/lib/artifact-activity-capture";
import { IndexKeyOrigin } from "@/lib/index-key-lookup";
import {
  indexKeyCandidates,
  resolveStoredIndexKey,
} from "@/lib/index-key-projection";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";
import { generateSlug } from "@/lib/slug-generator";
import { acquireSessionAdvisoryLocks } from "./service/advisory-locks";
import { listSessionsByArtifactIds } from "./service/list-by-artifact-ids";
import type { SessionCreateWrite } from "./session-operation-receipt";
import { sessionUpdateService } from "./session-update-service";
import {
  readSessionWriteListItem,
  resolveSessionAssignmentTargets,
  runSessionWrite,
  SessionWriteRefusal,
} from "./session-write-transaction";
import {
  AgentSessionBulkAssignField,
  type AgentSessionBulkAssignResponse,
  type AgentSessionCreateResponse,
} from "./write-contract";

export type CreateSessionInput = {
  organizationId: string;
  actorUserId: string;
  computeTargetId: string;
  externalSessionId: string;
  name?: string;
  status?: SessionStatus;
  projectId?: string | null;
  ownerUserId?: string | null;
  harness?: string;
  repositoryFullName?: string | null;
  startedAt?: string;
};

/**
 * NO `name`. ISS-8733 routed the session rename to
 * `sessionRenameService.rename`, which writes `session_detail.name_override`;
 * the route strips `name` before it reaches here. Leaving the field would leave
 * a live path back onto `artifacts.name` — the column ingest rewrites on every
 * sync — which is the exact defect ISS-8717 exists to prevent. `createSession`
 * still takes a `name` because a create SEEDS the collector's placeholder.
 */
export type UpdateSessionInput = {
  organizationId: string;
  sessionId: string;
  actor: ActivityActor;
  surface?: ArtifactStatusEditSurface;
  status?: SessionStatus;
  projectId?: string | null;
  ownerUserId?: string | null;
  /**
   * ISS-9486 optimistic guards, one per field above and with its ABSENT ≠ NULL
   * rule. Refused before any write when the stored value is neither the
   * expected one nor the one being written.
   */
  expectedStatus?: SessionStatus;
  expectedProjectId?: string | null;
  expectedOwnerUserId?: string | null;
};

/**
 * One session's assignment transition in a bulk assign (ISS-9465). `before` is
 * the value read inside the write's transaction; `after` is the batch's target,
 * which is the same for every row because the write is all-or-nothing.
 */
export type BulkAssignChange = {
  artifactId: string;
  before: string | null;
  after: string | null;
};

/** What a committed bulk assignment reports: its row count and its transitions. */
export type BulkAssignCommit = {
  count: number;
  changes: BulkAssignChange[];
};

/**
 * `bulkAssignSessions`'s answer: the wire response plus the transitions the
 * route feeds to the receipt and the ledger and never serializes (ISS-9465),
 * the same internal-alongside-wire split `batchMoveArtifacts` makes.
 */
export type BulkAssignSessionsResult = {
  response: AgentSessionBulkAssignResponse;
  changes: BulkAssignChange[];
};

export type BulkAssignSessionsInput = {
  organizationId: string;
  sessionIds: readonly string[];
  field: AgentSessionBulkAssignField;
  value: string | null;
};

/**
 * The write half of the Sessions surface (ISS-8648 / ISS-8649).
 *
 * Three invariants hold across every function here, each enforced by the SQL
 * rather than by a prior read whose result could go stale:
 *
 *  1. **Org scope rides in the write predicate.** Every write carries
 *     `organizationId` (directly, or through the `artifact` relation), so a row
 *     outside the caller's org cannot be written even when its id is supplied.
 *  2. **A set is applied whole or not at all.** The row count the database
 *     reports is compared against the requested id count inside the
 *     transaction, and a shortfall throws. An `updateMany` reporting
 *     `{count: 0}` for a row that is absent — where `update` would have thrown
 *     `P2025` — is therefore caught by the same check that catches an id
 *     belonging to another org.
 *  3. **Assignment TARGETS are org-scoped too.** The project or user a write
 *     points AT is verified against the caller's org before it is written, so a
 *     caller cannot park their own sessions on another org's project or user.
 *
 * What this service deliberately does NOT do: reverse-map a display label to an
 * identifier. `SessionsGroupDropController.onMove` hands its host a rendered
 * band LABEL, and mapping "Failed" back to `error` or "Jane Doe" back to a user
 * id in the API would move a display vocabulary into the backend. ISS-8296
 * tracks carrying a machine-readable value alongside the label; until it lands,
 * these endpoints take identifiers only.
 */
export const sessionWriteService = {
  /**
   * `recordWrite` runs on the create's own transaction, so a receipt that
   * cannot be stored rolls the session back (ISS-12552).
   */
  async createSession(
    input: CreateSessionInput,
    recordWrite?: RecordWriteInTransaction<SessionCreateWrite>
  ): Promise<Result<AgentSessionCreateResponse>> {
    const result = await runSessionWrite(
      async (tx): Promise<SessionCreateWrite> => {
        const written = await createSessionInTx(tx, input);
        await recordWrite?.(tx, written);
        return written;
      }
    );
    if (!result.ok) {
      return result;
    }

    const session = await readSessionWriteListItem(
      input.organizationId,
      result.value.artifactId
    );
    if (!session) {
      return { ok: false, error: Status.Error };
    }
    return { ok: true, value: { session, created: result.value.created } };
  },

  updateSession: sessionUpdateService.updateSession,

  async bulkAssignSessions(
    input: BulkAssignSessionsInput,
    recordReceipt?: RecordBulkAssignReceipt
  ): Promise<Result<BulkAssignSessionsResult>> {
    const result = await sessionWriteService.commitBulkAssignment(
      input,
      recordReceipt
    );
    if (!result.ok) {
      return result;
    }

    const ids = [...new Set(input.sessionIds)];
    const sessions = await listSessionsByArtifactIds(
      input.organizationId,
      ids,
      ids.length
    );
    return {
      ok: true,
      value: {
        response: {
          field: input.field,
          assignedCount: result.value.count,
          sessions,
        },
        changes: result.value.changes,
      },
    };
  },

  /** The committed write alone: no post-commit row read to pay for or fail on. */
  async commitBulkAssignment(
    input: BulkAssignSessionsInput,
    recordReceipt?: RecordBulkAssignReceipt
  ): Promise<Result<BulkAssignCommit>> {
    const ids = [...new Set(input.sessionIds)];
    if (ids.length === 0) {
      return { ok: false, error: Status.BadRequest };
    }
    return await runSessionWrite(async (tx) => {
      const commit = await bulkAssignInTx(tx, input, ids);
      // Past the all-or-nothing check, so the receipt describes a write that
      // will commit, and a receipt that cannot be written throws out of the
      // same transaction and takes the assignment with it (ISS-10993).
      await recordReceipt?.(tx, commit);
      return commit;
    });
  },
};

async function createSessionInTx(
  tx: TransactionClient,
  input: CreateSessionInput
): Promise<SessionCreateWrite> {
  // The SAME per-session advisory lock the desktop ingest takes (ISS-8619 moved
  // it to `service/session-slice-identity.ts`), on the same key, so the
  // lookup-then-create below is atomic against every other writer of this
  // identity — a concurrent retry of this endpoint AND a concurrent ingest of
  // the same run. Without it both writers pass the lookup under READ COMMITTED
  // and the loser takes a raw P2002 out to a 500, breaking the idempotent-200
  // this route promises.
  await acquireSessionAdvisoryLocks(
    tx,
    input.externalSessionId,
    IndexKeyOrigin.Wire
  );

  const computeTarget = await tx.computeTarget.findFirst({
    where: { id: input.computeTargetId, organizationId: input.organizationId },
    select: { id: true },
  });
  if (!computeTarget) {
    throw new SessionWriteRefusal(Status.BadRequest);
  }

  // The SAME index-key resolution the desktop ingest uses
  // (`findSessionDetailByAnyIndexKey` in `service/session-detail-lookup.ts`), because this
  // route writes the very column that upsert keys on. Two properties come with
  // it, and both are lost by a raw equality lookup:
  //
  //  • ISS-8069 — an id over `INDEX_KEY_MAX_BYTES` is stored PROJECTED, so a
  //    lookup on the raw value misses a row that already exists and this create
  //    mints a second `SessionDetail` for the same run.
  //  • ISS-8254 — a raw id inside the reserved `~idxsha256:` namespace is itself
  //    projected at the write. Storing it verbatim here would let it collide with
  //    the stored key of a DIFFERENT long id, and a later desktop sync would then
  //    join two unrelated sessions onto one row.
  const found = await findExistingSessionDetail(tx, input);
  if (found.detail) {
    // Idempotent retry, and it short-circuits AHEAD of the project/owner
    // validation below on purpose: a retry whose payload names a project that
    // has since been deleted must still return the existing row, or the
    // idempotency this route documents would lapse with the reference.
    //
    // The unscoped compound lookup is org-safe because the compute target was
    // just proven to be this org's, and a compute target belongs to exactly one
    // org. Do not reorder these two.
    return { artifactId: found.detail.artifactId, created: false };
  }

  // No row matched, so `storedKey` is null and this resolves to the PROJECTED
  // key — the same value the ingest would store for this id. Routed through
  // `resolveStoredIndexKey` rather than `projectIndexKey` so the create and the
  // ingest keep one write-key rule between them.
  const externalSessionIdKey = resolveStoredIndexKey(
    input.externalSessionId,
    found.storedExternalSessionId
  );

  const targets = await resolveSessionAssignmentTargets(tx, input);
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  const slug = await generateSlug(input.organizationId, SlugPrefix.Session);
  const created = await tx.sessionDetail.create({
    data: {
      artifact: {
        create: {
          organization: { connect: { id: input.organizationId } },
          ...(targets.projectId
            ? { project: { connect: { id: targets.projectId } } }
            : {}),
          type: ArtifactType.Session,
          name: input.name ?? input.externalSessionId,
          status: input.status ?? SESSION_STATUS.ACTIVE,
          slug,
          createdBy: { connect: { id: input.actorUserId } },
          // ISS-12251 D-1: the Owner is the artifact assignee. An omitted
          // `ownerUserId` leaves it unset; the caller is never substituted.
          ...(targets.ownerUserId
            ? { assignee: { connect: { id: targets.ownerUserId } } }
            : {}),
        },
      },
      computeTarget: { connect: { id: input.computeTargetId } },
      // The PROJECTED key, never the raw wire value — see the lookup above. The
      // display `name` keeps the raw id, because that is what the caller sent.
      externalSessionId: externalSessionIdKey.value,
      metadataActivityCoverageStartedAt: new Date(),
      // `origin` is left at the schema default DESKTOP_SYNC, which is the
      // accurate claim rather than an oversight: this row is keyed on the pair
      // the desktop ingest upserts on, so it is a PRE-REGISTRATION of a
      // desktop-synced run. The consequence is intended — the stale-session
      // reaper scopes to DESKTOP_SYNC, so a row here that no device ever syncs
      // has its stored `active` closed like any other silent desktop session
      // instead of holding `active` forever.
      origin: SessionOrigin.DESKTOP_SYNC,
      ...(input.harness === undefined ? {} : { harness: input.harness }),
      ...(input.repositoryFullName === undefined
        ? {}
        : { repositoryFullName: input.repositoryFullName }),
      sessionStartedAt: startedAt,
      sessionUpdatedAt: startedAt,
      // ISS-8515: named EXPLICITLY, because this transaction has no cost writer.
      // Pre-registration carries no token evidence and no `sessionAnalytics`, so
      // the authoritative writer never corrects this row — before this, the schema
      // `@default(0)` made it a confident $0 for a session nothing had priced.
      // `null` is the truth here, and after the DEFAULT is dropped an omission
      // would reach the same value by accident rather than on purpose.
      estimatedCost: null,
      // NOT NULL, and the ingest's GREATEST floor tracks the session start —
      // seed it at the same value so a later desktop sync of this run is never
      // asked to move the activity anchor backward.
      lastActivityAt: startedAt,
    },
    select: { artifactId: true },
  });
  return { artifactId: created.artifactId, created: true };
}

async function bulkAssignInTx(
  tx: TransactionClient,
  input: BulkAssignSessionsInput,
  ids: readonly string[]
): Promise<BulkAssignCommit> {
  const assignsProject = input.field === AgentSessionBulkAssignField.Project;
  const targets = await resolveSessionAssignmentTargets(tx, {
    organizationId: input.organizationId,
    ...(assignsProject
      ? { projectId: input.value }
      : { ownerUserId: input.value }),
  });

  // The value each row held BEFORE the write, which `updateMany` cannot report
  // — it answers with a count (ISS-9465). Taken UNDER A ROW LOCK, for the
  // reason `lockDocumentRowsForMove` states for the move batch: a pinned
  // connection is not a snapshot, and under READ COMMITTED an unlocked read
  // lets two concurrent assigns both see project A and then record A→B and
  // A→C, the second of which never happened — a permanent ledger entry for a
  // transition this request did not perform.
  const locked = await lockSessionAssignments(tx, input.organizationId, ids);
  const before = new Map(
    [...locked].map(([id, row]) => [
      id,
      assignsProject ? row.projectId : row.assigneeId,
    ])
  );

  const after = assignsProject ? targets.projectId : targets.ownerUserId;

  // The write's ids are DERIVED from the locked read's keys. The lock's SQL
  // and `bulkAssignWhere` are two hand-written spellings of one scope that
  // nothing makes agree; a written row missing from `before` would take the
  // coalesce below and record a prior project of unset, permanently. Written
  // rows are a subset of these keys, so a divergence can only cost a refusal.
  const lockedIds = ids.filter((id) => before.has(id));

  const { count } = await tx.artifact.updateMany({
    where: bulkAssignWhere(input.organizationId, lockedIds),
    data: assignsProject
      ? { projectId: targets.projectId }
      : { assigneeId: targets.ownerUserId },
  });

  // The whole point of the bulk path. Every id the caller named must have been
  // written by the org-scoped predicate above; a smaller count means at least
  // one id is absent, belongs to another org, or survived the lock's predicate
  // but not the write's, and throwing here unwinds the transaction so NOTHING
  // was applied. Without this comparison an unauthorized or deleted id is
  // indistinguishable from a successful write, because `updateMany` reports a
  // count and never throws.
  if (count !== ids.length) {
    throw new SessionWriteRefusal(Status.NotFound);
  }
  // Past the all-or-nothing check, so every requested id was written and the
  // `before` map covers all of them — `?? null` can now only report a column
  // that genuinely held null. A row already holding the target value is
  // reported here anyway; the receipt and the ledger filter it out, the same
  // way the status and priority batches drop a no-op re-apply.
  return {
    count,
    changes: ids.map((artifactId) => ({
      artifactId,
      before: before.get(artifactId) ?? null,
      after,
    })),
  };
}

type LockedSessionAssignment = {
  projectId: string | null;
  assigneeId: string | null;
};

/**
 * Each requested session's current project and Owner (its assignee, ISS-12251
 * D-1), through the write's own predicate. Both live on the artifact row, which
 * is the row either arm writes.
 */
async function lockSessionAssignments(
  tx: TransactionClient,
  organizationId: string,
  ids: readonly string[]
): Promise<Map<string, LockedSessionAssignment>> {
  if (ids.length === 0) {
    return new Map();
  }
  const idSql = Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
  const rows = await tx.$queryRaw<({ id: string } & LockedSessionAssignment)[]>(
    Prisma.sql`
      SELECT "id", "project_id" AS "projectId", "assignee_id" AS "assigneeId"
      FROM "artifacts"
      WHERE "id" IN (${idSql})
        AND "organization_id" = ${organizationId}::uuid
        AND "type" = ${ArtifactType.Session}::"ArtifactType"
      ORDER BY "id" ASC
      FOR NO KEY UPDATE
    `
  );
  return new Map(
    rows.map((row) => [
      row.id,
      { projectId: row.projectId, assigneeId: row.assigneeId },
    ])
  );
}

/**
 * The `SessionDetail` for this identity under ANY key it could be stored under,
 * plus the key that actually matched.
 *
 * The twin of `findSessionDetailByAnyIndexKey` in `service/session-detail-lookup.ts`, and
 * deliberately the same shape: two ordered lookups rather than one `in`, so the
 * PROJECTED key wins when a raw and a projected row both somehow exist. Values
 * inside the byte budget yield a single candidate, so ordinary traffic pays
 * exactly the one `findUnique` this replaced.
 */
async function findExistingSessionDetail(
  tx: TransactionClient,
  input: Pick<CreateSessionInput, "computeTargetId" | "externalSessionId">
): Promise<{
  detail: { artifactId: string } | null;
  storedExternalSessionId: string | null;
}> {
  for (const candidate of indexKeyCandidates(input.externalSessionId)) {
    const detail = await tx.sessionDetail.findUnique({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: input.computeTargetId,
          externalSessionId: candidate,
        },
      },
      select: { artifactId: true },
    });
    if (detail) {
      return { detail, storedExternalSessionId: candidate };
    }
  }
  return { detail: null, storedExternalSessionId: null };
}

/**
 * The rows a bulk assignment writes, on either field: both the project and the
 * Owner (assignee) live on the SESSION artifact row. v2 labels a refusal with
 * this predicate.
 */
export function bulkAssignWhere(
  organizationId: string,
  ids: readonly string[]
): Prisma.ArtifactWhereInput {
  return {
    id: { in: [...ids] },
    organizationId,
    type: ArtifactType.Session,
  };
}

/**
 * Writes the activity receipt for a bulk assignment on the WRITE's transaction
 * (ISS-10993), so the receipt and the assignment commit or roll back together.
 *
 * Handed in rather than opened around the call because the refusal this write
 * raises only rolls back while `runSessionWrite` owns the outermost transaction — see
 * {@link SessionWriteRefusal}. Invoked once, after the all-or-nothing check has
 * passed, and a throw from it aborts the assignment.
 */
export type RecordBulkAssignReceipt = (
  tx: TransactionClient,
  commit: BulkAssignCommit
) => Promise<void>;
