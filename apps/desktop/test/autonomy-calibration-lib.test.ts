import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampPercent, median } from "@repo/api/src/utils/math";
import {
  ANCESTOR_LONG_STRETCH_MS,
  ANCESTOR_PROMPT_BURST_MS,
  ancestorAutonomy,
  groupBursts,
  type SessionInput,
  scoreSession,
  sortedTimes,
  text,
} from "../scripts/autonomy-calibration-lib.js";
import {
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const MINUTE_MS = 60_000;
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** An ISO timestamp `offsetMs` after a fixed epoch — no wall clock anywhere. */
function at(offsetMs: number): string {
  return new Date(BASE_MS + offsetMs).toISOString();
}

function session(overrides: Partial<SessionInput>): SessionInput {
  return {
    id: "session-1",
    harness: "claude",
    headless: false,
    promptTimestamps: [],
    agentActivityTimestamps: [],
    activityTimestamps: [],
    ...overrides,
  };
}

describe("ISS-5303: sortedTimes", () => {
  test("parses to epoch milliseconds and sorts ascending", () => {
    assert.deepEqual(sortedTimes([at(10_000), at(5000), at(20_000)]), [
      BASE_MS + 5000,
      BASE_MS + 10_000,
      BASE_MS + 20_000,
    ]);
  });

  test("drops unparseable timestamps instead of emitting NaN", () => {
    // Every downstream arithmetic path assumes finite input; a NaN leaking
    // through here would poison a whole session's score silently.
    assert.deepEqual(sortedTimes([at(1000), "not-a-timestamp", ""]), [
      BASE_MS + 1000,
    ]);
  });

  test("returns an empty array for no input", () => {
    assert.deepEqual(sortedTimes([]), []);
  });
});

describe("ISS-5303: groupBursts collapses a typing burst into one episode", () => {
  test("no times means no episodes", () => {
    assert.deepEqual(groupBursts([], ANCESTOR_PROMPT_BURST_MS), []);
  });

  test("a lone time is its own zero-width episode", () => {
    assert.deepEqual(groupBursts([5000], 1000), [{ start: 5000, end: 5000 }]);
  });

  test("a gap EXACTLY on the threshold merges — the comparison is <=", () => {
    assert.deepEqual(groupBursts([0, 1000], 1000), [{ start: 0, end: 1000 }]);
  });

  test("a gap one millisecond past the threshold splits", () => {
    assert.deepEqual(groupBursts([0, 1001], 1000), [
      { start: 0, end: 0 },
      { start: 1001, end: 1001 },
    ]);
  });

  test("the window slides off the episode END, not its start", () => {
    // Three times 900ms apart span 1800ms total — more than the 1000ms
    // threshold — yet they are one burst, because each is measured against the
    // previous time rather than against the episode's opening timestamp.
    assert.deepEqual(groupBursts([0, 900, 1800], 1000), [
      { start: 0, end: 1800 },
    ]);
  });
});

describe("ISS-5303: the @repo/api math contract ancestorAutonomy relies on", () => {
  // These were local copies inside autonomy-calibration.ts until ISS-5303
  // pointed the harness at the canonical exports. `median` returning `null`
  // rather than `undefined` on empty input is the one contract difference, and
  // ancestorAutonomy's omitted-median branch is gated on it — so it is pinned
  // here rather than assumed.
  test("median of no values is null, not undefined and not zero", () => {
    assert.equal(median([]), null);
  });

  test("median of an odd-length input is the middle value", () => {
    assert.equal(median([3, 1, 2]), 2);
  });

  test("median of an even-length input averages the middle pair", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
  });

  test("median does not reorder the caller's array", () => {
    const values = [3, 1, 2];

    median(values);

    assert.deepEqual(values, [3, 1, 2]);
  });

  test("clampPercent pins a below-zero percentage to 0", () => {
    assert.equal(clampPercent(-11.11), 0);
  });

  test("clampPercent pins an above-hundred percentage to 100", () => {
    assert.equal(clampPercent(155.55), 100);
  });

  test("clampPercent leaves an in-range percentage untouched", () => {
    assert.equal(clampPercent(42.5), 42.5);
  });
});

describe("ISS-5303: ancestorAutonomy reports no estimate without evidence", () => {
  test("no prompts means null — the ancestor's hasEstimate:false", () => {
    assert.equal(ancestorAutonomy([], [at(0), at(MINUTE_MS)]), null);
  });

  test("no activity means null", () => {
    assert.equal(ancestorAutonomy([at(0)], []), null);
  });

  test("prompts that all fail to parse are the same as no prompts", () => {
    assert.equal(ancestorAutonomy(["not-a-timestamp"], [at(0)]), null);
  });

  test("a zero-span session scores 0 with the median term omitted", () => {
    // One prompt sharing the only activity timestamp: every stretch is 0 and is
    // filtered out, so `median([])` is null and the 0.45 median term never
    // enters `parts`. The score is then the long-stretch share alone (0)
    // renormalised over the 0.35 weight that did apply — not null, and not a
    // NaN from dividing by a zero weight total.
    assert.equal(ancestorAutonomy([at(0)], [at(0)]), 0);
  });
});

describe("ISS-5303: ancestorAutonomy weighs stretch length against steering", () => {
  test("one prompt then an hour of unattended activity saturates at 100", () => {
    // Exercises both clamp directions at once: the median stretch is 60min
    // against a 15min target (400% -> 100) and the steering rate is below the
    // light threshold (-11% -> 0, so the term contributes a full 100).
    assert.equal(ancestorAutonomy([at(0)], [at(0), at(60 * MINUTE_MS)]), 100);
  });

  test("two long stretches with light steering score high", () => {
    assert.equal(
      ancestorAutonomy(
        [at(0), at(10 * MINUTE_MS)],
        [at(0), at(20 * MINUTE_MS)]
      ),
      84
    );
  });

  test("the same episode count over short stretches scores far lower", () => {
    // Identical shape to the case above — two episodes, one trailing stretch —
    // but every stretch is 2min, under ANCESTOR_LONG_STRETCH_MS. The
    // long-stretch share collapses to 0 and the steering rate rises to 15/hour,
    // so stretch LENGTH, not episode count, is what moves the number.
    assert.ok(2 * MINUTE_MS < ANCESTOR_LONG_STRETCH_MS);
    assert.equal(
      ancestorAutonomy([at(0), at(2 * MINUTE_MS)], [at(0), at(4 * MINUTE_MS)]),
      12
    );
  });

  test("ten prompts inside 18 minutes bottom out the steering term", () => {
    // 30 interventions/hour is past ANCESTOR_HEAVY_STEERING_PER_HOUR, so the
    // 0.2 term clamps to 0 from above.
    const prompts = Array.from({ length: 10 }, (_, index) =>
      at(index * 2 * MINUTE_MS)
    );

    assert.equal(ancestorAutonomy(prompts, [at(0), at(18 * MINUTE_MS)]), 6);
  });

  test("prompts inside the burst window are one intervention, not two", () => {
    // The only difference between these two calls is 40ms of prompt spacing
    // straddling ANCESTOR_PROMPT_BURST_MS. Merged, the session is one episode
    // followed by a single 19-minute stretch (100); split, it gains a 100ms
    // stretch that is too short to count as long and a second episode that
    // raises the steering rate.
    const activity = [at(0), at(20 * MINUTE_MS)];
    const merged = ancestorAutonomy(
      [at(0), at(ANCESTOR_PROMPT_BURST_MS - 30_000)],
      activity
    );
    const split = ancestorAutonomy(
      [at(0), at(ANCESTOR_PROMPT_BURST_MS + 10_000)],
      activity
    );

    assert.equal(merged, 100);
    assert.equal(split, 81);
  });
});

describe("ISS-5303: scoreSession over its scoring branches", () => {
  test("an empty shell reports unknown, not zero", () => {
    const scored = scoreSession(session({ id: "empty" }));

    assert.deepEqual(scored, {
      id: "empty",
      harness: "claude",
      headless: false,
      prompts: 0,
      autonomy: null,
      steeringEpisodes: null,
      ancestor: null,
      wallMinutes: 0,
    });
  });

  test("a headless run with no prompts is fully autonomous", () => {
    const scored = scoreSession(
      session({
        id: "headless",
        harness: null,
        headless: true,
        agentActivityTimestamps: [at(0), at(10 * MINUTE_MS)],
        activityTimestamps: [at(0), at(10 * MINUTE_MS)],
      })
    );

    assert.equal(scored.autonomy, 100);
    assert.equal(scored.steeringEpisodes, 0);
    assert.equal(scored.harness, null);
    assert.equal(scored.headless, true);
    assert.equal(scored.wallMinutes, 10);
    // No prompts, so the ancestor column declines to estimate even though the
    // production deriver is confident.
    assert.equal(scored.ancestor, null);
  });

  test("an interactive run with no captured prompts reports unknown", () => {
    const scored = scoreSession(
      session({
        agentActivityTimestamps: [at(0), at(10 * MINUTE_MS)],
        activityTimestamps: [at(0), at(10 * MINUTE_MS)],
      })
    );

    assert.equal(scored.autonomy, null);
    assert.equal(scored.steeringEpisodes, null);
    assert.equal(scored.wallMinutes, 10);
  });

  test("a prompt the agent never answered scores 0, not null", () => {
    const scored = scoreSession(
      session({
        promptTimestamps: [at(0)],
        agentActivityTimestamps: [at(0)],
        activityTimestamps: [at(0)],
      })
    );

    assert.equal(scored.autonomy, 0);
    assert.equal(scored.steeringEpisodes, 0);
    assert.equal(scored.prompts, 1);
    // Two timestamps, zero elapsed: the wall-span branch is taken and still
    // yields 0, which is not the same code path as the empty-shell 0 above.
    assert.equal(scored.wallMinutes, 0);
    assert.equal(scored.ancestor, 0);
  });

  test("one prompt then ten minutes of agent work scores 100", () => {
    const scored = scoreSession(
      session({
        promptTimestamps: [at(0)],
        agentActivityTimestamps: [at(10 * MINUTE_MS)],
        activityTimestamps: [at(0), at(10 * MINUTE_MS)],
      })
    );

    assert.equal(scored.autonomy, 100);
    assert.equal(scored.steeringEpisodes, 0);
    assert.equal(scored.prompts, 1);
    assert.equal(scored.wallMinutes, 10);
    // The reference column deliberately disagrees: it discounts a run for
    // having only one 10-minute stretch against its 15-minute target.
    assert.equal(scored.ancestor, 85);
  });

  test("a steered run splits attended time away from the agent", () => {
    // Agent works 0-1min, human reads 1-3min, agent works 3-4min: half the
    // attributed time is the person, so 50 — a real interior value, not a
    // saturated 0 or 100.
    const scored = scoreSession(
      session({
        promptTimestamps: [at(0), at(3 * MINUTE_MS)],
        agentActivityTimestamps: [at(MINUTE_MS), at(4 * MINUTE_MS)],
        activityTimestamps: [
          at(0),
          at(MINUTE_MS),
          at(3 * MINUTE_MS),
          at(4 * MINUTE_MS),
        ],
      })
    );

    assert.equal(scored.autonomy, 50);
    assert.equal(scored.steeringEpisodes, 1);
    assert.equal(scored.prompts, 2);
    assert.equal(scored.wallMinutes, 4);
    assert.equal(scored.ancestor, 12);
  });

  test("the ancestor column reads activityTimestamps, not the agent stream", () => {
    // The two streams differ on purpose: `activityTimestamps` carries the
    // prompts too. Feeding the agent-only stream to the ancestor would shorten
    // its span and change its answer, so this pins which field it consumes.
    const prompts = [at(0), at(10 * MINUTE_MS)];
    const agentOnly = [at(20 * MINUTE_MS)];
    const scored = scoreSession(
      session({
        promptTimestamps: prompts,
        agentActivityTimestamps: agentOnly,
        activityTimestamps: [...prompts, ...agentOnly],
      })
    );

    assert.equal(
      scored.ancestor,
      ancestorAutonomy(prompts, [...prompts, ...agentOnly])
    );
    assert.notEqual(scored.ancestor, ancestorAutonomy(prompts, agentOnly));
  });

  test("prompts counts raw timestamps while scoring uses only parseable ones", () => {
    const scored = scoreSession(
      session({
        promptTimestamps: ["not-a-timestamp", at(0)],
        agentActivityTimestamps: [at(10 * MINUTE_MS)],
        activityTimestamps: [at(0), at(10 * MINUTE_MS)],
      })
    );

    assert.equal(scored.prompts, 2);
    // Identical to the single-parseable-prompt case above — the junk entry is
    // counted in the corpus tally but never reaches the arithmetic.
    assert.equal(scored.autonomy, 100);
    assert.equal(scored.wallMinutes, 10);
    assert.equal(scored.ancestor, 85);
  });
});

describe("ISS-5303: text normalises a SQLite column value", () => {
  test("trims surrounding whitespace", () => {
    assert.equal(text("  claude  "), "claude");
  });

  test("a whitespace-only value is null, not an empty string", () => {
    assert.equal(text("   "), null);
  });

  test("an empty string is null", () => {
    assert.equal(text(""), null);
  });

  test("a non-string column value is null", () => {
    // libsql hands back numbers, bigints, buffers and null for non-TEXT
    // columns; none of them are usable as an id or a harness name.
    assert.equal(text(42), null);
    assert.equal(text(null), null);
    assert.equal(text(undefined), null);
    assert.equal(text(Buffer.from("claude")), null);
  });
});

describe("ISS-5303: the entrypoint actually uses the extracted lib", () => {
  // autonomy-calibration.ts ends in an unguarded module-level `await main()`,
  // so importing it here would run the harness against a real store. These are
  // therefore structural, via the sanctioned TypeScript-AST mechanism — without
  // them every test above stays green next to a shell that quietly kept its own
  // copies of the helpers.
  const ENTRYPOINT = "autonomy-calibration.ts";
  const LIB = "autonomy-calibration-lib.ts";

  test("imports the scoring surface from the lib", () => {
    const names = namedImportsFrom(
      parseDesktopScript(ENTRYPOINT),
      "./autonomy-calibration-lib.js"
    );

    assert.deepEqual(names, ["SessionInput", "scoreSession", "text"]);
  });

  test("keeps no local copy of any moved helper", () => {
    // A redeclaration would shadow the import, so the lib could be wrong — or
    // deleted outright — while the harness kept printing numbers.
    const declared = declaredFunctionNames(parseDesktopScript(ENTRYPOINT));

    for (const moved of [
      "scoreSession",
      "ancestorAutonomy",
      "sortedTimes",
      "groupBursts",
      "median",
      "clampPercent",
      "text",
    ]) {
      assert.ok(
        !declared.includes(moved),
        `${ENTRYPOINT} redeclares ${moved} instead of importing it`
      );
    }
    // ...while the I/O half that CANNOT be extracted is still there, so this
    // test fails loudly on a bad move rather than on an empty file.
    assert.deepEqual(declared, ["main", "snapshotStore", "loadSessionInputs"]);
  });

  test("calls the imported text() when reading store columns", () => {
    assert.ok(
      calledIdentifiers(parseDesktopScript(ENTRYPOINT)).includes("text"),
      "loadSessionInputs no longer normalises columns through text()"
    );
  });

  test("the lib reuses the canonical math helpers rather than recreating them", () => {
    // ISS-5303's reuse-don't-recreate constraint: `median` and `clampPercent`
    // are canonical @repo/api exports. Re-adding local copies here is the
    // regression this pins — it would also silently restore the old
    // `undefined`-on-empty and NaN-passthrough contracts.
    const source = parseDesktopScript(LIB);

    assert.deepEqual(namedImportsFrom(source, "@repo/api/src/utils/math"), [
      "clampPercent",
      "median",
    ]);
    const declared = declaredFunctionNames(source);
    assert.ok(!declared.includes("median"));
    assert.ok(!declared.includes("clampPercent"));
  });
});
