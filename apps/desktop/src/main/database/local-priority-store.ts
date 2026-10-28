/**
 * @file local-priority-store.ts
 * @description ISS-10332 / PLN-2086 Milestone 3 step 16 — the local-mode
 * priority write for a session (`sessions.priority`) and for a branch (every
 * `artifacts` row of `kind = 'branch'` under one identity).
 *
 * This is the ONLY writer of either column: no import path touches them (the
 * `name_override` precedent), so a value set here survives every re-import and
 * rides the next sync to the cloud, which adopts it only while it holds none.
 *
 * A write that changes the value also sets `priority_upload_pending`, and the
 * sync lane sends the value only while that is set — see
 * `priority-upload-marker.ts` for why, and for the ack that resets it.
 */

import { decodeBranchId } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { isStaleExpectation } from "@repo/api/src/types/optimistic-write-guard";
import { z } from "zod";
import {
  type LocalPriorityWriteResult,
  LocalPriorityWriteStatus,
} from "../../shared/local-priority-write-contract.js";
import { ArtifactKind } from "../enrichment/identity-key.js";
import { MAX_DB_ID_LENGTH } from "./ipc-validation.js";
import type { DesktopPrisma } from "./prisma-client.js";
import {
  allOrNothingCanonicalSortSql,
  canonicalRankingKeySql,
} from "./session-timestamp-form.js";

/** The `store:` op names; a write cannot cross the db-host proxy. */
export const LOCAL_SESSION_PRIORITY_WRITE_STORE_OP = "localPriority.setSession";
export const LOCAL_BRANCH_PRIORITY_WRITE_STORE_OP = "localPriority.setBranch";

/**
 * An encoded branch id is two URI-encoded components — a repository name (wire
 * bound 200) and a branch name (wire bound 300) — each of which can triple in
 * length when encoded, so it gets its own bound rather than the session id's.
 */
const MAX_LOCAL_BRANCH_ID_LENGTH = 2048;
/** A machine-stamped ISO instant; the allowance covers an offset form only. */
const MAX_WRITTEN_AT_CHARS = 40;

const priorityValueSchema = z.enum(Priority).nullable();

/**
 * The renderer's request, as main and the db-host child both parse it. Strict:
 * a caller that sends a key this write does not know is refused, never partly
 * applied. `surface` is the cloud route's analytics provenance and is accepted
 * so the one shared request body crosses unchanged; nothing here reads it.
 */
export function localPriorityWriteRequestSchema(maxIdLength: number) {
  return z
    .object({
      id: z.string().min(1).max(maxIdLength),
      priority: priorityValueSchema,
      expectedPriority: priorityValueSchema.optional(),
      surface: z.string().max(64).optional(),
    })
    .strict();
}

export const localSessionPriorityWriteRequestSchema =
  localPriorityWriteRequestSchema(MAX_DB_ID_LENGTH);
export const localBranchPriorityWriteRequestSchema =
  localPriorityWriteRequestSchema(MAX_LOCAL_BRANCH_ID_LENGTH);

export type LocalPriorityWriteArgs = z.infer<
  typeof localSessionPriorityWriteRequestSchema
>;

/** What the child answers, re-validated in main at the process boundary. */
export const localPriorityWriteResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal(LocalPriorityWriteStatus.Written),
    priority: priorityValueSchema,
  }),
  z.object({ status: z.literal(LocalPriorityWriteStatus.Stale) }),
  z.object({ status: z.literal(LocalPriorityWriteStatus.NotFound) }),
]) satisfies z.ZodType<LocalPriorityWriteResult>;

export const localSessionPriorityWriteArgsSchema = z.tuple([
  localSessionPriorityWriteRequestSchema,
  z.string().min(1).max(MAX_WRITTEN_AT_CHARS),
]);
export const localBranchPriorityWriteArgsSchema = z.tuple([
  localBranchPriorityWriteRequestSchema,
  z.string().min(1).max(MAX_WRITTEN_AT_CHARS),
]);

/**
 * Set or clear one session's priority.
 *
 * `expectedPriority` is the cloud route's optimistic guard, `isStaleExpectation`
 * itself: omitted is last-write-wins, a present value must equal the stored one,
 * and a request for the value already stored is never stale. A changed value
 * also moves `updated_at` FORWARD, which is what re-queues the session for sync
 * — selection walks that column — the `recordThreadViewed` precedent, including
 * never moving it backward. An unchanged value writes
 * nothing, so a repeated click causes no sync churn.
 */
export function writeLocalSessionPriority(
  prisma: DesktopPrisma,
  request: LocalPriorityWriteArgs,
  writtenAt: string
): Promise<LocalPriorityWriteResult> {
  return prisma.write(async (client) => {
    const row = await client.session.findUnique({
      where: { id: request.id },
      select: { priority: true, updatedAt: true },
    });
    if (!row) {
      return { status: LocalPriorityWriteStatus.NotFound };
    }
    if (
      isStaleExpectation(
        row.priority,
        request.priority,
        request.expectedPriority
      )
    ) {
      return { status: LocalPriorityWriteStatus.Stale };
    }
    if (row.priority !== request.priority) {
      await client.session.update({
        where: { id: request.id },
        data: {
          priority: request.priority,
          priorityUploadPending: 1,
          updatedAt: advancedUpdatedAt(row.updatedAt, writtenAt),
        },
        select: { id: true },
      });
    }
    return {
      status: LocalPriorityWriteStatus.Written,
      priority: request.priority,
    };
  });
}

/**
 * Set or clear one branch's priority, on EVERY `kind = 'branch'` row of the
 * decoded `(repo_full_name, branch_name)` identity — the key the Branches list
 * groups rows by, so the list reads back the value it was sent. A `null`
 * repository matches the repo-less identity the list encodes with its local
 * sentinel.
 *
 * A branch reaches the cloud only as a ref on a session payload, so a change
 * re-queues the most recently updated session linked to it; one session carries
 * the ref, and re-queueing every linked session would re-upload each of them
 * for one field.
 */
export function writeLocalBranchPriority(
  prisma: DesktopPrisma,
  request: LocalPriorityWriteArgs,
  writtenAt: string
): Promise<LocalPriorityWriteResult> {
  const { repoFullName, branchName } = decodeBranchId(request.id);
  const identity = { kind: ArtifactKind.Branch, branchName, repoFullName };
  // One transaction: the value and its sync re-queue are separate writes, and a
  // crash between them would leave the new priority invisible to the cursor.
  return prisma.write((writer) =>
    writer.$transaction(async (client) => {
      const rows = await client.artifact.findMany({
        where: identity,
        select: { priority: true },
        orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
      });
      if (rows.length === 0) {
        return { status: LocalPriorityWriteStatus.NotFound };
      }
      const stored =
        rows.find((row) => row.priority !== null)?.priority ?? null;
      if (
        isStaleExpectation(stored, request.priority, request.expectedPriority)
      ) {
        return { status: LocalPriorityWriteStatus.Stale };
      }
      if (rows.some((row) => row.priority !== request.priority)) {
        await client.artifact.updateMany({
          where: identity,
          data: { priority: request.priority, priorityUploadPending: 1 },
        });
        // Raw: the instant ranking is the shared SQL fold, which has no
        // delegate form.
        const [newest] = await client.$queryRawUnsafe<
          { id: string; updated_at: string | null }[]
        >(
          `SELECT ranked.id AS id, ranked.updated_at AS updated_at
           FROM (
             SELECT
               s.id AS id,
               s.updated_at AS updated_at,
               ${NEWEST_SESSION_SORT_SQL} AS session_sort
             FROM session_artifact_links sal
             JOIN artifacts a ON a.id = sal.artifact_id AND a.kind = 'branch'
             JOIN sessions s ON s.id = sal.session_id
             WHERE a.branch_name = $1 AND a.repo_full_name IS $2
           ) ranked
           ORDER BY ranked.session_sort DESC, ranked.id ASC
           LIMIT 1`,
          branchName,
          repoFullName
        );
        if (newest) {
          await client.session.update({
            where: { id: newest.id },
            data: {
              updatedAt: advancedUpdatedAt(newest.updated_at, writtenAt),
            },
            select: { id: true },
          });
        }
      }
      return {
        status: LocalPriorityWriteStatus.Written,
        priority: request.priority,
      };
    })
  );
}

/**
 * The linked sessions ranked by `updated_at` as an INSTANT, not as text: stored
 * timestamps are TEXT, so a raw `ORDER BY` would rank `…:00Z` above
 * `…:00.500Z` (ISS-6414). The ranking is BETWEEN rows, so the fold's window is
 * the whole set.
 */
const NEWEST_SESSION_SORT_SQL = allOrNothingCanonicalSortSql(
  canonicalRankingKeySql("s.updated_at"),
  "s.updated_at",
  ""
);

/**
 * The `updated_at` a changed priority re-queues its session with: the write
 * time, or one millisecond past a stored value already at or after it (clock
 * skew, the same millisecond). Never unchanged — an unmoved watermark leaves
 * the edit unsynced until the session next changes (#7794 review) — and never
 * backward. An unparseable stored value is replaced by the write time.
 */
function advancedUpdatedAt(stored: string | null, writtenAt: string): string {
  const storedMs = stored === null ? Number.NaN : Date.parse(stored);
  if (!(storedMs >= Date.parse(writtenAt))) {
    return writtenAt;
  }
  return new Date(storedMs + 1).toISOString();
}
