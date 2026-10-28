import { describe, expect, it } from "vitest";
import {
  AGENT_TURN_TIMESTAMPS_METADATA_KEY,
  collectLegacyAgentTurnUnits,
  deriveAgentTurnTimestamps,
  MAX_METADATA_AGENT_TURN_TIMESTAMPS,
} from "./agent-turn-timestamps";
import {
  HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
} from "./human-turn-timestamps";

const ASSISTANT = (timestamp: unknown) => ({ role: "assistant", timestamp });
const HUMAN = (timestamp: unknown) => ({ role: "human", timestamp });
const ISO = (i: number) =>
  `2026-06-15T${String(i % 24).padStart(2, "0")}:${String(Math.floor(i / 24) % 60).padStart(2, "0")}:00.000Z`;

describe("collectLegacyAgentTurnUnits (ISS-9864 — the cloud fallback's row set)", () => {
  it("keeps assistant rows, verbatim and in traversal order", () => {
    expect(
      collectLegacyAgentTurnUnits(
        [
          ASSISTANT(ISO(1)),
          HUMAN(ISO(2)),
          ASSISTANT(ISO(0)),
          { role: "tool", timestamp: ISO(3) },
          { role: "system", timestamp: ISO(4) },
          { role: "assistant" },
          "not an object",
          [ASSISTANT(ISO(9))],
          null,
        ],
        false
      )
    ).toEqual([ISO(1), ISO(0)]);
  });

  it("promotes a HEADLESS session's human prompts to agent units (FEA-2641)", () => {
    // The disjunct the cloud's `agentLegacyMessageRowsSql` carries: on a
    // headless session the injected `human` prompts are programmatic and land
    // in the Agent half, because `collectHumanTurnUnits` suppresses them on the
    // human side. Drop it and those rows leave the grid entirely.
    // A `tool` or `system` row is promoted by NOTHING: only the human role is.
    const messages = [
      HUMAN(ISO(1)),
      ASSISTANT(ISO(2)),
      { role: "tool", timestamp: ISO(4) },
      { role: "system", timestamp: ISO(5) },
      HUMAN(ISO(3)),
    ];
    expect(collectLegacyAgentTurnUnits(messages, true)).toEqual([
      ISO(1),
      ISO(2),
      ISO(3),
    ]);
    expect(collectLegacyAgentTurnUnits(messages, false)).toEqual([ISO(2)]);
  });

  it("skips a numeric timestamp rather than stringifying it", () => {
    // Matches the cloud's `jsonb_typeof(m -> 'timestamp') = 'string'`. Only
    // the human arm takes numbers (FEA-3597 froze that half byte-identical).
    expect(
      collectLegacyAgentTurnUnits(
        [ASSISTANT(1_750_000_000_000), ASSISTANT(ISO(1))],
        false
      )
    ).toEqual([ISO(1)]);
  });

  it("skips a fork-replayed row, which belongs to the parent session (ISS-8659)", () => {
    expect(
      collectLegacyAgentTurnUnits(
        [
          { ...ASSISTANT(ISO(1)), isForkReplayed: true },
          { ...HUMAN(ISO(2)), isForkReplayed: true },
          ASSISTANT(ISO(3)),
          { ...ASSISTANT(ISO(4)), isForkReplayed: false },
          { ...ASSISTANT(ISO(5)), isForkReplayed: "true" },
        ],
        true
      )
    ).toEqual([ISO(3), ISO(4), ISO(5)]);
  });

  it("yields nothing for a non-array", () => {
    expect(collectLegacyAgentTurnUnits("nope", false)).toEqual([]);
    expect(collectLegacyAgentTurnUnits(undefined, true)).toEqual([]);
    expect(collectLegacyAgentTurnUnits({ role: "assistant" }, false)).toEqual(
      []
    );
  });
});

describe("deriveAgentTurnTimestamps (whole-or-absent)", () => {
  it("carries every agent turn past the 100-message compaction cap", () => {
    // THE BUG: `messages` reaches the cloud capped at 100, so the cloud's
    // legacy arm could never see turn 101. The key is derived from the full
    // local array and must carry all of them.
    const messages = Array.from({ length: 250 }, (_, i) => ASSISTANT(ISO(i)));
    const derived = deriveAgentTurnTimestamps({ messages });
    expect(derived).toHaveLength(250);
    expect(derived?.[0]).toBe(ISO(0));
    expect(derived?.at(-1)).toBe(ISO(249));
  });

  it("derives exactly the units the collector yields, unit for unit", () => {
    // The identity the desktop bucket derivation and the cloud key rest on:
    // one predicate, one list. A filter added to either side alone forks them.
    const messages = [
      ...Array.from({ length: 40 }, (_, i) => ASSISTANT(ISO(i))),
      ...Array.from({ length: 7 }, (_, i) => HUMAN(ISO(100 + i))),
      { ...ASSISTANT(ISO(200)), isForkReplayed: true },
      { role: "tool", timestamp: ISO(201) },
    ];
    for (const meta of [{ messages }, { entrypoint: "codex exec", messages }]) {
      const headless = "entrypoint" in meta;
      expect(deriveAgentTurnTimestamps(meta)).toEqual(
        collectLegacyAgentTurnUnits(messages, headless)
      );
    }
  });

  it("returns null when ONE unit is outside the grammar", () => {
    // A partial array would be read as authoritative and report fewer turns
    // than the `$.messages` fallback it displaces.
    expect(
      deriveAgentTurnTimestamps({
        messages: [ASSISTANT(ISO(1)), ASSISTANT("20260615"), ASSISTANT(ISO(2))],
      })
    ).toBeNull();
    expect(
      deriveAgentTurnTimestamps({
        messages: [ASSISTANT("July 1, 2026")],
      })
    ).toBeNull();
  });

  it("returns null past the entry cap rather than a truncated head", () => {
    const messages = Array.from(
      { length: MAX_METADATA_AGENT_TURN_TIMESTAMPS + 1 },
      (_, i) => ASSISTANT(ISO(i))
    );
    expect(deriveAgentTurnTimestamps({ messages })).toBeNull();
    expect(
      deriveAgentTurnTimestamps({
        messages: messages.slice(0, MAX_METADATA_AGENT_TURN_TIMESTAMPS),
      })
    ).toHaveLength(MAX_METADATA_AGENT_TURN_TIMESTAMPS);
  });

  it("shares the human key's bound rather than copying its literal", () => {
    expect(MAX_METADATA_AGENT_TURN_TIMESTAMPS).toBe(
      MAX_METADATA_HUMAN_TURN_TIMESTAMPS
    );
    expect(AGENT_TURN_TIMESTAMPS_METADATA_KEY).not.toBe(
      HUMAN_TURN_TIMESTAMPS_METADATA_KEY
    );
  });

  it("returns an EMPTY array for an interactive all-human session, not null", () => {
    // `[]` and `null` diverge downstream: the cloud takes a present array as
    // authoritative (zero agent turns, matching the desktop's zero agent rows)
    // and falls back on an absent one.
    expect(
      deriveAgentTurnTimestamps({
        entrypoint: "cli",
        messages: [HUMAN(ISO(1)), HUMAN(ISO(2))],
      })
    ).toEqual([]);
  });

  it("includes a headless session's injected prompts", () => {
    for (const headless of [
      { entrypoint: "sdk-python" },
      { entrypoint: "codex exec" },
      { permissionMode: "bypassPermissions" },
    ]) {
      expect(
        deriveAgentTurnTimestamps({
          ...headless,
          messages: [HUMAN(ISO(1)), ASSISTANT(ISO(2))],
        }),
        JSON.stringify(headless)
      ).toEqual([ISO(1), ISO(2)]);
    }
  });

  it("returns null for a non-object and [] for a session with no messages", () => {
    expect(deriveAgentTurnTimestamps(null)).toBeNull();
    expect(deriveAgentTurnTimestamps("nope")).toBeNull();
    expect(deriveAgentTurnTimestamps({})).toEqual([]);
    expect(deriveAgentTurnTimestamps({ messages: "malformed" })).toEqual([]);
  });

  it("ships an offset-bearing turn in UTC, so both readers bucket the same day", () => {
    // Today's raw read discards the offset (Postgres `::timestamp`), bucketing
    // the 15th; the key arm gets the true instant on the 16th.
    expect(
      deriveAgentTurnTimestamps({
        messages: [ASSISTANT("2026-06-15T23:30:00-05:00")],
      })
    ).toEqual(["2026-06-16T04:30:00.000Z"]);
  });

  it("returns null for an offset no zone has (D7)", () => {
    expect(
      deriveAgentTurnTimestamps({
        messages: [ASSISTANT(ISO(1)), ASSISTANT("2026-06-15T23:30:00+99:99")],
      })
    ).toBeNull();
  });

  it("skips a numeric timestamp rather than refusing the whole key", () => {
    // The collector never yields a number (the cloud fallback never counts
    // one either), so it is not an uncarriable unit — it is not a unit at all.
    expect(
      deriveAgentTurnTimestamps({
        messages: [ASSISTANT(1_750_000_000_000), ASSISTANT(ISO(1))],
      })
    ).toEqual([ISO(1)]);
  });
});
