/**
 * @file local-invocation-read-paging.test.ts
 * @description ISS-10640: `readAgentComponentInvocationPage` served the first
 * 500 rows and nothing else. `hasMore` said more existed and no token could
 * ask for them, so the rows past the cap were unreachable from this surface.
 *
 * The desktop twin of `apps/api/app/agent-components/__tests__/
 * invocation-read-paging.test.ts` (ISS-9880), against a REAL SQLite store
 * rather than a mocked client: the continuation is a SQL predicate over a TEXT
 * column whose null semantics are the thing most likely to be wrong, and a
 * fake that answers from an array cannot fail the way the store can.
 */

import assert from "node:assert/strict";
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
} from "@repo/api/src/types/agent-component-invocation";
import { test } from "vitest";
import { readAgentComponentInvocationPage } from "../src/main/dashboard/local-invocation-read.js";
import {
  type InvocationSeed,
  insertComponent,
  insertInvocations,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

const CAP = AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS;
const COMPONENT_KEY = "paging-probe";
const COMPONENT_ID = "component-paging-probe";
const OTHER_COMPONENT_ID = "component-reattributed";
const SESSION_ID = "session-paging-probe";
const BASE_MINUTE_MS = Date.parse("2026-07-22T07:00:00.000Z");
const INVALID_CURSOR_MESSAGE = /Invalid local invocation read cursor/;

/**
 * `timestamped` rows share a timestamp in blocks of ten so BOTH halves of the
 * cursor predicate decide a boundary somewhere in the walk: the `invoked_at <`
 * arm between blocks, and the `session_id`/`sequence`/`external_invocation_id`
 * tiebreak tail inside one. `untimestamped` rows carry a NULL `invoked_at`, the
 * tail the read's `invoked_at IS NULL ASC` term sorts last.
 */
function seedRows(
  timestamped: number,
  untimestamped: number
): InvocationSeed[] {
  const rows: InvocationSeed[] = [];
  for (let index = 0; index < timestamped; index++) {
    rows.push({
      ...invocationSeedBase(`ts-${String(index).padStart(4, "0")}`),
      invokedAt: new Date(
        BASE_MINUTE_MS - Math.floor(index / 10) * 60_000
      ).toISOString(),
      sequence: index,
    });
  }
  for (let index = 0; index < untimestamped; index++) {
    rows.push({
      ...invocationSeedBase(`null-${String(index).padStart(4, "0")}`),
      invokedAt: null,
      sequence: 100_000 + index,
    });
  }
  return rows;
}

function invocationSeedBase(id: string): InvocationSeed {
  return {
    id,
    sessionId: SESSION_ID,
    componentKind: AgentComponentInvocationKind.Skill,
    componentKey: COMPONENT_KEY,
    anchorKind: AgentComponentInvocationAnchorKind.Session,
    anchorValue: SESSION_ID,
    localComponentId: COMPONENT_ID,
    sequence: 0,
  };
}

/** Seeded order IS read order, so the expected page contents are a slice. */
function seededIds(rows: InvocationSeed[]): string[] {
  return rows.map((row) => row.id);
}

function pageIds(page: AgentComponentInvocationReadPage | undefined): string[] {
  return (page?.items ?? []).map((item) => item.id);
}

/**
 * Both inventory rows exist because `agent_component_invocations.
 * local_component_id` is a real FK: the reattribution case below has to move a
 * row to a component the store actually holds.
 *
 * The NULL `invoked_at` cells are written AFTER the seed insert, because
 * `insertInvocations` coalesces an absent or null `invokedAt` to a default
 * timestamp — seeding alone produces no untimestamped row at all, and the tail
 * this suite exists to reach would not exist.
 */
async function seedPopulation(
  prisma: Parameters<typeof insertInvocations>[0],
  rows: InvocationSeed[]
): Promise<void> {
  for (const id of [COMPONENT_ID, OTHER_COMPONENT_ID]) {
    await insertComponent(prisma, {
      id,
      kind: AgentComponentInvocationKind.Skill,
      externalId: id,
      key: id === COMPONENT_ID ? COMPONENT_KEY : "other-component-key",
    });
  }
  await insertInvocations(prisma, rows);
  const untimestamped = rows.filter((row) => row.invokedAt === null);
  if (untimestamped.length > 0) {
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        `UPDATE agent_component_invocations SET invoked_at = NULL
          WHERE id IN (${untimestamped.map(() => "?").join(", ")})`,
        ...untimestamped.map((row) => row.id)
      )
    );
  }
}

test("ISS-10640: a continuation reaches the rows past the 500-row cap", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const rows = seedRows(CAP + 10, 5);
    await seedPopulation(prisma, rows);

    const first = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID]
    );
    assert.equal(first?.items.length, CAP);
    assert.equal(first?.hasMore, true);
    assert.equal(typeof first?.nextCursor, "string");
    assert.deepEqual(pageIds(first), seededIds(rows).slice(0, CAP));

    const second = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID],
      first?.nextCursor
    );
    // The whole remainder, IN ORDER — including the five untimestamped rows a
    // bare `invoked_at < ?` would have dropped, because SQLite evaluates that
    // comparison to UNKNOWN for a NULL cell.
    assert.deepEqual(pageIds(second), seededIds(rows).slice(CAP));
    assert.equal(
      pageIds(second).filter((id) => id.startsWith("null-")).length,
      5
    );

    // `hasMore` is this page's own result, not `total > rows.length`: that
    // comparison is against the whole population, so from any cursor it
    // reported a next page that was not there, forever.
    assert.equal(second?.hasMore, false);
    assert.equal(second?.nextCursor, undefined);
    // The counts still describe the POPULATION on both pages rather than the
    // page — they are the caption's denominator, never the walk's stop signal,
    // which is `nextCursor` above.
    assert.equal(first?.total, rows.length);
    assert.equal(second?.total, rows.length);
  } finally {
    await close();
  }
});

test("ISS-10640: a cursor inside the untimestamped tail continues within it", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    // The cap falls INSIDE the null tail, so the second read starts from a
    // cursor whose lead key is null — the arm where nothing timestamped can
    // follow and the tiebreak tail is the whole predicate.
    const rows = seedRows(CAP - 5, 10);
    await seedPopulation(prisma, rows);

    const first = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID]
    );
    assert.equal(first?.items.length, CAP);
    assert.equal(first?.items.at(-1)?.invokedAt, null);

    const second = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID],
      first?.nextCursor
    );
    assert.deepEqual(pageIds(second), seededIds(rows).slice(CAP));
    assert.equal(second?.hasMore, false);
    assert.equal(second?.nextCursor, undefined);
  } finally {
    await close();
  }
});

test("ISS-10640: the walk resumes past a REATTRIBUTED anchor row", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const rows = seedRows(CAP + 10, 5);
    await seedPopulation(prisma, rows);

    const first = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID]
    );
    const anchorId = pageIds(first).at(-1);
    assert.equal(anchorId, seededIds(rows)[CAP - 1]);

    // The row the cursor names leaves the FILTERED set without being deleted —
    // reattributed to another component. This is what a Prisma `cursor` row
    // reference cannot survive, and it is why the position is compared by
    // value.
    await prisma.write((client) =>
      client.$executeRawUnsafe(
        "UPDATE agent_component_invocations SET local_component_id = ? WHERE id = ?",
        OTHER_COMPONENT_ID,
        anchorId
      )
    );

    const second = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID],
      first?.nextCursor
    );
    // Neither stalled nor skipped its successor: the same remainder, and the
    // population count has dropped by the one row that left.
    assert.deepEqual(pageIds(second), seededIds(rows).slice(CAP));
    assert.equal(second?.total, rows.length - 1);
    assert.equal(second?.hasMore, false);
  } finally {
    await close();
  }
});

test("ISS-10640: a walk to exhaustion delivers every row exactly once", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const rows = seedRows(CAP + 10, 5);
    await seedPopulation(prisma, rows);

    const walked: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await readAgentComponentInvocationPage(
        prisma,
        AgentComponentInvocationKind.Skill,
        COMPONENT_KEY,
        [COMPONENT_ID],
        cursor
      );
      walked.push(...pageIds(page));
      cursor = page?.nextCursor;
      pages++;
      assert.ok(pages <= 4, "walk did not terminate");
    } while (cursor !== undefined);

    assert.deepEqual(walked, seededIds(rows));
    assert.equal(new Set(walked).size, rows.length);
  } finally {
    await close();
  }
});

test("ISS-10640: a population under the cap pages once and mints no cursor", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    const rows = seedRows(3, 1);
    await seedPopulation(prisma, rows);

    const page = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID]
    );
    assert.deepEqual(pageIds(page), seededIds(rows));
    assert.equal(page?.hasMore, false);
    assert.equal(page?.nextCursor, undefined);
  } finally {
    await close();
  }
});

test("ISS-10640: a malformed cursor throws instead of restarting at the head", async () => {
  const { prisma, close } = await openTestPrisma();
  try {
    await seedPopulation(prisma, seedRows(3, 0));

    // An EMPTY STRING is malformed, not absent: a truthiness test would send
    // `""` down the head branch, which is the silent restart that loops a
    // walking caller forever.
    for (const raw of [
      "",
      "not-base64url-json",
      Buffer.from("{}").toString("base64url"),
    ]) {
      await assert.rejects(
        () =>
          readAgentComponentInvocationPage(
            prisma,
            AgentComponentInvocationKind.Skill,
            COMPONENT_KEY,
            [COMPONENT_ID],
            raw
          ),
        INVALID_CURSOR_MESSAGE
      );
    }

    // Including on a source that records no evidence: the `undefined` return
    // for "no such identity" must not swallow a caller's bad token.
    await assert.rejects(
      () =>
        readAgentComponentInvocationPage(
          prisma,
          AgentComponentInvocationKind.Skill,
          "no-such-component-key",
          [],
          "not-base64url-json"
        ),
      INVALID_CURSOR_MESSAGE
    );

    // `null` and `undefined` alone mean "no cursor".
    const head = await readAgentComponentInvocationPage(
      prisma,
      AgentComponentInvocationKind.Skill,
      COMPONENT_KEY,
      [COMPONENT_ID],
      null
    );
    assert.equal(head?.items.length, 3);
  } finally {
    await close();
  }
});
