import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  countAgentOracleEntries,
  deriveHasTokenEvents,
  oldRule,
  RULING_AGENT_COUNTS,
  rulingFlag,
} from "../scripts/fea3597-identity-probe-lib.js";

// The probe feeds `oldRule` a JSON round-trip of the stored metadata TEXT, so
// every field arrives as `unknown` and malformed shapes are genuinely
// reachable — this is a parse boundary, not a typed in-process call.
function metaWith(
  messages: unknown[],
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return { messages, ...extra };
}

function message(role: unknown, timestamp: unknown): Record<string, unknown> {
  return { role, timestamp };
}

describe("ISS-5303: oldRule counts an interactive session", () => {
  test("splits human and assistant turns", () => {
    assert.deepEqual(
      oldRule(
        metaWith([
          message("human", "2026-01-01T00:00:00Z"),
          message("assistant", "2026-01-01T00:00:01Z"),
          message("assistant", "2026-01-01T00:00:02Z"),
        ])
      ),
      { human: 1, agent: 2 }
    );
  });

  test("accepts a numeric timestamp as well as a string", () => {
    assert.deepEqual(
      oldRule(metaWith([message("human", 0), message("assistant", 1)])),
      { human: 1, agent: 1 }
    );
  });

  test("an unrecognised entrypoint and permission mode stay interactive", () => {
    assert.deepEqual(
      oldRule(
        metaWith([message("human", "t")], {
          entrypoint: "cli",
          permissionMode: "default",
        })
      ),
      { human: 1, agent: 0 }
    );
  });
});

describe("ISS-5303: oldRule reattributes headless sessions to the agent", () => {
  test("an sdk- entrypoint has no human at the keyboard", () => {
    assert.deepEqual(
      oldRule(
        metaWith([message("human", "t"), message("assistant", "t")], {
          entrypoint: "sdk-py",
        })
      ),
      { human: 0, agent: 2 }
    );
  });

  test("an entrypoint merely containing 'exec' counts too", () => {
    assert.deepEqual(
      oldRule(metaWith([message("human", "t")], { entrypoint: "codex-exec" })),
      { human: 0, agent: 1 }
    );
  });

  test("bypassPermissions counts even on an interactive entrypoint", () => {
    assert.deepEqual(
      oldRule(
        metaWith([message("human", "t")], {
          entrypoint: "cli",
          permissionMode: "bypassPermissions",
        })
      ),
      { human: 0, agent: 1 }
    );
  });

  test("the entrypoint match is case-insensitive", () => {
    // The rule lowercases before testing; a stored "SDK-Py" that classified as
    // interactive would silently move turns into the human row.
    assert.deepEqual(
      oldRule(metaWith([message("human", "t")], { entrypoint: "SDK-Py" })),
      { human: 0, agent: 1 }
    );
  });
});

describe("ISS-5303: oldRule tolerates malformed stored metadata", () => {
  test("no messages field at all", () => {
    assert.deepEqual(oldRule({}), { human: 0, agent: 0 });
  });

  test("a non-array messages field", () => {
    assert.deepEqual(oldRule({ messages: "not-an-array" }), {
      human: 0,
      agent: 0,
    });
    assert.deepEqual(oldRule({ messages: null }), { human: 0, agent: 0 });
  });

  test("non-object message entries are skipped, not counted", () => {
    assert.deepEqual(
      oldRule(
        metaWith([
          null,
          "human",
          42,
          ["human", "t"],
          message("human", "2026-01-01T00:00:00Z"),
        ])
      ),
      { human: 1, agent: 0 }
    );
  });

  test("roles outside human/assistant are skipped", () => {
    assert.deepEqual(
      oldRule(
        metaWith([
          message("system", "t"),
          message("tool", "t"),
          message(undefined, "t"),
          message("assistant", "t"),
        ])
      ),
      { human: 0, agent: 1 }
    );
  });

  test("a missing or non-scalar timestamp disqualifies the turn", () => {
    // The identity being probed is over entries WITH a usable timestamp, so an
    // undated turn must not inflate either row.
    assert.deepEqual(
      oldRule(
        metaWith([
          message("human", undefined),
          message("assistant", null),
          message("assistant", { at: "2026-01-01" }),
          message("human", "2026-01-01T00:00:00Z"),
        ])
      ),
      { human: 1, agent: 0 }
    );
  });

  test("a non-string entrypoint or permissionMode is not headless", () => {
    assert.deepEqual(
      oldRule(
        metaWith([message("human", "t")], {
          entrypoint: 7,
          permissionMode: { mode: "bypassPermissions" },
        })
      ),
      { human: 1, agent: 0 }
    );
  });
});

describe("ISS-5303: rulingFlag adjudicates against the operator ruling", () => {
  test("a dossier the ruling never named is unflagged", () => {
    assert.deepEqual(rulingFlag("deadbeef", 99), {
      label: "",
      mismatch: false,
    });
  });

  test("a matching count renders the confirmation suffix", () => {
    assert.deepEqual(rulingFlag("6d6d2e80", 82), {
      label: "  ✓ ruling 82",
      mismatch: false,
    });
  });

  test("a disagreeing count renders FAIL and reports the mismatch", () => {
    assert.deepEqual(rulingFlag("56f2ab4a", 64), {
      label: "  ✗ ruling expected 65 — FAIL",
      mismatch: true,
    });
  });

  test("every dossier the ruling names is adjudicable", () => {
    for (const [shortId, expected] of Object.entries(RULING_AGENT_COUNTS)) {
      assert.equal(rulingFlag(shortId, expected).mismatch, false, shortId);
      assert.equal(rulingFlag(shortId, expected + 1).mismatch, true, shortId);
    }
  });

  test("an inherited Object.prototype key is not an expectation", () => {
    // Short ids are sliced out of data. A bare index read would resolve
    // "toString" to a function and report a mismatch against a ruling that was
    // never made.
    assert.deepEqual(rulingFlag("toString", 82), {
      label: "",
      mismatch: false,
    });
    assert.deepEqual(rulingFlag("constructor", 82), {
      label: "",
      mismatch: false,
    });
  });

  test("the expectation table is injectable", () => {
    assert.deepEqual(rulingFlag("abcd1234", 7, { abcd1234: 7 }), {
      label: "  ✓ ruling 7",
      mismatch: false,
    });
    assert.deepEqual(rulingFlag("abcd1234", 8, { abcd1234: 7 }), {
      label: "  ✗ ruling expected 7 — FAIL",
      mismatch: true,
    });
    assert.deepEqual(rulingFlag("6d6d2e80", 82, {}), {
      label: "",
      mismatch: false,
    });
  });

  test("reports the same verdict twice — it holds no state", () => {
    // The probe used to increment a module-scope counter from inside this
    // function. It now returns the mismatch as data, so a second call must not
    // observe the first.
    assert.deepEqual(rulingFlag("cc6c71e9", 24), rulingFlag("cc6c71e9", 24));
  });
});

describe("ISS-8397: deriveHasTokenEvents mirrors the importer rule", () => {
  test("a session with tokenSeries entries bearing timestamps → true", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: [
          {
            timestamp: "2026-01-01T00:00:00Z",
            model: "opus",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
      }),
      true
    );
  });

  test("a session with multiple tokenSeries entries → true", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: [
          {
            timestamp: "2026-01-01T00:00:00Z",
            model: "opus",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          {
            timestamp: "2026-01-01T00:01:00Z",
            model: "sonnet",
            input: 2,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
      }),
      true
    );
  });

  test("a session with empty tokenSeries and no tokensByModel → false", () => {
    assert.equal(deriveHasTokenEvents({ tokenSeries: [] }), false);
  });

  test("a session with no tokenSeries and no tokensByModel → false", () => {
    assert.equal(deriveHasTokenEvents({}), false);
  });

  test("tokenSeries entries with only falsy timestamps → false", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: [
          {
            timestamp: "",
            model: "opus",
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
          {
            timestamp: null,
            model: "sonnet",
            input: 2,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
          },
        ],
      }),
      false
    );
  });

  test("synthesizes from tokensByModel when tokenSeries is absent", () => {
    // The importer uses startedAt as the timestamp for synthesized records.
    assert.equal(
      deriveHasTokenEvents({
        tokensByModel: {
          opus: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        startedAt: "2026-01-01T00:00:00Z",
      }),
      true
    );
  });

  test("tokensByModel with empty startedAt → true (importer falls back to now)", () => {
    // The importer synthesizes with `session.startedAt ?? now`. An EMPTY
    // string is not nullish, so `??` does not fire — but write-core's
    // skip-on-missing-timestamp rule is `Boolean(r.timestamp)`, and the
    // parser cannot emit `""` here: `startedAt` is `string | null`
    // (agent-db-contract.ts:19), so the reachable absent value is `null`,
    // which DOES take the `now` fallback. Rows are written either way once a
    // model is present, so the predicate does not read `startedAt` at all.
    assert.equal(
      deriveHasTokenEvents({
        tokensByModel: {
          opus: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        startedAt: "",
      }),
      true
    );
  });

  test("tokensByModel with null or missing startedAt → true", () => {
    // Regression for the arm this helper originally picked wrong: a valid
    // parsed session with an empty tokenSeries, a populated tokensByModel and
    // a null startedAt DOES get token_events rows (timestamp = `now`), so the
    // probe must select the round-trip arm, not the legacy one.
    const tokensByModel = {
      opus: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    };
    assert.equal(deriveHasTokenEvents({ tokensByModel }), true);
    assert.equal(
      deriveHasTokenEvents({ tokensByModel, startedAt: null }),
      true
    );
  });

  test("empty tokensByModel → false, whatever startedAt says", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokensByModel: {},
        startedAt: "2026-01-01T00:00:00Z",
      }),
      false
    );
  });

  test("non-object tokenSeries falls back to tokensByModel path", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: "not-an-array",
        tokensByModel: {
          opus: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        startedAt: "2026-01-01T00:00:00Z",
      }),
      true
    );
  });

  test("non-object tokensByModel → false", () => {
    assert.equal(
      deriveHasTokenEvents({ tokensByModel: "not-an-object" }),
      false
    );
    assert.equal(deriveHasTokenEvents({ tokensByModel: null }), false);
    assert.equal(deriveHasTokenEvents({ tokensByModel: [1, 2, 3] }), false);
  });

  test("non-object tokenSeries entries are skipped", () => {
    // Only objects with truthy timestamps count; primitives and arrays skip.
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: [null, "string", 42, ["array"]],
      }),
      false
    );
  });

  test("at least one truthy timestamp in a mixed series → true", () => {
    assert.equal(
      deriveHasTokenEvents({
        tokenSeries: [
          { timestamp: "", model: "opus" },
          { timestamp: "2026-01-01T00:00:00Z", model: "sonnet" },
        ],
      }),
      true
    );
  });
});

describe("ISS-8397: countAgentOracleEntries follows the ISS-5395 contract", () => {
  const parent = (timestamp: unknown): Record<string, unknown> => ({
    timestamp,
    model: "opus",
  });
  const folded = (timestamp: unknown): Record<string, unknown> => ({
    timestamp,
    model: "opus",
    subagentId: "child-1",
  });

  test("counts a folded subagent's round-trip as a qualifying entry", () => {
    // THE regression. `collectAgentUnits` stopped consulting `subagentId`
    // (ISS-5395), because a folded child has no `sessions` row of its own, so
    // excluding its round-trips lost them. An oracle that still subtracts them
    // reports a false identity failure on every dossier that folds a subagent.
    const counts = countAgentOracleEntries({
      tokenSeries: [
        parent("2026-01-01T00:00:00Z"),
        folded("2026-01-01T00:01:00Z"),
        folded("2026-01-01T00:02:00Z"),
      ],
    });

    assert.equal(counts.qualifying, 3);
    assert.equal(counts.parentOnly, 1);
    assert.equal(counts.marked, 2);
  });

  test("parentOnly preserves the retired Option A quantity the ruling names", () => {
    // `parentOnly` is not dead weight: RULING_AGENT_COUNTS was recorded under
    // FEA-3597 Option A, and this is the quantity that ruling was about.
    const counts = countAgentOracleEntries({
      tokenSeries: [
        parent("2026-01-01T00:00:00Z"),
        folded("2026-01-01T00:01:00Z"),
      ],
    });

    assert.equal(counts.parentOnly, 1);
    assert.equal(counts.qualifying, counts.parentOnly + counts.marked);
  });

  test("a session with no folded work reads the same under either rule", () => {
    const counts = countAgentOracleEntries({
      tokenSeries: [
        parent("2026-01-01T00:00:00Z"),
        parent("2026-01-01T00:01:00Z"),
      ],
    });

    assert.equal(counts.qualifying, 2);
    assert.equal(counts.parentOnly, 2);
    assert.equal(counts.marked, 0);
  });

  test("entries without a usable timestamp are skipped on both counters", () => {
    // Skipped BEFORE the attribution split, so `marked` can never exceed
    // `qualifying` and the probe's table stays internally consistent.
    const counts = countAgentOracleEntries({
      tokenSeries: [
        parent("not-a-date"),
        parent(42),
        parent(undefined),
        folded("still-not-a-date"),
        parent("2026-01-01T00:00:00Z"),
      ],
    });

    assert.equal(counts.qualifying, 1);
    assert.equal(counts.parentOnly, 1);
    assert.equal(counts.marked, 0);
  });

  test("non-object entries are skipped", () => {
    // A JSON round-trip of stored metadata TEXT — malformed shapes reachable.
    const counts = countAgentOracleEntries({
      tokenSeries: [
        null,
        "string",
        42,
        ["array"],
        parent("2026-01-01T00:00:00Z"),
      ],
    });

    assert.equal(counts.qualifying, 1);
  });

  test("absent or non-array tokenSeries yields zeros", () => {
    for (const tokenSeries of [undefined, null, "not-an-array", 42, {}]) {
      const counts = countAgentOracleEntries({ tokenSeries });
      assert.deepEqual(counts, { qualifying: 0, parentOnly: 0, marked: 0 });
    }
  });
});
