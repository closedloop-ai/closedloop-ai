/**
 * Real-Postgres integration proof for the audit ledger (FEA-3856 Slice 1a).
 *
 * Unlike the pure unit tests in
 * apps/api/app/audit/__tests__/audit-ledger-service.test.ts, this suite exercises
 * the DB-backed pieces that only a real database can prove:
 *   - the append-only trigger rejects UPDATE and DELETE on audit_entries
 *   - the statement-level trigger rejects TRUNCATE of audit_entries
 *   - INSERT (the append path) is permitted
 *   - auditLedgerService.verifyChain(orgId) verifies an intact persisted chain
 *   - a raw-SQL tamper of a historic row's detail is detected (brokenAtSeq)
 *   - org isolation: verifyChain(A) never reads org B's rows
 *
 * Self-skips when DATABASE_URL is unset (matches the other integration suites).
 * All rows are namespaced under freshly-created orgs and cleaned up in afterAll
 * (org delete cascades to audit_entries via the FK).
 */
import { randomUUID } from "node:crypto";
import {
  AUDIT_GENESIS_PREV_HASH,
  AuditActorType,
} from "@repo/api/src/types/audit";
import { Prisma, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AuditEntryRow,
  auditLedgerService,
  computeHash,
  VerifyBreakReason,
} from "@/app/audit/audit-ledger-service";
import { createTestOrganization } from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;
const appendOnlyErrorPattern = /append-only/i;

type AppendSpec = {
  action: string;
  actorType: AuditActorType;
  actorId: string | null;
  objectType: string;
  objectId: string;
  detail: Prisma.InputJsonValue;
};

/**
 * Append a row via the INSERT path (allowed by the trigger), assigning the next
 * gap-free seq and linking prevHash to the org's current head. Mirrors the
 * Slice 1b append contract closely enough to build a valid persisted chain.
 */
function appendEntry(
  organizationId: string,
  spec: AppendSpec
): Promise<AuditEntryRow> {
  return withDb.tx(async (tx) => {
    const headRows = await tx.$queryRaw<{ seq: bigint; hash: string }[]>(
      Prisma.sql`
        SELECT "seq", "hash" FROM "audit_entries"
        WHERE "organization_id" = ${organizationId}::uuid
        ORDER BY "seq" DESC
        LIMIT 1
      `
    );
    const head = headRows[0];
    const seq = head ? head.seq + 1n : 1n;
    const prevHash = head ? head.hash : AUDIT_GENESIS_PREV_HASH;
    const createdAt = new Date();
    const hash = computeHash({
      organizationId,
      seq,
      createdAt,
      action: spec.action,
      actorType: spec.actorType,
      actorId: spec.actorId,
      objectType: spec.objectType,
      objectId: spec.objectId,
      detail: spec.detail,
      prevHash,
    });
    await tx.auditEntry.create({
      data: {
        organizationId,
        seq,
        hash,
        prevHash,
        action: spec.action,
        actorType: spec.actorType,
        actorId: spec.actorId,
        objectType: spec.objectType,
        objectId: spec.objectId,
        detail: spec.detail,
        createdAt,
      },
    });
    return {
      organizationId,
      seq,
      hash,
      prevHash,
      action: spec.action,
      actorType: spec.actorType,
      actorId: spec.actorId,
      objectType: spec.objectType,
      objectId: spec.objectId,
      detail: spec.detail,
      createdAt,
    };
  });
}

function specForIndex(index: number): AppendSpec {
  return {
    action: `document.event_${index}`,
    actorType: index % 2 === 0 ? AuditActorType.User : AuditActorType.System,
    actorId: index % 2 === 0 ? randomUUID() : null,
    objectType: "document",
    objectId: randomUUID(),
    detail: { index, note: `event ${index}`, nested: { a: index, b: [1, 2] } },
  };
}

describe.skipIf(!hasDatabase)(
  "audit ledger integration (real Postgres)",
  () => {
    let orgId: string;
    let otherOrgId: string;

    beforeAll(async () => {
      orgId = await createTestOrganization();
      otherOrgId = await createTestOrganization();
      for (let i = 1; i <= 3; i += 1) {
        await appendEntry(orgId, specForIndex(i));
      }
      // A separate chain in another org to prove isolation.
      await appendEntry(otherOrgId, specForIndex(99));
    });

    afterAll(async () => {
      // Org delete cascades to audit_entries via ON DELETE CASCADE. The trigger
      // permits the cascade DELETE (it re-enters at pg_trigger_depth() > 1), so
      // no escape hatch is needed — deleting the org removes its ledger rows.
      await withDb.tx(async (tx) => {
        await tx.organization.delete({ where: { id: orgId } });
        await tx.organization.delete({ where: { id: otherOrgId } });
      });
    });

    it("permits INSERT (append) and verifies an intact chain", async () => {
      const result = await auditLedgerService.verifyChain(orgId);
      expect(result).toEqual({ ok: true });
    });

    it("rejects a direct UPDATE on a historic row (append-only trigger)", async () => {
      await expect(
        withDb(
          (db) =>
            db.$executeRaw`
          UPDATE "audit_entries"
          SET "detail" = ${Prisma.sql`'{"tampered":true}'::jsonb`}
          WHERE "organization_id" = ${orgId}::uuid AND "seq" = 2
        `
        )
      ).rejects.toThrow(appendOnlyErrorPattern);

      // The row is unchanged and the chain still verifies.
      const result = await auditLedgerService.verifyChain(orgId);
      expect(result).toEqual({ ok: true });
    });

    it("rejects a direct DELETE on a historic row (append-only trigger)", async () => {
      await expect(
        withDb(
          (db) =>
            db.$executeRaw`
          DELETE FROM "audit_entries"
          WHERE "organization_id" = ${orgId}::uuid AND "seq" = 1
        `
        )
      ).rejects.toThrow(appendOnlyErrorPattern);
    });

    it("rejects a TRUNCATE of the ledger (statement-level trigger)", async () => {
      await expect(
        withDb((db) => db.$executeRaw`TRUNCATE TABLE "audit_entries"`)
      ).rejects.toThrow(appendOnlyErrorPattern);

      // The chain is untouched and still verifies.
      const result = await auditLedgerService.verifyChain(orgId);
      expect(result).toEqual({ ok: true });
    });

    it("detects a raw-SQL tamper of a historic row's detail", async () => {
      // Model a privileged operator who bypasses the append-only trigger the
      // ONLY way it can be bypassed — disabling it, an owner/superuser DDL
      // action — then rewrites seq=2's `detail` in place WITHOUT recomputing its
      // hash. verifyChain must catch the now-stale hash. The trigger is
      // re-enabled in the same transaction so the ledger stays locked afterward.
      await withDb.tx(async (tx) => {
        await tx.$executeRaw`ALTER TABLE "audit_entries" DISABLE TRIGGER "audit_entries_append_only"`;
        await tx.$executeRaw`
          UPDATE "audit_entries"
          SET "detail" = '{"index":2,"note":"TAMPERED","nested":{"a":2,"b":[1,2]}}'::jsonb
          WHERE "organization_id" = ${orgId}::uuid AND "seq" = 2
        `;
        await tx.$executeRaw`ALTER TABLE "audit_entries" ENABLE TRIGGER "audit_entries_append_only"`;
      });

      const result = await auditLedgerService.verifyChain(orgId);
      expect(result).toEqual({
        ok: false,
        brokenAtSeq: 2n,
        reason: VerifyBreakReason.HashMismatch,
      });
    });

    it("isolates chains by organization", async () => {
      // Tampering org A above must not affect org B's chain.
      const other = await auditLedgerService.verifyChain(otherOrgId);
      expect(other).toEqual({ ok: true });
    });
  }
);
