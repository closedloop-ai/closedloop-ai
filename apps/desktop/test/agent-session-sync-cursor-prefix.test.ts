/**
 * @file agent-session-sync-cursor-prefix.test.ts
 * @description ISS-8041 — unit coverage for WHERE the session lane's durable
 * cursor may be recorded. The three refusals in
 * `agent-session-sync-cursor-prefix.ts` are the whole safety argument, so each
 * one is exercised against inputs where the OTHER two would have allowed a
 * write; a test that only proved the happy advance would stay green against a
 * resolver that had dropped any of them.
 *
 * The restart-replay half — that a row left below the boundary is genuinely
 * re-selected by the real cursor scan after a restart — lives in
 * `agent-session-sync-cursor-prefix-restart.test.ts`, over the real service.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  resolveCursorPrefixBoundary,
  resolveOldestOwedUpdatedAt,
} from "../src/main/agent-sync/agent-session-sync-cursor-prefix.js";

const T0 = "2026-08-25T21:00:00.000Z";
const T1 = "2026-08-25T21:05:00.000Z";
const T2 = "2026-08-25T21:10:00.000Z";
const T3 = "2026-08-25T21:15:00.000Z";

function resolve(input: {
  unackedIds?: string[];
  queuedUpdatedAtById?: Record<string, string>;
  observedTopUpdatedAt?: string | null;
  observedIdsAtTopUpdatedAt?: string[];
  lastPersistedTopUpdatedAt?: string | null;
}) {
  return resolveCursorPrefixBoundary({
    unackedIds: input.unackedIds ?? [],
    queuedUpdatedAtById: new Map(
      Object.entries(input.queuedUpdatedAtById ?? {})
    ),
    observedTopUpdatedAt:
      input.observedTopUpdatedAt === undefined
        ? T3
        : input.observedTopUpdatedAt,
    observedIdsAtTopUpdatedAt: new Set(input.observedIdsAtTopUpdatedAt ?? []),
    lastPersistedTopUpdatedAt: input.lastPersistedTopUpdatedAt ?? null,
  });
}

describe("resolveCursorPrefixBoundary — the advance ISS-8041 adds", () => {
  it("records the OLDEST still-owed stamp, not the watermark above it", () => {
    // The ISS-8041 shape: `stuck` is in bounded retry while newer rows ack, so
    // the lane may record everything below `stuck` and nothing at or above it.
    const boundary = resolve({
      unackedIds: ["stuck"],
      queuedUpdatedAtById: { stuck: T1 },
      observedTopUpdatedAt: T3,
      observedIdsAtTopUpdatedAt: ["fresh"],
      lastPersistedTopUpdatedAt: T0,
    });
    assert.equal(boundary?.observedTopUpdatedAt, T1);
  });

  it("empties the tied-top set at a prefix boundary so the resume scan re-selects it", () => {
    // `updated_at > $1 OR (updated_at = $1 AND id NOT IN (<tied>))` collapses to
    // `>= $1` on an empty set. Serializing the LIVE tied set here would exclude
    // ids at the boundary stamp from the restart scan — the data-loss shape.
    const boundary = resolve({
      unackedIds: ["stuck"],
      queuedUpdatedAtById: { stuck: T1 },
      observedIdsAtTopUpdatedAt: ["fresh", "stuck"],
      lastPersistedTopUpdatedAt: T0,
    });
    assert.deepEqual([...(boundary?.observedIdsAtTopUpdatedAt ?? [])], []);
  });

  it("takes the minimum across BOTH lanes, not whichever id came first", () => {
    const boundary = resolve({
      // Ordered newest-first on purpose: a resolver that sampled the head, or
      // took the last write, would answer T2.
      unackedIds: ["late", "early", "middle"],
      queuedUpdatedAtById: { late: T3, early: T1, middle: T2 },
      lastPersistedTopUpdatedAt: T0,
    });
    assert.equal(boundary?.observedTopUpdatedAt, T1);
  });

  it("advances again as the oldest still-owed row changes", () => {
    const after = resolve({
      unackedIds: ["middle"],
      queuedUpdatedAtById: { middle: T2 },
      lastPersistedTopUpdatedAt: T1,
    });
    assert.equal(after?.observedTopUpdatedAt, T2);
  });
});

describe("resolveCursorPrefixBoundary — the refusals that make it safe", () => {
  it("refuses when ANY still-owed id has no recorded stamp", () => {
    // A row re-enqueued from the durable outbox, a data-revision inject, or a
    // recovered dead-letter carries no stamp here, and its outbox row was
    // written fire-and-forget — so no boundary can be PROVEN to sit below it.
    const boundary = resolve({
      unackedIds: ["stuck", "resumed-from-outbox"],
      queuedUpdatedAtById: { stuck: T2 },
      lastPersistedTopUpdatedAt: T0,
    });
    assert.equal(
      boundary,
      null,
      "one unstamped id refuses the write outright, it does not merely drop out of the minimum"
    );
  });

  it("refuses a boundary at or below what was already written", () => {
    // FEA-3473 records the corpus MAXIMUM mid-backfill once the outbox seed
    // commits. Recomputing a prefix during that walk must not rewind it.
    for (const lastPersisted of [T2, T3]) {
      assert.equal(
        resolve({
          unackedIds: ["corpus-oldest"],
          queuedUpdatedAtById: { "corpus-oldest": T2 },
          lastPersistedTopUpdatedAt: lastPersisted,
        }),
        null
      );
    }
  });

  it("refuses before the first scan has produced a watermark", () => {
    assert.equal(resolve({ observedTopUpdatedAt: null }), null);
  });
});

describe("resolveCursorPrefixBoundary — the drained path is unchanged", () => {
  it("records the live watermark and its EXACT tied-top set when nothing is owed", () => {
    const boundary = resolve({
      unackedIds: [],
      observedTopUpdatedAt: T3,
      observedIdsAtTopUpdatedAt: ["a", "b"],
      lastPersistedTopUpdatedAt: T0,
    });
    assert.equal(boundary?.observedTopUpdatedAt, T3);
    assert.deepEqual(
      [...(boundary?.observedIdsAtTopUpdatedAt ?? [])].sort(),
      ["a", "b"],
      "the drained write keeps the precise tied-top exclusion it always had"
    );
  });

  it("still writes a drained watermark that equals what was last persisted", () => {
    // The never-move-backwards refusal is deliberately NOT applied here: the
    // pre-ISS-8041 lane rewrote the row on every drained ack, and the burn-down
    // reporter's `durableCursorWrittenAtIso` freshness reads that write.
    const boundary = resolve({
      unackedIds: [],
      observedTopUpdatedAt: T3,
      lastPersistedTopUpdatedAt: T3,
    });
    assert.equal(boundary?.observedTopUpdatedAt, T3);
  });
});

describe("resolveOldestOwedUpdatedAt — ISS-10429: the row the watermark waits on", () => {
  function oldest(unackedIds: string[], stamps: Record<string, string>) {
    return resolveOldestOwedUpdatedAt({
      unackedIds,
      queuedUpdatedAtById: new Map(Object.entries(stamps)),
    });
  }

  it("names the OLDEST stamp among the owed ids", () => {
    assert.equal(oldest(["b", "a", "c"], { a: T2, b: T1, c: T3 }), T1);
  });

  it("names nothing when nothing is owed", () => {
    assert.equal(oldest([], { stale: T0 }), null);
  });

  it("names nothing when an owed id has no live-scan stamp", () => {
    assert.equal(oldest(["a", "resumed"], { a: T1 }), null);
  });
});
