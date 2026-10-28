import {
  SearchEntityType,
  STATUS_TRIGGER_OWNED_ENTITY_TYPES,
} from "@repo/api/src/types/search-entity-kind";
import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-9938 — the shape of the two triggers that kept `search_document.status`
 * in step with `artifacts.status` and `loops.status`. ISS-12435 dropped the
 * loop trigger and its function; the artifact trigger remains.
 *
 * The behavioral proof is
 * `__tests__/integration/iss9938-search-document-status-sync.integration.test.ts`,
 * which needs a real Postgres and so does not run in the unit tier. This file
 * is what fails in the unit tier when a trigger's event list, its DOCUMENT
 * gate, or the set of columns its function writes is changed. Prisma's drift
 * check cannot see any of it: triggers are invisible to `schema.prisma`.
 *
 * Every assertion is made against ONE parsed statement, never a substring of
 * the whole file (`packages/database/AGENTS.md`). Reads declarative
 * migration.sql DDL only — not implementation source.
 */

const MIGRATION = "20260921132329_iss9938_search_document_status_sync_triggers";

/** ISS-12435 retires Loops and drops the loop half of the ISS-9938 sync. */
const LOOPS_DATA_MIGRATION = "20261013180200_iss12435_empty_loops_data";

/**
 * Repeated as literals rather than derived: a rename has to change this file
 * too, so it is a decision somebody makes rather than one that rides along.
 */
const ARTIFACT_TRIGGER = "artifacts_search_document_status_sync";
const ARTIFACT_FUNCTION = "sync_search_document_artifact_status";
const LOOP_TRIGGER = "loops_search_document_status_sync";
const LOOP_FUNCTION = "sync_search_document_loop_status";

const WHITESPACE_G = /\s+/g;
const ANY_CREATE_TRIGGER_G = /\bCREATE\s+TRIGGER\b/gi;
const ANY_CREATE_FUNCTION_G = /\bCREATE\s+FUNCTION\b/gi;
const CREATE_TRIGGER_G = /CREATE\s+TRIGGER\s+"([^"]+)"([^;]*);/gi;
const CREATE_FUNCTION_G =
  /CREATE\s+FUNCTION\s+"([^"]+)"\(\)\s*RETURNS\s+trigger\s+AS\s+\$\$([\s\S]*?)\$\$\s*LANGUAGE\s+plpgsql\s*;/gi;
const UPDATE_STATEMENT_G =
  /\bUPDATE\s+"([^"]+)"\s+SET\s+([\s\S]*?)\s+WHERE\s+([\s\S]*?);/gi;
const INSERT_G = /\bINSERT\b/i;
const ENTITY_TYPE_LITERAL_G = /"entity_type"\s*=\s*'([^']+)'/g;
const ANY_DROP_TRIGGER_G = /\bDROP\s+TRIGGER\b/gi;
const ANY_DROP_FUNCTION_G = /\bDROP\s+FUNCTION\b/gi;
const DROP_TRIGGER_G =
  /DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\s+ON\s+"([^"]+)"\s*;/gi;
const DROP_FUNCTION_G =
  /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"([^"]+)"\(\)\s*;/gi;

type ParsedUpdate = { table: string; set: string; where: string };

describe(`${MIGRATION} migration DDL`, () => {
  it("creates exactly two triggers and two functions", () => {
    // Counted with looser patterns than the parsers use, so a statement the
    // strict parser cannot read fails the count instead of vanishing from it.
    const ddl = migrationDdl(MIGRATION);
    expect(ddl.match(ANY_CREATE_TRIGGER_G) ?? []).toHaveLength(2);
    expect(ddl.match(ANY_CREATE_FUNCTION_G) ?? []).toHaveLength(2);
    expect([...parseTriggers().keys()].sort()).toEqual(
      [ARTIFACT_TRIGGER, LOOP_TRIGGER].sort()
    );
    expect([...parseFunctions().keys()].sort()).toEqual(
      [ARTIFACT_FUNCTION, LOOP_FUNCTION].sort()
    );
  });

  // `UPDATE OF "status"` keeps every other artifact write from reaching the
  // function. The `type = 'DOCUMENT'` gate keeps session, branch and
  // deployment status writes — session status is written at desktop-sync
  // cadence — from firing it at all. FOR EACH ROW because both bulk status
  // paths write many rows in one statement.
  it("fires on artifacts per row, on a status change, for DOCUMENT artifacts only", () => {
    expect(parseTriggers().get(ARTIFACT_TRIGGER)).toBe(
      `AFTER UPDATE OF "status" ON "artifacts" FOR EACH ROW WHEN (NEW."type" = 'DOCUMENT' AND OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION "${ARTIFACT_FUNCTION}"()`
    );
  });

  it("fires on loops per row, on a status change", () => {
    expect(parseTriggers().get(LOOP_TRIGGER)).toBe(
      `AFTER UPDATE OF "status" ON "loops" FOR EACH ROW WHEN (OLD."status" IS DISTINCT FROM NEW."status") EXECUTE FUNCTION "${LOOP_FUNCTION}"()`
    );
  });

  // `status` and nothing else. Leaving `updated_at` alone is PLN-2065 §8's
  // scope decision, and the migration header names the reads it costs, so a
  // trigger that starts writing it has to change this deliberately. The WHERE
  // is the projection's unique key, and its entity_type literal must be the
  // value the app writes, or the trigger silently matches no row.
  it("writes only the document row's status, keyed on the projection's unique key", () => {
    expect(onlyUpdate(ARTIFACT_FUNCTION)).toEqual({
      table: "search_document",
      set: '"status" = NEW."status"',
      where: `"organization_id" = NEW."organization_id" AND "entity_type" = '${SearchEntityType.Document}' AND "entity_id" = NEW."id" AND "status" IS DISTINCT FROM NEW."status"`,
    });
  });

  it("writes only the loop row's status, cast from the LoopStatus enum to text", () => {
    expect(onlyUpdate(LOOP_FUNCTION)).toEqual({
      table: "search_document",
      set: '"status" = NEW."status"::text',
      where: `"organization_id" = NEW."organization_id" AND "entity_type" = '${SearchEntityType.Loop}' AND "entity_id" = NEW."id" AND "status" IS DISTINCT FROM NEW."status"::text`,
    });
  });

  // A missing mirror row is created by the app's post-commit indexer with the
  // status current at that moment; a trigger that inserted would create rows
  // with no title or body behind them.
  it("never inserts a mirror row", () => {
    for (const [name, body] of parseFunctions()) {
      expect(INSERT_G.test(body), name).toBe(false);
    }
  });

  // The app's writers read the source status for exactly the kinds the shared
  // set names; a kind in one and not the other means either a trigger nobody
  // reads through or a read no trigger backs. A function a later migration
  // dropped no longer backs any kind.
  it("covers exactly the entity kinds the app treats as trigger-owned", () => {
    const dropped = parseDroppedFunctions();
    const covered = [...parseFunctions()]
      .filter(([name]) => !dropped.has(name))
      .flatMap(([, body]) =>
        [...body.matchAll(ENTITY_TYPE_LITERAL_G)].map((match) => match[1])
      );
    expect(covered.sort()).toEqual(
      [...STATUS_TRIGGER_OWNED_ENTITY_TYPES].sort()
    );
  });
});

describe(`${LOOPS_DATA_MIGRATION} migration DDL`, () => {
  it("drops the loop status trigger on loops and its function, and nothing else", () => {
    const ddl = migrationDdl(LOOPS_DATA_MIGRATION);
    expect(ddl.match(ANY_DROP_TRIGGER_G) ?? []).toHaveLength(1);
    expect(ddl.match(ANY_DROP_FUNCTION_G) ?? []).toHaveLength(1);
    expect([...parseDroppedTriggers()]).toEqual([[LOOP_TRIGGER, "loops"]]);
    expect([...parseDroppedFunctions()]).toEqual([LOOP_FUNCTION]);
  });
});

function flat(text: string): string {
  return text.replace(WHITESPACE_G, " ").trim();
}

/** Trigger name → everything after its name, whitespace-collapsed. */
function parseTriggers(): Map<string, string> {
  const triggers = new Map<string, string>();
  for (const match of migrationDdl(MIGRATION).matchAll(CREATE_TRIGGER_G)) {
    triggers.set(match[1], flat(match[2]));
  }
  return triggers;
}

/** Function name → its plpgsql body between the `$$` quotes. */
function parseFunctions(): Map<string, string> {
  const functions = new Map<string, string>();
  for (const match of migrationDdl(MIGRATION).matchAll(CREATE_FUNCTION_G)) {
    functions.set(match[1], match[2]);
  }
  return functions;
}

/** Trigger name → table, for every `DROP TRIGGER` in the ISS-12435 data step. */
function parseDroppedTriggers(): Map<string, string> {
  const triggers = new Map<string, string>();
  for (const match of migrationDdl(LOOPS_DATA_MIGRATION).matchAll(
    DROP_TRIGGER_G
  )) {
    triggers.set(match[1], match[2]);
  }
  return triggers;
}

/** Function names the ISS-12435 data step drops. */
function parseDroppedFunctions(): Set<string> {
  return new Set(
    [...migrationDdl(LOOPS_DATA_MIGRATION).matchAll(DROP_FUNCTION_G)].map(
      (match) => match[1]
    )
  );
}

/** The single UPDATE in a function body, or a failure naming the count. */
function onlyUpdate(functionName: string): ParsedUpdate {
  const body = parseFunctions().get(functionName);
  if (body === undefined) {
    throw new Error(`${MIGRATION}: function ${functionName} not found`);
  }
  const updates = [...body.matchAll(UPDATE_STATEMENT_G)].map(
    (match): ParsedUpdate => ({
      table: match[1],
      set: flat(match[2]),
      where: flat(match[3]),
    })
  );
  if (updates.length !== 1) {
    throw new Error(
      `${MIGRATION}: ${functionName} carries ${updates.length} UPDATE statements, expected exactly 1`
    );
  }
  return updates[0];
}
