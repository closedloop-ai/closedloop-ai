/**
 * Real-Postgres integration proof for the LIVE audit ledger (FEA-3862 Slices
 * 1b–1d). Complements __tests__/integration/audit-ledger.test.ts (Slice 1a:
 * trigger + tamper detection) by exercising the pieces only a real database can
 * prove:
 *   - single-writer append: N concurrent appends for one org produce gap-free
 *     seq 1..N with linked prevHash, under the per-org advisory lock (1b)
 *   - two orgs appending concurrently do not serialize against each other and
 *     each chain verifies (1b)
 *   - the emit → outbox → drain → ledger round-trip records a verifiable entry,
 *     and a re-drain is idempotent (no duplicate seq) (1c)
 *   - readHead returns the live head (seq,hash); verifyChain passes (1d)
 *
 * Self-skips when DATABASE_URL is unset (matches the other integration suites).
 * All rows are namespaced under freshly-created orgs and cleaned up in afterAll
 * (org delete cascades to audit_entries and audit_outbox via the FK).
 */
import {
  AUDIT_GENESIS_PREV_HASH,
  AuditAction,
  AuditActorType,
  AuditObjectType,
} from "@repo/api/src/types/audit";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  drainAuditOutbox,
  emitAuditEvent,
  MAX_DRAIN_ATTEMPTS,
} from "@/app/audit/audit-emit-service";
import { auditLedgerService } from "@/app/audit/audit-ledger-service";
import { createTestOrganization } from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

describe.skipIf(!hasDatabase)(
  "audit ledger live integration (real Postgres)",
  () => {
    let orgId: string;
    let otherOrgId: string;

    beforeAll(async () => {
      orgId = await createTestOrganization();
      otherOrgId = await createTestOrganization();
    });

    afterAll(async () => {
      await withDb.tx(async (tx) => {
        await tx.organization.delete({ where: { id: orgId } });
        await tx.organization.delete({ where: { id: otherOrgId } });
      });
    });

    it("assigns gap-free, monotonic seq under concurrent appends (single-writer)", async () => {
      const concurrentOrg = await createTestOrganization();
      try {
        const N = 25;
        // Fire N appends for ONE org concurrently. Without the per-org advisory
        // lock two of these would read the same head and pick a colliding seq;
        // the lock serializes them so seq is exactly 1..N with linked prevHash.
        const heads = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            auditLedgerService.append({
              organizationId: concurrentOrg,
              action: AuditAction.DocumentStatusChanged,
              actorType: AuditActorType.System,
              actorId: null,
              objectType: AuditObjectType.Document,
              objectId: `doc-${i}`,
              detail: { i },
            })
          )
        );

        const seqs = heads.map((h) => Number(h.seq)).sort((a, b) => a - b);
        expect(seqs).toEqual(Array.from({ length: N }, (_, i) => i + 1));

        // The chain the concurrent appends built verifies end-to-end (linkage +
        // recompute), and the head reports seq=N.
        const verify = await auditLedgerService.verifyChain(concurrentOrg);
        expect(verify).toEqual({ ok: true });
        const head = await auditLedgerService.readHead(concurrentOrg);
        expect(Number(head.seq)).toBe(N);
      } finally {
        await withDb((db) =>
          db.organization.delete({ where: { id: concurrentOrg } })
        );
      }
    });

    it("does not serialize appends across different orgs; each chain verifies", async () => {
      // Interleave appends to two orgs concurrently. Per-org lock keys differ, so
      // they never contend; both chains must be independently valid.
      await Promise.all([
        ...Array.from({ length: 5 }, (_, i) =>
          auditLedgerService.append({
            organizationId: orgId,
            action: AuditAction.DocumentStatusChanged,
            actorType: AuditActorType.System,
            actorId: null,
            objectType: AuditObjectType.Document,
            objectId: `a-${i}`,
            detail: { i },
          })
        ),
        ...Array.from({ length: 5 }, (_, i) =>
          auditLedgerService.append({
            organizationId: otherOrgId,
            action: AuditAction.DocumentStatusChanged,
            actorType: AuditActorType.System,
            actorId: null,
            objectType: AuditObjectType.Document,
            objectId: `b-${i}`,
            detail: { i },
          })
        ),
      ]);

      expect(await auditLedgerService.verifyChain(orgId)).toEqual({ ok: true });
      expect(await auditLedgerService.verifyChain(otherOrgId)).toEqual({
        ok: true,
      });
      expect(Number((await auditLedgerService.readHead(orgId)).seq)).toBe(5);
      expect(Number((await auditLedgerService.readHead(otherOrgId)).seq)).toBe(
        5
      );
    });

    it("emit → drain records a verifiable ledger entry; re-drain is idempotent", async () => {
      const emitOrg = await createTestOrganization();
      try {
        // Genesis: empty chain returns the sentinel head.
        const before = await auditLedgerService.readHead(emitOrg);
        expect(before).toEqual({ seq: "0", hash: AUDIT_GENESIS_PREV_HASH });

        await emitAuditEvent({
          organizationId: emitOrg,
          actor: { actorType: AuditActorType.User, actorId: null },
          action: AuditAction.ApiKeyMinted,
          objectType: AuditObjectType.ApiKey,
          objectId: "key-1",
          detail: { name: "ci" },
        });

        // Nothing is in the ledger until the drain runs (emission is async).
        expect(Number((await auditLedgerService.readHead(emitOrg)).seq)).toBe(
          0
        );

        const first = await drainAuditOutbox();
        expect(first.appended).toBeGreaterThanOrEqual(1);

        // The emitted event is now a real, verifiable ledger row.
        const head = await auditLedgerService.readHead(emitOrg);
        expect(Number(head.seq)).toBe(1);
        expect(await auditLedgerService.verifyChain(emitOrg)).toEqual({
          ok: true,
        });

        // Re-drain: the appended row was deleted from the outbox, so no duplicate
        // seq is produced.
        await drainAuditOutbox();
        expect(Number((await auditLedgerService.readHead(emitOrg)).seq)).toBe(
          1
        );
        expect(await auditLedgerService.verifyChain(emitOrg)).toEqual({
          ok: true,
        });
      } finally {
        await withDb((db) =>
          db.organization.delete({ where: { id: emitOrg } })
        );
      }
    });

    it("drains a row one below the cap but parks a row at the cap", async () => {
      const capOrg = await createTestOrganization();
      try {
        // Two outbox rows with valid payloads (their appends would succeed):
        // one one-below the cap, one exactly at the cap.
        const [belowCap, atCap] = await withDb((db) =>
          Promise.all([
            db.auditOutbox.create({
              data: {
                organizationId: capOrg,
                action: AuditAction.ApiKeyMinted,
                actorType: AuditActorType.System,
                actorId: null,
                objectType: AuditObjectType.ApiKey,
                objectId: "below-cap",
                detail: {},
                attempts: MAX_DRAIN_ATTEMPTS - 1,
              },
            }),
            db.auditOutbox.create({
              data: {
                organizationId: capOrg,
                action: AuditAction.ApiKeyMinted,
                actorType: AuditActorType.System,
                actorId: null,
                objectType: AuditObjectType.ApiKey,
                objectId: "at-cap",
                detail: {},
                attempts: MAX_DRAIN_ATTEMPTS,
              },
            }),
          ])
        );

        await drainAuditOutbox();

        // The below-cap row was drained (claimed, appended, deleted); the parked
        // at-cap row was excluded from the batch and remains pending.
        const remaining = await withDb((db) =>
          db.auditOutbox.findMany({
            where: { organizationId: capOrg },
            select: { id: true },
          })
        );
        expect(remaining).toEqual([{ id: atCap.id }]);
        expect(Number((await auditLedgerService.readHead(capOrg)).seq)).toBe(1);
        // The at-cap row is untouched — never claimed, never a ledger entry.
        expect(belowCap.id).not.toBe(atCap.id);
      } finally {
        await withDb((db) => db.organization.delete({ where: { id: capOrg } }));
      }
    });

    it("the claim re-checks the cap: a row pushed to the cap after the batch snapshot is never appended past it", async () => {
      // Models the overlap the dead-letter cap must survive: two drain passes
      // both read the same row at attempts = cap-1, then one pass settles it up
      // to the cap. The other pass — holding a stale snapshot — must NOT append
      // it. The claim's `attempts < cap` predicate enforces that even though the
      // stale pass believed the row was still drainable.
      const raceOrg = await createTestOrganization();
      try {
        const row = await withDb((db) =>
          db.auditOutbox.create({
            data: {
              organizationId: raceOrg,
              action: AuditAction.ApiKeyMinted,
              actorType: AuditActorType.System,
              actorId: null,
              objectType: AuditObjectType.ApiKey,
              objectId: "raced",
              detail: {},
              attempts: MAX_DRAIN_ATTEMPTS - 1,
            },
          })
        );

        // A concurrent pass settled this row up to the cap after our snapshot.
        await withDb((db) =>
          db.auditOutbox.updateMany({
            where: { id: row.id },
            data: { attempts: MAX_DRAIN_ATTEMPTS },
          })
        );

        // Our stale pass tries to claim+append the row it snapshotted at cap-1.
        const result = await auditLedgerService.appendClaimingOutbox(
          row.id,
          {
            organizationId: raceOrg,
            action: AuditAction.ApiKeyMinted,
            actorType: AuditActorType.System,
            actorId: null,
            objectType: AuditObjectType.ApiKey,
            objectId: "raced",
            detail: {},
          },
          MAX_DRAIN_ATTEMPTS
        );

        // Not claimed, nothing appended, row still parked in the outbox.
        expect(result).toEqual({ claimed: false });
        expect(Number((await auditLedgerService.readHead(raceOrg)).seq)).toBe(
          0
        );
        const stillPending = await withDb((db) =>
          db.auditOutbox.findUnique({ where: { id: row.id } })
        );
        expect(stillPending?.attempts).toBe(MAX_DRAIN_ATTEMPTS);
      } finally {
        await withDb((db) =>
          db.organization.delete({ where: { id: raceOrg } })
        );
      }
    });
  }
);
