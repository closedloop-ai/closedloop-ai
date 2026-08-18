/**
 * @file foreign-key-integrity.ts
 * @description ISS-5102 (PRD-611) — the referential-integrity store-health
 * check: a bounded `PRAGMA foreign_key_check` plus the ISS-5098 FK-less orphan
 * counter. Detection only — healing dangling rows stays with ISS-5098/ISS-5099.
 *
 * `PRAGMA foreign_key_check` reports rows whose FK parent is missing, but it
 * cannot see the one orphan shape that actually took installs down (ISS-5098):
 * `events.agent_id` deliberately has no FK constraint, so its orphans need a
 * separate `NOT EXISTS` count against `agents`.
 *
 * The second counter names our tables, so this module must NOT live in
 * `database-integrity/` — that directory is deliberately engine-level only. It
 * follows the shape `token-parity.ts` / `invocation-telemetry-integrity.ts`
 * established: the SQL, the READ, the wire SCHEMA, and the CLASSIFIER live
 * here, and {@link foreignKeyIntegrityCheck} composes them into the probe's
 * generic optional-check descriptor so the schema-aware wiring injects the
 * check rather than the probe importing it. The dependency runs one way only —
 * this module imports `database-integrity/`, never the reverse.
 *
 * FEA-2038 aggregate invariant: everything is counted in SQL. The only rows
 * hydrated into JS are the per-child-table GROUP BY rows (bounded by the number
 * of tables in our schema, belt-and-braces LIMIT {@link FK_VIOLATION_TABLE_CAP})
 * — never a violating row itself, so no rowid or column value can leave SQL.
 */

import { z } from "zod";
import type { StoreIntegrityIssue } from "../telemetry/telemetry-protocol.js";
import {
  defineStoreIntegrityOptionalCheck,
  type StoreIntegrityOptionalCheck,
} from "./database-integrity/store-integrity-probe.js";
import type { DesktopPrisma } from "./prisma-client.js";

/** Cap on reported per-table violation groups. Our schema has far fewer tables
 *  than this, so the cap only guards a pathological store; `violationTotal`
 *  stays exact regardless (it is a window SUM over ALL groups, computed before
 *  the LIMIT applies). */
export const FK_VIOLATION_TABLE_CAP = 50;

/** Mirrors the probe's forwarded-identifier clamp: a reported table name is a
 *  single schema identifier that becomes an issue `object` bound for Datadog,
 *  so an arbitrary string from a version-skewed host must never get there. */
const TABLE_IDENTIFIER_RE = /^[A-Za-z0-9_]+$/;
const MAX_TABLE_IDENTIFIER_LENGTH = 128;

/**
 * Bounded, content-free referential-integrity counts. `violationTotal` is the
 * EXACT number of dangling FK rows store-wide; `violationTables` is the
 * per-child-table breakdown, capped at {@link FK_VIOLATION_TABLE_CAP} groups.
 */
export type ForeignKeyIntegrityResult = {
  violationTotal: number;
  violationTables: { table: string; rows: number }[];
  orphanEventAgentRows: number;
};

/**
 * The minimal reader surface this check needs, satisfied structurally by the
 * desktop `SqliteAgentDatabase` (and by the db-host proxy in production).
 * Optional for the same reason the probe's other optional checks are: a test
 * fake, or a version-skewed host predating this read, need not serve it.
 */
export type ForeignKeyIntegrityReader = {
  runForeignKeyIntegrityCheck?(): Promise<ForeignKeyIntegrityResult>;
};

/** The counts as they arrive ACROSS the db-host method proxy. A version-skewed
 *  host that answers with a shape this build cannot read — including a table
 *  name that is not a plain schema identifier — fails this parse, which drops
 *  the whole check (omitted from `checksRun`) rather than reporting it clean. */
export const FOREIGN_KEY_INTEGRITY_SCHEMA = z
  .object({
    violationTotal: z.number().int().nonnegative().safe(),
    violationTables: z
      .array(
        z.object({
          table: z
            .string()
            .max(MAX_TABLE_IDENTIFIER_LENGTH)
            .regex(TABLE_IDENTIFIER_RE),
          /* A `GROUP BY` group always has at least one row, so 0 is impossible
             and would classify as nothing while still claiming the table. */
          rows: z.number().int().positive().safe(),
        })
      )
      .max(FK_VIOLATION_TABLE_CAP),
    orphanEventAgentRows: z.number().int().nonnegative().safe(),
  })
  .superRefine((value, ctx) => {
    const tables = value.violationTables.map((entry) => entry.table);
    if (new Set(tables).size !== tables.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "duplicate table in violationTables (GROUP BY cannot repeat)",
      });
    }
    /* The total is a window SUM over ALL groups while the list is LIMITed, so
       the group rows must reconcile with it exactly below the cap and may only
       fall short AT the cap. Anything else is a contradictory payload — most
       dangerously a positive total with no groups, which the classifier would
       turn into a silent "healthy". */
    const summed = value.violationTables.reduce(
      (total, entry) => total + entry.rows,
      0
    );
    const atCap = value.violationTables.length === FK_VIOLATION_TABLE_CAP;
    const reconciles = atCap
      ? summed <= value.violationTotal
      : summed === value.violationTotal;
    if (!reconciles) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `violationTables rows (${summed}) do not reconcile with violationTotal (${value.violationTotal})`,
      });
    }
  });

// `pragma_foreign_key_check` is the table-valued form of the PRAGMA (it reports
// existing dangles whatever `PRAGMA foreign_keys` is set to). One scan: the
// per-table GROUP BY bounds what is hydrated, and the window SUM keeps the
// store-wide total exact even if the group list were ever capped.
const FK_VIOLATIONS_SQL = `SELECT tbl, cnt, total FROM (
    SELECT "table" AS tbl, COUNT(*) AS cnt, SUM(COUNT(*)) OVER () AS total
    FROM pragma_foreign_key_check
    GROUP BY "table"
    ORDER BY cnt DESC, tbl
  ) LIMIT ${FK_VIOLATION_TABLE_CAP}`;

// ISS-5098's orphan shape. `events.agent_id` deliberately has no FK (an event
// may outlive agent materialization), so `foreign_key_check` cannot see it;
// `idx_events_agent_id` keeps this an index-driven anti-join.
const ORPHAN_EVENT_AGENT_SQL = `SELECT COUNT(*) AS cnt FROM events e
    WHERE e.agent_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = e.agent_id)`;

export function runForeignKeyIntegrityCheck(
  prisma: DesktopPrisma
): Promise<ForeignKeyIntegrityResult> {
  /* Both reads run inside ONE read-scoped `$transaction` so they see a single
     committed snapshot. Run separately they can be torn by a concurrent writer:
     re-parenting a row between them moves it from the FK-less orphan count into
     the `foreign_key_check` set (or the reverse), and each read then misses it
     in its own window — a store that was never clean reports zero on both. */
  return prisma.read((reader) =>
    reader.$transaction(async (tx) => {
      const violationRows =
        await tx.$queryRawUnsafe<
          { tbl: string; cnt: bigint | number; total: bigint | number }[]
        >(FK_VIOLATIONS_SQL);
      const [orphanRow] = await tx.$queryRawUnsafe<
        { cnt: bigint | number | null }[]
      >(ORPHAN_EVENT_AGENT_SQL);
      /* A bare `COUNT(*)` returns exactly one row, always. No row (or a null
         count) means the read itself is broken, so throw and let the probe omit
         the check — coalescing to 0 would report a broken read as a clean store.
         The violation read is different: an EMPTY result set is the legitimate
         healthy answer (no groups), so its total defaults to 0. */
      if (orphanRow?.cnt === undefined || orphanRow.cnt === null) {
        throw new Error(
          "foreign_key_check: orphan COUNT(*) returned no row — broken read"
        );
      }
      return {
        violationTotal: Number(violationRows[0]?.total ?? 0),
        violationTables: violationRows.map((row) => ({
          table: row.tbl,
          rows: Number(row.cnt),
        })),
        orphanEventAgentRows: Number(orphanRow.cnt),
      };
    })
  );
}

/**
 * Map non-empty counts into the degraded taxonomy: one `foreign_key_violation`
 * issue per offending child table, and one `orphaned_row` issue for the
 * ISS-5098 shape. `object` carries a bounded table identifier only — the wire
 * schema above guarantees no rowid or row value can have reached this far.
 */
export function classifyForeignKeyIntegrity(
  result: ForeignKeyIntegrityResult,
  issues: StoreIntegrityIssue[]
): void {
  for (const violation of result.violationTables) {
    if (violation.rows > 0) {
      issues.push({
        check: "foreign_key_check",
        category: "foreign_key_violation",
        object: violation.table,
        objectType: "table",
      });
    }
  }
  if (result.orphanEventAgentRows > 0) {
    issues.push({
      check: "foreign_key_check",
      category: "orphaned_row",
      object: "events",
      objectType: "table",
    });
  }
}

/**
 * Compose the read + schema + classifier into the probe's generic optional-check
 * descriptor. The wiring passes the result as an `extraChecks` entry, which is
 * how the schema-agnostic probe runs a schema-aware check without importing one.
 *
 * The read is a CLOSURE, never
 * `reader.runForeignKeyIntegrityCheck?.bind(reader)` — detaching a method off
 * the db-host proxy is never valid (it builds the op path `…Check.bind` and
 * posts the non-clone-safe proxy as an argument; that is how ISS-4818 took
 * Desktop down). See the proxy note on `StoreIntegrityReader`.
 */
export function foreignKeyIntegrityCheck(
  reader: ForeignKeyIntegrityReader
): StoreIntegrityOptionalCheck {
  return defineStoreIntegrityOptionalCheck({
    name: "foreign_key_check",
    label: "foreign key integrity check",
    read: reader.runForeignKeyIntegrityCheck
      ? () => Promise.resolve(reader.runForeignKeyIntegrityCheck?.())
      : undefined,
    schema: FOREIGN_KEY_INTEGRITY_SCHEMA,
    classify: classifyForeignKeyIntegrity,
  });
}
