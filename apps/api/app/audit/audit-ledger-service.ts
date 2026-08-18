import { createHash } from "node:crypto";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_EMPTY_CHAIN_HEAD,
  AUDIT_GENESIS_PREV_HASH,
  type AuditActorType,
  type AuditChainHead,
} from "@repo/api/src/types/audit";
import { Prisma, type TransactionClient, withDb } from "@repo/database";
import { z } from "zod";

/**
 * Tamper-evident audit ledger core (FEA-3856 / FEA-3799 Phase 1 Slice 1a) plus
 * the single-writer append path and read surfaces (FEA-3862 Slice 1b).
 *
 * This module owns the pure hashing/canonical-JSON primitives, the
 * `verifyChain(organizationId)` read that recomputes an organization's chain
 * and reports the first broken link, the `readHead` chain-head read, and the
 * per-org single-writer `append`. Every method is org-scoped.
 *
 * Hashing is built on `node:crypto` `createHash` (mirroring
 * `apps/api/lib/auth/token-hash.ts`), NOT by overloading `hashToken`: the ledger
 * hashes a canonical concatenation of structured fields, not a single string.
 */

/**
 * ASCII Unit Separator (U+001F) used to join the hashed fields. See
 * `computeHash` for why a control character (rather than a printable space) is
 * required.
 */
const HASH_FIELD_SEPARATOR = "";

/**
 * The subset of an audit entry's fields that participate in its hash. `seq` and
 * `createdAt` are included so reordering or backdating a row is detectable;
 * `prevHash` chains each row to its predecessor. Every semantically-relevant
 * persisted column is covered — including `actorType` and `objectType` — so a
 * bypassing operator cannot silently re-attribute a row (e.g. flip
 * `system`→`user`) or re-target it (e.g. `document`→another resource) and still
 * leave the stored hash valid.
 */
export type AuditHashInput = {
  organizationId: string;
  seq: bigint;
  createdAt: Date;
  action: string;
  // The append path always supplies a valid AuditActorType; the read/verify
  // path may carry a raw string for a corrupt row so it hashes to a mismatch
  // (see narrowActorType). Widened to string to accept both without a cast.
  actorType: AuditActorType | string;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: unknown;
  prevHash: string;
};

/**
 * The caller-supplied fields of an append. `seq`, `prevHash`, `hash`, and
 * `createdAt` are assigned by `append` inside the single-writer transaction —
 * the caller never chooses them, so a race cannot pick a colliding or
 * out-of-order `seq`.
 */
export type AuditAppendInput = {
  organizationId: string;
  action: string;
  actorType: AuditActorType;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: Prisma.InputJsonValue;
};

/** A persisted ledger row, as read back for verification. */
export type AuditEntryRow = {
  organizationId: string;
  seq: bigint;
  hash: string;
  prevHash: string;
  action: string;
  // Normally an AuditActorType; a corrupt DB value is carried through as its
  // raw string (see narrowActorType) so the hash recompute flags it.
  actorType: AuditActorType | string;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: unknown;
  createdAt: Date;
};

/**
 * Result of verifying an organization's chain. `ok: true` means every row's
 * stored hash matches a recompute and every `prevHash` links to its
 * predecessor. `ok: false` reports the `seq` of the first row that fails —
 * either a content mismatch (a mutated field) or a broken link.
 */
export type VerifyChainResult =
  | { ok: true }
  | { ok: false; brokenAtSeq: bigint; reason: VerifyBreakReason };

export const VerifyBreakReason = {
  /** A row's stored `hash` does not match a recompute of its fields. */
  HashMismatch: "hash_mismatch",
  /** A row's `prevHash` does not equal the previous row's `hash`. */
  BrokenLink: "broken_link",
  /** The sequence is not gap-free / strictly increasing from 1. */
  SequenceGap: "sequence_gap",
} as const;

export type VerifyBreakReason =
  (typeof VerifyBreakReason)[keyof typeof VerifyBreakReason];

/**
 * Deterministic, sorted-key JSON serialization. Two structurally-equal values
 * (same keys, any insertion order; nested objects and arrays) serialize to the
 * identical string, so the hash of `detail` is stable regardless of how the
 * object was built. Arrays preserve order (order is semantically meaningful);
 * object keys are sorted ascending by code unit.
 *
 * Delegates to the shared `stableStringify` (`@closedloop-ai/loops-api/stable-stringify`)
 * — the same canonical-JSON serializer used for signed command fingerprints —
 * rather than re-deriving one here. Beyond deduplication, `stableStringify`
 * emits each key directly from a sorted `Object.keys` walk (reading
 * `record[key]`), so an own-enumerable key literally named `__proto__` (as
 * `JSON.parse` produces) is serialized like any other key. An earlier local
 * implementation rebuilt objects with `result[key] = …`; that bracket
 * assignment silently drops a `__proto__` key (it targets the prototype slot,
 * not an own property), which would let `{ "__proto__": v, b: 2 }` and
 * `{ b: 2 }` hash identically and defeat tamper detection.
 */
export function canonicalJson(value: unknown): string {
  return stableStringify(value);
}

/**
 * SHA-256 hex digest over the canonical concatenation of an entry's fields:
 *
 *   hash = SHA-256(
 *     organizationId · seq · createdAt · action · actorType · actorId
 *       · objectType · objectId · canonicalJson(detail) · prevHash
 *   )
 *
 * Fields are joined with an ASCII Unit Separator (`U+001F`). Because `action`,
 * `objectType`, and `objectId` are free-form text (a plain space could occur
 * inside them), a printable separator would let two distinct field tuples
 * collide by shifting a boundary (e.g. `("ab","c")` vs `("a","bc")`); `U+001F`
 * is a control character that does not appear in these values, so each boundary
 * is unambiguous. Every semantically-relevant persisted column participates —
 * `actorType`/`objectType` are hashed alongside `actorId`/`objectId` so a row
 * cannot be re-attributed or re-targeted without invalidating its hash.
 * `createdAt` is serialized as its ISO-8601 UTC string (millisecond precision,
 * matching Postgres `TIMESTAMP(3)`), `seq` as its base-10 string, and a null
 * `actorId` as the empty string. The genesis entry passes `prevHash =
 * AUDIT_GENESIS_PREV_HASH` (32 zero bytes as hex).
 */
export function computeHash(input: AuditHashInput): string {
  const fields = [
    input.organizationId,
    input.seq.toString(),
    input.createdAt.toISOString(),
    input.action,
    input.actorType,
    input.actorId ?? "",
    input.objectType,
    input.objectId,
    canonicalJson(input.detail),
    input.prevHash,
  ];
  return createHash("sha256")
    .update(fields.join(HASH_FIELD_SEPARATOR), "utf8")
    .digest("hex");
}

/**
 * Verify an already-ordered slice of an organization's chain in memory. Pure —
 * no DB — so it is exhaustively unit-testable (determinism, genesis, tamper
 * detection) independent of Postgres. `rows` MUST be ascending by `seq`.
 *
 * Checks, in order per row: sequence contiguity (`1, 2, 3, …`), linkage
 * (`prevHash` equals the predecessor's stored `hash`, genesis for the first
 * row), then content (recomputed hash equals the stored `hash`). The content
 * check is last so a mutated historic field is reported at the row it was
 * mutated on, not merely at its successor's broken link.
 */
export function verifyChainRows(
  rows: readonly AuditEntryRow[]
): VerifyChainResult {
  let expectedSeq = 1n;
  let expectedPrevHash = AUDIT_GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.seq !== expectedSeq) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: VerifyBreakReason.SequenceGap,
      };
    }
    if (row.prevHash !== expectedPrevHash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: VerifyBreakReason.BrokenLink,
      };
    }
    const recomputed = computeHash({
      organizationId: row.organizationId,
      seq: row.seq,
      createdAt: row.createdAt,
      action: row.action,
      actorType: row.actorType,
      actorId: row.actorId,
      objectType: row.objectType,
      objectId: row.objectId,
      detail: row.detail,
      prevHash: row.prevHash,
    });
    if (recomputed !== row.hash) {
      return {
        ok: false,
        brokenAtSeq: row.seq,
        reason: VerifyBreakReason.HashMismatch,
      };
    }
    expectedSeq += 1n;
    expectedPrevHash = row.hash;
  }
  return { ok: true };
}

type AuditEntryDbRow = {
  organization_id: string;
  seq: bigint;
  hash: string;
  prev_hash: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  object_type: string;
  object_id: string;
  detail: unknown;
  created_at: Date;
};

const actorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);

/**
 * Narrow the raw DB `actor_type` string to the {@link AuditActorType} union
 * instead of an unchecked `as` cast. When the stored value is one of the known
 * actor types, the parsed union member is returned. When it is NOT — a corrupt
 * row, or one written outside the sanctioned append path — the raw string is
 * carried through unchanged rather than masquerading as a trusted union member.
 * Because `actorType` participates in the hash, a value that no valid append
 * could have produced cannot match the row's stored hash, so `verifyChainRows`
 * reports it as a `HashMismatch` instead of silently trusting it.
 */
function narrowActorType(actorType: string): AuditActorType | string {
  const parsed = actorTypeSchema.safeParse(actorType);
  return parsed.success ? parsed.data : actorType;
}

function toAuditEntryRow(row: AuditEntryDbRow): AuditEntryRow {
  return {
    organizationId: row.organization_id,
    seq: row.seq,
    hash: row.hash,
    prevHash: row.prev_hash,
    action: row.action,
    actorType: narrowActorType(row.actor_type),
    actorId: row.actor_id,
    objectType: row.object_type,
    objectId: row.object_id,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

/**
 * Transaction bounds for the single-writer append paths (`append` and
 * `appendClaimingOutbox`). Both run the shared `appendWithinTx`, which takes a
 * per-org `pg_advisory_xact_lock` to serialize writers for one organization. A
 * second concurrent same-org append (e.g. two overlapping drain passes, or the
 * drain plus a standalone append) blocks on that lock until the holder commits.
 * That wait is added to this transaction's own head read + insert, so a blocked
 * append can stay open past Prisma's 5s default interactive-transaction timeout
 * and abort with a P2028 instead of gracefully waiting its turn — turning the
 * intended serialization into a failed append. Raise both bounds to give the
 * lock wait ample room, matching the advisory-lock writer convention used
 * elsewhere in apps/api (catalog pack import and the pull-request handler both
 * pin 30s timeout / 5s maxWait; deployment recording raises only the timeout,
 * to 15s): 30s work timeout, 5s max wait to acquire a pool connection.
 */
const AUDIT_APPEND_TRANSACTION_TIMEOUT_MS = 30_000;
const AUDIT_APPEND_TRANSACTION_MAX_WAIT_MS = 5000;

const auditAppendTxOptions = {
  maxWait: AUDIT_APPEND_TRANSACTION_MAX_WAIT_MS,
  timeout: AUDIT_APPEND_TRANSACTION_TIMEOUT_MS,
} as const;

export const auditLedgerService = {
  canonicalJson,
  computeHash,
  verifyChainRows,

  /**
   * Recompute and verify an organization's entire audit chain from Postgres.
   * Reads rows in `seq` order (org-scoped) and delegates to the pure
   * `verifyChainRows`. An empty chain trivially verifies (`ok: true`).
   *
   * Slice 1a walks the whole chain in one ordered read; chunked/streaming
   * verification for very long chains is a later concern.
   */
  async verifyChain(organizationId: string): Promise<VerifyChainResult> {
    const rows = await withDb((db) =>
      db.$queryRaw<AuditEntryDbRow[]>(Prisma.sql`
        SELECT
          "organization_id",
          "seq",
          "hash",
          "prev_hash",
          "action",
          "actor_type",
          "actor_id",
          "object_type",
          "object_id",
          "detail",
          "created_at"
        FROM "audit_entries"
        WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "seq" ASC
      `)
    );
    return verifyChainRows(rows.map(toAuditEntryRow));
  },

  /**
   * Read an organization's chain head — the highest `seq` and its `hash` — as
   * the JSON-safe `AuditChainHead` (decimal-string `seq`). An empty chain
   * returns a fresh copy of `AUDIT_EMPTY_CHAIN_HEAD` (`seq: "0"`, genesis hash)
   * so callers can treat empty and populated chains uniformly. Org-scoped;
   * served by the `GET /audit/head` route.
   */
  async readHead(organizationId: string): Promise<AuditChainHead> {
    const rows = await withDb((db) =>
      db.$queryRaw<{ seq: bigint; hash: string }[]>(Prisma.sql`
        SELECT "seq", "hash"
        FROM "audit_entries"
        WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "seq" DESC
        LIMIT 1
      `)
    );
    const head = rows[0];
    if (!head) {
      // Return a fresh copy — never hand out the shared sentinel object, so a
      // caller mutating the result can't corrupt it for later callers.
      return { ...AUDIT_EMPTY_CHAIN_HEAD };
    }
    return { seq: head.seq.toString(), hash: head.hash };
  },

  /**
   * Single-writer append (Slice 1b). Serializes writers *for one organization*
   * on a transaction-scoped advisory lock keyed by
   * `hashtext('audit:' || organizationId)` — the repo idiom (see
   * `catalog/service.ts`), auto-released on commit/rollback so a serverless
   * timeout cannot leak a held lock. Inside the lock it reads the org's current
   * head, assigns `seq = head.seq + 1` (genesis `1` when empty), links
   * `prevHash = head.hash`, computes the row hash (over every persisted column,
   * including `actorType`/`objectType`), and inserts. The lock makes `seq`
   * gap-free and monotonic under concurrency; two *different* orgs never
   * contend because the lock key is per-org.
   *
   * Returns the persisted row's `(seq, hash)` head. Callers on the hot path do
   * NOT invoke this directly — they enqueue via the outbox (`emitAuditEvent`)
   * and the `drain-audit-outbox` cron calls {@link appendClaimingOutbox}, so a
   * slow or failed append never blocks the user's request.
   */
  append(input: AuditAppendInput): Promise<AuditChainHead> {
    return withDb.tx((tx) => appendWithinTx(tx, input), auditAppendTxOptions);
  },

  /**
   * Atomically claim one pending `audit_outbox` row and append it to the ledger
   * in a *single* transaction (the drain path). The claim is a
   * `DELETE … WHERE id = $1 AND attempts < $2 RETURNING id`: exactly one worker
   * can delete a given row, so two overlapping drain passes (or a redelivered
   * cron) can never both append the same event. The `attempts < maxAttempts`
   * predicate enforces the dead-letter cap in the claim itself, so a row that a
   * concurrent pass pushed to the cap after this pass snapshotted the batch is
   * never appended past it. If the claim returns no row — another worker already
   * claimed it, or the row has reached `maxAttempts` — this returns
   * `{ claimed: false }` and appends nothing.
   *
   * Because the outbox delete and the ledger insert commit together, there is no
   * window where the ledger row is committed but the outbox row still pending
   * (which previously could double-append with a fresh `seq`). A rollback (e.g.
   * the append throws) un-deletes the outbox row, so it is retried next pass.
   */
  appendClaimingOutbox(
    outboxId: string,
    input: AuditAppendInput,
    maxAttempts: number
  ): Promise<{ claimed: boolean; head?: AuditChainHead }> {
    return withDb.tx(async (tx) => {
      const claimed = await tx.$queryRaw<{ id: string }[]>(
        Prisma.sql`
          DELETE FROM "audit_outbox"
          WHERE "id" = ${outboxId}::uuid AND "attempts" < ${maxAttempts}
          RETURNING "id"
        `
      );
      if (claimed.length === 0) {
        // Another drain pass already claimed and appended this row, or it has
        // reached the dead-letter cap. Do nothing — appending here would either
        // duplicate the event with a new seq or run a parked row past its cap.
        return { claimed: false };
      }
      const head = await appendWithinTx(tx, input);
      return { claimed: true, head };
    }, auditAppendTxOptions);
  },
} as const;

/**
 * The core single-writer append, running inside a caller-supplied transaction.
 * Takes the per-org advisory lock, reads the head, assigns the next `seq`, links
 * `prevHash`, hashes every persisted column, and inserts. Extracted so both the
 * standalone {@link auditLedgerService.append} and the drain's atomic
 * claim-and-append ({@link auditLedgerService.appendClaimingOutbox}) share one
 * implementation and one hashing contract.
 */
async function appendWithinTx(
  tx: TransactionClient,
  input: AuditAppendInput
): Promise<AuditChainHead> {
  // Transaction-scoped, per-org advisory lock: the second concurrent writer
  // for this org blocks here until the first commits, then reads the now
  // -committed head — so no two appends can pick the same seq. Auto-released
  // at tx end. Different orgs hash to different keys and never contend.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`audit:${input.organizationId}`}))`;

  const headRows = await tx.$queryRaw<{ seq: bigint; hash: string }[]>(
    Prisma.sql`
      SELECT "seq", "hash"
      FROM "audit_entries"
      WHERE "organization_id" = ${input.organizationId}::uuid
      ORDER BY "seq" DESC
      LIMIT 1
    `
  );
  const head = headRows[0];
  const seq = head ? head.seq + 1n : 1n;
  const prevHash = head ? head.hash : AUDIT_GENESIS_PREV_HASH;
  const createdAt = new Date();
  const hash = computeHash({
    organizationId: input.organizationId,
    seq,
    createdAt,
    action: input.action,
    actorType: input.actorType,
    actorId: input.actorId,
    objectType: input.objectType,
    objectId: input.objectId,
    detail: input.detail,
    prevHash,
  });

  await tx.auditEntry.create({
    data: {
      organizationId: input.organizationId,
      seq,
      hash,
      prevHash,
      action: input.action,
      actorType: input.actorType,
      actorId: input.actorId,
      objectType: input.objectType,
      objectId: input.objectId,
      detail: input.detail,
      createdAt,
    },
  });

  return { seq: seq.toString(), hash };
}
