import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { describe, expect, it } from "vitest";
import type { NormalizedTokenCounts, NormalizedTokenRecord } from "./types";
import type { RawCacheWriteTtl } from "./usage-dedup";
import {
  buildUsageTokenRecord,
  claudeTranscriptEntryUuidScheme,
  foldDedupMap,
  mergeFoldedUsage,
  recordUsageLine,
  type UsageDedupEntry,
  type UsageLineParams,
  validateCacheWriteTtl,
} from "./usage-dedup";

const FIRST_UUID = "00000000-0000-4000-8000-000000000001";
const SECOND_UUID = "00000000-0000-4000-8000-000000000002";

describe("Claude usage source identity", () => {
  it("retains ordered distinct entry UUIDs while preserving grouped usage semantics", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));
    recordUsageLine(
      map,
      usageLine({
        lineUuid: SECOND_UUID,
        timestamp: "2026-08-02T10:00:01.000Z",
        input: 20,
        output: 8,
      })
    );

    const folded = foldDedupMap(map);
    expect(folded.tokensByModel["claude-opus-4-1"]).toEqual({
      input: 20,
      output: 8,
      cacheRead: 2,
      cacheWrite: 3,
      cacheWriteTtl: { fiveM: 1, oneH: 2 },
    });
    expect(folded.tokenSeries).toEqual([
      expect.objectContaining({
        timestamp: "2026-08-02T10:00:00.000Z",
        input: 20,
        output: 8,
        cacheWriteTtl: { fiveM: 1, oneH: 2 },
        subagentId: "agent-a",
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Available,
          scheme: claudeTranscriptEntryUuidScheme,
          sourceRecordIds: [FIRST_UUID, SECOND_UUID],
        },
      }),
    ]);
  });

  it("treats an exact UUID replay as idempotent instead of changing the record", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));

    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({
        timestamp: "2026-08-02T10:00:00.000Z",
        input: 10,
        output: 5,
        sourceIdentity: expect.objectContaining({
          sourceRecordIds: [FIRST_UUID],
        }),
      }),
    ]);
  });

  it.each([
    [undefined, TokenSourceIdentityUnavailableReason.MissingSourceRecordId],
    [null, TokenSourceIdentityUnavailableReason.Malformed],
    ["", TokenSourceIdentityUnavailableReason.Malformed],
    ["not-a-uuid", TokenSourceIdentityUnavailableReason.Malformed],
  ])("degrades %j identity without dropping usage", (lineUuid, reason) => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid }));

    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({
        input: 10,
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason,
        },
      }),
    ]);
  });

  it("degrades an over-limit identity collection without losing the grouped record", () => {
    const map = new Map<string, UsageDedupEntry>();
    for (let index = 1; index <= 65; index += 1) {
      recordUsageLine(
        map,
        usageLine({
          lineUuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          input: index,
        })
      );
    }

    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({
        input: 65,
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.Malformed,
        },
      }),
    ]);

    recordUsageLine(
      map,
      usageLine({
        lineUuid: "00000000-0000-4000-8000-000000000065",
        input: 66,
      })
    );
    expect(foldDedupMap(map).tokenSeries[0]?.input).toBe(65);
  });

  it("bounds long over-cap replay state while keeping recent redelivery idempotent", () => {
    const map = new Map<string, UsageDedupEntry>();
    for (let index = 1; index <= 4096; index += 1) {
      recordUsageLine(
        map,
        usageLine({
          lineUuid: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          input: index,
        })
      );
    }

    const entry = map.get("message-1|request-1");
    expect(entry?.sourceRecordIds).toHaveLength(64);
    expect(entry?.overflowReplaySourceRecordIds.size).toBeLessThanOrEqual(64);
    recordUsageLine(
      map,
      usageLine({
        lineUuid: "00000000-0000-4000-8000-000000004096",
        input: 9999,
      })
    );
    expect(foldDedupMap(map).tokenSeries[0]?.input).toBe(4096);
    recordUsageLine(
      map,
      usageLine({
        lineUuid: "00000000-0000-4000-8000-000000000001",
        input: 8888,
      })
    );
    expect(foldDedupMap(map).tokenSeries[0]?.input).toBe(4096);
  });

  it("keeps equal usage groups distinguishable by their source evidence", () => {
    const first = new Map<string, UsageDedupEntry>();
    const second = new Map<string, UsageDedupEntry>();
    recordUsageLine(first, usageLine({ lineUuid: FIRST_UUID }));
    recordUsageLine(second, usageLine({ lineUuid: SECOND_UUID }));

    expect(foldDedupMap(first).tokenSeries[0]?.sourceIdentity).not.toEqual(
      foldDedupMap(second).tokenSeries[0]?.sourceIdentity
    );
  });
});

function usageLine(
  overrides: Partial<UsageLineParams> & Pick<UsageLineParams, "lineUuid">
): UsageLineParams {
  return {
    messageId: "message-1",
    requestId: "request-1",
    timestamp: "2026-08-02T10:00:00.000Z",
    model: "claude-opus-4-1",
    input: 10,
    output: 5,
    cacheRead: 2,
    cacheWrite: 3,
    cacheWriteTtlRaw: { fiveM: 1, oneH: 2 },
    subagentId: "agent-a",
    ...overrides,
  };
}

const THIRD_UUID = "00000000-0000-4000-8000-000000000003";

describe("buildUsageTokenRecord", () => {
  it("returns null when firstTs is empty (no timestamp anchor)", () => {
    const entry: UsageDedupEntry = {
      model: "claude-opus-4-1",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      firstTs: "",
      sourceRecordIds: [],
      overflowReplaySourceRecordIds: new Set(),
      sourceIdentityUnavailableReason:
        TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
    };
    expect(buildUsageTokenRecord(entry)).toBeNull();
  });
});

describe("foldDedupMap without TTL", () => {
  it("accumulates model totals without cacheWriteTtl when raw breakdown is absent", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(
      map,
      usageLine({ lineUuid: FIRST_UUID, cacheWriteTtlRaw: undefined })
    );
    const folded = foldDedupMap(map);
    expect(folded.tokensByModel["claude-opus-4-1"]).toEqual({
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 3,
    });
    expect("cacheWriteTtl" in folded.tokensByModel["claude-opus-4-1"]!).toBe(
      false
    );
  });
});

describe("recordUsageLine — second-occurrence identity degradation paths", () => {
  it("downgrades to Malformed when a non-undefined invalid lineUuid arrives on an existing entry", () => {
    // First: valid UUID → entry created without unavailableReason
    // Second: null lineUuid (not undefined, so Malformed, not MissingSourceRecordId)
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));
    recordUsageLine(map, usageLine({ lineUuid: null }));
    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.Malformed,
        },
      }),
    ]);
  });

  it("downgrades to MissingSourceRecordId when undefined lineUuid arrives on an entry with no prior reason", () => {
    // First: valid UUID → entry created without unavailableReason
    // Second: undefined lineUuid → triggers the ?? MissingSourceRecordId fallback
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));
    recordUsageLine(map, usageLine({ lineUuid: undefined }));
    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({
        sourceIdentity: {
          availability: TokenSourceIdentityAvailability.Unavailable,
          reason: TokenSourceIdentityUnavailableReason.MissingSourceRecordId,
        },
      }),
    ]);
  });
});

describe("recordSubagentAttribution — parent-beats-subagent precedence", () => {
  it("is a no-op when a subagent line arrives after the parent already cleared the attribution", () => {
    const map = new Map<string, UsageDedupEntry>();
    // Call 1: subagent sets the id
    recordUsageLine(
      map,
      usageLine({ lineUuid: FIRST_UUID, subagentId: "agent-a" })
    );
    // Call 2: parent clears the id (subagentId=undefined)
    recordUsageLine(
      map,
      usageLine({ lineUuid: SECOND_UUID, subagentId: undefined })
    );
    // Call 3: another subagent tries to claim it — must be a no-op (parent wins)
    recordUsageLine(
      map,
      usageLine({ lineUuid: THIRD_UUID, subagentId: "agent-b" })
    );
    // The parent's clearing of subagentId must survive
    expect(foldDedupMap(map).tokenSeries).toEqual([
      expect.objectContaining({ input: 10 }),
    ]);
    const series = foldDedupMap(map).tokenSeries[0];
    expect("subagentId" in (series ?? {})).toBe(false);
  });
});

describe("mergeFoldedUsage", () => {
  it("initializes a new model entry when target lacks it, and accumulates with cacheWriteTtl", () => {
    // Annotated rather than inferred: an unannotated `{}` literal widens
    // `tokensByModel` to `{}`, which cannot be indexed by a model key.
    const target: {
      tokensByModel: Record<string, NormalizedTokenCounts>;
      tokenSeries: NormalizedTokenRecord[];
    } = { tokensByModel: {}, tokenSeries: [] };
    const source = {
      tokensByModel: {
        "claude-opus-4-1": {
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 20,
          cacheWriteTtl: { fiveM: 5, oneH: 15 },
        },
      },
      tokenSeries: [],
    };
    mergeFoldedUsage(target, source);
    expect(target.tokensByModel["claude-opus-4-1"]).toEqual({
      input: 100,
      output: 50,
      cacheRead: 10,
      cacheWrite: 20,
      cacheWriteTtl: { fiveM: 5, oneH: 15 },
    });
  });

  it("accumulates into an existing model entry without cacheWriteTtl in source", () => {
    const target = {
      tokensByModel: {
        "claude-opus-4-1": {
          input: 50,
          output: 25,
          cacheRead: 5,
          cacheWrite: 10,
        },
      },
      tokenSeries: [],
    };
    const source = {
      tokensByModel: {
        "claude-opus-4-1": {
          input: 30,
          output: 10,
          cacheRead: 3,
          cacheWrite: 7,
        },
      },
      tokenSeries: [],
    };
    mergeFoldedUsage(target, source);
    expect(target.tokensByModel["claude-opus-4-1"]).toEqual({
      input: 80,
      output: 35,
      cacheRead: 8,
      cacheWrite: 17,
    });
  });
});

/**
 * ISS-6735: the REJECTION REASONS in `validateCacheWriteTtl`.
 *
 * Its docstring makes a precise promise — a member that is negative,
 * non-integer, or non-numeric, or a sum exceeding `cacheWrite`, rejects the
 * ENTIRE split to `undefined`, and members are never coerced to 0 individually
 * because `{0,0}` is reserved for a genuinely-reported zero split and a
 * fabricated partial one would corrupt provenance.
 *
 * The suite above covered only "a TTL is present" and "a TTL is absent".
 * Mutation testing replaced each of the seven conditions with `false` in turn
 * and every one survived: no test made any single rejection reason the reason.
 * A guard whose branches are individually untested is a guard that can lose one
 * without anyone noticing — and the value it protects is a token breakdown the
 * cost rollup prices.
 */
describe("validateCacheWriteTtl — each rejection reason", () => {
  const OK = { fiveM: 3, oneH: 4 };

  it("accepts a well-formed split within the cacheWrite budget", () => {
    expect(validateCacheWriteTtl(OK, 10)).toEqual({ fiveM: 3, oneH: 4 });
  });

  it("accepts a genuinely-reported {0,0}", () => {
    // Reserved by the docstring: {0,0} means the provider reported zeros, and
    // must stay distinguishable from `undefined`, which means it reported
    // nothing usable.
    expect(validateCacheWriteTtl({ fiveM: 0, oneH: 0 }, 10)).toEqual({
      fiveM: 0,
      oneH: 0,
    });
  });

  it("returns undefined when there is no raw split at all", () => {
    expect(validateCacheWriteTtl(undefined, 10)).toBeUndefined();
  });

  it("rejects the WHOLE split on a non-integer member", () => {
    // Not `{fiveM: 3, oneH: undefined}` and not a rounded 4 — the whole thing.
    expect(validateCacheWriteTtl({ fiveM: 3.5, oneH: 4 }, 10)).toBeUndefined();
    expect(validateCacheWriteTtl({ fiveM: 3, oneH: 4.5 }, 10)).toBeUndefined();
  });

  it("rejects the WHOLE split on a negative member", () => {
    expect(validateCacheWriteTtl({ fiveM: -1, oneH: 4 }, 10)).toBeUndefined();
    expect(validateCacheWriteTtl({ fiveM: 3, oneH: -1 }, 10)).toBeUndefined();
  });

  it("rejects the WHOLE split on a non-numeric member", () => {
    expect(
      validateCacheWriteTtl(
        { fiveM: "3", oneH: 4 } as unknown as RawCacheWriteTtl,
        10
      )
    ).toBeUndefined();
    expect(
      validateCacheWriteTtl(
        { fiveM: 3, oneH: null } as unknown as RawCacheWriteTtl,
        10
      )
    ).toBeUndefined();
  });

  it("rejects a non-finite member, which is a number but not an integer", () => {
    // Reachable at the transcript boundary: JSON.parse yields Infinity for an
    // overflowing literal.
    expect(
      validateCacheWriteTtl({ fiveM: Number.POSITIVE_INFINITY, oneH: 0 }, 10)
    ).toBeUndefined();
    expect(
      validateCacheWriteTtl({ fiveM: 0, oneH: Number.NaN }, 10)
    ).toBeUndefined();
  });

  it("rejects a split whose members sum ABOVE cacheWrite", () => {
    // The split is a breakdown OF cacheWrite; a sum exceeding it is not a
    // breakdown of anything, so it cannot be trusted in part either.
    expect(validateCacheWriteTtl({ fiveM: 6, oneH: 5 }, 10)).toBeUndefined();
  });

  it("accepts a split that sums EXACTLY to cacheWrite", () => {
    // The boundary: the guard is `>`, not `>=`. A fully-accounted split is the
    // normal case, not an error.
    expect(validateCacheWriteTtl({ fiveM: 6, oneH: 4 }, 10)).toEqual({
      fiveM: 6,
      oneH: 4,
    });
  });

  it("accepts a split that sums BELOW cacheWrite", () => {
    // Under-reporting is tolerated: the provider need not attribute every byte.
    expect(validateCacheWriteTtl({ fiveM: 1, oneH: 1 }, 10)).toEqual({
      fiveM: 1,
      oneH: 1,
    });
  });
});

/**
 * ISS-6735: the lineUuid normalization inside `recordUsageLine`.
 *
 * The dedup key falls back `messageId ?? lineUuid ?? timestamp`, and the raw
 * field is typed `unknown` precisely so "absent" and "present but malformed"
 * stay distinct. `recordUsageLine` narrows it first — a non-string, or an EMPTY
 * string, becomes `null` so the fallback continues to the timestamp.
 *
 * All six mutants of that narrowing survived, including `true` and `false`:
 * nothing distinguished an absent uuid from an empty-string one. An empty
 * string kept as a uuid is not merely untidy — it is a key component every such
 * line shares, so distinct turns collide into one entry and their tokens are
 * folded away. Same shape as the `""` timestamp that sorted before every real
 * one in `isoTs`.
 */
describe("recordUsageLine — an empty lineUuid is absent, not a key", () => {
  function noMessageIdLine(
    lineUuid: unknown,
    timestamp: string
  ): UsageLineParams {
    // messageId null is what puts lineUuid in the key at all; with a messageId
    // present the fallback never reaches it and the narrowing is unobservable.
    return usageLine({ lineUuid, messageId: null, requestId: null, timestamp });
  }

  it("keeps two empty-uuid lines APART, on their timestamps", () => {
    // The consequence, asserted directly rather than through the key string: if
    // "" were kept, both lines would share the key `|` and the second would
    // overwrite the first, silently losing a turn's tokens.
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, noMessageIdLine("", "2026-08-02T10:00:00.000Z"));
    recordUsageLine(map, noMessageIdLine("", "2026-08-02T10:00:01.000Z"));
    expect(map.size).toBe(2);
  });

  it("keeps two non-string-uuid lines apart the same way", () => {
    // The SAME malformed value on both lines, on purpose. Two DIFFERENT ones
    // stay apart even when the narrowing is broken — their retained keys just
    // differ from each other — so only repeating one value proves `42` is
    // actually dropped and the fallback reaches the timestamp.
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, noMessageIdLine(42, "2026-08-02T10:00:00.000Z"));
    recordUsageLine(map, noMessageIdLine(42, "2026-08-02T10:00:01.000Z"));
    expect(map.size).toBe(2);
  });

  it("still uses a REAL uuid as the key, collapsing a replay of the same line", () => {
    // The control: without this, the assertions above would also pass for a
    // narrowing that rejected every uuid.
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(
      map,
      noMessageIdLine(FIRST_UUID, "2026-08-02T10:00:00.000Z")
    );
    recordUsageLine(
      map,
      noMessageIdLine(FIRST_UUID, "2026-08-02T10:00:09.000Z")
    );
    expect(map.size).toBe(1);
  });

  it("distinguishes two different real uuids at the same timestamp", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(
      map,
      noMessageIdLine(FIRST_UUID, "2026-08-02T10:00:00.000Z")
    );
    recordUsageLine(
      map,
      noMessageIdLine(SECOND_UUID, "2026-08-02T10:00:00.000Z")
    );
    expect(map.size).toBe(2);
  });
});
