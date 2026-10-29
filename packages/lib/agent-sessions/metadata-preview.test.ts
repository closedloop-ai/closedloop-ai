import { describe, expect, it } from "vitest";
import { redactSecrets } from "../security/redact-secrets";
import {
  AGENT_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_AGENT_TURN_TIMESTAMPS,
} from "./agent-turn-timestamps";
import {
  HUMAN_TURN_TIMESTAMPS_METADATA_KEY,
  MAX_METADATA_HUMAN_TURN_TIMESTAMPS,
} from "./human-turn-timestamps";
import {
  compactAgentMetadataForPreview,
  compactMetadataForPreview,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_KEYS,
  MAX_METADATA_MESSAGE_TEXT_CHARS,
  MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS,
  MetadataContentPolicy,
  MIN_METADATA_MESSAGE_TEXT_CHARS,
} from "./metadata-preview";

type Msg = Record<string, unknown>;

function messagesOf(result: unknown): Msg[] {
  return (result as { messages: Msg[] }).messages;
}

describe("compactMetadataForPreview (FEA-3693 shared preview contract)", () => {
  it("drops message bodies while keeping allowlisted fields + text truncation marker", () => {
    const result = compactMetadataForPreview({
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          model: "claude-opus-4-8",
          text: "hi",
          isThinking: false,
          isSynthetic: true,
          // ISS-8659: this rebuild is an ALLOW-LIST, so a key missing from it is
          // unreachable in the cloud rather than merely absent from the preview.
          // The flag shipped omitted, which made the cloud heatmap's fork gate
          // inert; this case is exhaustive (`toEqual`), so it is the assertion
          // that would have caught it had the input ever carried the key.
          isForkReplayed: true,
          content: [{ type: "text", text: "SECRET raw prompt / source code" }],
          apiKey: "sk_live_should_not_persist",
        },
      ],
    });

    expect(result).toEqual({
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          model: "claude-opus-4-8",
          text: "hi",
          textTruncation: "complete",
          isThinking: false,
          isSynthetic: true,
          isForkReplayed: true,
        },
      ],
    });
  });

  it("marks a short, fully-retained turn as `complete`", () => {
    const out = messagesOf(
      compactMetadataForPreview({ messages: [{ role: "user", text: "short" }] })
    );
    expect(out[0].text).toBe("short");
    expect(out[0].textTruncation).toBe("complete");
  });

  it("marks an over-cap turn as `previewed` and truncates at the per-message cap", () => {
    const out = messagesOf(
      compactMetadataForPreview({
        messages: [{ role: "user", text: "z".repeat(4096) }],
      })
    );
    expect((out[0].text as string).length).toBe(
      MAX_METADATA_MESSAGE_TEXT_CHARS
    );
    expect(out[0].textTruncation).toBe("previewed");
  });

  it("OMITS absent text entirely (no `text`, no `textTruncation`, never null)", () => {
    const out = messagesOf(
      compactMetadataForPreview({
        messages: [
          { role: "assistant", timestamp: "2026-07-16T00:00:00.000Z" },
        ],
      })
    );
    expect("text" in out[0]).toBe(false);
    expect("textTruncation" in out[0]).toBe(false);
    expect(JSON.stringify(out[0])).not.toContain("null");
  });

  it("enforces the per-message FLOOR after the aggregate budget is spent (never drops later text)", () => {
    // 100 messages of 2500 chars each. The aggregate budget (60_000) is spent by
    // message ~24; every later message must still keep a floor-length preview —
    // this is the exact FEA-3693 divergence the old API sanitizer had (it emitted
    // `undefined` text for the tail while desktop kept the floor).
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      timestamp: "2026-07-16T00:00:00.000Z",
      text: "q".repeat(3000), // over the 2500 per-message cap
    }));
    const out = messagesOf(compactMetadataForPreview({ messages }));
    expect(out.length).toBe(100);

    // Early messages keep the full per-message preview (truncated from source)...
    expect(out[0].text).toBe("q".repeat(MAX_METADATA_MESSAGE_TEXT_CHARS));
    expect(out[0].textTruncation).toBe("previewed");

    // ...and EVERY later, budget-exhausted message still keeps at least the floor
    // (never omits `text`), truthfully marked `previewed`.
    for (const msg of out) {
      expect(typeof msg.text).toBe("string");
      expect((msg.text as string).length).toBeGreaterThanOrEqual(
        MIN_METADATA_MESSAGE_TEXT_CHARS
      );
    }
    const last = out[99];
    expect(last.text).toBe("q".repeat(MIN_METADATA_MESSAGE_TEXT_CHARS));
    expect(last.textTruncation).toBe("previewed");
    expect(last.role).toBe("user");
    expect(last.timestamp).toBe("2026-07-16T00:00:00.000Z");
  });

  it("keeps the summed preview text near the aggregate budget plus the guaranteed floors", () => {
    const messages = Array.from({ length: 100 }, () => ({
      role: "user",
      text: "q".repeat(2500),
    }));
    const out = messagesOf(compactMetadataForPreview({ messages }));
    const total = out.reduce(
      (sum, m) => sum + (typeof m.text === "string" ? m.text.length : 0),
      0
    );
    // Aggregate budget + at most one floor per message is the hard ceiling.
    expect(total).toBeLessThanOrEqual(
      MAX_METADATA_TOTAL_MESSAGE_TEXT_CHARS +
        100 * MIN_METADATA_MESSAGE_TEXT_CHARS
    );
  });

  it("redacts secrets before truncation (no partial-key leak at the boundary)", () => {
    const A32 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
    const filler = "x".repeat(2490);
    const result = compactMetadataForPreview({
      messages: [{ role: "user", text: `${filler} sk_live_${A32}` }],
    });
    const mirror = JSON.stringify(result);
    expect(mirror.includes("sk_live_")).toBe(false);
    expect(mirror.includes("A1b2C3d4")).toBe(false);
  });

  it("returns null for non-objects and objects that compact to nothing", () => {
    expect(compactMetadataForPreview(null)).toBeNull();
    expect(compactMetadataForPreview("str")).toBeNull();
    expect(compactMetadataForPreview([1, 2, 3])).toBeNull();
    expect(compactMetadataForPreview({})).toBeNull();
    expect(compactMetadataForPreview({ tokenSeries: [1] })).toBeNull();
  });

  it("is idempotent for already-compacted metadata (incl. re-derived markers)", () => {
    const input = {
      gitBranch: "main",
      messages: [
        {
          role: "user",
          timestamp: "2026-07-16T00:00:00.000Z",
          text: "hi there",
        },
      ],
    };
    const once = compactMetadataForPreview(input);
    const twice = compactMetadataForPreview(once);
    expect(twice).toEqual(once);
  });

  it("keeps a previewed marker when compacting an already-truncated payload", () => {
    const input = {
      messages: [
        {
          role: "user",
          text: "short preview",
          textTruncation: "previewed",
        },
      ],
    };
    const out = messagesOf(compactMetadataForPreview(input));
    expect(out[0].textTruncation).toBe("previewed");
  });

  it("collapses objects beyond MAX_METADATA_DEPTH to null instead of recursing", () => {
    // Objects at depth > MAX_METADATA_DEPTH (4) collapse to null inside their parent.
    const deep: Record<string, unknown> = { f: "value" };
    // Nest MAX_METADATA_DEPTH + 1 levels: a→b→c→d→e→deep
    const input = { a: { b: { c: { d: { e: deep } } } } };
    const result = compactMetadataForPreview(input);
    expect(result).not.toBeNull();
    // "e" is at depth 5 (> MAX_METADATA_DEPTH=4) → collapsed to null
    expect((result as Record<string, unknown>)?.a).toBeDefined();
    const d = ((result as Record<string, unknown>).a as Record<string, unknown>)
      .b as { c: { d: { e: null } } };
    expect(d.c.d.e).toBeNull();
  });

  it("collapses arrays beyond MAX_METADATA_DEPTH to an empty array", () => {
    // Arrays at depth > MAX_METADATA_DEPTH (4) become [].
    const input = { a: { b: { c: { d: { e: [1, 2, 3] } } } } };
    const result = compactMetadataForPreview(input) as {
      a: { b: { c: { d: { e: unknown[] } } } };
    };
    expect(result?.a?.b?.c?.d?.e).toEqual([]);
  });

  it("preserves null, boolean, and number values in compacted objects", () => {
    const result = compactMetadataForPreview({
      active: true,
      count: 42,
      ratio: 0.5,
      empty: null,
    });
    expect(result).toEqual({
      active: true,
      count: 42,
      ratio: 0.5,
      empty: null,
    });
  });

  it("handles a non-array messages field by compacting it as a plain value", () => {
    // messages field that is not an array → compactMetadataMessages receives a
    // non-array and delegates to compactMetadataValue.
    const result = compactMetadataForPreview({ messages: "plain text" });
    expect(result).toEqual({ messages: "plain text" });
  });

  it("converts messages field to null when compactMetadataValue returns undefined", () => {
    // A messages field whose value cannot be represented (e.g. undefined) causes
    // compactMetadataValue to return undefined, which the ?? null coercion catches.
    const input: Record<string, unknown> = { messages: undefined };
    const result = compactMetadataForPreview(input);
    expect(result).toEqual({ messages: null });
  });

  it("replaces non-record items in the messages array with null", () => {
    // isRecord fails for primitives → each becomes null in the output array.
    const result = compactMetadataForPreview({
      messages: [42, "string", null, true],
    });
    expect(result).toEqual({ messages: [null, null, null, null] });
  });

  it("carries the ISS-7259 launch-attribution facet through untouched", () => {
    // This is the THIRD hop the facet makes on its way to a cloud-rendered row
    // (parser -> worker boundary -> metadata blob -> HERE -> cloud). It survives
    // today only because it is a shallow object of short scalars, well inside
    // MAX_METADATA_DEPTH and MAX_METADATA_KEYS — none of which is guaranteed by
    // anything the facet controls. Without this case, adding the key to
    // OMITTED_METADATA_KEYS, or reordering the key slice so it falls past the
    // cap, would silently strip launch attribution from every synced session and
    // no test would say so.
    const facet = {
      threadSource: "subagent",
      firstAttributedSkill: "cl-produce",
      observedSkillCount: 3,
      promptSource: "typed",
      agentRole: "review-soul",
      agentNickname: "Leibniz",
      parentThreadId: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
      depth: 2,
    };

    const result = compactMetadataForPreview({
      entrypoint: "claude",
      harnessLaunchAttribution: facet,
    });

    expect(result).toEqual({
      entrypoint: "claude",
      harnessLaunchAttribution: facet,
    });
  });
});

// ISS-7775 + ISS-8014 — the two rules that make the retained set CLOSED, and
// the redaction that reaches every string in it, asserted on the shared contract
// itself rather than only through one of its two callers.
//
// The synthetic tokens below are secret-SHAPED, never real, and every assertion
// compares booleans rather than substrings so a failure prints a policy question
// instead of rendering a token into stdout and the reporter output.
const SECRET_SHAPED = "sk-ant-api03-libunitAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
const BENIGN_SHAPED = "release-sk-branch-AAAABBBBCCCCDDDDEEEEFFFFGGGG";

describe("MetadataContentPolicy.Omit (ISS-7775)", () => {
  it("drops a string under a key nobody declared structural", () => {
    // The decisive property: this key exists nowhere in the repo, so a policy
    // that passed only because someone enumerated it cannot pass here.
    const result = compactMetadataForPreview(
      { aKeyNoPolicyMentions: "some prose", userMessages: 7 },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({ userMessages: 7 });
  });

  it("keeps every non-string value, so session shape needs no enumeration", () => {
    // Numbers, booleans and nulls cannot carry a prompt, a completion, or file
    // contents, so they are retained unconditionally — including under keys the
    // allow-list has never heard of. This is what stops the narrowing from being
    // "emit nothing", and it is the reason the string allow-list can stay short.
    const result = compactMetadataForPreview(
      {
        someFutureCounter: 42,
        someFutureFlag: false,
        someFutureAbsence: null,
        diffStats: { filesChanged: 3, linesAdded: 10, linesRemoved: 1 },
      },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({
      someFutureCounter: 42,
      someFutureFlag: false,
      someFutureAbsence: null,
      diffStats: { filesChanged: 3, linesAdded: 10, linesRemoved: 1 },
    });
  });

  it("denies a nested prose field without denying its structural siblings", () => {
    // Matching is on the complete PATH, so `plans.content` is denied while its
    // declared siblings `plans.source` / `plans.timestamp` resolve.
    const result = compactMetadataForPreview(
      {
        plans: [
          { source: "ExitPlanMode", content: "the plan prose", timestamp: "t" },
        ],
      },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({
      plans: [{ source: "ExitPlanMode", timestamp: "t" }],
    });
  });

  it("denies an allow-listed WORD reused by an undeclared shape (review: whitlockk)", () => {
    // `slashCommands.name` is structural, so under a LEAF-KEY allow-list the word
    // `name` was permitted wherever it appeared — and `teams` is `unknown[]` with
    // no declared element shape, so a parser-supplied `teams: [{ name }]` carried
    // prose straight past the Metadata tier while the docstring claimed `teams`
    // strings were denied. Path matching is what makes that claim true.
    //
    // COUNTERFACTUAL: revert `retainedString` to matching the bare leaf key and
    // this reddens (the prose survives) while every other case in this file stays
    // green — which is precisely how the hole shipped.
    const result = compactMetadataForPreview(
      { teams: [{ name: "a delegation prompt written as prose", size: 3 }] },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({ teams: [{ size: 3 }] });
  });

  it("denies a structural word nested under an unknown parent (review: security-privacy critic)", () => {
    // The same hole reached through `agents[].metadata`, which is compacted as
    // its OWN root and whose key set is open because `buildSubagentMetadata`
    // spreads the parser's blob into it. `future.name` is not a declared path.
    const result = compactMetadataForPreview(
      { future: { name: "prompt prose", source: "prompt prose", count: 1 } },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({ future: { count: 1 } });
  });

  it("still resolves the declared paths those two words belong to", () => {
    // POSITIVE CONTROL for the two denials above: without it, both are equally
    // satisfied by an allow-list that stopped matching anything at all.
    const result = compactMetadataForPreview(
      {
        slashCommands: [{ name: "/probe", normalizedName: "probe" }],
        plans: [{ source: "ExitPlanMode" }],
      },
      MetadataContentPolicy.Omit
    );
    expect(result).toEqual({
      slashCommands: [{ name: "/probe", normalizedName: "probe" }],
      plans: [{ source: "ExitPlanMode" }],
    });
  });

  it("keeps a turn's shape while dropping its text and its truncation marker", () => {
    // The turn must still reach the timeline — `agent-session-detail-projection`
    // keeps any message carrying role + timestamp — carrying no content. No
    // `textTruncation` either: this module's existing rule is that a message
    // without stored text is fully omitted rather than marked.
    const [message] = messagesOf(
      compactMetadataForPreview(
        { messages: [{ role: "user", timestamp: "t0", text: "a prompt" }] },
        MetadataContentPolicy.Omit
      )
    );
    expect(message).toEqual({ role: "user", timestamp: "t0" });
  });

  it("retains that same text under the default policy, so the drops above are a policy", () => {
    // POSITIVE CONTROL. Without it every expectation above is equally satisfied
    // by a compactor that returns nothing at all.
    const [message] = messagesOf(
      compactMetadataForPreview({
        messages: [{ role: "user", timestamp: "t0", text: "a prompt" }],
      })
    );
    expect(message.text).toBe("a prompt");
  });
});

describe("secret redaction reaches every retained string (ISS-8014)", () => {
  it("redacts a secret under a key nobody declared structural", () => {
    // Before this, `redactSecrets` was reachable ONLY from the `messages`
    // special case. The retained key set is OPEN under the default policy, so a
    // per-channel test cannot establish coverage — this plants where nothing
    // enumerates.
    const wire = JSON.stringify(
      compactMetadataForPreview({ aKeyNoPolicyMentions: SECRET_SHAPED })
    );
    expect(
      wire.includes(SECRET_SHAPED),
      "a secret-shaped token under an unenumerated key survived — redaction is per-channel again"
    ).toBe(false);
    expect(
      wire.includes("[REDACTED:sk-ant]"),
      "no marker either, so the token may be absent because the key was dropped rather than because it was redacted"
    ).toBe(true);
  });

  it("leaves a benign secret-shaped string byte-identical, and emits no marker", () => {
    // POSITIVE CONTROL for the redactor plus the repo's "a marker only where
    // non-empty sensitive content actually matched" rule, in one assertion pair.
    const result = compactMetadataForPreview({ gitBranch: BENIGN_SHAPED });
    expect(result).toEqual({ gitBranch: BENIGN_SHAPED });
    expect(JSON.stringify(result).includes("[REDACTED")).toBe(false);
  });
});

describe("humanTurnTimestamps (ISS-7896 whole-or-absent bounded pass-through)", () => {
  const TS = (i: number) =>
    `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
  const key = HUMAN_TURN_TIMESTAMPS_METADATA_KEY;
  const read = (result: unknown) =>
    (result as Record<string, unknown> | null)?.[key];

  it("carries more entries than the generic array cap would allow", () => {
    // THE BUG. Without explicit handling this key falls to
    // MAX_METADATA_ARRAY_ITEMS (100) — the same 100 that caps `messages` — and
    // the undercount simply moves to a new field.
    const stamps = Array.from({ length: 400 }, (_, i) => TS(i));
    expect(read(compactMetadataForPreview({ [key]: stamps }))).toHaveLength(
      400
    );
  });

  it("drops the WHOLE key past the entry cap instead of truncating", () => {
    const stamps = Array.from(
      { length: MAX_METADATA_HUMAN_TURN_TIMESTAMPS + 1 },
      (_, i) => TS(i)
    );
    // A truncated array would still be read as authoritative and would
    // under-report a session the `$.messages` fallback counts in full.
    expect(read(compactMetadataForPreview({ [key]: stamps }))).toBeUndefined();
  });

  it("drops the WHOLE key when any single entry is not a timestamp", () => {
    for (const bad of [
      "20260615",
      "2026-06-15T10:00:00.000Z or so",
      "not-a-date",
      "",
      42,
      null,
      { at: "2026-06-15T10:00:00.000Z" },
    ]) {
      const result = compactMetadataForPreview({
        [key]: [TS(0), bad, TS(2)],
      });
      expect(read(result), `entry ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("accepts the timestamp forms Postgres accepts that the desktop can emit", () => {
    const accepted = [
      "2026-06-15",
      "2026-06-15T10:00:00Z",
      "2026-06-15 10:00:00",
      "2026-06-15T10:00:00.123456+00",
      "2026-06-15T10:00:00.123456789012Z",
      "2026-06-15T10:00:00-05:00",
      "2026-06-15T10:00:00+0530",
    ];
    expect(read(compactMetadataForPreview({ [key]: accepted }))).toEqual(
      accepted
    );
  });

  it("keeps a NON-array value on the ordinary string path, denied under Omit", () => {
    // The privacy counterfactual. Admitting this key to
    // STRUCTURAL_METADATA_STRING_PATHS would have matched on path alone and let
    // a scalar of prose egress from a Metadata-tier machine.
    const prose = "the user asked me to delete the production database";
    expect(read(compactMetadataForPreview({ [key]: prose }))).toBe(prose);
    expect(
      read(
        compactMetadataForPreview({ [key]: prose }, MetadataContentPolicy.Omit)
      )
    ).toBeUndefined();
  });

  it("does not let an agents[].metadata blob borrow the key's bound", () => {
    // `agents[].metadata` is compacted as its own root, so the key resolves to
    // `agents.metadata.humanTurnTimestamps` and must fall to the generic
    // 100-item array cap rather than this key's 1000.
    const stamps = Array.from({ length: 400 }, (_, i) => TS(i));
    const result = compactAgentMetadataForPreview({ [key]: stamps });
    expect(read(result)).toHaveLength(MAX_METADATA_ARRAY_ITEMS);
  });

  it("falls off the first-80-key window rather than displacing a real key", () => {
    const filler = Object.fromEntries(
      Array.from({ length: MAX_METADATA_KEYS }, (_, i) => [`k${i}`, i])
    );
    const result = compactMetadataForPreview({ ...filler, [key]: [TS(0)] });
    // Safe degradation: the cloud sees no key and reads `$.messages`, which is
    // exactly its pre-ISS-7896 behavior. Every real key survives.
    expect(read(result)).toBeUndefined();
    expect(Object.keys(result as object)).toHaveLength(MAX_METADATA_KEYS);
    expect((result as Record<string, unknown>).k79).toBe(79);
  });

  it("is deterministic and adds no key to a blob that does not carry one", () => {
    const input = { gitBranch: "main", messages: [{ role: "human" }] };
    const before = JSON.stringify(compactMetadataForPreview(input));
    expect(before).toBe(JSON.stringify(compactMetadataForPreview(input)));
    expect(JSON.parse(before)).not.toHaveProperty(key);
  });

  it("is idempotent", () => {
    const stamps = Array.from({ length: 250 }, (_, i) => TS(i));
    const once = compactMetadataForPreview({ [key]: stamps });
    expect(compactMetadataForPreview(once)).toEqual(once);
  });

  it("pins that redaction is a no-op on representative grammar-admitted values", () => {
    // `compactTurnTimestamps` deliberately skips `redactSecrets`. That is
    // sound only while no secret family can match the timestamp grammar; assert
    // it rather than argue it in prose, so a future numeric-prefixed family
    // fails here instead of silently egressing.
    for (const stamp of [
      "2026-06-15",
      "2026-06-15T10:00:00.123456789012+0530",
    ]) {
      expect(redactSecrets(stamp)).toBe(stamp);
    }
  });
});

describe("agentTurnTimestamps (ISS-9864 — the same pass-through, its own bound)", () => {
  const TS = (i: number) =>
    `2026-06-15T${String(i % 24).padStart(2, "0")}:00:00.000Z`;
  const key = AGENT_TURN_TIMESTAMPS_METADATA_KEY;
  const humanKey = HUMAN_TURN_TIMESTAMPS_METADATA_KEY;
  const read = (result: unknown) =>
    (result as Record<string, unknown> | null)?.[key];

  it("carries more entries than the generic array cap, under BOTH policies", () => {
    // The undercount would otherwise move from `messages` to this key. Under
    // Omit the entries survive by validated shape, not by a declared path.
    const stamps = Array.from({ length: 400 }, (_, i) => TS(i));
    expect(read(compactMetadataForPreview({ [key]: stamps }))).toHaveLength(
      400
    );
    expect(
      read(
        compactMetadataForPreview({ [key]: stamps }, MetadataContentPolicy.Omit)
      )
    ).toHaveLength(400);
  });

  it("drops the WHOLE key past ITS bound instead of truncating", () => {
    const stamps = Array.from(
      { length: MAX_METADATA_AGENT_TURN_TIMESTAMPS + 1 },
      (_, i) => TS(i)
    );
    expect(read(compactMetadataForPreview({ [key]: stamps }))).toBeUndefined();
    expect(
      read(compactMetadataForPreview({ [key]: stamps.slice(0, -1) }))
    ).toHaveLength(MAX_METADATA_AGENT_TURN_TIMESTAMPS);
  });

  it("drops the WHOLE key when any single entry is not a timestamp", () => {
    for (const bad of ["20260615", "not-a-date", "", 42, null, { at: TS(0) }]) {
      expect(
        read(compactMetadataForPreview({ [key]: [TS(0), bad, TS(2)] })),
        `entry ${JSON.stringify(bad)}`
      ).toBeUndefined();
    }
  });

  it("keeps a NON-array value on the ordinary string path, denied under Omit", () => {
    const prose = "then the model deleted the production database";
    expect(read(compactMetadataForPreview({ [key]: prose }))).toBe(prose);
    expect(
      read(
        compactMetadataForPreview({ [key]: prose }, MetadataContentPolicy.Omit)
      )
    ).toBeUndefined();
  });

  it("does not let an agents[].metadata blob borrow the key's bound", () => {
    // Path match, not bare-key match: under the agent root the key resolves to
    // `agents.metadata.agentTurnTimestamps` and takes the generic 100 cap.
    const stamps = Array.from({ length: 400 }, (_, i) => TS(i));
    expect(
      read(compactAgentMetadataForPreview({ [key]: stamps }))
    ).toHaveLength(MAX_METADATA_ARRAY_ITEMS);
  });

  it("falls off the first-80-key window AFTER the human key", () => {
    // The producer appends human first, agent last, so on a blob one short of
    // the window the human key survives and the agent key is the one dropped —
    // the cloud then reads `$.messages` for agent turns, exactly as today.
    const filler = Object.fromEntries(
      Array.from({ length: MAX_METADATA_KEYS - 1 }, (_, i) => [`k${i}`, i])
    );
    const result = compactMetadataForPreview({
      ...filler,
      [humanKey]: [TS(0)],
      [key]: [TS(1)],
    }) as Record<string, unknown>;
    expect(Object.keys(result)).toHaveLength(MAX_METADATA_KEYS);
    expect(result[humanKey]).toEqual([TS(0)]);
    expect(result[key]).toBeUndefined();
    expect(result.k78).toBe(78);
  });

  it("never derives the key from `messages`", () => {
    // The cloud persist boundary re-runs this over a blob whose `messages` is
    // already capped; deriving here would rebuild the key from the cap.
    const result = compactMetadataForPreview({
      messages: Array.from({ length: 100 }, () => ({
        role: "assistant",
        timestamp: TS(0),
      })),
    });
    expect(result).not.toHaveProperty(key);
  });

  it("is idempotent and pins that redaction is a no-op on its entries", () => {
    const stamps = Array.from({ length: 250 }, (_, i) => TS(i));
    const once = compactMetadataForPreview({ [key]: stamps });
    expect(compactMetadataForPreview(once)).toEqual(once);
    expect(redactSecrets("2026-06-15T10:00:00.123456789012+0530")).toBe(
      "2026-06-15T10:00:00.123456789012+0530"
    );
  });
});

/**
 * ISS-8565. `compactMetadataObject` rebuilt the preview on a plain `{}`, so a
 * key literally named `__proto__` — which `JSON.parse` DOES deliver as a real
 * own key — hit the inherited setter and created no own key. That is worse than
 * one lost field: the trailing `Object.keys(compacted).length > 0` collapse then
 * turns a metadata object whose ONLY key was `__proto__` into `null`, deleting
 * the entire preview rather than a single entry.
 *
 * Fixtures come from `JSON.parse`, not object literals: a quoted `"__proto__"`
 * in a LITERAL is the prototype-setter form and creates no own key at all.
 */
describe("compactMetadataForPreview keeps a __proto__ key (ISS-8565)", () => {
  it("keeps it alongside ordinary keys", () => {
    const metadata = JSON.parse(
      '{"__proto__":{"nested":"kept"},"normal":"value"}'
    ) as Record<string, unknown>;

    const compacted = compactMetadataForPreview(metadata) as Record<
      string,
      unknown
    >;

    expect(Object.keys(compacted).sort()).toEqual(["__proto__", "normal"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    expect(compacted.__proto__).toEqual({ nested: "kept" });
    expect(Object.getPrototypeOf(compacted)).toBe(Object.prototype);
  });

  it("does not collapse the WHOLE preview to null when __proto__ is the only key", () => {
    const metadata = JSON.parse('{"__proto__":"only"}') as Record<
      string,
      unknown
    >;

    const compacted = compactMetadataForPreview(metadata);

    expect(compacted).not.toBeNull();
    expect(Object.keys(compacted as Record<string, unknown>)).toEqual([
      "__proto__",
    ]);
  });
});
