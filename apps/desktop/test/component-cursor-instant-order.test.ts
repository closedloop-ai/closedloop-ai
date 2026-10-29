/**
 * @file component-cursor-instant-order.test.ts
 * @description ISS-11327: the component-lane keyset cursor orders by INSTANT, on the
 * SQL side and the consumer side, and an already-persisted cursor keeps its position.
 *
 * The whole suite turns on one fixture premise, asserted as its first case so it can
 * never quietly stop being adversarial: for these spellings BYTE order and
 * CHRONOLOGICAL order DISAGREE. `2026-06-22T09:30:00-01:00` is 10:30Z — LATER than
 * `2026-06-22T10:00:00.000Z` — and sorts BELOW it on bytes, so a byte-wise cursor
 * sitting on the `Z` value can never re-select the row that advanced to the offset
 * form. In a sync cursor that is silent, permanent data loss, which is why the
 * assertion below is the suite rather than a detail of it.
 *
 * Every case drives the REAL query (`listAgentComponentCursorRows`) and the REAL
 * advance (`advanceComponentCursor`) rather than re-deriving either, and every
 * expected cursor position is a pinned literal — never recomputed with the code's own
 * fold, which would pass against any fold at all.
 */

import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { test } from "vitest";
import type { ComponentSyncCursorPosition } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import { advanceComponentCursor } from "../src/main/agent-sync/agent-component-sync-dead-letter.js";
import {
  componentCursorRank,
  isUnreadableComponentCursorValue,
} from "../src/main/database/component-cursor-rank.js";
import { listAgentComponentCursorRows } from "../src/main/database/component-sync-source.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import { openTestPrisma } from "./prisma-test-utils.js";

/** 09:00Z written as a +01:00 wall clock. Same instant as {@link Z_0900}. */
const OFFSET_0900 = "2026-06-22T10:00:00+01:00";
/** 09:00Z, canonical. Sorts BELOW {@link OFFSET_0900} on bytes. */
const Z_0900 = "2026-06-22T09:00:00.000Z";
/** 10:00Z, canonical — the position a byte-wise cursor gets stuck on. */
const Z_1000 = "2026-06-22T10:00:00.000Z";
/** 10:30Z written as a -01:00 wall clock. LATER than {@link Z_1000}, lower bytes. */
const OFFSET_1030 = "2026-06-22T09:30:00-01:00";

const PAGE = 50;

const INSERT_SQL = `INSERT INTO agent_components
     (id, component_kind, external_id, component_key, name, resolved_state, last_seen_at)
   VALUES ($1, $2, $1, $1, $1, 'resolved', $3)`;

async function seed(
  prisma: DesktopPrisma,
  rows: readonly { id: string; lastSeenAt: string | null }[]
): Promise<void> {
  for (const row of rows) {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        INSERT_SQL,
        row.id,
        AgentComponentKind.Skill,
        row.lastSeenAt
      )
    );
  }
}

async function restamp(
  prisma: DesktopPrisma,
  id: string,
  lastSeenAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      "UPDATE agent_components SET last_seen_at = $1 WHERE id = $2",
      lastSeenAt,
      id
    )
  );
}

/**
 * Drain the lane the way production drains it: page the real query from the keyset
 * position, then advance onto the LAST row of the batch through the real
 * `advanceComponentCursor`. Returns every id delivered, in order, and the final
 * position — so a caller can assert BOTH that nothing was skipped and that nothing
 * was re-walked.
 */
async function drain(
  prisma: DesktopPrisma,
  from: { ts: string; id: string }
): Promise<{ delivered: string[]; ts: string; id: string }> {
  let position: ComponentSyncCursorPosition = {
    watermark: from.ts,
    lastId: from.id,
  };
  const delivered: string[] = [];
  for (let guard = 0; guard < 20; guard += 1) {
    const rows = await listAgentComponentCursorRows(
      prisma,
      position.watermark ?? "",
      position.lastId ?? "",
      PAGE
    );
    const last = rows.at(-1);
    if (last === undefined) {
      return {
        delivered,
        ts: position.watermark ?? "",
        id: position.lastId ?? "",
      };
    }
    delivered.push(...rows.map((row) => row.id));
    position = advanceComponentCursor(
      position,
      last,
      "source-key-iss11327",
      undefined,
      []
    );
  }
  throw new Error("drain did not settle: the cursor is not advancing");
}

test("FIXTURE PREMISE: byte order and instant order disagree for these spellings", () => {
  // The skip pair. `OFFSET_1030` is the LATER instant and the LOWER text, which is
  // the entire defect: a byte-wise cursor resting on `Z_1000` never reaches it.
  assert.ok(
    OFFSET_1030 < Z_1000,
    "fixture must keep the later instant BELOW the earlier one in byte order"
  );
  assert.equal(
    Date.parse(OFFSET_1030) - Date.parse(Z_1000),
    30 * 60 * 1000,
    "fixture must keep OFFSET_1030 half an hour AFTER Z_1000"
  );
  // The tie pair. Same instant, and byte order calls one strictly greater.
  assert.equal(Date.parse(OFFSET_0900), Date.parse(Z_0900));
  assert.ok(
    OFFSET_0900 > Z_0900,
    "fixture must keep two equal instants UNEQUAL in byte order"
  );
});

test("the SQL rank and its JS mirror agree on every fixture spelling", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const spellings: (string | null)[] = [
      null,
      "",
      Z_0900,
      Z_1000,
      OFFSET_0900,
      OFFSET_1030,
      "2026-06-22",
      "2026-06-22T10:00",
      "2026-06-22T10:00:00",
      "2026-06-22T10:00:00.123456Z",
      "2026-06-22T24:30:00Z",
      "2026-06-22T10:60:00Z",
      "2026-06-22 10:00:00",
      "2026-06-22T10:00:00+0100",
      "banana",
      // Canonical in SHAPE, impossible in VALUE. The JS half's fast path matches the
      // shape with a bare digit class, so without a value check it returned these
      // VERBATIM while the SQL half floored them — a watermark no real rank can ever
      // exceed, which permanently skips every row below it. These four are the whole
      // field set `strftime` refuses at millisecond precision.
      "2026-06-22T10:60:00.000Z",
      "2026-06-22T10:00:60.000Z",
      "2026-13-22T10:00:00.000Z",
      "2026-06-00T10:00:00.000Z",
      // The one out-of-range calendar date both engines ROLL, and the SQL canonical
      // arm then passes through untouched. It must NOT be floored.
      "2026-06-31T10:00:00.000Z",
    ];
    await seed(
      prisma,
      spellings.map((lastSeenAt, index) => ({
        id: `pair-${String(index).padStart(2, "0")}`,
        lastSeenAt,
      }))
    );
    const rows = await listAgentComponentCursorRows(prisma, "", "", PAGE);
    assert.equal(
      rows.length,
      spellings.length,
      "every seeded row must be walked exactly once"
    );
    const bySql = new Map(rows.map((row) => [row.id, row.cursor_key]));
    for (const [index, spelling] of spellings.entries()) {
      const id = `pair-${String(index).padStart(2, "0")}`;
      assert.equal(
        bySql.get(id),
        componentCursorRank(spelling),
        `SQL and JS must rank ${JSON.stringify(spelling)} identically`
      );
    }
    // Non-circular spot checks on the fold itself, so "they agree" cannot mean
    // "they are both wrong in the same way".
    assert.equal(bySql.get("pair-04"), "2026-06-22T09:00:00.000Z");
    assert.equal(bySql.get("pair-05"), "2026-06-22T10:30:00.000Z");
    assert.equal(bySql.get("pair-06"), "2026-06-22T00:00:00.000Z");
    assert.equal(bySql.get("pair-09"), "2026-06-22T10:00:00.123Z");
    assert.equal(bySql.get("pair-10"), "", "hour 24 is not an instant");
    assert.equal(
      bySql.get("pair-13"),
      "",
      "a basic-format offset is unreadable"
    );
    assert.equal(bySql.get("pair-14"), "");
    for (const index of [15, 16, 17, 18]) {
      const id = `pair-${index}`;
      assert.equal(
        bySql.get(id),
        "",
        `a canonical-SHAPED value with an impossible field must rank to the floor, not verbatim (${id})`
      );
    }
    assert.equal(
      bySql.get("pair-19"),
      "2026-06-31T10:00:00.000Z",
      "a rollover calendar day is a real instant and passes through untouched"
    );
  } finally {
    await close();
  }
});

test("a row re-stamped to a LATER instant in a lower-sorting spelling is re-selected", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seed(prisma, [{ id: "comp-a", lastSeenAt: Z_1000 }]);

    const first = await drain(prisma, { ts: "", id: "" });
    assert.deepEqual(first.delivered, ["comp-a"]);
    assert.equal(
      first.ts,
      "2026-06-22T10:00:00.000Z",
      "the cursor must advance onto the row's ranking key"
    );

    // Precondition: the cursor is genuinely drained, so the re-selection below can
    // only come from the re-stamp and not from a cursor that never caught up.
    assert.deepEqual(
      (
        await listAgentComponentCursorRows(prisma, first.ts, first.id, PAGE)
      ).map((row) => row.id),
      [],
      "fixture must leave the cursor drained before the re-stamp"
    );

    await restamp(prisma, "comp-a", OFFSET_1030);

    const second = await drain(prisma, { ts: first.ts, id: first.id });
    assert.deepEqual(
      second.delivered,
      ["comp-a"],
      "the later instant must re-enter the lane even though its text sorts lower"
    );
    assert.equal(second.ts, "2026-06-22T10:30:00.000Z");
  } finally {
    await close();
  }
});

test("two rows at one instant in different spellings are each delivered exactly once", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seed(prisma, [
      { id: "comp-offset", lastSeenAt: OFFSET_0900 },
      { id: "comp-zulu", lastSeenAt: Z_0900 },
    ]);

    const walk = await drain(prisma, { ts: "", id: "" });
    assert.deepEqual(
      walk.delivered,
      ["comp-offset", "comp-zulu"],
      "an instant tie must be broken by id, not by the spelling's bytes"
    );
    assert.equal(walk.ts, "2026-06-22T09:00:00.000Z");
    assert.equal(walk.id, "comp-zulu");

    // Nothing is re-walked: a second drain from the same position delivers nothing.
    const again = await drain(prisma, { ts: walk.ts, id: walk.id });
    assert.deepEqual(again.delivered, []);
  } finally {
    await close();
  }
});

test("translating a byte-order cursor into the new order would SKIP an unsent row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seed(prisma, [
      // Where a byte-ordered build stopped.
      { id: "comp-stopped", lastSeenAt: Z_1000 },
      // 06:00Z. Byte-AFTER the stopped position, so the old byte-wise walk had NOT
      // sent it; instant-BEFORE it, so the new walk starts past it.
      { id: "comp-unsent", lastSeenAt: "2026-06-22T11:00:00+05:00" },
      { id: "comp-later", lastSeenAt: "2026-06-22T12:00:00.000Z" },
    ]);

    // The translation this PR originally shipped, and why ISS-11327 retired the
    // cursor by key instead (tamsinb, chatgpt-codex review): ranking the stored
    // value lands on the same ROW, and loses the rows the order moved behind it.
    const translated = componentCursorRank(Z_1000);
    const resumed = await listAgentComponentCursorRows(
      prisma,
      translated,
      "comp-stopped",
      PAGE
    );
    assert.deepEqual(
      resumed.map((row) => row.id),
      ["comp-later"],
      "comp-unsent is unreachable from a translated cursor — unsent by the old walk, behind the new one"
    );

    // The shipped behavior: the ordering change bumped the payload revision, so the
    // upgraded lane finds no position under its new key and re-walks from ('', '').
    const rewalk = await listAgentComponentCursorRows(prisma, "", "", PAGE);
    assert.deepEqual(
      rewalk.map((row) => row.id),
      ["comp-unsent", "comp-stopped", "comp-later"],
      "a full re-walk reaches every row in instant order, comp-unsent included"
    );
  } finally {
    await close();
  }
});

test("a stored value with no readable instant ranks to the floor and is still walked", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seed(prisma, [
      { id: "comp-corrupt", lastSeenAt: "banana" },
      { id: "comp-good", lastSeenAt: Z_1000 },
    ]);

    assert.ok(isUnreadableComponentCursorValue("banana"));
    assert.equal(
      isUnreadableComponentCursorValue(null),
      false,
      "an absent value is not a corrupt one"
    );

    const walk = await drain(prisma, { ts: "", id: "" });
    assert.deepEqual(
      walk.delivered,
      ["comp-corrupt", "comp-good"],
      "the unreadable row must sort FIRST so it cannot strand the readable one"
    );
    assert.equal(walk.ts, "2026-06-22T10:00:00.000Z");
  } finally {
    await close();
  }
});
