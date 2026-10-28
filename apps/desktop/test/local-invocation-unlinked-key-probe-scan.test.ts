/**
 * @file local-invocation-unlinked-key-probe-scan.test.ts
 * @description ISS-6843: planner guard for the component-detail reader's
 * unresolved-key probe.
 *
 * `local-invocation-read-contract-version.test.ts` and
 * `local-invocation-no-branch-identity.test.ts` already cover WHAT
 * `readAgentComponentInvocationPage` returns, and both are green whether the
 * probe seeks an index or walks the whole `component_kind` partition — a
 * handful of fixture rows behave identically either way. The defect this file
 * exists for is invisible to that: the probe runs on EVERY agent-component
 * detail load, inside the heap-capped db-host worker, and
 * `local_component_id` is in no index that also leads on `component_kind`, so
 * it was a NON-INDEXED RESIDUAL. Every entry in the kind partition cost a rowid
 * table lookup just to evaluate `local_component_id IS NULL` — and for
 * `component_kind = 'tool'` that partition is essentially the whole
 * `agent_component_invocations` table, the largest-cardinality table in the
 * desktop store.
 *
 * The probe itself has to stay: it is matching on `normalizeComponentKey`, a JS
 * fold (lowercase + trim, FEA-3205), so the candidate keys must come back to JS
 * before the match can happen. That is why the fix is a partial index on the
 * probe's own predicate and not a rewritten WHERE clause, and it is why the
 * fixture below stores a MIXED-CASE key: the fold is load-bearing, so a change
 * that pushed it into SQL would fail the identity assertion here rather than
 * quietly returning nothing.
 *
 * The assertions are about the PLAN and the BYTECODE, not the DDL alone. Four
 * ways to lose what this change bought, each with the assertion that catches it:
 *   - `idx_aci_unlinked_kind_key` is PARTIAL, so SQLite reaches it only where
 *     the query's terms imply `local_component_id IS NULL`. Loosening that term
 *     — into an `OR`, a `COALESCE`, or dropping it in favour of a JS filter —
 *     returns the same keys with every behavioural assertion still green, and
 *     puts the probe back on `idx_aci_kind_key_invoked_at` with the residual.
 *     Caught by {@link UNLINKED_SEEK_RE}.
 *   - WIDENING the INDEX's own predicate — `… IS NULL OR component_kind =
 *     'tool'` — keeps the probe on this index and leaves the plan string
 *     byte-identical, but readmits the linked rows the partial index exists to
 *     exclude, each of which now costs the table lookup back. Caught by
 *     {@link PARTIAL_PREDICATE_RE}, which is ANCHORED on the end of the stored
 *     DDL so only the exact predicate passes.
 *   - REORDERING the key to `(component_key, component_kind)` leaves the seek
 *     column unbound and degrades the probe to a covering SCAN. Caught by
 *     {@link INVOCATIONS_SCAN_RE}.
 *   - WIDENING the key with `invoked_at` re-adds the write cost the migration
 *     argues against and buys the probe nothing — and it is INVISIBLE to the
 *     plan, which stays byte-identical because the extra column is simply
 *     never seeked. Only the DDL can see it, so {@link KEY_COLUMNS_RE} pins the
 *     key list rather than the plan.
 *
 * The index-only property itself is asserted on the BYTECODE, by
 * {@link tableReadOpcodes}, because `EXPLAIN QUERY PLAN` cannot see it: SQLite
 * reports a partial index as plain `USING INDEX` even when the table is never
 * read, since the cursor stays open for the implied `local_component_id` term
 * it resolved away. `USING COVERING INDEX` therefore CANNOT be asserted here —
 * the word never appears for the good plan. The bytecode is unambiguous: with
 * the exact predicate the probe reads columns off the index cursor only, and
 * every way of readmitting linked rows adds a `Column` off the table cursor to
 * re-check `local_component_id`.
 *
 * The statement it plans is CAPTURED from a real production-path call, never
 * transcribed: the store is opened with the `onStatement` hook, the read runs
 * through the exported `readAgentComponentInvocationPage` the two detail call
 * sites use, and the EXPLAIN replays the SQL and bindings that reached the
 * driver adapter. Editing the probe therefore moves this assertion with it — a
 * hand-copied statement would stay green while the detail load drifted back
 * onto the residual.
 *
 * NOT covered here, deliberately: the sibling paged read in the same function
 * keeps its `MULTI-INDEX OR` plus `USE TEMP B-TREE FOR ORDER BY`, because
 * `ORDER BY invoked_at IS NULL ASC, invoked_at DESC, …` is an expression no
 * index can supply. Pinning that plan would pin a shape we want changed.
 */

import assert from "node:assert/strict";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";
import type { CapturedStatement } from "../src/main/database/prisma-statement-observers.js";
import { createWriteQueue } from "../src/main/database/write-queue.js";
import {
  insertComponent,
  insertInvocations,
} from "./agent-components-test-fixtures.js";
import { type OpenTestPrisma, openTestPrisma } from "./prisma-test-utils.js";

type QueryPlanRow = { detail: string };
type SqliteMasterRow = { sql: string | null };
type RootPageRow = { name: string; rootpage: unknown };
/** One `EXPLAIN` step. Every `p` column arrives as a SQLite integer. */
type BytecodeRow = { opcode: string; p1: unknown; p2: unknown };

const SESSION_ID = "session-unlinked-key-probe";
const LINKED_COMPONENT_ID = "cmp-bash";
/**
 * The key as STORED on the unlinked row, and the normalized key the reader is
 * asked for. They differ by case on purpose — that difference is the whole
 * reason the probe exists, so a fixture where they matched would let a SQL-side
 * rewrite of the fold pass.
 */
const STORED_KEY = "Bash";
const NORMALIZED_KEY = "bash";

const INVOCATIONS_TABLE = "agent_component_invocations";
const UNLINKED_INDEX_NAME = "idx_aci_unlinked_kind_key";
/** The index the probe used to land on, carrying the residual this change removes. */
const RESIDUAL_INDEX_NAME = "idx_aci_kind_key_invoked_at";

/** The seek this whole change exists to produce. */
const UNLINKED_SEEK_RE = new RegExp(
  `SEARCH agent_component_invocations USING (?:COVERING )?INDEX ${UNLINKED_INDEX_NAME} \\(component_kind=\\?\\)`
);
/**
 * The regression itself, pinned on the plan WORD rather than on an index name,
 * so any future full walk of the invocations table fails here too.
 */
const INVOCATIONS_SCAN_RE = /\bSCAN agent_component_invocations\b/;
/**
 * The index's own predicate, as the live schema stores it, ANCHORED on the end
 * of the DDL so nothing may be appended to it. A partial index is only
 * reachable while the query can prove it, so narrowing it returns the probe to
 * the residual — but so does WIDENING it (`… IS NULL OR component_kind =
 * 'tool'`), which keeps the probe on this index and the plan string identical
 * while readmitting exactly the linked rows the partial predicate excludes,
 * each one costing back the table lookup this migration removed. An unanchored
 * substring match accepts that widening, so this one is anchored.
 */
const PARTIAL_PREDICATE_RE =
  /\bWHERE\s+"?local_component_id"?\s+IS\s+NULL\s*;?\s*$/i;
/**
 * The index's key list, closed on the paren so a THIRD column fails. The plan
 * cannot see that widening — an unseeked trailing column leaves the detail
 * string byte-identical — so this is the only assertion standing between the
 * narrow key and the per-unlinked-row write cost the migration rejects.
 */
const KEY_COLUMNS_RE = /\(\s*"?component_kind"?\s*,\s*"?component_key"?\s*\)/i;
/** Picks the unresolved-key probe out of everything the read issued. */
const PROBE_RE = /SELECT\s+DISTINCT\s+component_key/i;

async function explain(
  h: OpenTestPrisma,
  statement: CapturedStatement
): Promise<string> {
  const rows = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<QueryPlanRow[]>(
      `EXPLAIN QUERY PLAN ${statement.sql}`,
      ...statement.args
    )
  );
  return rows.map((row) => row.detail).join(" | ");
}

/**
 * The `Column` reads the statement takes off the TABLE cursor — the per-row
 * lookup this migration exists to remove — labelled with the cursor and column
 * they read, so a failure names which column dragged the table back in.
 *
 * `EXPLAIN` names cursors by number, not by table, so cursors are mapped back
 * the only unambiguous way: `sqlite_master.rootpage` gives the b-tree each name
 * lives in, and an `OpenRead` whose `p2` is that root page names the cursor
 * bound to it. Reads off the INDEX cursor are what an index-only plan is made
 * of and are left alone.
 *
 * NO table cursor at all is the BEST case, not a failure: SQLite opens one here
 * only to hold the deferred seek it never takes, and a future version free to
 * elide it would report `USING COVERING INDEX` instead. So the anti-vacuity
 * anchor is the INDEX cursor — if that is missing, the root pages no longer
 * describe this plan and an empty result would mean nothing.
 */
async function tableReadOpcodes(
  h: OpenTestPrisma,
  statement: CapturedStatement
): Promise<string[]> {
  const roots = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<RootPageRow[]>(
      "SELECT name, rootpage FROM sqlite_master WHERE name IN ($1, $2)",
      INVOCATIONS_TABLE,
      UNLINKED_INDEX_NAME
    )
  );
  const rootPage = (name: string): number =>
    Number(roots.find((row) => row.name === name)?.rootpage);
  const tableRoot = rootPage(INVOCATIONS_TABLE);
  const indexRoot = rootPage(UNLINKED_INDEX_NAME);
  if (!(Number.isInteger(tableRoot) && Number.isInteger(indexRoot))) {
    throw new Error(
      `could not resolve the root pages of ${INVOCATIONS_TABLE} / ${UNLINKED_INDEX_NAME}`
    );
  }

  const rows = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<BytecodeRow[]>(
      `EXPLAIN ${statement.sql}`,
      ...statement.args
    )
  );
  const cursorsOn = (root: number): Set<number> =>
    new Set(
      rows
        .filter((row) => row.opcode === "OpenRead" && Number(row.p2) === root)
        .map((row) => Number(row.p1))
    );
  if (cursorsOn(indexRoot).size === 0) {
    throw new Error(
      `${UNLINKED_INDEX_NAME} is never opened by the probe — the cursor mapping this assertion depends on no longer describes the plan`
    );
  }

  const tableCursors = cursorsOn(tableRoot);
  return rows
    .filter(
      (row) => row.opcode === "Column" && tableCursors.has(Number(row.p1))
    )
    .map(
      (row) => `${row.opcode} cursor ${Number(row.p1)} column ${Number(row.p2)}`
    );
}

async function readIndexDdl(
  h: OpenTestPrisma,
  name: string
): Promise<string | undefined> {
  const [row] = await h.prisma.read((reader) =>
    reader.$queryRawUnsafe<SqliteMasterRow[]>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = $1",
      name
    )
  );
  return row?.sql ?? undefined;
}

test("ISS-6843: the component-detail probe seeks the unlinked-key index instead of scanning the kind partition", async () => {
  const captured: CapturedStatement[] = [];
  const h = await openTestPrisma(createWriteQueue(), {
    onStatement: (statement) => captured.push(statement),
  });
  try {
    const ddl = await readIndexDdl(h, UNLINKED_INDEX_NAME);
    assert.ok(
      ddl,
      `${UNLINKED_INDEX_NAME} is missing from the migrated schema`
    );
    assert.match(
      ddl,
      PARTIAL_PREDICATE_RE,
      `${UNLINKED_INDEX_NAME} must be partial on the predicate the probe implies, got: ${ddl}`
    );
    assert.match(
      ddl,
      KEY_COLUMNS_RE,
      `${UNLINKED_INDEX_NAME} must be keyed on (component_kind, component_key) and nothing else — a wider key costs writes the probe never reads, got: ${ddl}`
    );

    // Three rows the probe has to tell apart, all inside the `tool` partition
    // the residual used to walk:
    //   - `inv-linked` carries a local component, so it belongs to the OTHER
    //     arm of `local_component_id` and must stay out of the partial index.
    //   - `inv-unlinked` is the row the probe exists to find, stored under a
    //     key the JS fold has to normalize before it matches.
    //   - `inv-other-kind` shares the normalized key under a different kind, so
    //     the `component_kind=?` seek is load-bearing rather than incidental.
    await insertComponent(h.prisma, {
      id: LINKED_COMPONENT_ID,
      kind: AgentComponentInvocationKind.Tool,
      externalId: NORMALIZED_KEY,
      key: NORMALIZED_KEY,
    });
    await insertInvocations(h.prisma, [
      {
        id: "inv-linked",
        sessionId: SESSION_ID,
        componentKind: AgentComponentInvocationKind.Tool,
        componentKey: NORMALIZED_KEY,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: SESSION_ID,
        sequence: 0,
        localComponentId: LINKED_COMPONENT_ID,
      },
      {
        id: "inv-unlinked",
        sessionId: SESSION_ID,
        componentKind: AgentComponentInvocationKind.Tool,
        componentKey: STORED_KEY,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: SESSION_ID,
        sequence: 1,
      },
      {
        id: "inv-other-kind",
        sessionId: SESSION_ID,
        componentKind: AgentComponentInvocationKind.Skill,
        componentKey: STORED_KEY,
        anchorKind: AgentComponentInvocationAnchorKind.Session,
        anchorValue: SESSION_ID,
        sequence: 2,
      },
    ]);

    // The production read, through the production entry point: whatever SQL
    // this emits IS the statement an agent-component detail load runs. No
    // inventory ids, which is the shape the unresolved-key detail call site
    // (`readSharedAgentComponentDetailByIdentity`) passes.
    captured.length = 0;
    const page = await readAgentComponentInvocationPage(
      h.prisma,
      AgentComponentInvocationKind.Tool,
      NORMALIZED_KEY,
      []
    );
    // The probe is load-bearing, not decoration: only the unlinked row of this
    // kind may come back, and it only comes back because the JS fold matched a
    // key SQL could not have matched.
    assert.deepEqual(
      (page?.items ?? []).map((item) => item.id),
      ["inv-unlinked"],
      "the fallback arm must resolve exactly the unlinked row whose normalized key matches"
    );

    const probes = captured.filter((statement) => PROBE_RE.test(statement.sql));
    assert.equal(
      probes.length,
      1,
      `the read must issue ONE unresolved-key probe per detail load for this plan to cover it, got: ${JSON.stringify(probes.map((statement) => statement.sql))}`
    );
    const [probe] = probes;

    const plan = await explain(h, probe);
    assert.match(
      plan,
      UNLINKED_SEEK_RE,
      `the probe must seek ${UNLINKED_INDEX_NAME} on the kind, got: ${plan}`
    );
    assert.doesNotMatch(
      plan,
      INVOCATIONS_SCAN_RE,
      `the probe must not walk agent_component_invocations — that is the per-load cost this index removes, got: ${plan}`
    );
    assert.doesNotMatch(
      plan,
      new RegExp(RESIDUAL_INDEX_NAME),
      `the probe must not fall back to ${RESIDUAL_INDEX_NAME}, whose entries carry no local_component_id and so cost a table lookup each, got: ${plan}`
    );

    // The point of the whole change, and the one property the plan string
    // cannot show: seeking the right index is not enough if the rows it hands
    // back still have to be re-checked against the table.
    assert.deepEqual(
      await tableReadOpcodes(h, probe),
      [],
      `the probe must answer from ${UNLINKED_INDEX_NAME} alone — any read off the ${INVOCATIONS_TABLE} cursor is the per-row lookup this index removes, and means rows the partial predicate should have excluded are back in it`
    );
  } finally {
    await h.close();
  }
});
