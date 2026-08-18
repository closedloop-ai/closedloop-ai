-- CreateTable
CREATE TABLE "audit_entries" (
    "organization_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "hash" CHAR(64) NOT NULL,
    "prev_hash" CHAR(64) NOT NULL,
    "action" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "detail" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entries_pkey" PRIMARY KEY ("organization_id","seq")
);

-- CreateIndex
-- NOTE: no separate (organization_id, seq) index — the composite PRIMARY KEY
-- above already creates a unique btree on exactly those columns, so a second
-- index would be redundant (extra write amplification + storage).
CREATE INDEX "audit_entries_organization_id_object_type_object_id_idx" ON "audit_entries"("organization_id", "object_type", "object_id");

-- AddForeignKey
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- APPEND-ONLY GUARD (FEA-3856) — hand-edited SQL below this line.
--
-- The audit ledger is tamper-evident only if historic rows cannot be silently
-- rewritten or deleted: mutating a row's `detail`/`hash`/`seq` would let a
-- forged chain re-link and defeat `auditLedgerService.verifyChain`. We enforce
-- immutability at the DB layer with a BEFORE UPDATE OR DELETE trigger that
-- RAISEs, so *any* client (Prisma, raw SQL, psql) is rejected regardless of
-- application-layer discipline. INSERT stays allowed — the ledger is
-- append-only, not read-only.
--
-- UPDATE/DELETE are row-level events, but PostgreSQL does NOT fire row-level
-- (or DELETE) triggers for `TRUNCATE`: a client with table-owner privileges
-- could otherwise `TRUNCATE "audit_entries"` and wipe an org's entire chain
-- without tripping the append-only guard. We close that hole with a separate
-- BEFORE TRUNCATE *statement*-level trigger that RAISEs unconditionally.
-- Unlike DELETE, TRUNCATE has no legitimate cascade path here: org offboarding
-- deletes via `DELETE FROM organizations` (which cascades as row-level DELETEs,
-- handled above), never TRUNCATE, so blocking every TRUNCATE is safe. A
-- privileged operator who genuinely must purge disables the trigger explicitly
-- (`ALTER TABLE ... DISABLE TRIGGER`), the same auditable escape hatch as the
-- row-level guard.
--
-- Prisma cannot express a trigger or trigger function in `schema.prisma`, so
-- this is hand-written per packages/database/AGENTS.md ("Hand-write only ...
-- Prisma-inexpressible SQL"). Prisma does NOT track triggers, so this block is
-- invisible to the drift/shadow-database check and does not desync the schema.
--
-- The FK above uses `ON DELETE CASCADE` so deleting an Organization still
-- removes its ledger rows. A cascade delete fires as an implicit DELETE the
-- trigger would otherwise block, so the trigger must distinguish a *direct*
-- DELETE (tampering) from a *cascade* DELETE (legitimate org offboarding). It
-- does so with `pg_trigger_depth()`, which the client CANNOT spoof:
--   * A direct `DELETE FROM audit_entries ...` fires this trigger at depth 1.
--   * A cascade from `DELETE FROM organizations ...` re-enters at depth > 1.
-- So the trigger rejects DELETE at depth 1 and allows it at depth > 1. There is
-- deliberately NO client-settable escape hatch (an earlier draft used a session
-- GUC, but any client can `set_config` it, which would reopen the exact tamper
-- hole this trigger exists to close). A privileged operator who genuinely must
-- purge rows disables the trigger explicitly (`ALTER TABLE ... DISABLE TRIGGER`,
-- an owner/superuser action) — that is auditable at the role/DDL level and is
-- not reachable by an ordinary write connection. Slice 1a has no delete path at
-- all; the cascade is the only sanctioned removal.
-- ============================================================================

CREATE OR REPLACE FUNCTION "audit_entries_reject_mutation"()
RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        -- Allow the delete only when it is a cascade re-entry from a parent
        -- (e.g. Organization) delete; reject a direct DELETE (tampering).
        IF pg_trigger_depth() > 1 THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_entries is append-only: DELETE is not permitted (row org=%, seq=%)', OLD.organization_id, OLD.seq
            USING ERRCODE = 'restrict_violation';
    END IF;
    RAISE EXCEPTION 'audit_entries is append-only: UPDATE is not permitted (row org=%, seq=%)', OLD.organization_id, OLD.seq
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_entries_append_only"
    BEFORE UPDATE OR DELETE ON "audit_entries"
    FOR EACH ROW
    EXECUTE FUNCTION "audit_entries_reject_mutation"();

-- TRUNCATE is a statement-level operation with no OLD row, so it needs its own
-- statement-level function and trigger (a FOR EACH ROW trigger never fires on
-- TRUNCATE). It rejects unconditionally — there is no legitimate TRUNCATE path.
CREATE OR REPLACE FUNCTION "audit_entries_reject_truncate"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only: TRUNCATE is not permitted'
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_entries_no_truncate"
    BEFORE TRUNCATE ON "audit_entries"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "audit_entries_reject_truncate"();
