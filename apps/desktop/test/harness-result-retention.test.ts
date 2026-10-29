/**
 * @file harness-result-retention.test.ts
 * @description ISS-7332 — unit coverage for durable retention of Claude Code's
 * raw `{"type":"result"}` stdout envelope, src/main/cost/harness-result-retention.ts.
 *
 * Reviewed invariants: (1) the envelope is retained VERBATIM, so a narrowing
 * bug in `parseHarnessResult` is recoverable rather than terminal; (2) nothing
 * a retained envelope carries can reach the outcome value that crosses a log or
 * telemetry boundary; (3) the retention window and both caps actually evict,
 * oldest first; (4) out-of-scope harness output (Codex) retains nothing without
 * a per-harness branch; (5) every failure path resolves to a closed-enum status
 * instead of throwing into loop finalization.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "vitest";
import {
  describeHarnessResultRetention,
  findLastResultEnvelopeLine,
  HarnessResultEnvelopeStore,
  type HarnessResultRetentionOutcome,
  HarnessResultRetentionStatus,
  retainHarnessResultEnvelope,
} from "../src/main/cost/harness-result-retention.js";
import { parseHarnessResult } from "../src/main/cost/token-usage.js";
import { HarnessResultEnvelopeDropReason } from "../src/main/telemetry/telemetry-protocol.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

const tempDirs: string[] = [];
/** 2026-08-20T00:00:00Z — a pinned epoch so every window assertion is exact. */
const FIXED_NOW_MS = 1_787_270_400_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  nodeTestTimers.reset();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** A work dir holding `claude-output.jsonl` with the given raw lines. */
function makeCapture(lines: string[]): string {
  const dir = makeTempDir("harness-result-capture-");
  fs.writeFileSync(
    path.join(dir, "claude-output.jsonl"),
    `${lines.join("\n")}\n`,
    "utf-8"
  );
  return dir;
}

function makeStore(options?: {
  retentionDays?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
}): HarnessResultEnvelopeStore {
  return new HarnessResultEnvelopeStore({
    cwd: makeTempDir("harness-result-store-"),
    name: "test-harness-result-envelopes",
    ...options,
  });
}

test("retains the result envelope verbatim, byte for byte", () => {
  // Non-canonical spacing and key order on purpose: a re-serialized record
  // would not survive this, and re-parseability is the point of retaining.
  const rawEnvelope =
    '{ "type":"result",  "total_cost_usd": 0.4212,   "num_turns":7 }';
  const dir = makeCapture([
    JSON.stringify({
      type: "assistant",
      message: { model: "claude-opus-4-6" },
    }),
    rawEnvelope,
  ]);
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-verbatim", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.equal(store.getByLoopId("loop-verbatim")?.rawEnvelope, rawEnvelope);
});

test("the cost survives a narrowing parse that rejects it", () => {
  // The exact failure mode ISS-7332 exists for: a `total_cost_usd` shape the
  // extractor does not accept (here a string, a plausible CLI change) makes the
  // derived accounting UNKNOWN. Before retention that lost the figure forever.
  const dir = makeCapture([
    JSON.stringify({
      type: "result",
      total_cost_usd: "0.4212",
      num_turns: 7,
    }),
  ]);
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-rejected", { store });

  assert.equal(
    parseHarnessResult(dir)?.totalCostUsd,
    null,
    "precondition: the narrowing parse must reject this cost"
  );
  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  const retained = store.getByLoopId("loop-rejected");
  assert.ok(retained);
  const reparsed = JSON.parse(retained.rawEnvelope) as Record<string, unknown>;
  assert.equal(
    reparsed.total_cost_usd,
    "0.4212",
    "the authoritative figure must remain recoverable from the retained line"
  );
});

test("the LAST envelope wins when a reused work dir appends a retry", () => {
  const dir = makeCapture([
    JSON.stringify({ type: "result", total_cost_usd: 0.11 }),
    JSON.stringify({ type: "assistant", message: {} }),
    JSON.stringify({ type: "result", total_cost_usd: 0.99 }),
  ]);
  const store = makeStore();

  retainHarnessResultEnvelope(dir, "loop-retry", { store });

  const retained = store.getByLoopId("loop-retry");
  assert.ok(retained);
  const reparsed = JSON.parse(retained.rawEnvelope) as Record<string, unknown>;
  assert.equal(reparsed.total_cost_usd, 0.99);
});

test("a Codex capture retains nothing, with no per-harness branch", () => {
  // Codex `exec --json` emits item/turn events and never a `result` envelope,
  // so the artifact's own absence is what excludes it — there is no harness
  // check to keep in sync, and no machinery implying a cost exists to retain.
  const dir = makeCapture([
    JSON.stringify({
      type: "item.started",
      item: { id: "i1", type: "command" },
    }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  ]);
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-codex", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.NoEnvelope);
  assert.equal(outcome.envelopeBytes, 0);
  assert.equal(store.list().length, 0);
});

test("a missing capture resolves to a status instead of throwing", () => {
  const dir = makeTempDir("harness-result-empty-");
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-missing", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.CaptureMissing);
  assert.equal(store.list().length, 0);
});

test("an unreadable capture is reported apart from a missing one", () => {
  // The two need different responses: a cleaned-up work dir is benign, while an
  // unreadable present capture breaks retention for every run on the machine.
  const dir = makeCapture([JSON.stringify({ type: "result" })]);
  const capturePath = path.join(dir, "claude-output.jsonl");
  fs.chmodSync(capturePath, 0o000);
  const store = makeStore();

  try {
    const outcome = retainHarnessResultEnvelope(dir, "loop-unreadable", {
      store,
    });
    assert.equal(
      outcome.status,
      HarnessResultRetentionStatus.CaptureUnreadable
    );
    assert.equal(store.list().length, 0);
  } finally {
    fs.chmodSync(capturePath, 0o600);
  }
});

test("a store that rejects the write resolves to retention_failed", () => {
  const dir = makeCapture([JSON.stringify({ type: "result" })]);
  const failing = {
    retain(): number {
      throw new Error("disk full");
    },
  } as unknown as HarnessResultEnvelopeStore;

  const outcome = retainHarnessResultEnvelope(dir, "loop-failed", {
    store: failing,
  });

  assert.equal(outcome.status, HarnessResultRetentionStatus.RetentionFailed);
});

test("malformed lines around the envelope never hide it", () => {
  const rawEnvelope = JSON.stringify({ type: "result", total_cost_usd: 1.5 });
  const content = ["not json at all", "", "null", "[]", rawEnvelope, "{"].join(
    "\n"
  );

  assert.equal(findLastResultEnvelopeLine(content), rawEnvelope);
});

/**
 * Compile-time keys-covered guard. A field added to the outcome without a key
 * here fails `tsc`, so the runtime walk below cannot silently stop covering the
 * whole seam.
 */
const OUTCOME_KEYS = {
  loopId: true,
  status: true,
  envelopeBytes: true,
  retainedEntries: true,
} as const satisfies Record<keyof HarnessResultRetentionOutcome, true>;

const RETENTION_STATUSES: readonly string[] = Object.values(
  HarnessResultRetentionStatus
);

/** Every string reachable from a value, at any depth. */
function collectStrings(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, found);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      collectStrings(item, found);
    }
  }
}

test("no retained content reaches the outcome or the log seam", () => {
  const secret = "SECRET-PROMPT-CONTENT-9f2b";
  const dir = makeCapture([
    JSON.stringify({
      type: "result",
      total_cost_usd: 0.5,
      // The envelope's own `result` field carries the run's final assistant
      // text; this is the content that must never cross a boundary.
      result: `here is the file you asked for: ${secret}`,
    }),
  ]);
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-privacy", { store });
  const rendered = describeHarnessResultRetention(outcome);

  // Positive control: the recorder is live and the fixture really carried the
  // secret, so a clean walk below cannot be clean by virtue of retaining nothing.
  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.ok(
    store.getByLoopId("loop-privacy")?.rawEnvelope.includes(secret),
    "positive control: durable storage must hold the content"
  );

  assert.deepEqual(
    Object.keys(outcome).sort(),
    Object.keys(OUTCOME_KEYS).sort(),
    "the outcome must carry exactly the guarded keys"
  );
  const strings: string[] = [];
  collectStrings(outcome, strings);
  for (const value of strings) {
    assert.ok(
      value === "loop-privacy" || RETENTION_STATUSES.includes(value),
      `outcome carried a string that is neither a supplied id nor a closed-enum member: ${value}`
    );
  }
  assert.ok(
    !rendered.includes(secret),
    "the log rendering must not carry retained content"
  );
});

test("the retention window evicts envelopes past it", () => {
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const cwd = makeTempDir("harness-result-ttl-");
  const store = new HarnessResultEnvelopeStore({
    cwd,
    name: "ttl-store",
    retentionDays: 90,
  });
  const dir = makeCapture([JSON.stringify({ type: "result" })]);

  retainHarnessResultEnvelope(dir, "loop-old", { store });
  assert.equal(
    store.list().length,
    1,
    "precondition: the envelope is retained"
  );

  nodeTestTimers.tick(89 * MS_PER_DAY);
  retainHarnessResultEnvelope(dir, "loop-fresh", { store });
  assert.deepEqual(
    store
      .list()
      .map((held) => held.loopId)
      .sort(),
    ["loop-fresh", "loop-old"],
    "inside the window both survive"
  );

  nodeTestTimers.tick(2 * MS_PER_DAY);
  retainHarnessResultEnvelope(dir, "loop-newest", { store });
  assert.deepEqual(
    store
      .list()
      .map((held) => held.loopId)
      .sort(),
    ["loop-fresh", "loop-newest"],
    "the envelope past 90 days is evicted"
  );
});

test("the entry cap evicts the oldest envelope", () => {
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const store = makeStore({ maxEntries: 2 });
  const dir = makeCapture([JSON.stringify({ type: "result" })]);

  retainHarnessResultEnvelope(dir, "loop-1", { store });
  nodeTestTimers.tick(1000);
  retainHarnessResultEnvelope(dir, "loop-2", { store });
  nodeTestTimers.tick(1000);
  const outcome = retainHarnessResultEnvelope(dir, "loop-3", { store });

  assert.equal(outcome.retainedEntries, 2);
  assert.deepEqual(
    store.list().map((held) => held.loopId),
    ["loop-3", "loop-2"],
    "newest kept, oldest evicted"
  );
});

test("the byte budget evicts oldest first and never the newest envelope", () => {
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const rawEnvelope = JSON.stringify({
    type: "result",
    result: "x".repeat(4000),
  });
  const dir = makeCapture([rawEnvelope]);
  // Room for one envelope only — the newest must still be retained in full.
  const store = makeStore({ maxTotalBytes: rawEnvelope.length + 10 });

  retainHarnessResultEnvelope(dir, "loop-a", { store });
  nodeTestTimers.tick(1000);
  retainHarnessResultEnvelope(dir, "loop-b", { store });

  assert.deepEqual(
    store.list().map((held) => held.loopId),
    ["loop-b"]
  );
  assert.equal(store.getByLoopId("loop-b")?.rawEnvelope, rawEnvelope);
});

test("an envelope larger than the whole byte budget is still retained", () => {
  // The budget must never be the cap that drops the run that just finished:
  // reporting `retained` while the envelope was evicted would silently recreate
  // the unrecoverable gap this store exists to close. Sized so the single
  // envelope blows the budget on its own, which the two-envelope case above
  // cannot reach.
  const rawEnvelope = JSON.stringify({
    type: "result",
    result: "x".repeat(4000),
  });
  const dir = makeCapture([rawEnvelope]);
  const store = makeStore({ maxTotalBytes: 1 });

  const outcome = retainHarnessResultEnvelope(dir, "loop-oversized", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.equal(outcome.retainedEntries, 1);
  assert.equal(store.getByLoopId("loop-oversized")?.rawEnvelope, rawEnvelope);
});

test("a re-run of the same loop replaces its envelope instead of duplicating", () => {
  const store = makeStore();
  const first = makeCapture([
    JSON.stringify({ type: "result", total_cost_usd: 0.1 }),
  ]);
  const second = makeCapture([
    JSON.stringify({ type: "result", total_cost_usd: 0.2 }),
  ]);

  retainHarnessResultEnvelope(first, "loop-same", { store });
  retainHarnessResultEnvelope(second, "loop-same", { store });

  assert.equal(store.list().length, 1);
  const reparsed = JSON.parse(
    store.getByLoopId("loop-same")?.rawEnvelope ?? "{}"
  ) as Record<string, unknown>;
  assert.equal(reparsed.total_cost_usd, 0.2);
});

test("envelopes survive a process restart and corrupt rows are dropped on load", () => {
  const cwd = makeTempDir("harness-result-durable-");
  const dir = makeCapture([
    JSON.stringify({ type: "result", total_cost_usd: 0.77 }),
  ]);
  const first = new HarnessResultEnvelopeStore({ cwd, name: "durable-store" });
  retainHarnessResultEnvelope(dir, "loop-durable", { store: first });

  const storeFile = path.join(cwd, "durable-store.json");
  const persisted = JSON.parse(fs.readFileSync(storeFile, "utf-8")) as {
    envelopes: unknown[];
  };
  persisted.envelopes.push({ loopId: "", retainedAtMs: "nope" });
  fs.writeFileSync(storeFile, JSON.stringify(persisted), "utf-8");

  const reloaded = new HarnessResultEnvelopeStore({
    cwd,
    name: "durable-store",
    reportDropped: () => undefined,
  });

  assert.equal(reloaded.list().length, 1);
  const reparsed = JSON.parse(
    reloaded.getByLoopId("loop-durable")?.rawEnvelope ?? "{}"
  ) as Record<string, unknown>;
  assert.equal(reparsed.total_cost_usd, 0.77);
});

test("a row written by a newer build with an extra field is still recovered", () => {
  // The persisted schema STRIPS unknown keys rather than rejecting them: a
  // downgrade must not turn a forward-compatible row into permanent data loss,
  // which is the exact failure this store exists to prevent.
  const cwd = makeTempDir("harness-result-forward-");
  const storeFile = path.join(cwd, "forward-store.json");
  const rawEnvelope = JSON.stringify({ type: "result", total_cost_usd: 0.33 });
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      envelopes: [
        {
          loopId: "loop-forward",
          retainedAtMs: FIXED_NOW_MS,
          rawEnvelope,
          harnessVersion: "a field this build has never heard of",
        },
      ],
    }),
    "utf-8"
  );

  const drops: { reason: string; count: number }[] = [];
  const store = new HarnessResultEnvelopeStore({
    cwd,
    name: "forward-store",
    now: () => FIXED_NOW_MS,
    reportDropped: (input) => drops.push(input),
  });

  assert.equal(store.getByLoopId("loop-forward")?.rawEnvelope, rawEnvelope);
  assert.deepEqual(drops, [], "a forward-compatible row is not a corrupt row");
});

test("corrupt persisted rows reach the monitored signal before the rewrite", () => {
  // The load succeeds, the rows are skipped, and the file is rewritten WITHOUT
  // them — nothing throws. Without this report the recovery artifact deletes
  // part of itself with no actionable trace anywhere.
  const cwd = makeTempDir("harness-result-corrupt-");
  const storeFile = path.join(cwd, "corrupt-store.json");
  fs.writeFileSync(
    storeFile,
    JSON.stringify({
      envelopes: [
        { loopId: "", retainedAtMs: 1, rawEnvelope: "x" },
        { loopId: "loop-a", retainedAtMs: -1, rawEnvelope: "x" },
        { loopId: "loop-b", retainedAtMs: 1, rawEnvelope: "" },
        { loopId: "loop-ok", retainedAtMs: FIXED_NOW_MS, rawEnvelope: "{}" },
      ],
    }),
    "utf-8"
  );

  const drops: { reason: string; count: number }[] = [];
  const store = new HarnessResultEnvelopeStore({
    cwd,
    name: "corrupt-store",
    now: () => FIXED_NOW_MS,
    reportDropped: (input) => drops.push(input),
  });

  assert.deepEqual(drops, [
    { reason: HarnessResultEnvelopeDropReason.CorruptPersistedRow, count: 3 },
  ]);
  assert.deepEqual(
    store.list().map((held) => held.loopId),
    ["loop-ok"],
    "the valid row is kept; a partially-corrupt store is never persisted whole"
  );
});

test("a clean load reports no drop at all", () => {
  // The counter must sit inside the reject branch: a tally that ran regardless
  // would alert on every healthy boot.
  const cwd = makeTempDir("harness-result-clean-");
  fs.writeFileSync(
    path.join(cwd, "clean-store.json"),
    JSON.stringify({
      envelopes: [
        { loopId: "loop-ok", retainedAtMs: FIXED_NOW_MS, rawEnvelope: "{}" },
      ],
    }),
    "utf-8"
  );

  const drops: unknown[] = [];
  new HarnessResultEnvelopeStore({
    cwd,
    name: "clean-store",
    now: () => FIXED_NOW_MS,
    reportDropped: (input) => drops.push(input),
  });

  assert.deepEqual(drops, []);
});

test("the scan boundary excludes a previous attempt's envelope", () => {
  // A reused work dir: the harness APPENDS, so the last `result` line in the
  // whole file belongs to the previous run when this attempt wrote none.
  // Retaining it would file another loop's cost under this loop — a wrong
  // figure, which is worse than an absent one.
  const dir = makeTempDir("harness-result-offset-");
  const capturePath = path.join(dir, "claude-output.jsonl");
  const previousAttempt = `${JSON.stringify({ type: "result", total_cost_usd: 9.99 })}\n`;
  fs.writeFileSync(capturePath, previousAttempt, "utf-8");
  const fromByteOffset = Buffer.byteLength(previousAttempt, "utf-8");
  fs.appendFileSync(
    capturePath,
    `${JSON.stringify({ type: "turn.completed" })}\n`,
    "utf-8"
  );
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-current", {
    store,
    fromByteOffset,
  });

  assert.equal(outcome.status, HarnessResultRetentionStatus.NoEnvelope);
  assert.equal(store.getByLoopId("loop-current"), null);
});

test("the scan boundary still admits the current attempt's own envelope", () => {
  // Positive control for the test above: the boundary must exclude the previous
  // attempt WITHOUT excluding this one, or "retains nothing" would pass by
  // reading nothing at all.
  const dir = makeTempDir("harness-result-offset-live-");
  const capturePath = path.join(dir, "claude-output.jsonl");
  const previousAttempt = `${JSON.stringify({ type: "result", total_cost_usd: 9.99 })}\n`;
  fs.writeFileSync(capturePath, previousAttempt, "utf-8");
  const fromByteOffset = Buffer.byteLength(previousAttempt, "utf-8");
  const current = JSON.stringify({ type: "result", total_cost_usd: 0.25 });
  fs.appendFileSync(capturePath, `${current}\n`, "utf-8");
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-current", {
    store,
    fromByteOffset,
  });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.equal(store.getByLoopId("loop-current")?.rawEnvelope, current);
});

test("an offset past the end of a truncated capture falls back to the whole file", () => {
  // The recorded boundary no longer describes this file, so honouring it would
  // discard an envelope that IS this attempt's. Scanning the whole file is the
  // honest fallback — the same one an absent offset takes.
  const rawEnvelope = JSON.stringify({ type: "result", total_cost_usd: 0.5 });
  const dir = makeCapture([rawEnvelope]);
  const store = makeStore();

  const outcome = retainHarnessResultEnvelope(dir, "loop-truncated", {
    store,
    fromByteOffset: 10_000_000,
  });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.equal(store.getByLoopId("loop-truncated")?.rawEnvelope, rawEnvelope);
});

test("a same-millisecond arrival at capacity is never the one evicted", () => {
  // `compareEnvelopes` breaks a `retainedAtMs` tie on `loopId`, so at capacity an
  // arrival sorting after a held envelope would be sliced off by the entry cap
  // while the caller was still told `retained`. The class contract is that
  // enforcing a bound can never destroy the run that just finished.
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const store = makeStore({ maxEntries: 1 });
  const dir = makeCapture([JSON.stringify({ type: "result" })]);

  retainHarnessResultEnvelope(dir, "loop-aaa", { store });
  // No tick: the same millisecond, so only the loopId tiebreak orders these.
  const outcome = retainHarnessResultEnvelope(dir, "loop-zzz", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.ok(
    store.getByLoopId("loop-zzz"),
    "a caller told `retained` must be able to read the envelope back"
  );
  assert.equal(outcome.retainedEntries, store.list().length);
});

test("the byte budget also never skips a same-millisecond arrival", () => {
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const rawEnvelope = JSON.stringify({
    type: "result",
    result: "x".repeat(2000),
  });
  const dir = makeCapture([rawEnvelope]);
  // Room for exactly one envelope, so the second is what the budget skips.
  const store = makeStore({ maxTotalBytes: rawEnvelope.length + 10 });

  retainHarnessResultEnvelope(dir, "loop-aaa", { store });
  const outcome = retainHarnessResultEnvelope(dir, "loop-zzz", { store });

  assert.equal(outcome.status, HarnessResultRetentionStatus.Retained);
  assert.equal(store.getByLoopId("loop-zzz")?.rawEnvelope, rawEnvelope);
});

test("an arrival already past the retention window is expired, not restored", () => {
  // The window is expiry, not a cap, so the survival guard must not resurrect
  // it — that would defeat the privacy commitment the window is.
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const store = makeStore({ retentionDays: 90 });

  store.retain({
    loopId: "loop-ancient",
    retainedAtMs: FIXED_NOW_MS - 91 * MS_PER_DAY,
    rawEnvelope: JSON.stringify({ type: "result" }),
  });

  assert.equal(store.getByLoopId("loop-ancient"), null);
  assert.equal(store.list().length, 0);
});

test("pruneExpired drops envelopes past the window with no new retention", () => {
  // The boot-owned sweep's seam. Without it, expiry only ever runs when another
  // loop finishes, so a user who stops running loops keeps plaintext envelopes
  // on disk indefinitely past the window.
  nodeTestTimers.enable(["Date"], { now: FIXED_NOW_MS });
  const store = makeStore({ retentionDays: 90 });
  const dir = makeCapture([JSON.stringify({ type: "result" })]);
  retainHarnessResultEnvelope(dir, "loop-old", { store });
  assert.equal(store.list().length, 1, "precondition: retained");

  nodeTestTimers.tick(91 * MS_PER_DAY);

  assert.equal(store.pruneExpired(), 1);
  assert.equal(store.list().length, 0);
  assert.equal(store.pruneExpired(), 0, "a second sweep has nothing to drop");
});
