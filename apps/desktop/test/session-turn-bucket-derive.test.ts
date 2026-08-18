/**
 * @file session-turn-bucket-derive.test.ts
 * @description FEA-3132 / FEA-3597 — unit coverage for `deriveSessionTurnBuckets`,
 * the PURE, json_each-FREE per-turn bucket derivation. json_each was both the
 * corpus-scale perf sink and the @libsql native SIGTRAP trigger (db-host exit
 * code 5) on large sessions, so the derivation parses metadata in JS.
 *
 * FEA-3597 changed the AGENT source. It was `$.messages` rows with
 * `role='assistant'` — one row per JSONL entry, so a single billable round-trip
 * split across text/tool_use/thinking blocks counted several times (~3x inflation
 * against the canonical rollup). It is now `$.tokenSeries` entries: the billable
 * round-trip series. HUMAN rows are unchanged and byte-identical.
 *
 * ISS-5395 corrected the attribution half: FEA-3597 also EXCLUDED every entry
 * carrying a `subagentId`, which lost those turns rather than re-homing them (a
 * folded subagent has no `sessions` row of its own), so a session that delegates
 * its work rendered as idle. Every round-trip now counts.
 *
 * Byte-for-byte equivalence against the live SQLite read is separately asserted
 * in session-turn-bucket-equivalence.test.ts.
 */
// FEA-3597: pinned because the derivation now NORMALIZES the agent `ts` through
// `toCanonicalIso`, and `Date.parse` of a zone-less value is host-local. Without
// a pin these assertions would pass on a UTC CI box and fail on a developer
// machine. Peers pin the same way (local-insights-contract.test.ts,
// attribution-day-bucketing.test.ts, golden-layer3-derive.test.ts).
process.env.TZ = "America/Chicago";

import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSessionTurnBuckets } from "../src/main/database/turn-buckets.js";

const meta = (o: Record<string, unknown>) => JSON.stringify(o);
const ts = (v: string) => ({ timestamp: v, model: "m", input: 1, output: 1 });
/** The canonical instant shape `toCanonicalIso` emits, for the ISS-5395
 * reconciliation test's INDEPENDENT count of placeable round-trips. */
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("interactive session: human from $.messages, agent from $.tokenSeries", () => {
  const rows = deriveSessionTurnBuckets(
    "s1",
    meta({
      entrypoint: "cli",
      messages: [
        { role: "human", timestamp: "2026-07-01T10:00:00Z" },
        // FEA-3597: assistant MESSAGES no longer produce agent rows. This one is
        // the per-block over-count the ticket removes — it must be ignored.
        { role: "assistant", timestamp: "2026-07-01T10:01:00Z" },
        { role: "assistant", timestamp: "2026-07-01T10:01:00Z" },
      ],
      tokenSeries: [ts("2026-07-01T10:01:00.000Z")],
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
      ts: "2026-07-01T10:01:00.000Z",
      turnKind: "agent",
      turnCount: 1,
    },
  ]);
});

test("ISS-5395: subagent-attributed tokenSeries entries ROLL UP to the parent", () => {
  const rows = deriveSessionTurnBuckets(
    "sub",
    meta({
      entrypoint: "cli",
      messages: [],
      tokenSeries: [
        ts("2026-07-01T10:00:00.000Z"),
        { ...ts("2026-07-01T10:01:00.000Z"), subagentId: "agent-abc" },
        {
          ...ts("2026-07-01T10:02:00.000Z"),
          subagentId: "workflows__w__agent-x",
        },
        {
          ...ts("2026-07-01T10:03:00.000Z"),
          subagentId: "unattributed-subagent",
        },
        ts("2026-07-01T10:04:00.000Z"),
      ],
    })
  );
  const agent = rows
    .filter((r) => r.turnKind === "agent")
    .reduce((s, r) => s + r.turnCount, 0);
  // FEA-3597 counted only the two PARENT entries and DROPPED the three
  // subagent ones. A folded subagent has no `sessions` row of its own (all
  // three folding harnesses remove the child from the top-level list, and the
  // local table has no `parent_id`), so those three turns were lost outright
  // rather than re-homed. All five are this session's work.
  assert.equal(agent, 5);
});

test("ISS-5395: a session whose work is ENTIRELY delegated is not lost", () => {
  // The live shape the ticket reported: a produce-loop session that does almost
  // nothing itself and drives everything through sub-agents. Under FEA-3597 it
  // derived ZERO agent turns and rendered as idle on the autonomy trend and the
  // activity heatmap while running four concurrent implementation lanes.
  const delegated = Array.from({ length: 40 }, (_, i) => ({
    ...ts(
      `2026-07-01T1${Math.floor(i / 10)}:${String(i % 10).padStart(2, "0")}:00.000Z`
    ),
    subagentId: `agent-${i % 7}`,
  }));
  const rows = deriveSessionTurnBuckets(
    "delegator",
    meta({ entrypoint: "cli", messages: [], tokenSeries: delegated })
  );
  const agent = rows
    .filter((r) => r.turnKind === "agent")
    .reduce((s, r) => s + r.turnCount, 0);
  assert.equal(agent, 40, "every delegated round-trip lands on the parent");
  assert.ok(
    rows.length > 0,
    "a busy delegating session must never derive an empty bucket set"
  );
});

test("ISS-5395: reconciliation — derived agent turns equal the round-trips present", () => {
  // Counted INDEPENDENTLY from the fixture here (a filter over the seeded
  // series), not compared against a second constant, so a derivation that
  // silently dropped a class of entry would fail rather than agree with itself.
  const series = [
    ts("2026-07-01T10:00:00.000Z"),
    { ...ts("2026-07-01T10:01:00.000Z"), subagentId: "agent-a" },
    { ...ts("2026-07-01T10:01:00.000Z"), subagentId: "agent-b" },
    ts("2026-07-01T10:02:00.000Z"),
    { ...ts("2026-07-01T10:03:00.000Z"), subagentId: "agent-a" },
    // Not a round-trip the store can place: ambiguous instant, excluded from
    // BOTH sides of the reconciliation.
    { ...ts("2026-07-01T10:04:00"), subagentId: "agent-c" },
  ];
  const expected = series.filter((e) =>
    CANONICAL_INSTANT_RE.test(String(e.timestamp))
  ).length;
  const derived = deriveSessionTurnBuckets(
    "recon",
    meta({ entrypoint: "cli", messages: [], tokenSeries: series })
  )
    .filter((r) => r.turnKind === "agent")
    .reduce((s, r) => s + r.turnCount, 0);
  assert.equal(derived, expected);
  assert.equal(expected, 5, "the fixture must actually exercise the drop path");
});

test("ISS-5395: a genuine zero still derives zero", () => {
  // The false-empty fix must not make the empty case unreachable. A session with
  // no round-trips at all has a TRUE zero and must still derive no agent rows.
  for (const tokenSeries of [[], undefined, "not-an-array", 7]) {
    const rows = deriveSessionTurnBuckets(
      "empty",
      meta({
        entrypoint: "cli",
        messages: [],
        ...(tokenSeries === undefined ? {} : { tokenSeries }),
      })
    );
    assert.deepEqual(
      rows.filter((r) => r.turnKind === "agent"),
      [],
      `tokenSeries=${JSON.stringify(tokenSeries)} must derive a true zero`
    );
  }
});

test("ISS-5395: activity on day 1 and day 2 yields buckets on BOTH days", () => {
  // Regression guard on the exact shape observed in the live corpus: 97 turns
  // stamped on the session's FIRST day and nothing afterwards, for a session
  // that kept working. Both days' round-trips are delegated, which is what made
  // day 2 vanish entirely under FEA-3597.
  const rows = deriveSessionTurnBuckets(
    "twoday",
    meta({
      entrypoint: "cli",
      messages: [],
      tokenSeries: [
        { ...ts("2026-08-05T02:36:50.140Z"), subagentId: "agent-a" },
        ts("2026-08-05T03:00:00.000Z"),
        { ...ts("2026-08-06T14:21:40.159Z"), subagentId: "agent-b" },
        { ...ts("2026-08-06T18:00:00.000Z"), subagentId: "agent-c" },
      ],
    })
  );
  const byDay = new Map<string, number>();
  for (const row of rows.filter((r) => r.turnKind === "agent")) {
    byDay.set(
      row.ts.slice(0, 10),
      (byDay.get(row.ts.slice(0, 10)) ?? 0) + row.turnCount
    );
  }
  assert.deepEqual([...byDay.entries()].sort(), [
    ["2026-08-05", 2],
    ["2026-08-06", 2],
  ]);
});

test("headless: suppression still works, and agent rows come from tokenSeries", () => {
  // FEA-3597: the headless classifier's role NARROWED. It used to suppress the
  // human row AND promote that turn to an agent row; the promotion is gone. Both
  // halves are asserted so the FEA-3616 regression coverage is not hollowed out.
  for (const entrypoint of [
    "sdk-cli",
    "SDK-TS",
    "codex_exec",
    "claude-codex-exec",
    "some-EXEC-runner",
  ]) {
    const rows = deriveSessionTurnBuckets(
      "h",
      meta({
        entrypoint,
        messages: [{ role: "human", timestamp: "2026-07-02T09:00:00Z" }],
        tokenSeries: [ts("2026-07-02T09:01:00.000Z")],
      })
    );
    assert.equal(
      rows.filter((r) => r.turnKind === "human").length,
      0,
      `entrypoint ${entrypoint}: headless human turn must NOT produce a human row`
    );
    assert.equal(
      rows.filter((r) => r.turnKind === "agent").length,
      1,
      `entrypoint ${entrypoint}: agent row must come from tokenSeries`
    );
  }
  const bypass = deriveSessionTurnBuckets(
    "b",
    meta({
      entrypoint: "cli",
      permissionMode: "bypassPermissions",
      messages: [{ role: "human", timestamp: "2026-07-02T09:00:00Z" }],
    })
  );
  assert.deepEqual(bypass, [], "bypassPermissions suppresses the human row");
  // FEA-3616 GUARD: `codex_sdk_ts` is the Codex VS Code / Conductor IDE
  // transport — it carries `sdk` but is a HUMAN typing (golden 019effc3 /
  // 019f0041), so it must NOT be demoted.
  for (const entrypoint of ["codex_sdk_ts", "codex-tui", "codex_vscode"]) {
    const [interactive] = deriveSessionTurnBuckets(
      "i",
      meta({
        entrypoint,
        messages: [{ role: "human", timestamp: "2026-07-02T09:00:00Z" }],
      })
    );
    assert.equal(
      interactive?.turnKind,
      "human",
      `entrypoint ${entrypoint} must stay interactive`
    );
  }
});

test("FEA-3597: tokenSeries populated + $.messages ABSENT still yields agent rows", () => {
  // The `messages` guard must gate ONLY the human half. A top-level early return
  // would silently suppress every agent bucket here — and no pre-FEA-3597 test
  // would catch it, because they all seed `messages`.
  for (const messages of [undefined, "nope", 42, null]) {
    const rows = deriveSessionTurnBuckets(
      "m",
      meta({
        entrypoint: "cli",
        ...(messages === undefined ? {} : { messages }),
        tokenSeries: [ts("2026-07-01T10:00:00.000Z")],
      })
    );
    assert.equal(
      rows.filter((r) => r.turnKind === "agent").length,
      1,
      `messages=${JSON.stringify(messages)} must not suppress agent rows`
    );
  }
});

test("FEA-3597: messages present + tokenSeries EMPTY yields 0 agent rows", () => {
  // Ruling §6 case 1. Correct under this rule: no billable round-trip, no agent
  // turn. Human rows are unaffected.
  const rows = deriveSessionTurnBuckets(
    "z",
    meta({
      entrypoint: "cli",
      messages: [
        { role: "human", timestamp: "2026-07-01T10:00:00Z" },
        { role: "assistant", timestamp: "2026-07-01T10:01:00Z" },
      ],
      tokenSeries: [],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "z",
      ts: "2026-07-01T10:00:00Z",
      turnKind: "human",
      turnCount: 1,
    },
  ]);
});

test("FEA-3597: ambiguous timestamps are REJECTED; unambiguous ones are NORMALIZED", () => {
  // Accepted + normalized to the same instant. `+02:00` and the no-millis form
  // would have been silently DROPPED under the rejected canonical-form design.
  for (const raw of [
    "2026-07-01T12:00:00.000Z",
    "2026-07-01T12:00:00Z",
    "2026-07-01T07:00:00-05:00",
    "2026-07-01T14:00:00+02:00",
  ]) {
    const [row] = deriveSessionTurnBuckets(
      "ok",
      meta({ entrypoint: "cli", tokenSeries: [ts(raw)] })
    );
    assert.equal(
      row?.ts,
      "2026-07-01T12:00:00.000Z",
      `${raw} must normalize to the canonical instant`
    );
  }
  // Rejected. The zone-less forms are rejected for AMBIGUITY, not form:
  // `Date.parse` reads them as HOST-LOCAL, which would make the bucket's day and
  // hour machine-dependent and break the golden UTC-vs-Chicago determinism.
  // `01/02/2026` is day/month-order locale-dependent on top.
  for (const raw of [
    "2026-07-01T12:00:00",
    "2026-07-01 12:00:00",
    "01/02/2026",
    "July 1, 2026",
    "2026-13-45T99:99:99.000Z",
    "garbage",
    "",
  ]) {
    const rows = deriveSessionTurnBuckets(
      "bad",
      meta({ entrypoint: "cli", tokenSeries: [ts(raw)] })
    );
    assert.deepEqual(rows, [], `${JSON.stringify(raw)} must be rejected`);
  }
  // A non-string timestamp is rejected on the agent side (the human side keeps
  // its looser string-or-number rule — the asymmetry is deliberate).
  assert.deepEqual(
    deriveSessionTurnBuckets(
      "num",
      meta({ entrypoint: "cli", tokenSeries: [{ ...ts(""), timestamp: 1 }] })
    ),
    []
  );
});

test("FEA-3597: entries normalizing to the same instant collapse, preserving the sum", () => {
  const rows = deriveSessionTurnBuckets(
    "c",
    meta({
      entrypoint: "cli",
      tokenSeries: [
        ts("2026-07-01T12:00:00.000Z"),
        ts("2026-07-01T12:00:00Z"),
        ts("2026-07-01T07:00:00-05:00"),
      ],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "c",
      ts: "2026-07-01T12:00:00.000Z",
      turnKind: "agent",
      turnCount: 3,
    },
  ]);
});

test("cursor shared-timestamp pileup collapses onto one ts", () => {
  // Cursor token records fall back to a shared session timestamp when the event
  // carries none. Pre-existing and out of scope, but pinned: SUM(turnCount) must
  // still equal the number of qualifying entries.
  const rows = deriveSessionTurnBuckets(
    "cur",
    meta({
      entrypoint: "cursor",
      tokenSeries: Array.from({ length: 25 }, () =>
        ts("2026-07-01T12:00:00.000Z")
      ),
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "cur",
      ts: "2026-07-01T12:00:00.000Z",
      turnKind: "agent",
      turnCount: 25,
    },
  ]);
});

test("duplicate (ts, kind) collapse into turnCount", () => {
  const rows = deriveSessionTurnBuckets(
    "d",
    meta({
      entrypoint: "cli",
      tokenSeries: [
        ts("2026-07-01T10:16:00.000Z"),
        ts("2026-07-01T10:16:00.000Z"),
        ts("2026-07-01T10:16:00.000Z"),
      ],
    })
  );
  assert.deepEqual(rows, [
    {
      sessionId: "d",
      ts: "2026-07-01T10:16:00.000Z",
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
        { role: "assistant", timestamp: "2026-07-01T10:00:00Z" }, // no longer an agent source
        { role: "human" }, // no timestamp
        { role: "human", timestamp: null }, // null timestamp
        "a-string-primitive", // non-object
        ["nested", "array"], // array element
        42, // number element
        null, // null element
        { role: "human", timestamp: "2026-07-01T10:05:00Z" }, // the only keeper
      ],
      tokenSeries: [
        "a-string-primitive",
        null,
        42,
        { model: "m" }, // no timestamp
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
  assert.deepEqual(deriveSessionTurnBuckets("e", "{}"), []); // neither source
  assert.deepEqual(
    deriveSessionTurnBuckets("f", meta({ entrypoint: "cli" })),
    []
  ); // no messages, no tokenSeries
  assert.deepEqual(
    deriveSessionTurnBuckets(
      "g",
      meta({ entrypoint: "cli", messages: "nope", tokenSeries: "nope" })
    ),
    []
  ); // neither is an array
});

test("human numeric timestamp is coerced to string (stored verbatim as TEXT)", () => {
  // The HUMAN half keeps its verbatim string-or-number rule — only the agent
  // half normalizes. The asymmetry is deliberate: human output is frozen by the
  // FEA-3597 byte-identity requirement.
  const [row] = deriveSessionTurnBuckets(
    "n",
    meta({
      entrypoint: "cli",
      messages: [{ role: "human", timestamp: 1_720_000_000 }],
    })
  );
  assert.equal(row?.ts, "1720000000");
});

test("crash repro: a 5,000-entry session derives without json_each and stays fast", () => {
  // This is the shape that natively SIGTRAPped @libsql's json_each (db-host exit
  // code 5). The pure JS derivation must handle it correctly and cheaply.
  const messages: Record<string, unknown>[] = [];
  const tokenSeries: Record<string, unknown>[] = [];
  for (let i = 0; i < 2500; i++) {
    const minute = String(i % 60).padStart(2, "0");
    messages.push({
      role: "human",
      timestamp: `2026-07-01T10:${minute}:00Z`,
      content: "x".repeat(512),
    });
    tokenSeries.push(ts(`2026-07-01T10:${minute}:00.000Z`));
  }
  const rows = deriveSessionTurnBuckets(
    "big",
    meta({ entrypoint: "cli", messages, tokenSeries })
  );

  // 2500 human + 2500 agent units, each minute reused ~42x per kind -> at most
  // 60 minutes * 2 kinds = 120 rows, and every input unit is accounted for by
  // SUM(turnCount) — which IS the FEA-3597 primary identity.
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
