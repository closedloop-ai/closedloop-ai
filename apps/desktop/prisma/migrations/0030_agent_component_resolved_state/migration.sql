-- F1 (FEA-3290 / PRD-527 Slice 4) — honest component resolution state (AC-007).
-- `resolved_state` records whether an inventory row is backed by an exact user
-- definition (`resolved`), is name/label-only (`unresolved`), was permission-
-- denied at capture (`inaccessible`), or was deleted/absent (`missing`).
-- `inaccessible` is DELIBERATELY distinct from `missing` (AC-5). Additive +
-- NOT NULL DEFAULT 'unresolved' so every legacy + label-minted row is honestly
-- unresolved until exact definition evidence promotes it. Forward-only on user
-- machines (no down-migration), like every desktop migration. Generated offline.

-- AlterTable
ALTER TABLE "agent_components" ADD COLUMN "resolved_state" TEXT NOT NULL DEFAULT 'unresolved';
