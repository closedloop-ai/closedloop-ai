/**
 * @file session-model-backfill.test.ts
 * @description ISS-4649 finding 8 — the null-`sessions.model` backfill must pick
 * the latest token record by TIMESTAMP, not by position.
 *
 * The regression these guard: both subagent folds (`foldCodexDescendants` and
 * `foldOpencodeSubagents`) APPEND a folded child's `tokenSeries` after the root's
 * own, in child-enumeration order — OpenCode enumerates sessions
 * `time_updated DESC`, so the LAST element of a folded root's series is routinely
 * the OLDEST record. Reading `tokenSeries.at(-1)` therefore backfilled a
 * multi-model session with whichever child happened to be folded last.
 *
 * Plus the three constraints on WHICH records may be selected at all, and the
 * repair of rows the old heuristic already mis-filled — see the review threads on
 * PR #4286: the aggregate vocabulary (`codex-auto-review` is in `tokenSeries` but
 * deliberately not in `tokensByModel`), parent-vs-subagent provenance, and
 * "no chronology ⇒ unknown" rather than an arbitrary pick.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createNormalizedSession } from "@repo/lib/harness/types";
import type { NormalizedTokenRecord } from "../src/main/collectors/types.js";
import {
  backfillSessionModel,
  latestTokenRecordModel,
  repairableStoredModels,
  usableAggregateModels,
} from "../src/main/database/session-model-backfill.js";

const MODEL_BACKFILL_SQL = /UPDATE sessions SET model/;
const CLEAR_MODEL_SQL = /SET model = NULL/;
const CLEAR_KEY_PLACEHOLDERS_SQL = /model IN \(\$3, \$4\)/;
const REPAIR_PREDICATE_SQL = /model IS NULL OR \(model <> \$1 AND model IN \(/;

function record(
  timestamp: string,
  model: string,
  subagentId?: string
): NormalizedTokenRecord {
  return {
    timestamp,
    model,
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    ...(subagentId === undefined ? {} : { subagentId }),
  };
}

const COUNTS = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };

function aggregate(...models: string[]): ReadonlySet<string> {
  return new Set(models);
}

type RecordedCall = { sql: string; params: unknown[] };

function recordingTx(): {
  calls: RecordedCall[];
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    $executeRawUnsafe: (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return Promise.resolve(1);
    },
  };
}

test("latestTokenRecordModel picks by timestamp, not position", () => {
  // A folded root: the root's own newest turn first, then a child's OLDER turns
  // appended by the fold. `.at(-1)` would answer "child-model".
  const series = [
    record("2026-01-02T00:00:00.000Z", "root-model"),
    record("2026-01-01T00:00:00.000Z", "child-model"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("root-model", "child-model")),
    "root-model"
  );
  assert.equal(series.at(-1)?.model, "child-model");
});

test("latestTokenRecordModel keeps positional-last on a tie", () => {
  const series = [
    record("2026-01-01T00:00:00.000Z", "first"),
    record("2026-01-01T00:00:00.000Z", "second"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("first", "second")),
    "second"
  );
});

test("latestTokenRecordModel ignores records with a blank or whitespace model", () => {
  const series = [
    record("2026-01-01T00:00:00.000Z", "real-model"),
    record("2026-01-03T00:00:00.000Z", ""),
    record("2026-01-04T00:00:00.000Z", "   "),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("real-model", "other-model")),
    "real-model"
  );
});

test("latestTokenRecordModel skips a series model the aggregate does not vouch for", () => {
  // parse-codex.ts remaps `codex-auto-review` out of tokensByModel because it is
  // a reviewer label, not a model — but leaves it in tokenSeries. Selecting it
  // would walk straight back into the bug FEA-1459 Fix 9 closed.
  const series = [
    record("2026-01-01T00:00:00.000Z", "gpt-5-codex"),
    record("2026-01-09T00:00:00.000Z", "codex-auto-review"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("gpt-5-codex", "gpt-5")),
    "gpt-5-codex"
  );
});

test("latestTokenRecordModel prefers the parent's own round trips over a folded subagent's", () => {
  // The multi-key case is frequently entered BECAUSE of the fold
  // (mergeTokensByModel merges the child's aggregate into the root), so without
  // this the child both causes the branch and answers it.
  const series = [
    record("2026-01-01T00:00:00.000Z", "root-model"),
    record("2026-01-05T00:00:00.000Z", "child-model", "subagent-1"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("root-model", "child-model")),
    "root-model"
  );
});

test("latestTokenRecordModel uses subagent records when the parent contributes none", () => {
  const series = [
    record("2026-01-01T00:00:00.000Z", "child-a", "subagent-1"),
    record("2026-01-05T00:00:00.000Z", "child-b", "subagent-2"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("child-a", "child-b")),
    "child-b"
  );
});

test("latestTokenRecordModel returns the single distinct model without needing a timestamp", () => {
  const series = [record("not-a-date", "only-model")];
  assert.equal(
    latestTokenRecordModel(series, aggregate("only-model", "unused-key")),
    "only-model"
  );
});

test("latestTokenRecordModel returns null when several models have no parseable chronology", () => {
  // Both "the last one positionally" and "the first aggregate key" are arbitrary
  // here, and an arbitrary pick would be persisted and then made sticky.
  const series = [record("not-a-date", "older"), record("also-bad", "newer")];
  assert.equal(
    latestTokenRecordModel(series, aggregate("older", "newer")),
    null
  );
});

test("latestTokenRecordModel prefers a parseable timestamp over a positionally-later unparseable one", () => {
  const series = [
    record("2026-01-01T00:00:00.000Z", "dated-model"),
    record("not-a-date", "undated-model"),
  ];
  assert.equal(
    latestTokenRecordModel(series, aggregate("dated-model", "undated-model")),
    "dated-model"
  );
});

test("latestTokenRecordModel returns null for an empty series", () => {
  assert.equal(latestTokenRecordModel([], aggregate("key-a")), null);
});

test("usableAggregateModels drops blank and duplicate keys", () => {
  const session = createNormalizedSession({
    sessionId: "keys",
    tokensByModel: {
      "  spaced  ": COUNTS,
      "": COUNTS,
      "   ": COUNTS,
      spaced: COUNTS,
    },
  });
  assert.deepEqual(usableAggregateModels(session), ["spaced"]);
});

test("backfillSessionModel writes the newest model for a multi-model session", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-root",
    tokensByModel: { "child-model": COUNTS, "root-model": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [
      record("2026-01-02T00:00:00.000Z", "root-model"),
      record("2026-01-01T00:00:00.000Z", "child-model"),
    ],
    "2026-01-02T01:00:00.000Z"
  );
  assert.equal(tx.calls.length, 1);
  assert.match(tx.calls[0].sql, MODEL_BACKFILL_SQL);
  assert.equal(tx.calls[0].params[0], "root-model");
  assert.equal(tx.calls[0].params[2], "opencode-root");
});

test("backfillSessionModel uses the only model key without consulting the series", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-single",
    tokensByModel: { "opencode-default": COUNTS },
  });
  await backfillSessionModel(tx, session, [], "2026-01-02T01:00:00.000Z");
  assert.equal(tx.calls[0].params[0], "opencode-default");
});

test("backfillSessionModel never writes the codex-auto-review reviewer label", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "codex-root",
    // buildTokensByModel remapped the reviewer label's tokens onto the real
    // models, so it is absent here — but it is still in the series.
    tokensByModel: { "gpt-5-codex": COUNTS, "gpt-5": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [
      record("2026-01-01T00:00:00.000Z", "gpt-5-codex"),
      record("2026-01-09T00:00:00.000Z", "codex-auto-review"),
    ],
    "2026-01-09T01:00:00.000Z"
  );
  assert.equal(tx.calls[0].params[0], "gpt-5-codex");
});

test("backfillSessionModel does not advertise a folded subagent's model on the parent", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "folded-root",
    tokensByModel: { "root-model": COUNTS, "child-model": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [
      record("2026-01-01T00:00:00.000Z", "root-model"),
      record("2026-01-05T00:00:00.000Z", "child-model", "subagent-1"),
    ],
    "2026-01-05T01:00:00.000Z"
  );
  assert.equal(tx.calls[0].params[0], "root-model");
});

test("backfillSessionModel leaves a multi-model session unknown when no timestamp parses", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-nameless",
    tokensByModel: { "key-a": COUNTS, "key-b": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [record("not-a-date", "key-a"), record("also-bad", "key-b")],
    "2026-01-02T01:00:00.000Z"
  );
  // The clear statement is scoped so it only ever touches a previously-derived
  // value; a NULL row stays NULL and its sync watermark is not bumped.
  assert.equal(tx.calls.length, 1);
  assert.match(tx.calls[0].sql, CLEAR_MODEL_SQL);
  assert.match(tx.calls[0].sql, CLEAR_KEY_PLACEHOLDERS_SQL);
  // Aggregate keys and series models coincide here, so the repair set is both.
  assert.deepEqual(tx.calls[0].params.slice(2), ["key-a", "key-b"]);
});

test("backfillSessionModel leaves a multi-model session unknown when the series names none", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-seriesless",
    tokensByModel: { "key-a": COUNTS, "key-b": COUNTS },
  });
  await backfillSessionModel(tx, session, [], "2026-01-02T01:00:00.000Z");
  assert.match(tx.calls[0].sql, CLEAR_MODEL_SQL);
});

test("backfillSessionModel repairs a row the old positional heuristic mis-filled", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-root",
    tokensByModel: { "child-model": COUNTS, "root-model": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [
      record("2026-01-02T00:00:00.000Z", "root-model"),
      record("2026-01-01T00:00:00.000Z", "child-model"),
    ],
    "2026-01-02T01:00:00.000Z"
  );
  // Without this the stored "child-model" would survive: the session upsert
  // writes `model = COALESCE(model, $2)` with a null $2, and `AND model IS NULL`
  // alone would skip the row on every re-import and every rebuild.
  const { sql, params } = tx.calls[0];
  assert.match(sql, REPAIR_PREDICATE_SQL);
  assert.equal(params[0], "root-model");
  assert.deepEqual(params.slice(3), ["child-model", "root-model"]);
});

test("backfillSessionModel can repair a stored codex-auto-review label", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "codex-root",
    tokensByModel: { "gpt-5-codex": COUNTS, "gpt-5": COUNTS },
  });
  const series = [
    record("2026-01-01T00:00:00.000Z", "gpt-5-codex"),
    record("2026-01-09T00:00:00.000Z", "codex-auto-review"),
  ];
  await backfillSessionModel(tx, session, series, "2026-01-09T01:00:00.000Z");

  // The old code read tokenSeries.at(-1)?.model directly, so it could persist
  // the reviewer label — which is NOT a tokensByModel key. Keying the repair on
  // the aggregate alone would leave exactly those rows stuck forever.
  const { params } = tx.calls[0];
  assert.equal(params[0], "gpt-5-codex");
  assert.ok(params.slice(3).includes("codex-auto-review"));
});

test("repairableStoredModels covers aggregate keys, their trimmed forms, and series models", () => {
  const session = createNormalizedSession({
    sessionId: "repairable",
    tokensByModel: { "  padded  ": COUNTS, "key-a": COUNTS },
  });
  const repairable = repairableStoredModels(session, [
    record("2026-01-01T00:00:00.000Z", "series-only"),
  ]);
  assert.deepEqual(repairable.sort(), [
    "  padded  ",
    "key-a",
    "padded",
    "series-only",
  ]);
});

test("backfillSessionModel will not overwrite a model outside the session's aggregate", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-root",
    tokensByModel: { "key-a": COUNTS, "key-b": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [
      record("2026-01-02T00:00:00.000Z", "key-a"),
      record("2026-01-01T00:00:00.000Z", "key-b"),
    ],
    "2026-01-02T01:00:00.000Z"
  );
  // The IN-list is exactly the aggregate keys, so a stored value this derivation
  // did not produce is never a repair target.
  assert.deepEqual(tx.calls[0].params.slice(3), ["key-a", "key-b"]);
});

test("backfillSessionModel is a no-op when the session already names a model", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-known",
    model: "already-set",
    tokensByModel: { "key-a": COUNTS, "key-b": COUNTS },
  });
  await backfillSessionModel(
    tx,
    session,
    [record("2026-01-01T00:00:00.000Z", "key-b")],
    "2026-01-02T01:00:00.000Z"
  );
  assert.equal(tx.calls.length, 0);
});

test("backfillSessionModel is a no-op when there are no model keys", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({ sessionId: "opencode-empty" });
  await backfillSessionModel(tx, session, [], "2026-01-02T01:00:00.000Z");
  assert.equal(tx.calls.length, 0);
});

test("backfillSessionModel is a no-op when every aggregate key is blank", async () => {
  const tx = recordingTx();
  const session = createNormalizedSession({
    sessionId: "opencode-blank-keys",
    tokensByModel: { "": COUNTS, "   ": COUNTS },
  });
  await backfillSessionModel(tx, session, [], "2026-01-02T01:00:00.000Z");
  assert.equal(tx.calls.length, 0);
});
