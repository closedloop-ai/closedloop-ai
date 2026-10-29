import {
  TokenSourceIdentityAvailability,
  TokenSourceIdentityUnavailableReason,
} from "@repo/api/src/types/token-cost-provenance";
import { afterEach, describe, expect, it } from "vitest";
import { readStorageTokenCountAlias } from "./token-counts";
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
    recordUsageLine(
      map,
      usageLine({
        lineUuid: "00000000-0000-4000-8000-000000004050",
        input: 7777,
      })
    );
    expect(foldDedupMap(map).tokenSeries[0]?.input).toBe(4096);
    expect(entry?.overflowReplaySourceRecordIds.size).toBe(64);
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
 * one in `toIso`.
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

describe("unreadable timestamps keep their dedup identity (ISS-6738)", () => {
  it("does not collapse two id-less lines whose stamps are both unreadable", () => {
    // The reachable shape: a line with neither `messageId` nor `lineUuid` is
    // keyed by its timestamp. `toIso` answers null for text no `Date` can read
    // and the caller stores that as "", so without a raw identity component both
    // lines land on the key `"|"` and last-occurrence-wins drops the first
    // line's tokens from `tokensByModel` — which sums every entry in the map,
    // independent of whether `firstTs` is empty (whitlockk, ISS-6738 review).
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(
      map,
      usageLine({
        lineUuid: null,
        messageId: null,
        requestId: null,
        timestamp: "",
        rawTimestamp: "not-a-date",
        input: 10,
        output: 5,
      })
    );
    recordUsageLine(
      map,
      usageLine({
        lineUuid: null,
        messageId: null,
        requestId: null,
        timestamp: "",
        rawTimestamp: "also-not-a-date",
        input: 20,
        output: 8,
      })
    );

    expect(map.size).toBe(2);
    const folded = foldDedupMap(map);
    expect(folded.tokensByModel["claude-opus-4-1"].input).toBe(30);
    expect(folded.tokensByModel["claude-opus-4-1"].output).toBe(13);
  });

  it("still collapses when the raw stamp itself carries no identity", () => {
    // The fallback is not a licence to invent identity: a raw value that is
    // neither a non-empty string nor a finite number says nothing, so those
    // lines legitimately share a key exactly as they did before.
    const map = new Map<string, UsageDedupEntry>();
    for (const raw of [null, undefined]) {
      recordUsageLine(
        map,
        usageLine({
          lineUuid: null,
          messageId: null,
          requestId: null,
          timestamp: "",
          rawTimestamp: raw,
        })
      );
    }
    expect(map.size).toBe(1);
  });
});

/**
 * Every `NormalizedTokenCounts` field a poisoned fold writes onto a shared
 * object. `cacheWriteTtl` belongs here with the four counts:
 * `accumulateCacheWriteTtl` reads `target.cacheWriteTtl ?? {...}`, so an
 * inherited one is truthy and the next session accumulates onto the LEAKED
 * object instead of a fresh zero — which is how an incomplete cleanup here
 * silently corrupted the unrelated happy-path case below.
 */
const POLLUTABLE_COUNT_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWriteTtl",
] as const;

/** Named so `noProto`/`useLiteralKeys` never see a literal `__proto__` access. */
const PROTO_MODEL = "__proto__";

/**
 * Every object a poisoned write can land on. Only `__proto__` resolves through
 * the prototype getter to `Object.prototype`; the other three inherited names
 * resolve to the member ITSELF — the `Object` constructor and the
 * `toString`/`valueOf` function objects — so sweeping `Object.prototype` alone
 * would both miss the leak and carry it into the next case.
 */
const POLLUTION_OWNERS: readonly object[] = [
  Object.prototype,
  Object,
  Object.prototype.toString,
  Object.prototype.valueOf,
];

/** The count fields a poisoned fold leaked onto a shared object, if any. */
function pollutedKeys(): string[] {
  return POLLUTION_OWNERS.flatMap((owner) =>
    POLLUTABLE_COUNT_KEYS.filter((key) => Object.hasOwn(owner, key))
  );
}

describe("ISS-8235 — a model name that collides with Object.prototype", () => {
  // Unconditional, never the last line of a case: a case that fails midway
  // would otherwise leak a polluted owner into every later test in this
  // worker and turn the report into a file of unrelated red.
  afterEach(() => {
    for (const owner of POLLUTION_OWNERS) {
      for (const key of POLLUTABLE_COUNT_KEYS) {
        Reflect.deleteProperty(owner, key);
      }
    }
  });

  it.each(["__proto__", "constructor", "toString", "valueOf"])(
    "folds a model named %s into an own key, polluting no shared object",
    (model) => {
      const map = new Map<string, UsageDedupEntry>();
      recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID, model }));

      const folded = foldDedupMap(map);

      expect(Object.hasOwn(folded.tokensByModel, model)).toBe(true);
      expect(folded.tokensByModel[model]).toEqual({
        input: 10,
        output: 5,
        cacheRead: 2,
        cacheWrite: 3,
        cacheWriteTtl: { fiveM: 1, oneH: 2 },
      });
      // The assertion that kills the mutation: a fix guarding only the emitted
      // object still writes the running total onto that owner on the way.
      expect(pollutedKeys()).toEqual([]);
    }
  );

  it("conserves the token total across poisoned and normal model names", () => {
    const map = new Map<string, UsageDedupEntry>();
    const models = ["__proto__", "constructor", "claude-opus-4-1"];
    models.forEach((model, index) => {
      recordUsageLine(
        map,
        usageLine({
          lineUuid: `00000000-0000-4000-8000-00000000001${index}`,
          messageId: `message-${index}`,
          model,
          input: 100 * (index + 1),
        })
      );
    });

    const folded = foldDedupMap(map);

    // The invariant the bug breaks, and the one that survives a change of fix
    // shape: today the poisoned models' spend vanishes from the emitted object.
    const emitted = Object.values(folded.tokensByModel).reduce(
      (sum, counts) => sum + counts.input,
      0
    );
    expect(emitted).toBe(
      [...map.values()].reduce((sum, entry) => sum + entry.input, 0)
    );
    expect(emitted).toBe(600);
  });

  it("leaves a normal model name byte-identical and normally prototyped", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID }));

    const folded = foldDedupMap(map);

    expect(JSON.stringify(folded.tokensByModel)).toBe(
      '{"claude-opus-4-1":{"input":10,"output":5,"cacheRead":2,"cacheWrite":3,"cacheWriteTtl":{"fiveM":1,"oneH":2}}}'
    );
    // The null-prototype accumulator must not reach consumers: `deriveSessionUsage`
    // hands this object straight out, and a caller calling a prototype method on
    // it would throw if the fold leaked its bare accumulator.
    expect(Object.getPrototypeOf(folded.tokensByModel)).toBe(Object.prototype);
    expect(Object.hasOwn(folded.tokensByModel, "claude-opus-4-1")).toBe(true);
  });

  it("keeps readStorageTokenCountAlias honest for an unrelated record", () => {
    const map = new Map<string, UsageDedupEntry>();
    recordUsageLine(
      map,
      usageLine({ lineUuid: FIRST_UUID, model: PROTO_MODEL, input: 100 })
    );

    foldDedupMap(map);

    // The second-order harm, and the dangerous half: once `Object.prototype.input`
    // is a real number, a record that legitimately has NO `input` field inherits
    // it, `value != null` passes, and an unrelated session that never contained
    // the poisoned name is billed a fabricated 100.
    expect(readStorageTokenCountAlias({}, "unrelated.input", ["input"])).toBe(
      0
    );
  });

  // The merge target is a caller-owned plain `{}`, so unlike the fold's
  // null-prototype accumulator it INHERITS all four names — this is the site
  // where a write under `constructor`/`toString`/`valueOf` actually reaches
  // `Object` and the two function objects.
  it.each(["__proto__", "constructor", "toString", "valueOf"])(
    "merges a model named %s into a caller-owned target without polluting",
    (model) => {
      const target: {
        tokensByModel: Record<string, NormalizedTokenCounts>;
        tokenSeries: NormalizedTokenRecord[];
      } = { tokensByModel: {}, tokenSeries: [] };
      const map = new Map<string, UsageDedupEntry>();
      recordUsageLine(map, usageLine({ lineUuid: FIRST_UUID, model }));

      mergeFoldedUsage(target, foldDedupMap(map));

      expect(Object.hasOwn(target.tokensByModel, model)).toBe(true);
      expect(target.tokensByModel[model].input).toBe(10);
      expect(pollutedKeys()).toEqual([]);
      // An unguarded ASSIGN under `__proto__` would have invoked the setter and
      // swapped this object's prototype instead of storing a bucket. Fixing
      // only `foldDedupMap` leaves every one of these cases red.
      expect(Object.getPrototypeOf(target.tokensByModel)).toBe(
        Object.prototype
      );
    }
  );

  it("accumulates a poisoned model across repeated merges", () => {
    const target: {
      tokensByModel: Record<string, NormalizedTokenCounts>;
      tokenSeries: NormalizedTokenRecord[];
    } = { tokensByModel: {}, tokenSeries: [] };
    const foldOne = () => {
      const map = new Map<string, UsageDedupEntry>();
      recordUsageLine(
        map,
        usageLine({ lineUuid: FIRST_UUID, model: PROTO_MODEL })
      );
      return foldDedupMap(map);
    };

    mergeFoldedUsage(target, foldOne());
    mergeFoldedUsage(target, foldOne());

    // Exercises the second-write path, where the own-key check must find the
    // bucket it defined on the first pass rather than re-initializing it.
    expect(target.tokensByModel[PROTO_MODEL].input).toBe(20);
    expect(pollutedKeys()).toEqual([]);
  });
});
