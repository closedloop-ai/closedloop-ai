/**
 * @file session-turn-bucket-derive.test.ts
 * @description FEA-3132 — unit coverage for `deriveSessionTurnBuckets`, the PURE,
 * json_each-FREE per-turn bucket derivation that replaced the old
 * `INSERT ... SELECT ... json_each` SQL. json_each was both the corpus-scale perf
 * sink and the @libsql native SIGTRAP trigger (db-host exit code 5) on large
 * sessions, so the derivation now parses metadata in JS. These tests pin the
 * exact inclusion/attribution rules and prove the JS path handles the very shape
 * (a multi-thousand-message session) that crashed json_each. Byte-for-byte
 * equivalence against the live SQLite read is separately asserted in
 * session-turn-bucket-equivalence.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSessionTurnBuckets } from "../src/main/database/write-core.js";

const meta = (o: Record<string, unknown>) => JSON.stringify(o);

test("interactive session: human role -> human, assistant role -> agent", () => {
  const rows = deriveSessionTurnBuckets(
    "s1",
    meta({
      entrypoint: "cli",
      messages: [
        { role: "human", timestamp: "2026-07-01T10:00:00Z" },
        { role: "assistant", timestamp: "2026-07-01T10:01:00Z" },
      ],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "s1",
      ts: "2026-07-01T10:00:00Z",
      turnKind: "human",
      turnCount: 1,
    },
    {
      sessionId: "s1",
      ts: "2026-07-01T10:01:00Z",
      turnKind: "agent",
      turnCount: 1,
    },
  ]);
});

test("headless (sdk%/%exec%, case-insensitive) flips human -> agent", () => {
  for (const entrypoint of [
    "sdk-cli",
    "SDK-TS",
    "codex_exec",
    "some-EXEC-runner",
  ]) {
    const [row] = deriveSessionTurnBuckets(
      "h",
      meta({
        entrypoint,
        messages: [{ role: "human", timestamp: "2026-07-02T09:00:00Z" }],
      })
    );
    assert.equal(
      row?.turnKind,
      "agent",
      `entrypoint ${entrypoint} must be headless`
    );
  }
  // An interactive entrypoint keeps a human turn human.
  const [interactive] = deriveSessionTurnBuckets(
    "i",
    meta({
      entrypoint: "codex-tui",
      messages: [{ role: "human", timestamp: "2026-07-02T09:00:00Z" }],
    })
  );
  assert.equal(interactive?.turnKind, "human");
});

test("duplicate (ts, kind) collapse into turnCount", () => {
  const rows = deriveSessionTurnBuckets(
    "d",
    meta({
      entrypoint: "cli",
      messages: [
        { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
        { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
        { role: "assistant", timestamp: "2026-07-01T10:16:00Z" },
      ],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "d",
      ts: "2026-07-01T10:16:00Z",
      turnKind: "agent",
      turnCount: 3,
    },
  ]);
});

test("excludes non-qualifying elements (role, missing ts, non-object)", () => {
  const rows = deriveSessionTurnBuckets(
    "x",
    meta({
      entrypoint: "cli",
      messages: [
        { role: "tool", timestamp: "2026-07-01T10:00:00Z" }, // wrong role
        { role: "human" }, // no timestamp
        { role: "human", timestamp: null }, // null timestamp
        "a-string-primitive", // non-object
        ["nested", "array"], // array element
        42, // number element
        null, // null element
        { role: "human", timestamp: "2026-07-01T10:05:00Z" }, // the only keeper
      ],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "x",
      ts: "2026-07-01T10:05:00Z",
      turnKind: "human",
      turnCount: 1,
    },
  ]);
});

test("malformed / absent / non-array metadata yields [] (never throws)", () => {
  assert.deepEqual(deriveSessionTurnBuckets("a", null), []);
  assert.deepEqual(deriveSessionTurnBuckets("b", ""), []);
  assert.deepEqual(deriveSessionTurnBuckets("c", "{not valid json"), []);
  assert.deepEqual(deriveSessionTurnBuckets("d", "[]"), []); // top-level not object
  assert.deepEqual(
    deriveSessionTurnBuckets("e", meta({ entrypoint: "cli" })),
    []
  ); // no messages
  assert.deepEqual(
    deriveSessionTurnBuckets(
      "f",
      meta({ entrypoint: "cli", messages: "nope" })
    ),
    []
  ); // messages not array
});

test("numeric timestamp is coerced to string (stored verbatim as TEXT)", () => {
  const [row] = deriveSessionTurnBuckets(
    "n",
    meta({
      entrypoint: "cli",
      messages: [{ role: "human", timestamp: 1_720_000_000 }],
    })
  );
  assert.equal(row?.ts, "1720000000");
});

test("crash repro: a 5,000-message session derives without json_each and stays fast", () => {
  // This is the shape that natively SIGTRAPped @libsql's json_each (db-host exit
  // code 5). The pure JS derivation must handle it correctly and cheaply.
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < 5000; i++) {
    const minute = String(i % 60).padStart(2, "0");
    messages.push({
      role: i % 2 === 0 ? "human" : "assistant",
      timestamp: `2026-07-01T10:${minute}:00Z`,
      // a chunky body per message, mirroring real transcripts
      content: "x".repeat(512),
    });
  }
  const rows = deriveSessionTurnBuckets(
    "big",
    meta({ entrypoint: "cli", messages })
  );

  // 2500 human + 2500 assistant messages, each minute reused ~42x per role ->
  // aggregated into at most 60 minutes * 2 kinds = 120 rows, and every input
  // turn is accounted for by SUM(turnCount).
  const total = rows.reduce((sum, r) => sum + r.turnCount, 0);
  assert.equal(total, 5000);
  assert.ok(
    rows.length <= 120,
    `expected <=120 aggregated rows, got ${rows.length}`
  );
  const humans = rows
    .filter((r) => r.turnKind === "human")
    .reduce((s, r) => s + r.turnCount, 0);
  const agents = rows
    .filter((r) => r.turnKind === "agent")
    .reduce((s, r) => s + r.turnCount, 0);
  assert.equal(humans, 2500);
  assert.equal(agents, 2500);
});
