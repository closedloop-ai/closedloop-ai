import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  oldRule,
  RULING_AGENT_COUNTS,
  rulingFlag,
} from "../scripts/fea3597-identity-probe-lib.js";
import {
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const LIB_MODULE = "./fea3597-identity-probe-lib.js";
const PROBE_ENTRYPOINT = "fea3597-identity-probe.mts";

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
    assert.deepEqual(rulingFlag("b50de790", 82), {
      label: "  ✓ ruling 82",
      mismatch: false,
    });
  });

  test("a disagreeing count renders FAIL and reports the mismatch", () => {
    assert.deepEqual(rulingFlag("3b820c31", 64), {
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
    assert.deepEqual(rulingFlag("b50de790", 82, {}), {
      label: "",
      mismatch: false,
    });
  });

  test("reports the same verdict twice — it holds no state", () => {
    // The probe used to increment a module-scope counter from inside this
    // function. It now returns the mismatch as data, so a second call must not
    // observe the first.
    assert.deepEqual(rulingFlag("019ea892", 24), rulingFlag("019ea892", 24));
  });
});

describe("ISS-5303: fea3597-identity-probe.mts is wired to the lib", () => {
  test("imports exactly the two helpers the lib exports for it", () => {
    // The probe is a top-level-`await` script that `for await`s the entire
    // golden corpus and can `process.exit(1)`; importing or subprocess-driving
    // it from here is not an option. So the structural read is the only thing
    // standing between the lib tests above and a probe that quietly kept its
    // own `oldRule` — a probe whose oracle drifted from the tested one would
    // still print a table and still exit 0.
    const entrypoint = parseDesktopScript(PROBE_ENTRYPOINT);

    assert.deepEqual(namedImportsFrom(entrypoint, LIB_MODULE), [
      "oldRule",
      "rulingFlag",
    ]);
  });

  test("the imported names are the ones the lib actually exports", () => {
    const imported = namedImportsFrom(
      parseDesktopScript(PROBE_ENTRYPOINT),
      LIB_MODULE
    );
    const exported: Record<string, unknown> = { oldRule, rulingFlag };

    for (const name of imported) {
      assert.notEqual(
        exported[name],
        undefined,
        `${PROBE_ENTRYPOINT} imports ${name}, which the lib does not export`
      );
    }
  });

  test("keeps no local copy of either helper", () => {
    const declared = declaredFunctionNames(
      parseDesktopScript(PROBE_ENTRYPOINT)
    );

    assert.deepEqual(
      declared.filter((name) => name === "oldRule" || name === "rulingFlag"),
      []
    );
  });

  test("still calls both, once per dossier", () => {
    // `oldRule` produces the pre-FEA-3597 comparison baseline and `rulingFlag`
    // the per-dossier verdict. Dropping either call turns a HARD STOP into a
    // table that always reads clean.
    const called = calledIdentifiers(parseDesktopScript(PROBE_ENTRYPOINT));

    assert.equal(called.filter((name) => name === "oldRule").length, 1);
    assert.equal(called.filter((name) => name === "rulingFlag").length, 1);
  });
});
