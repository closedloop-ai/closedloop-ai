/**
 * ISS-6889 (codex P1 review): the two things canonicalization owes that a pure
 * producer test cannot show.
 *
 * 1. THE INSTALLED BASE. Canonicalizing the producer repairs nothing that a
 *    previous build already wrote. A padded part sitting in
 *    `agent_component_invocation_sync_outbox` keeps a `part_hash` signed over
 *    untrimmed bytes, the cloud re-hashes the TRIMMED object, and the row earns
 *    the permanent `validation_failed` that dead-letters it with no recovery
 *    path. That population is the whole reason the ticket exists, so the tests
 *    below seed a row exactly as the OLD build would have persisted it and prove
 *    the repair makes it verifiable — and that a correct row is left alone.
 *
 * 2. THE COLLISION. Trimming is what CREATES the case where two stored
 *    invocation ids differing only by surrounding whitespace become one. The
 *    resulting throw used to escape into the import `$transaction`, so the proof
 *    that matters is that a real import COMMITS and records the collision once.
 *
 * Real SQLite for both, for the reason the sibling
 * `component-invocations-local-projection.test.ts` gives: the decision is
 * unit-testable, the ROW is not.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import type { AgentComponentInvocationSyncPart } from "@repo/api/src/types/agent-component-invocation";
import {
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { agentComponentInvocationSyncPartSchema } from "@repo/api/src/types/agent-component-invocation-schema";
import { SYNTHETIC_GITHUB_TOKEN } from "@repo/lib/security/synthetic-secrets.test-helpers";
import { describe, test } from "vitest";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AgentComponentInvocationSyncLocalError,
} from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import {
  INVOCATION_SYNC_CANONICALIZATION_REVISION,
  INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
  repairInvocationSyncCanonicalization,
} from "../src/main/database/invocation-sync-canonicalization-repair.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { OutboxStatus } from "../src/shared/sync-lane-contract.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const ENDED_AT = "2026-07-22T17:05:00.000Z";
const DUPLICATE_INVOCATION_ID = /duplicate invocation id/;
const COULD_NOT_BE_REHASHED = /could not be rehashed/;

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

function openDb(dir: string): Promise<Db> {
  return openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => NOW,
  });
}

type OutboxRow = {
  external_generation_id: string;
  part_index: number;
  part_hash: string;
  /** A `Json` column: libsql hands it back already parsed, not as text. */
  payload: unknown;
  status: string;
  last_error: string | null;
  created_at: string;
};

function partOf(payload: unknown): AgentComponentInvocationSyncPart {
  return (
    typeof payload === "string" ? JSON.parse(payload) : payload
  ) as AgentComponentInvocationSyncPart;
}

function readTemplateRows(db: Db, sessionId: string): Promise<OutboxRow[]> {
  return db.prisma.client.$queryRawUnsafe<OutboxRow[]>(
    `SELECT external_generation_id, part_index, part_hash, payload, status,
            last_error, created_at
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2
      ORDER BY part_index ASC`,
    AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
    sessionId
  );
}

/**
 * The CLOUD's verdict on a stored payload, reproduced exactly: parse it through
 * the shared wire schema (which trims), then re-hash the parsed object and
 * compare — `apps/api/app/agent-sessions/service/component-invocation-helpers.ts`
 * `hasValidPartHash`. Reproduced here rather than imported because the point of
 * the assertion is that the two sides agree, and importing the desktop's own
 * helper would prove only that it agrees with itself.
 */
function cloudAcceptsPartHash(payload: unknown): boolean {
  const parsed = agentComponentInvocationSyncPartSchema.safeParse(
    partOf(payload)
  );
  if (!parsed.success) {
    return false;
  }
  const { partHash, ...withoutHash } = parsed.data;
  return (
    createHash("sha256")
      .update(agentComponentInvocationSyncPartHashPreimage(withoutHash))
      .digest("hex") === partHash
  );
}

/**
 * Rewrite one template row into the shape the PRE-canonicalization build
 * produced: padded item bytes, and a `part_hash` signed over them.
 *
 * This is the seed, not a helper under test — it reproduces the defect rather
 * than asserting anything, which is what makes the PRE/POST comparison a real
 * counterfactual instead of a restatement of the fix.
 *
 * `padItems` defaults to the whitespace-padded `sourceSessionId` the original
 * ISS-6889 fixture used. ISS-6910 overrides it to seed the generation whose ids
 * collide only AFTER trimming, which is the case canonicalization itself
 * creates and which no rehash can resolve.
 */
async function persistPaddedLegacyPart(
  db: Db,
  sessionId: string,
  padItems: (
    items: AgentComponentInvocationSyncPart["items"]
  ) => AgentComponentInvocationSyncPart["items"] = padSourceSessionId
): Promise<{ legacyGenerationId: string; legacyPartHash: string }> {
  const [row] = await readTemplateRows(db, sessionId);
  if (!row) {
    throw new Error("fixture must have produced a template part");
  }
  const part = partOf(row.payload);
  const items = padItems(part.items);
  // The old build hashed the PADDED bytes for both identities, so a faithful
  // seed has to move the generation id too — otherwise the row would already
  // carry the canonical id and the repair's hardest path (a primary-key change,
  // and the cursor that has to follow it) would never be exercised.
  const legacyGenerationId = createHash("sha256")
    .update(
      agentComponentInvocationGenerationHashPreimage({
        externalSessionId: part.externalSessionId,
        items,
      })
    )
    .digest("hex");
  const padded: AgentComponentInvocationSyncPart = {
    ...part,
    externalGenerationId: legacyGenerationId,
    items,
  };
  const { partHash: _partHash, ...withoutHash } = padded;
  const legacyPartHash = createHash("sha256")
    .update(agentComponentInvocationSyncPartHashPreimage(withoutHash))
    .digest("hex");
  const legacyPayload = JSON.stringify({ ...padded, partHash: legacyPartHash });
  await db.prisma.write(async (client) => {
    await client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_outbox
          SET payload = $1, part_hash = $2, external_generation_id = $3
        WHERE source_key = $4 AND external_session_id = $5
          AND part_index = $6`,
      legacyPayload,
      legacyPartHash,
      legacyGenerationId,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId,
      row.part_index
    );
    await client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_cursors
          SET external_generation_id = $1
        WHERE source_key = $2 AND external_session_id = $3`,
      legacyGenerationId,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId
    );
  });
  return { legacyGenerationId, legacyPartHash };
}

/** The ISS-6889 seed: whitespace the wire boundary trims off `sourceSessionId`. */
function padSourceSessionId(
  items: AgentComponentInvocationSyncPart["items"]
): AgentComponentInvocationSyncPart["items"] {
  const [first, ...rest] = items;
  if (!first) {
    throw new Error("fixture part must carry an item");
  }
  return [
    { ...first, sourceSessionId: `  ${first.sourceSessionId}  ` },
    ...rest,
  ];
}

/**
 * The ISS-6910 seed: two invocation ids that are DISTINCT as stored and become
 * ONE once the wire boundary trims them. A pre-canonicalization build wrote this
 * happily; no rehash can turn it into a deliverable generation.
 */
function collideAfterTrim(
  items: AgentComponentInvocationSyncPart["items"]
): AgentComponentInvocationSyncPart["items"] {
  const [first, second, ...rest] = items;
  if (!(first && second)) {
    throw new Error("fixture must carry two items");
  }
  return [
    { ...first, externalInvocationId: "toolu_collide" },
    { ...second, externalInvocationId: "  toolu_collide  " },
    ...rest,
  ];
}

const DELIVERY_TARGET_ID = "compute-target-canon";
const DELIVERY_SOURCE_KEY = `${AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY}:${DELIVERY_TARGET_ID}`;

/**
 * Reproduce what promotion leaves behind: a target-scoped clone of the template
 * rows, dead-lettered the way the padded generation actually ends up.
 */
async function cloneToDeliveryTarget(db: Db, sessionId: string): Promise<void> {
  await db.prisma.write(async (client) => {
    await client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_outbox
         (source_key, external_session_id, external_generation_id, part_index,
          part_count, part_hash, source_updated_at, data_revision,
          source_sequence, payload, status, attempt_count, next_attempt_at,
          last_error, created_at, updated_at)
       SELECT $1, external_session_id, external_generation_id, part_index,
              part_count, part_hash, source_updated_at, data_revision,
              source_sequence, payload, $2, 5, NULL, $3, created_at, updated_at
         FROM agent_component_invocation_sync_outbox
        WHERE source_key = $4 AND external_session_id = $5`,
      DELIVERY_SOURCE_KEY,
      OutboxStatus.DeadLettered,
      "validation_failed",
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId
    );
    await client.$executeRawUnsafe(
      `INSERT INTO agent_component_invocation_sync_cursors
         (source_key, external_session_id, external_generation_id,
          source_sequence, updated_at)
       SELECT $1, external_session_id, external_generation_id, source_sequence,
              updated_at
         FROM agent_component_invocation_sync_cursors
        WHERE source_key = $2 AND external_session_id = $3`,
      DELIVERY_SOURCE_KEY,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId
    );
  });
}

function readDeliveryRows(db: Db, sessionId: string): Promise<OutboxRow[]> {
  return db.prisma.client.$queryRawUnsafe<OutboxRow[]>(
    `SELECT external_generation_id, part_index, part_hash, payload, status,
            last_error, created_at
       FROM agent_component_invocation_sync_outbox
      WHERE source_key = $1 AND external_session_id = $2`,
    DELIVERY_SOURCE_KEY,
    sessionId
  );
}

async function readCursorSequences(
  db: Db,
  sessionId: string
): Promise<{ template: number; target: number }> {
  const rows = await db.prisma.client.$queryRawUnsafe<
    { source_key: string; source_sequence: number }[]
  >(
    `SELECT source_key, source_sequence
       FROM agent_component_invocation_sync_cursors
      WHERE external_session_id = $1`,
    sessionId
  );
  const sequenceFor = (key: string): number =>
    Number(
      rows.find((row) => row.source_key === key)?.source_sequence ?? Number.NaN
    );
  return {
    template: sequenceFor(AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY),
    target: sequenceFor(DELIVERY_SOURCE_KEY),
  };
}

function importOneToolSession(db: Db, sessionId: string) {
  return db.importer.importSession(
    makeSession({
      sessionId,
      startedAt: NOW,
      endedAt: ENDED_AT,
      toolUses: [{ id: "toolu_repair_0", name: "Read", timestamp: NOW }],
    }),
    "claude"
  );
}

function importTwoToolSession(db: Db, sessionId: string) {
  return db.importer.importSession(
    makeSession({
      sessionId,
      startedAt: NOW,
      endedAt: ENDED_AT,
      toolUses: [
        { id: "toolu_repair_0", name: "Read", timestamp: NOW },
        {
          id: "toolu_repair_1",
          name: "Read",
          timestamp: "2026-07-22T17:00:01.000Z",
        },
      ],
    }),
    "claude"
  );
}

/** Park this session's TEMPLATE rows, as a build that quarantined them left them. */
function deadLetterTemplateRows(db: Db, sessionId: string): Promise<unknown> {
  return db.prisma.write((client) =>
    client.$executeRawUnsafe(
      `UPDATE agent_component_invocation_sync_outbox
          SET status = $1, last_error = $2
        WHERE source_key = $3 AND external_session_id = $4`,
      OutboxStatus.DeadLettered,
      AgentComponentInvocationSyncLocalError.InvalidPersistedPayload,
      AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
      sessionId
    )
  );
}

describe("ISS-6889 canonicalization repair of already-persisted parts", () => {
  test("a padded part persisted by the old build is unverifiable, then repaired", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-repair-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-repair";
      await importOneToolSession(db, sessionId);
      const { legacyGenerationId, legacyPartHash } =
        await persistPaddedLegacyPart(db, sessionId);

      // PRE-fix state: this is exactly what the upgrading user has on disk, and
      // the cloud can never accept it. Without a repair pass it retries four
      // more times and dead-letters with no way back.
      const [before] = await readTemplateRows(db, sessionId);
      assert.ok(before);
      assert.equal(cloudAcceptsPartHash(before.payload), false);

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, { inspected: 1, repaired: 1, unrepairable: 0 });
      const [after] = await readTemplateRows(db, sessionId);
      assert.ok(after);
      // The whole point: the same row now survives the cloud's own check.
      assert.equal(cloudAcceptsPartHash(after.payload), true);
      assert.notEqual(after.part_hash, legacyPartHash);
      assert.notEqual(after.external_generation_id, legacyGenerationId);
      assert.equal(after.status, OutboxStatus.Pending);
      // The FIFO position is preserved, so a repaired backlog is not sent to
      // the back of the drain queue behind rows enqueued after it.
      assert.equal(after.created_at, before.created_at);
      // The row's payload and its indexed hash column cannot disagree, or the
      // ack path's `part_hash` predicate would never match the row it drained.
      assert.equal(partOf(after.payload).partHash, after.part_hash);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the superseded delivery row is retired and the template can re-promote", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-delivery-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-delivery";
      await importOneToolSession(db, sessionId);
      const { legacyGenerationId } = await persistPaddedLegacyPart(
        db,
        sessionId
      );
      // The state a real install is in: a target already cloned the padded
      // template and its copy is dead-lettered with the `validation_failed` this
      // lane has no recovery from.
      await cloneToDeliveryTarget(db, sessionId);

      const beforeSequences = await readCursorSequences(db, sessionId);
      const result = await repairInvocationSyncCanonicalization(db.prisma);
      const afterSequences = await readCursorSequences(db, sessionId);

      assert.deepEqual(result, { inspected: 1, repaired: 1, unrepairable: 0 });
      // Provably undeliverable — it names a generation id no template carries
      // any more — so it is retired rather than left to occupy the queue.
      assert.deepEqual(await readDeliveryRows(db, sessionId), []);
      // And the template must now out-rank the target, or
      // `loadPendingInvocationTemplates` would never owe this session again and
      // the rows just deleted could never be re-cloned.
      assert.ok(afterSequences.template > beforeSequences.template);
      assert.ok(afterSequences.template > afterSequences.target);
      // The cursor and the payload agree on which sequence was written.
      const [repaired] = await readTemplateRows(db, sessionId);
      assert.ok(repaired);
      assert.notEqual(repaired.external_generation_id, legacyGenerationId);
      assert.equal(
        partOf(repaired.payload).sourceSequence,
        afterSequences.template
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an already-canonical part is inspected and left byte-identical", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-noop-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-noop";
      await importOneToolSession(db, sessionId);
      const before = await readTemplateRows(db, sessionId);
      assert.ok(before.length > 0);
      assert.equal(cloudAcceptsPartHash(before[0]?.payload), true);

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      // Inspected, but not rewritten: no needless rehash churn on a correct row.
      assert.deepEqual(result, { inspected: 1, repaired: 0, unrepairable: 0 });
      assert.deepEqual(await readTemplateRows(db, sessionId), before);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the repair runs once per store and is a no-op afterwards", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-once-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-once";
      await importOneToolSession(db, sessionId);
      await persistPaddedLegacyPart(db, sessionId);

      const first = await repairInvocationSyncCanonicalization(db.prisma);
      const repaired = await readTemplateRows(db, sessionId);
      const second = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(first, { inspected: 1, repaired: 1, unrepairable: 0 });
      // Null, not a zero tally: the second call short-circuits on the sentinel
      // rather than re-walking every template on every sync tick.
      assert.equal(second, null);
      assert.deepEqual(await readTemplateRows(db, sessionId), repaired);
      const sentinel = await db.prisma.client.$queryRawUnsafe<
        { source_sequence: number }[]
      >(
        `SELECT source_sequence FROM agent_component_invocation_sync_cursors
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        INVOCATION_SYNC_CANONICALIZATION_SESSION_ID
      );
      assert.equal(
        Number(sentinel[0]?.source_sequence),
        INVOCATION_SYNC_CANONICALIZATION_REVISION
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ISS-6910: the populations revision 1 abandoned SILENTLY.
 *
 * Every fixture here is the stranded shape the ticket names — padded, already
 * dead-lettered at the delivery target, and with NO further session activity, so
 * `enqueueInvocationGeneration` (which only runs on new activity) can never heal
 * it. A test whose session saw later activity would pass against a do-nothing
 * implementation; these cannot.
 */
describe("ISS-6910 the repair reaches, or reports, the stranded population", () => {
  test("a padded template that was ITSELF parked is repaired and re-pended", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-parked-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-parked";
      await importOneToolSession(db, sessionId);
      const { legacyGenerationId } = await persistPaddedLegacyPart(
        db,
        sessionId
      );
      await cloneToDeliveryTarget(db, sessionId);
      // The template row itself is parked. Revision 1 filtered `status =
      // pending`, so this session was invisible to the scan — `inspected: 0` —
      // and its dead-lettered delivery clone stayed on disk forever.
      await deadLetterTemplateRows(db, sessionId);

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, { inspected: 1, repaired: 1, unrepairable: 0 });
      const [repaired] = await readTemplateRows(db, sessionId);
      assert.ok(repaired);
      // Re-pended, so the promotion pass can clone it again: a template left
      // `dead_lettered` is skipped by `loadPendingInvocationTemplates`.
      assert.equal(repaired.status, OutboxStatus.Pending);
      assert.equal(repaired.last_error, null);
      assert.notEqual(repaired.external_generation_id, legacyGenerationId);
      // And the cloud can now verify the bytes it will actually receive.
      assert.equal(cloudAcceptsPartHash(repaired.payload), true);
      // The superseded clone is retired rather than left occupying the queue.
      assert.deepEqual(await readDeliveryRows(db, sessionId), []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a generation that cannot be rehashed is counted, not reported healthy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-collide-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-collide";
      await importTwoToolSession(db, sessionId);
      // Two ids distinct as stored, identical once trimmed. Trimming is what
      // CREATES this, so canonicalization manufactures this population itself.
      const { legacyGenerationId } = await persistPaddedLegacyPart(
        db,
        sessionId,
        collideAfterTrim
      );
      await cloneToDeliveryTarget(db, sessionId);

      const logged: string[] = [];
      const result = await repairInvocationSyncCanonicalization(
        db.prisma,
        (message) => logged.push(message)
      );

      // The load-bearing distinction. Revision 1 reported `{ inspected: 1,
      // repaired: 0 }` here — byte-identical to what the healthy
      // already-canonical session two tests up reports — so a session nothing
      // could fix was indistinguishable from one that needed nothing.
      assert.deepEqual(result, { inspected: 1, repaired: 0, unrepairable: 1 });
      assert.equal(logged.length, 1);
      assert.match(logged[0] ?? "", COULD_NOT_BE_REHASHED);
      // Not guessed at: the stored generation is left exactly as it was rather
      // than re-keyed onto some smaller item set that would drop an invocation.
      const [untouched] = await readTemplateRows(db, sessionId);
      assert.ok(untouched);
      assert.equal(untouched.external_generation_id, legacyGenerationId);
      // And the dead-lettered clone is LEFT parked, not vacuumed. Deleting it
      // would destroy the only durable evidence of a generation this pass
      // cannot fix, on a store where the tally is a log line and nothing more.
      const stranded = await readDeliveryRows(db, sessionId);
      assert.equal(stranded.length, 1);
      assert.equal(stranded[0]?.status, OutboxStatus.DeadLettered);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a healthy store reports no unrepairable generations and logs nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-quiet-"));
    const db = await openDb(dir);
    try {
      await importOneToolSession(db, "session-canon-quiet");

      const logged: string[] = [];
      const result = await repairInvocationSyncCanonicalization(
        db.prisma,
        (message) => logged.push(message)
      );

      // The counterpart the tally needs to be worth anything: the pass must not
      // report an unrepairable generation on a store that has none, or the
      // signal it exists to raise is noise from the first run.
      assert.deepEqual(result, { inspected: 1, repaired: 0, unrepairable: 0 });
      assert.deepEqual(logged, []);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the second run changes nothing it did not already change", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-idem-"));
    const db = await openDb(dir);
    try {
      const repairable = "session-canon-idem-a";
      const collided = "session-canon-idem-b";
      await importOneToolSession(db, repairable);
      await persistPaddedLegacyPart(db, repairable);
      await cloneToDeliveryTarget(db, repairable);
      await deadLetterTemplateRows(db, repairable);
      await importTwoToolSession(db, collided);
      await persistPaddedLegacyPart(db, collided, collideAfterTrim);

      const first = await repairInvocationSyncCanonicalization(db.prisma);
      const afterFirst = await readTemplateRows(db, repairable);
      const collidedAfterFirst = await readTemplateRows(db, collided);
      const second = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(first, { inspected: 2, repaired: 1, unrepairable: 1 });
      // Idempotence asserted as an EFFECT, not as "it did not throw": the rows
      // are byte-identical after the second run, and the unrepairable session
      // was not re-keyed on a second look either.
      assert.equal(second, null);
      assert.deepEqual(await readTemplateRows(db, repairable), afterFirst);
      assert.deepEqual(
        await readTemplateRows(db, collided),
        collidedAfterFirst
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a store already repaired at revision 1 is swept again", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-rev1-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-rev1";
      await importOneToolSession(db, sessionId);
      await persistPaddedLegacyPart(db, sessionId);
      await cloneToDeliveryTarget(db, sessionId);
      await deadLetterTemplateRows(db, sessionId);
      // Exactly what #5206 left on disk: the sentinel stamped at revision 1,
      // with this session never reached because its template was parked. This
      // install is the stranded population — without the revision bump the
      // sentinel short-circuits and it stays broken forever.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_cursors
             (source_key, external_session_id, external_generation_id,
              source_sequence, updated_at)
           VALUES ($1, $2, $2, 1, $3)`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
          NOW
        )
      );

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, { inspected: 1, repaired: 1, unrepairable: 0 });
      assert.deepEqual(await readDeliveryRows(db, sessionId), []);
      const [repaired] = await readTemplateRows(db, sessionId);
      assert.ok(repaired);
      assert.equal(cloudAcceptsPartHash(repaired.payload), true);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a template this build cannot read is counted, not mistaken for settled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-unreadable-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-unreadable";
      await importOneToolSession(db, sessionId);
      await cloneToDeliveryTarget(db, sessionId);
      // A part written by a NEWER build under a protocol version this one does
      // not accept. `parseInvocationSyncPart` returns null for it, and every
      // part of a generation shares that version — so a single-part generation
      // yields ZERO parsed rows, the same shape as the deliberate error record.
      // The two must not be conflated: this one is unreadable, not settled, and
      // nothing else in the lane owns it (the ready-parts quarantine never sees
      // a template row, because the drain reads only delivery keys).
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET payload = $1
            WHERE source_key = $2 AND external_session_id = $3`,
          JSON.stringify({ protocolVersion: 9999, items: [] }),
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          sessionId
        )
      );

      const logged: string[] = [];
      const result = await repairInvocationSyncCanonicalization(
        db.prisma,
        (message) => logged.push(message)
      );

      assert.deepEqual(result, { inspected: 0, repaired: 0, unrepairable: 1 });
      assert.equal(logged.length, 1);
      assert.match(logged[0] ?? "", COULD_NOT_BE_REHASHED);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a mixed parseable and unreadable part set is unusable as a whole", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-mixed-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-mixed";
      await importOneToolSession(db, sessionId);
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_outbox
             (source_key, external_session_id, external_generation_id,
              part_index, part_count, part_hash, source_updated_at,
              data_revision, source_sequence, payload, status, attempt_count,
              next_attempt_at, last_error, created_at, updated_at)
           SELECT source_key, external_session_id, external_generation_id,
                  part_index + 1, part_count, part_hash, source_updated_at,
                  data_revision, source_sequence, $3, status, attempt_count,
                  next_attempt_at, last_error, created_at, updated_at
             FROM agent_component_invocation_sync_outbox
            WHERE source_key = $1 AND external_session_id = $2`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          sessionId,
          JSON.stringify({ protocolVersion: 9999, items: [] })
        )
      );
      const before = await readTemplateRows(db, sessionId);

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, {
        inspected: 0,
        repaired: 0,
        unrepairable: 1,
      });
      assert.deepEqual(
        await readTemplateRows(db, sessionId),
        before,
        "the repair must not rebuild from only the parseable survivor"
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an incomplete part run is unusable rather than rehashed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-incomplete-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-incomplete";
      await importOneToolSession(db, sessionId);
      const [row] = await readTemplateRows(db, sessionId);
      assert.ok(row);
      const incomplete = { ...partOf(row.payload), partCount: 2 };
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `UPDATE agent_component_invocation_sync_outbox
              SET part_count = 2, payload = $3
            WHERE source_key = $1 AND external_session_id = $2`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          sessionId,
          JSON.stringify(incomplete)
        )
      );
      const before = await readTemplateRows(db, sessionId);

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, {
        inspected: 0,
        repaired: 0,
        unrepairable: 1,
      });
      assert.deepEqual(await readTemplateRows(db, sessionId), before);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a malformed repair sentinel re-arms the current pass", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-sentinel-"));
    const db = await openDb(dir);
    try {
      await importOneToolSession(db, "session-canon-sentinel");
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_cursors
             (source_key, external_session_id, external_generation_id,
              source_sequence, updated_at)
           VALUES ($1, $2, $2, $3, $4)`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
          -1,
          NOW
        )
      );

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, {
        inspected: 1,
        repaired: 0,
        unrepairable: 0,
      });
      const sentinel = await db.prisma.client.$queryRawUnsafe<
        { source_sequence: unknown }[]
      >(
        `SELECT source_sequence FROM agent_component_invocation_sync_cursors
          WHERE source_key = $1 AND external_session_id = $2`,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        INVOCATION_SYNC_CANONICALIZATION_SESSION_ID
      );
      assert.equal(
        Number(sentinel[0]?.source_sequence),
        INVOCATION_SYNC_CANONICALIZATION_REVISION
      );
      assert.equal(await repairInvocationSyncCanonicalization(db.prisma), null);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the promotion step actually runs the repair and carries its log", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-wiring-"));
    const logged: string[] = [];
    const db = await openSqliteAgentDatabase({
      dataDir: path.join(dir, "agent-dashboard.sqlite"),
      detectBillingMode: () => "metered_api",
      now: () => NOW,
      log: (message: string) => logged.push(message),
    });
    try {
      const sessionId = "session-canon-wiring";
      await importTwoToolSession(db, sessionId);
      await persistPaddedLegacyPart(db, sessionId, collideAfterTrim);

      // Through the PRODUCTION entrypoint, not the repair function directly:
      // deleting the repair call in `prepareInvocationSyncTarget`, or dropping
      // the `log` argument threaded from `sync-source.ts`, must fail a test.
      await db.syncSource.prepareInvocationSyncTarget?.(
        DELIVERY_SOURCE_KEY,
        AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
        10
      );

      assert.equal(
        logged.filter((message) => COULD_NOT_BE_REHASHED.test(message)).length,
        1
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a locally-recorded undeliverable generation is neither touched nor counted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-recorded-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-recorded";
      // The NEW build's own record of a collision: one dead-lettered row whose
      // payload is an error record, not a part. Widening the scan to parked
      // rows must not resurrect it, and must not inflate the unrepairable
      // tally with a case it does not describe.
      await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: ENDED_AT,
          toolUses: [
            { id: "toolu_dupe", name: "Read", timestamp: NOW },
            {
              id: "  toolu_dupe  ",
              name: "Read",
              timestamp: "2026-07-22T17:00:01.000Z",
            },
          ],
        }),
        "claude"
      );
      const before = await readTemplateRows(db, sessionId);
      assert.equal(before.length, 1);
      assert.equal(before[0]?.status, OutboxStatus.DeadLettered);

      const logged: string[] = [];
      const result = await repairInvocationSyncCanonicalization(
        db.prisma,
        (message) => logged.push(message)
      );

      assert.deepEqual(result, { inspected: 0, repaired: 0, unrepairable: 0 });
      assert.deepEqual(logged, []);
      assert.deepEqual(await readTemplateRows(db, sessionId), before);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-6889 post-trim id collision is a recorded outcome, not an abort", () => {
  test("an import whose ids collide only after trimming still commits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-collision-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-collision";
      // Two provider ids that are distinct as STORED and identical once the
      // wire boundary trims them. Pre-fix this threw out of the invocation
      // group's `$transaction`, rolling the whole materialization back.
      const result = await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: ENDED_AT,
          toolUses: [
            { id: "toolu_collide", name: "Read", timestamp: NOW },
            {
              id: "  toolu_collide  ",
              name: "Read",
              timestamp: "2026-07-22T17:00:01.000Z",
            },
          ],
        }),
        "claude"
      );

      assert.equal(result.incomplete, undefined);
      // The user keeps both local rows; only DELIVERY is abandoned.
      const local = await db.prisma.client.$queryRawUnsafe<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM agent_component_invocations WHERE session_id = $1",
        sessionId
      );
      assert.equal(Number(local[0]?.n), 2);
      // Recorded exactly once, as one dead-lettered generation row.
      const rows = await readTemplateRows(db, sessionId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, OutboxStatus.DeadLettered);
      assert.equal(
        rows[0]?.last_error,
        AgentComponentInvocationSyncLocalError.DuplicateInvocationId
      );
      assert.match(
        JSON.stringify(rows[0]?.payload ?? null),
        DUPLICATE_INVOCATION_ID
      );
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a session with distinct ids records no collision outcome", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-no-collision-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-no-collision";
      const result = await db.importer.importSession(
        makeSession({
          sessionId,
          startedAt: NOW,
          endedAt: ENDED_AT,
          toolUses: [
            { id: "toolu_a", name: "Read", timestamp: NOW },
            {
              id: "toolu_b",
              name: "Read",
              timestamp: "2026-07-22T17:00:01.000Z",
            },
          ],
        }),
        "claude"
      );

      assert.equal(result.incomplete, undefined);
      const rows = await readTemplateRows(db, sessionId);
      assert.ok(rows.length > 0);
      // The clean path records nothing: every row is a deliverable pending part.
      for (const row of rows) {
        assert.equal(row.status, OutboxStatus.Pending);
        assert.equal(row.last_error, null);
      }
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ISS-4965 the repair redacts definition text an earlier build persisted", () => {
  test("a template holding raw definition text is rebuilt redacted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aci-canon-redact-"));
    const db = await openDb(dir);
    try {
      const sessionId = "session-canon-redact";
      await importOneToolSession(db, sessionId);
      await persistPaddedLegacyPart(db, sessionId, withRawDefinitionSecret);
      // The store a revision-2 build already repaired: without the bump this
      // pass would skip it and the raw text would stay queued for egress.
      await db.prisma.write((client) =>
        client.$executeRawUnsafe(
          `INSERT INTO agent_component_invocation_sync_cursors
             (source_key, external_session_id, external_generation_id,
              source_sequence, updated_at)
           VALUES ($1, $2, $2, $3, $4)`,
          AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
          INVOCATION_SYNC_CANONICALIZATION_SESSION_ID,
          2,
          NOW
        )
      );

      const result = await repairInvocationSyncCanonicalization(db.prisma);

      assert.deepEqual(result, { inspected: 1, repaired: 1, unrepairable: 0 });
      const [after] = await readTemplateRows(db, sessionId);
      assert.ok(after);
      const serialized = JSON.stringify(after.payload);
      assert.ok(!serialized.includes(SYNTHETIC_GITHUB_TOKEN));
      assert.equal(
        partOf(after.payload).items[0]?.definitionContent,
        "TOKEN=[REDACTED:ghp]"
      );
      assert.equal(cloudAcceptsPartHash(after.payload), true);
    } finally {
      await db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** The ISS-4965 seed: a skill item carrying raw definition text, as stored by an earlier build. */
function withRawDefinitionSecret(
  items: AgentComponentInvocationSyncPart["items"]
): AgentComponentInvocationSyncPart["items"] {
  const [first, ...rest] = items;
  if (!first) {
    throw new Error("fixture part must carry an item");
  }
  const definitionContent = `TOKEN=${SYNTHETIC_GITHUB_TOKEN}`;
  return [
    {
      ...first,
      kind: AgentComponentInvocationKind.Skill,
      evidenceClass: AgentComponentInvocationEvidenceClass.TranscriptSnapshot,
      definitionContent,
      ...computeDefinitionHash({
        body: definitionContent,
        kind: AgentComponentInvocationKind.Skill,
      }),
    },
    ...rest,
  ];
}
