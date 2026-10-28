/**
 * @file sync-oversized-metadata-degrade.test.ts
 * @description ISS-7997 — a session whose `metadata` base exhausts the chunk
 * budget must DEGRADE, not vanish.
 *
 * The shared compaction contract bounds `metadata` per dimension (80 keys, 100
 * array items, 1024 chars, depth 4) and never in aggregate, so a blob it admits
 * WHOLE still serializes to megabytes. That blob is replicated into every
 * chunk's base, so `chunkOversizedSession` produced no chunk, the prepare
 * returned `dead-letter`, and the session never reached the cloud at all — the
 * user sees a working sync with sessions missing and nothing says data was
 * dropped.
 *
 * Asserted on the BATCHES THAT CROSSED `sendBatch`, driving the real
 * `AgentSessionSyncService`, because "a helper returned a non-empty array" is
 * not the contract — the session arriving is.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JsonObject } from "@repo/api/src/types/common";
import { test } from "vitest";
import { SESSION_PAYLOAD_BYTE_CAP } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import type {
  AgentSessionSyncBatch,
  SyncedAgentSession,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  boundSessionMetadataToBytes,
  chunkWithBoundedMetadata,
  METADATA_WITHHELD_KEYS_FIELD,
} from "../src/main/agent-sync/agent-session-sync-metadata.js";
import { AgentSessionSyncService } from "../src/main/agent-sync/agent-session-sync-service.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  makeSessionWithLargeTiling,
  makeUnchunkableOversizedSession,
  settleSelfContinuedDrain,
} from "./agent-session-sync-service-fixtures.js";
import { FakeSyncSource, makeSyncedSession } from "./fake-sync-source.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const COMPUTE_TARGET = "compute-target-iss7997";
const OVERSIZED_ID = "s-iss7997-oversized";
const HEALTHY_ID = "s-iss7997-healthy";
const EVENT_COUNT = 12;

/**
 * A `metadata` blob every compaction dimension admits whole. The 8-bucket
 * default serializes to 1,081,697 bytes — 4x the 256 KiB payload cap.
 *
 * `buckets` exists because the two sizers bind on DIFFERENT dimensions, and one
 * fixture cannot exercise both. The identity sizer bounds RAW bytes at 256 KiB,
 * which the default already blows. The gzip sizer bounds COMPRESSED bytes at
 * 256 KiB and raw bytes at the 4 MiB decompressed target — and this blob is
 * repetitive, so 8 buckets gzip to 6,114 bytes and ship WHOLE without ever
 * reaching the degrade. Measured. Only a blob past the decompressed target
 * (40 buckets = 5,408,511 raw) forces the gzip path to chunk.
 *
 * NUMERIC leaves on purpose: `MetadataContentPolicy.Omit` drops undeclared
 * strings, so a string-valued fixture would collapse under the default producer
 * policy and prove nothing about the level a real machine syncs at. Numbers are
 * kept unconditionally by BOTH policies, so this reproduces at every tier.
 */
function oversizedMetadata(buckets = 8): JsonObject {
  const metadata: JsonObject = {};
  for (let key = 0; key < buckets; key++) {
    metadata[`bucket${key}`] = Array.from({ length: 100 }, () => {
      const row: Record<string, number> = {};
      for (let field = 0; field < 80; field++) {
        row[`f${field}`] = 1_234_567_890;
      }
      return row;
    });
  }
  return metadata;
}

function events(id: string, count = EVENT_COUNT): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `${id}-event-${index}`,
    eventType: "ToolUse",
    toolName: "Read",
    createdAt: "2026-06-08T12:00:00.000Z",
  }));
}

/**
 * Drive the real service over `sessions` and return every batch it sent.
 *
 * `capabilities` is what the server advertised. It defaults to NEITHER, which is
 * what a desktop resolves against an old or silent server — but production is
 * the opposite: `desktop-server-capabilities.ts` advertises both unconditionally
 * since ISS-8022, so the gzip sizer, not the identity one, is the path a real
 * install takes. Both are exercised below.
 */
async function captureBatches(
  sessions: SyncedAgentSession[],
  capabilities: { compression?: boolean; activityChunking?: boolean } = {}
): Promise<{ batches: AgentSessionSyncBatch[]; deadLettered: number }> {
  const source = new FakeSyncSource(sessions);
  const batches: AgentSessionSyncBatch[] = [];
  const service = new AgentSessionSyncService({
    isHttpReady: () => true,
    getSource: () => source,
    getSyncComputeTargetId: () => COMPUTE_TARGET,
    isSyncCompressionSupported: () => capabilities.compression === true,
    isSyncActivityChunkingSupported: () =>
      capabilities.activityChunking === true,
    sendBatch: (batch) => {
      batches.push(batch);
      return Promise.resolve({ accepted: true as const });
    },
  });
  service.start();
  try {
    await settleSelfContinuedDrain(service);
    return {
      batches,
      deadLettered: service.getSyncProgress().deadLetteredSessions ?? 0,
    };
  } finally {
    service.stop();
  }
}

/** Every wire session carrying `id`, across every chunk of every batch. */
function shippedParts(
  batches: AgentSessionSyncBatch[],
  id: string
): SyncedAgentSession[] {
  return batches
    .flatMap((batch) => batch.sessions)
    .filter((session) => session.externalSessionId === id);
}

test("ISS-7997: a session whose metadata base exhausts the budget still reaches the cloud", async () => {
  // COUNTERFACTUAL: delete the `chunkWithBoundedMetadata` arm from
  // `prepareAgentSessionPayload` and this session is prepared `dead-letter`,
  // no batch ever carries it, and `shipped` is empty.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        OVERSIZED_ID,
        "2026-06-08T12:00:00.000Z",
        events(OVERSIZED_ID)
      ),
      metadata: oversizedMetadata(),
    },
  ]);

  const shipped = shippedParts(batches, OVERSIZED_ID);
  assert.ok(
    shipped.length > 0,
    "the session never reached the cloud; a dead-lettered session is absent, not degraded"
  );
});

test("ISS-7997: the degraded delivery keeps the data that was never oversized", async () => {
  // The point of degrading rather than dead-lettering is that the events,
  // status and token usage sync fine on their own. A fix that shipped an empty
  // husk would satisfy the arrival assertion above and lose exactly what the
  // dead-letter was losing.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        OVERSIZED_ID,
        "2026-06-08T12:00:00.000Z",
        events(OVERSIZED_ID)
      ),
      metadata: oversizedMetadata(),
    },
  ]);

  const shipped = shippedParts(batches, OVERSIZED_ID);
  const deliveredEventIds = new Set(
    shipped.flatMap((part) => part.events.map((e) => e.externalEventId))
  );
  assert.deepEqual(
    [...deliveredEventIds].sort(),
    events(OVERSIZED_ID)
      .map((e) => e.externalEventId)
      .sort(),
    "every event must still arrive; they were never what exceeded the cap"
  );
  assert.equal(shipped[0].status, "completed");
  assert.deepEqual(shipped[0].tokenUsageByModel, [
    {
      model: "gpt-5",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.001,
    },
  ]);
  // The assertion that makes this a DEGRADE rather than a STRIP (review:
  // review-soul). Everything above stays green if the budget collapses to 0 and
  // the blob ships as `{}` — arrival alone cannot tell the two apart. A leading
  // key must survive and a key that cannot fit must not, which also pins the
  // drop ORDER: reverse it and `bucket0` is the one missing.
  const shippedMetadata = shipped[0].metadata as Record<string, unknown>;
  assert.ok(
    Object.hasOwn(shippedMetadata, "bucket0"),
    "the leading metadata key must survive; a degrade that keeps nothing is a strip"
  );
  assert.ok(
    !Object.hasOwn(shippedMetadata, "bucket7"),
    "a key the budget cannot fit must not ship"
  );
});

test("ISS-7997: the degrade drops only the oversized keys, never the small semantic ones", async () => {
  // The consumer-harm guard (review: review-soul, synchronizing-susan). Three
  // cloud consumers read named metadata keys and cannot tell "the producer had
  // nothing" from "the producer dropped it to fit": `sessionWebSearchCostUsd`
  // prices from `usageExtras` (absent reads as no web search -> an understated
  // DOLLAR figure), and the insights heatmap reads `entrypoint`,
  // `permissionMode` and `humanTurnTimestamps` (absent demotes the session to
  // the undercounting basis).
  //
  // They are safe because `boundSessionMetadataToBytes` SKIPS an unfittable key
  // and keeps scanning instead of breaking, so a key is dropped only if it
  // ALONE exceeds the remaining budget — which these, being small, never do.
  // That is a property of the skip, not a coincidence, so it is pinned here:
  // switch the skip to a `break` and every key after the first bucket is lost.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        OVERSIZED_ID,
        "2026-06-08T12:00:00.000Z",
        events(OVERSIZED_ID)
      ),
      metadata: {
        usageExtras: { web_search_requests: 7 },
        ...oversizedMetadata(),
        entrypoint: "cli",
        permissionMode: "acceptEdits",
      },
    },
  ]);

  const shipped = shippedParts(batches, OVERSIZED_ID);
  assert.ok(shipped.length > 0, "the session must reach the cloud");
  const metadata = shipped[0].metadata as Record<string, unknown>;
  assert.deepEqual(
    metadata.usageExtras,
    { web_search_requests: 7 },
    "cost is priced from usageExtras; dropping it understates a dollar figure"
  );
  assert.equal(metadata.entrypoint, "cli");
  assert.equal(metadata.permissionMode, "acceptEdits");
  assert.ok(
    Object.hasOwn(metadata, "humanTurnTimestamps"),
    "the heatmap treats humanTurnTimestamps as authoritative when present"
  );
  assert.ok(
    Object.hasOwn(metadata, "agentTurnTimestamps"),
    "ISS-9864: the agent key rides the degraded blob the same way"
  );
  assert.ok(
    !Object.hasOwn(metadata, "bucket7"),
    "the oversized keys ARE still dropped; this is a degrade, not a no-op"
  );
});

test("ISS-7997: a session whose metadata already fits ships it untouched", async () => {
  // POSITIVE SIBLING for the two above, and the regression they could otherwise
  // hide: a degrade that fired on every session would trim metadata for the
  // whole fleet to fix the rare oversized one. The expectation is an
  // INDEPENDENT literal, not a re-derivation through the compactor, so a
  // producer that started dropping keys cannot agree with its own output.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        HEALTHY_ID,
        "2026-06-08T12:00:00.000Z",
        events(HEALTHY_ID)
      ),
      metadata: { turnCount: 42, costUsd: 1.25, toolCalls: 7 },
    },
  ]);

  const shipped = shippedParts(batches, HEALTHY_ID);
  assert.equal(shipped.length, 1, "a fitting session must not be chunked");
  assert.deepEqual(shipped[0].metadata, {
    turnCount: 42,
    costUsd: 1.25,
    toolCalls: 7,
    // ISS-7896's derived key, appended by `compactSessionMetadataForSync` on
    // every session. Pinned rather than filtered out: this assertion is the
    // fleet-wide guard that the producer emits the whole blob, so it has to
    // fail on a key that appears as well as on one that disappears.
    humanTurnTimestamps: [],
    // ISS-9864's derived key, appended after it. Present because this fixture
    // carries no `tokenEvents` — the producer omits it on a round-trip session.
    agentTurnTimestamps: [],
  });
});

test("ISS-7997: a base oversized for reasons metadata cannot fix still dead-letters", async () => {
  // The degrade must not launder a genuine failure into a fake success. This
  // session's agents — replicated into every chunk and not degradable — are what
  // exceeds the cap, so no metadata bound can rescue it and the existing
  // monitored dead-letter disposition must still fire.
  const { batches, deadLettered } = await captureBatches([
    makeUnchunkableOversizedSession(
      "s-iss7997-unchunkable",
      "2026-06-08T12:00:00.000Z"
    ),
  ]);

  assert.equal(shippedParts(batches, "s-iss7997-unchunkable").length, 0);
  assert.equal(
    deadLettered,
    1,
    "an unshippable session must still be reported dead-lettered, not silently dropped"
  );
});

test("ISS-7997: the degrade holds on the gzip sizer, which is the path production takes", async () => {
  // The four cases above run the identity sizer, which is what a desktop
  // resolves only against a server advertising nothing. A real install
  // negotiates compression, and under gzip the cap bounds COMPRESSED bytes
  // while `remainingChunkByteBudget` switches to the decompressed ceiling
  // (`sizer.encoding !== identity`) and the packer switches to
  // `appendPaginatedChunksByMeasuredSize`. A degrade that only worked on the
  // identity path would fix nothing for the user who reported this.
  const session = {
    ...makeSyncedSession(
      OVERSIZED_ID,
      "2026-06-08T12:00:00.000Z",
      events(OVERSIZED_ID)
    ),
    // 40 buckets, not the default 8: see `oversizedMetadata`. At 8 this blob
    // gzips to 6 KiB, ships whole, and this test passes WITHOUT the degrade —
    // measured, and it is why the size is stated here rather than defaulted.
    metadata: oversizedMetadata(40),
  };

  const { batches } = await captureBatches([session], {
    compression: true,
    activityChunking: true,
  });

  const shipped = shippedParts(batches, OVERSIZED_ID);
  assert.ok(
    shipped.length > 0,
    "the session must reach the cloud under the negotiated gzip sizer too"
  );
  // Proves the DEGRADE ran rather than the blob simply fitting: an undegraded
  // 40-bucket blob carries `bucket39`.
  assert.ok(
    !Object.hasOwn(shipped[0].metadata as Record<string, unknown>, "bucket39"),
    "the gzip path must have degraded the blob, not shipped it whole"
  );
});

test("ISS-7997: an oversized tiling AND an oversized metadata blob both degrade", async () => {
  // The composite fallback chain, which neither case above reaches: strip the
  // tiling (ISS-4578, only available because the server advertises no activity
  // chunking), find the base STILL oversized because of metadata, then degrade
  // metadata on the tiling-stripped base. The strip flag must survive the
  // second degrade — a degrade that rebuilt from `sanitized` instead of the
  // stripped base would silently re-add the tiling.
  const { batches } = await captureBatches(
    [
      {
        ...makeSessionWithLargeTiling(OVERSIZED_ID),
        metadata: oversizedMetadata(),
      },
    ],
    { activityChunking: false }
  );

  const shipped = shippedParts(batches, OVERSIZED_ID);
  assert.ok(shipped.length > 0, "the session must still reach the cloud");
  assert.equal(
    shipped[0].activitySegmentRowsStripped,
    true,
    "the tiling strip must stay legible on a payload that was ALSO metadata-degraded"
  );
});

test("ISS-7997: a session with no metadata to degrade dead-letters exactly as before", async () => {
  // The `boundSessionMetadataToBytes` / `chunkWithBoundedMetadata` early return
  // for a non-object blob. `metadata` is typed `JsonObject | null`, so `null` is
  // reachable, not a type-forbidden input. The degrade must ABSTAIN rather than
  // misfire — and the session must still be reported, not silently dropped.
  const { batches, deadLettered } = await captureBatches([
    {
      ...makeUnchunkableOversizedSession(
        "s-iss7997-null-metadata",
        "2026-06-08T12:00:00.000Z"
      ),
      metadata: null,
    },
  ]);

  assert.equal(shippedParts(batches, "s-iss7997-null-metadata").length, 0);
  assert.equal(deadLettered, 1);
});

test("ISS-7997: boundSessionMetadataToBytes returns a null blob untouched", () => {
  assert.equal(boundSessionMetadataToBytes(null, 0), null);
});

test("ISS-7997: the pre-hydrate oversize probe no longer discards a degradable blob", async () => {
  // The chunker is not the only gate. On the uncompressed lane
  // `selectHydratableCandidateIds` dead-letters a candidate BEFORE hydration and
  // before any send, from this probe — so a probe that still called a degradable
  // blob unshippable would make the degrade above unreachable there, and the
  // session would vanish exactly as it does today.
  //
  // COUNTERFACTUAL: restore the `estimateSessionPayloadBytes(sanitized) >
  // maxBytes` comparison in `findSqliteLocallyOversizedSessions` and this
  // reports `["metadata-oversized"]`.
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss7997-preflight-"));
  const db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "metadata-oversized", {
      metadata: JSON.stringify(oversizedMetadata()),
    });

    const oversized = await db.syncSource.findLocallyOversizedSessions?.(
      ["metadata-oversized"],
      SESSION_PAYLOAD_BYTE_CAP
    );

    assert.deepEqual(oversized, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ISS-7997: boundSessionMetadataToBytes keeps leading keys and skips an unfittable one", () => {
  // Precedence is under test, so the budget is pre-seeded to admit `first` and
  // `third` while `second` alone cannot fit: a `break` instead of the skip would
  // strand `third`, and a reversed order would keep the wrong pair.
  const bounded = boundSessionMetadataToBytes(
    {
      first: 1,
      second: "x".repeat(400),
      third: 3,
    },
    64
  );

  assert.deepEqual(bounded, { first: 1, third: 3 });
});

test("ISS-7997: boundSessionMetadataToBytes leaves a blob that already fits byte-identical", () => {
  const blob = { turnCount: 42, nested: { a: [1, 2, 3] } };

  assert.deepEqual(boundSessionMetadataToBytes(blob, 4096), blob);
});

/** `n` fixed-width numbers — a metadata value whose serialized size is chosen. */
function block(n: number): number[] {
  return Array.from({ length: n }, () => 1_234_567_890);
}

/** Irrelevant to the search below, which never consults the cursor. */
const STEP_FIXTURE_UPDATED_AT = "2026-06-08T12:00:00.000Z";

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value));

test("ISS-7997: a failed candidate steps to the next distinct retained subset, not to half the budget", () => {
  // davetho (#6308): `boundSessionMetadataToBytes` SKIPS an unfittable key and
  // keeps scanning, so the retained set is DISCONTINUOUS in the budget — halving
  // does not walk it, it jumps over it. This fixture is that discontinuity: one
  // wide leading key plus five narrow ones, sized so the only budgets that
  // retain `wide` at all sit in the top half of the range. Halve once and `wide`
  // — the key `compactMetadataObject`'s own ordering says wins — is gone for
  // every remaining round, and the degrade ships 306 bytes of tail keys instead
  // of the 784-byte subset that was shippable all along.
  const metadata = {
    wide: block(54),
    n1: block(5),
    n2: block(5),
    n3: block(5),
    n4: block(5),
    n5: block(5),
  };
  // The chunker's verdict is a pure size gate here, pinned to the subset the
  // step should land on: the first candidate (`wide` + n1..n4) is over it, so
  // the loop must take at least one step, and everything at or below it is
  // shippable — including the tail-only subset halving would settle for. So this
  // asserts WHICH subset the search finds, not whether it finds one at all.
  const acceptCapBytes = serializedBytes({
    wide: metadata.wide,
    n1: metadata.n1,
    n2: metadata.n2,
    n3: metadata.n3,
  });
  const attempted: number[] = [];
  const session: SyncedAgentSession = {
    ...makeSyncedSession("s-iss7997-step", STEP_FIXTURE_UPDATED_AT),
    metadata,
  };

  const chunks = chunkWithBoundedMetadata(
    session,
    serializedBytes(metadata),
    (candidate) => {
      const bytes = serializedBytes(candidate.metadata);
      attempted.push(bytes);
      return bytes <= acceptCapBytes ? [candidate] : [];
    }
  );

  // The fixture is only the discontinuous case if the first candidate really is
  // rejected; a fixture that shipped on attempt one would pass under halving too.
  assert.ok(attempted.length > 1, "the first candidate must be rejected");
  assert.deepEqual(chunks?.[0]?.metadata, {
    wide: metadata.wide,
    n1: metadata.n1,
    n2: metadata.n2,
    n3: metadata.n3,
  });
  // No attempt repeats a subset it already rejected. Halving retested identical
  // retained sets whenever two budgets bracketed the same set, spending a full
  // re-chunk (a gzip pass on the compressed sizer) to learn nothing.
  assert.equal(new Set(attempted).size, attempted.length);
});

test("ISS-7997: the degrade search is bounded and dead-letters rather than spinning", () => {
  // The step is a BYTE step, so nothing in it guarantees a key falls off each
  // round; `MAX_DEGRADE_ATTEMPTS_PER_KEY` is what stops a pathological blob from
  // buying a gzip pass per byte. A chunker that never accepts must terminate at
  // null — main's behaviour for this session — in a bounded number of attempts.
  const metadata = { a: block(20), b: block(15), c: block(10), d: block(5) };
  const session: SyncedAgentSession = {
    ...makeSyncedSession("s-iss7997-bounded", STEP_FIXTURE_UPDATED_AT),
    metadata,
  };
  let attempts = 0;

  const chunks = chunkWithBoundedMetadata(
    session,
    serializedBytes(metadata),
    () => {
      attempts += 1;
      return [];
    }
  );

  assert.equal(chunks, null);
  assert.ok(
    attempts <= Object.keys(metadata).length * 4 + 1,
    `degrade search ran ${attempts} attempts`
  );
});

test("ISS-8641: the degraded delivery NAMES the metadata keys it withheld", async () => {
  // The wire half of ISS-8641. Before this, a degraded payload and a complete
  // one were the same shape, so the cloud's wholesale assign deleted every
  // dropped key from a row that already held it and nothing on the wire said so.
  //
  // COUNTERFACTUAL: drop the `withWithheldMetadataKeys` call in
  // `chunkWithBoundedMetadata` and `metadataWithheldKeys` is undefined on every
  // shipped part.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        OVERSIZED_ID,
        "2026-06-08T12:00:00.000Z",
        events(OVERSIZED_ID)
      ),
      metadata: oversizedMetadata(),
    },
  ]);

  const shipped = shippedParts(batches, OVERSIZED_ID);
  const shippedMetadata = shipped[0].metadata as Record<string, unknown>;
  const declared = shipped[0].metadataWithheldKeys;
  assert.ok(
    Array.isArray(declared) && declared.length > 0,
    "a degraded delivery must declare the keys it withheld"
  );
  // EXACTLY the complement, not merely non-empty. A declaration that named the
  // wrong keys would make the cloud reinstate keys the user deleted and drop
  // keys the degrade actually withheld — both worse than the defect it closes.
  assert.deepEqual(
    [...declared].sort(),
    Object.keys(oversizedMetadata())
      .filter((key) => !Object.hasOwn(shippedMetadata, key))
      .sort(),
    "the declaration must be exactly the keys present locally and absent on the wire"
  );
  // The list and the blob cannot overlap: a key cannot be both sent and withheld.
  assert.deepEqual(
    declared.filter((key) => Object.hasOwn(shippedMetadata, key)),
    [],
    "no shipped key may also be declared withheld"
  );
});

test("ISS-8641: every chunk of a degraded session carries the declaration", async () => {
  // `chunkOversizedSession` spreads the base into every part, and the cloud
  // applies the metadata on EVERY chunk slice — so a declaration that rode only
  // the first part would let a later chunk's wholesale assign delete the very
  // keys the first one preserved.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        OVERSIZED_ID,
        "2026-06-08T12:00:00.000Z",
        events(OVERSIZED_ID)
      ),
      metadata: oversizedMetadata(),
      // Enough events that the degraded base still cannot ride one part, which
      // is what actually forces the split this test is about. The metadata
      // degrade alone leaves a base small enough to fit a single chunk.
      events: events(OVERSIZED_ID, 4000),
    },
  ]);

  const shipped = shippedParts(batches, OVERSIZED_ID);
  // Positive control: without more than one part this asserts nothing about
  // chunks at all.
  assert.ok(shipped.length > 1, "the fixture must actually have split");
  for (const part of shipped) {
    assert.ok(
      Array.isArray(part.metadataWithheldKeys) &&
        part.metadataWithheldKeys.length > 0,
      "every chunk of a degraded session must carry the declaration"
    );
  }
});

test("ISS-8641: a session that ships its metadata whole declares nothing", async () => {
  // OMISSION IS THE CROSS-REPO CONTRACT. A payload that withheld nothing must be
  // indistinguishable from one sent by a build that cannot declare at all, so the
  // cloud keeps its wholesale replace rather than applying a merge policy on a
  // producer's behalf. `null` would NOT satisfy this — the field must be absent.
  const { batches } = await captureBatches([
    {
      ...makeSyncedSession(
        HEALTHY_ID,
        "2026-06-08T12:00:00.000Z",
        events(HEALTHY_ID)
      ),
      metadata: { entrypoint: 1 },
    },
  ]);

  const shipped = shippedParts(batches, HEALTHY_ID);
  assert.equal(shipped.length, 1);
  // `entrypoint` intact, not a deepEqual on the whole blob: the producer also
  // DERIVES `humanTurnTimestamps` (ISS-7896), which is a separate contract and
  // not something this test may quietly re-pin.
  assert.equal(
    (shipped[0].metadata as Record<string, unknown>).entrypoint,
    1,
    "an undegraded blob ships its keys untouched"
  );
  assert.ok(
    !Object.hasOwn(shipped[0], "metadataWithheldKeys"),
    "an undegraded payload must OMIT the field, not send [] or null"
  );
});

/**
 * ISS-8883: the degrade fold accumulated into a plain `{}`, so a top-level
 * metadata key literally named `__proto__` — which BOTH producers deliberately
 * preserve (ISS-8565) — hit the inherited setter: the accumulator was
 * reparented, no own key was created, and the entry's bytes were still counted
 * as kept. The fixture builds the key with `JSON.parse`, which DEFINES it as a
 * real own key the way the SQLite `metadata` text does; a quoted `"__proto__"`
 * in an object literal would create no own key and prove nothing.
 */
function protoMetadataBlob(): Record<string, unknown> {
  return JSON.parse('{"__proto__":{"a":1},"version":"x"}');
}

/** Serialized width of {@link protoMetadataBlob}: `{"__proto__":{"a":1},"version":"x"}`. */
const PROTO_BLOB_BYTES = 35;
/** Width of the blob with only its first entry kept: `{"__proto__":{"a":1}}`. */
const PROTO_FIRST_ENTRY_BYTES = 21;

test("ISS-8883: boundSessionMetadataToBytes keeps a computed __proto__ key as an own key", () => {
  const blob = protoMetadataBlob();
  assert.equal(Buffer.byteLength(JSON.stringify(blob)), PROTO_BLOB_BYTES);

  const bounded = boundSessionMetadataToBytes(
    blob as SyncedAgentSession["metadata"],
    PROTO_BLOB_BYTES
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(bounded), ["__proto__", "version"]);
  // biome-ignore lint/suspicious/noProto: ISS-8883 regression — the hostile key IS the subject under test
  assert.deepEqual(bounded.__proto__, { a: 1 });
  // A reparented accumulator would answer `1` here; a normal-prototype result
  // with an OWN `__proto__` key answers `undefined`.
  assert.equal(bounded.a, undefined);
  assert.equal(Object.getPrototypeOf(bounded), Object.prototype);
  assert.equal(Buffer.byteLength(JSON.stringify(bounded)), PROTO_BLOB_BYTES);
});

test("ISS-8883: the byte accounting counts the __proto__ entry once it is really kept", () => {
  // One byte short of the whole blob: insertion order wins, so the first entry
  // (`"__proto__":{"a":1}`, 19 bytes, landing at 21) is KEPT and `version`
  // (which would reach 35) is SKIPPED. On main the first entry vanished from
  // the accumulator while still being charged, so `version` was skipped AND
  // nothing survived.
  const blob = protoMetadataBlob();
  const bounded = boundSessionMetadataToBytes(
    blob as SyncedAgentSession["metadata"],
    PROTO_BLOB_BYTES - 1
  ) as Record<string, unknown>;

  assert.deepEqual(Object.keys(bounded), ["__proto__"]);
  assert.equal(
    Buffer.byteLength(JSON.stringify(bounded)),
    PROTO_FIRST_ENTRY_BYTES
  );

  const candidates: SyncedAgentSession[] = [];
  const chunks = chunkWithBoundedMetadata(
    {
      ...makeSyncedSession(
        HEALTHY_ID,
        "2026-06-08T12:00:00.000Z",
        events(HEALTHY_ID)
      ),
      metadata: blob as SyncedAgentSession["metadata"],
    },
    PROTO_BLOB_BYTES - 1,
    (candidate) => {
      candidates.push(candidate);
      return [candidate];
    }
  );

  assert.ok(chunks);
  assert.deepEqual(
    (candidates[0] as Record<string, unknown>)[METADATA_WITHHELD_KEYS_FIELD],
    ["version"]
  );
});
