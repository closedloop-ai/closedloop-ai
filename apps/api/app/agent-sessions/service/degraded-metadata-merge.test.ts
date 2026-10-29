/**
 * ISS-8641 / ISS-8714: the merge that stops a degraded resync deleting stored
 * `metadata` keys, and the monitored event that says one landed.
 *
 * The WIRING — that `upsertSessionSlice` calls this and writes the result — is
 * pinned separately by `service.degraded-metadata-persist.test.ts`, because a
 * unit test of a pure function stays green when nothing calls it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.logWarn, error: vi.fn(), info: vi.fn() },
}));

import {
  countDegradedMetadataSessions,
  degradedMetadataThrottle,
  METADATA_DEGRADED_EVENT,
  mergeDegradedMetadata,
  reportDegradedMetadata,
  resolveWithheldMetadataKeys,
} from "./degraded-metadata-merge";

const ORGANIZATION_ID = "org-degraded-merge";
const COMPUTE_TARGET_ID = "target-degraded-merge";

describe("resolveWithheldMetadataKeys", () => {
  it("reads an absent or null declaration as no declaration", () => {
    // The cross-repo default. Every already-installed desktop build sends
    // neither, and both must mean "states no opinion" rather than "withheld
    // nothing in particular".
    expect(resolveWithheldMetadataKeys(undefined)).toEqual([]);
    expect(resolveWithheldMetadataKeys(null)).toEqual([]);
    expect(resolveWithheldMetadataKeys([])).toEqual([]);
  });

  it("dedupes, and keeps the empty-string key the compactor can retain", () => {
    // DELIBERATE REVERSAL of an earlier revision that dropped `""` as a key that
    // "names nothing" (review: whitlockk). It names something: `""` is a valid JSON
    // object key and `compactMetadataForPreview({ "": 42 })` returns `{ "": 42 }`,
    // so the desktop can withhold it and declare `[""]`. Stripping it made a
    // one-key declaration EMPTY, which reads as no declaration and falls back to
    // the wholesale replace — deleting the exact key the producer named. The
    // dedupe half is unchanged: a repeated key would make the merge's bookkeeping
    // depend on multiplicity for no gain.
    expect(
      resolveWithheldMetadataKeys([
        "usageExtras",
        "",
        "usageExtras",
        "entrypoint",
      ])
    ).toEqual(["usageExtras", "", "entrypoint"]);
  });

  it("reads a lone empty-string key as a real declaration, not an empty one", () => {
    // The case that made the strip destructive rather than merely lossy: a
    // declaration of exactly `[""]` collapsed to `[]`, and `[]` is the sentinel
    // for "this peer stated no opinion".
    expect(resolveWithheldMetadataKeys([""])).toEqual([""]);
  });

  it("reads a non-array as no declaration rather than throwing", () => {
    // Types do not constrain what arrives over the wire. A malformed value must
    // fall back to today's replace, never fail the session.
    expect(
      resolveWithheldMetadataKeys("usageExtras" as unknown as readonly string[])
    ).toEqual([]);
  });
});

describe("mergeDegradedMetadata", () => {
  it("reinstates a withheld key the stored row still holds", () => {
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "cli", usageExtras: { webSearchRequests: 7 } },
        incoming: { entrypoint: "cli" },
        withheldKeys: ["usageExtras"],
      })
    ).toEqual({ entrypoint: "cli", usageExtras: { webSearchRequests: 7 } });
  });

  it("drops a stored key that was neither sent nor declared withheld", () => {
    // THE DELETION CASE — the one thing merge-instead-of-replace can get wrong,
    // and the reason the wire carries a list rather than a flag.
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "cli", permissionMode: "acceptEdits" },
        incoming: { entrypoint: "cli" },
        withheldKeys: ["usageExtras"],
      })
    ).toEqual({ entrypoint: "cli" });
  });

  it("returns the incoming blob untouched when nothing is declared", () => {
    const incoming = { entrypoint: "cli" };
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "cli", usageExtras: { webSearchRequests: 7 } },
        incoming,
        withheldKeys: [],
      })
    ).toBe(incoming);
  });

  it("prefers the incoming value for a key the payload both sent and listed", () => {
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "stale" },
        incoming: { entrypoint: "cli" },
        withheldKeys: ["entrypoint"],
      })
    ).toEqual({ entrypoint: "cli" });
  });

  it("treats a stored array or primitive as nothing to preserve", () => {
    // A row written by a non-desktop caller can hold either. `key in []` would
    // answer for indices and inherited members rather than for data, so the
    // guard is a refusal and not a cast.
    const incoming = { entrypoint: "cli" };
    expect(
      mergeDegradedMetadata({
        stored: ["usageExtras"],
        incoming,
        withheldKeys: ["usageExtras"],
      })
    ).toBe(incoming);
    expect(
      mergeDegradedMetadata({
        stored: 42,
        incoming,
        withheldKeys: ["usageExtras"],
      })
    ).toBe(incoming);
  });

  it("preserves a withheld key even when the payload carried no metadata at all", () => {
    // `incoming` is null when the blob compacted to nothing. Reinstating is
    // still correct — and is what keeps the write off `Prisma.DbNull`, which
    // would erase the row.
    expect(
      mergeDegradedMetadata({
        stored: { usageExtras: { webSearchRequests: 7 } },
        incoming: null,
        withheldKeys: ["usageExtras"],
      })
    ).toEqual({ usageExtras: { webSearchRequests: 7 } });
  });

  it("reinstates a withheld key whose name is an Object.prototype member", () => {
    // `key in merged` answers for `Object.prototype` on a plain `{}`, so a stored
    // `constructor` declared withheld would be read as already-incoming and
    // skipped — deleting exactly the key this module exists to preserve. Both
    // operands are untrusted (the list is off the wire, the blob is parsed JSON),
    // so this name is reachable, not theoretical.
    expect(
      mergeDegradedMetadata({
        stored: { constructor: "harness-v2", toString: "cli" },
        incoming: { entrypoint: "cli" },
        withheldKeys: ["constructor", "toString"],
      })
    ).toEqual({
      entrypoint: "cli",
      constructor: "harness-v2",
      toString: "cli",
    });
  });

  it("does not hand an Object.prototype function to a key the stored blob lacks", () => {
    // The mirrored half. `!(key in stored)` is FALSE for `toString` even on a blob
    // that owns no such key, so an own-property check on only the first operand
    // would assign `Object.prototype.toString` — a FUNCTION — into the persisted
    // metadata as if it were session data.
    const merged = mergeDegradedMetadata({
      stored: { entrypoint: "cli" },
      incoming: { entrypoint: "cli" },
      withheldKeys: ["toString"],
    });

    expect(merged).toEqual({ entrypoint: "cli" });
    // OWN-property, not `merged.toString`: every plain object inherits a
    // `toString` function, so a bare member read is satisfied by the prototype
    // and would pass even if the merge HAD assigned one.
    expect(Object.hasOwn(merged ?? {}, "toString")).toBe(false);
  });

  it("reinstates a withheld empty-string key from the stored row", () => {
    // whitlockk's case end to end: the declaration survives `resolveWithheldMetadataKeys`
    // AND the merge preserves the value under it. `sanitizeMetadataForPersist`
    // keeps `""` too, so nothing downstream re-strips it.
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "cli", "": 42 },
        incoming: { entrypoint: "cli" },
        withheldKeys: resolveWithheldMetadataKeys([""]),
      })
    ).toEqual({ entrypoint: "cli", "": 42 });
  });

  it("does not let a stored `__proto__` reparent the merged object", () => {
    // review: tamsinb. On a plain `{}` accumulator `merged["__proto__"] = value`
    // is a [[Set]] that finds `Object.prototype`'s accessor and REPARENTS the
    // object instead of creating an own property — so the key silently vanishes
    // while `preservedAny` claims it was preserved, and an untrusted parsed-JSON
    // object becomes the accumulator's prototype. The accumulator is now
    // `Object.create(null)`, which has no accessor to find.
    //
    // WHAT THIS PINS is that no `Object.prototype` member leaks into the
    // persisted blob and the OTHER declared key still lands. It does NOT pin
    // whether `__proto__` itself reaches the column: that is
    // `sanitizeMetadataForPersist`'s call, it is the same on the wholesale-replace
    // path this ticket did not change, and ISS-8565 deliberately made it KEEP the
    // key as an own data property — dropping it silently could collapse a preview
    // whose only key was `__proto__` to `null`. So the key surviving here is
    // main's intended behavior, not this merge leaking one; what would be a defect
    // is the OBJECT being reparented by it, which is what the prototype and
    // `polluted` assertions below rule out.
    // JSON.parse, not a literal: an object literal's `__proto__` is the
    // prototype SETTER, so `{ __proto__: x }` never creates the own property this
    // case is about. `JSON.parse` uses CreateDataProperty and does — which is
    // also exactly how a stored blob arrives back from Postgres.
    const stored = JSON.parse(
      '{"__proto__":{"polluted":true},"usageExtras":{"webSearchRequests":7}}'
    );
    const merged = mergeDegradedMetadata({
      stored,
      incoming: { entrypoint: "cli" },
      withheldKeys: ["__proto__", "usageExtras"],
    });

    expect(Reflect.ownKeys(merged ?? {}).sort()).toEqual(
      ["__proto__", "entrypoint", "usageExtras"].sort()
    );
    expect(merged?.entrypoint).toEqual("cli");
    expect(merged?.usageExtras).toEqual({ webSearchRequests: 7 });
    expect(Object.getPrototypeOf(merged ?? {})).toBe(Object.prototype);
    expect(Object.hasOwn(merged ?? {}, "polluted")).toBe(false);
    expect(merged?.polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns the incoming blob when a declared key is absent from the stored row too", () => {
    // Nothing to preserve, so no merged object is built and the caller writes
    // exactly what it would have written before this ticket.
    const incoming = { entrypoint: "cli" };
    expect(
      mergeDegradedMetadata({
        stored: { entrypoint: "cli" },
        incoming,
        withheldKeys: ["usageExtras"],
      })
    ).toBe(incoming);
  });
});

describe("countDegradedMetadataSessions", () => {
  const DEGRADED = {
    externalSessionId: "ext-degraded",
    metadataWithheldKeys: ["usageExtras"],
  };
  const CLEAN = { externalSessionId: "ext-clean" };

  it("counts only a declaring session whose slice committed", () => {
    expect(
      countDegradedMetadataSessions(
        [DEGRADED, CLEAN],
        ["ext-degraded", "ext-clean"]
      )
    ).toBe(1);
  });

  it("does not count a declaring session whose slice never committed", () => {
    // A slice that threw re-sends in full, so reporting it would name a landing
    // that has not happened. Counting `sessions` alone passes the case above and
    // fails here.
    expect(
      countDegradedMetadataSessions([DEGRADED, CLEAN], ["ext-clean"])
    ).toBe(0);
  });

  it("counts nothing when the batch committed nothing", () => {
    expect(countDegradedMetadataSessions([DEGRADED], [])).toBe(0);
  });
});

describe("reportDegradedMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    degradedMetadataThrottle.clear();
  });

  it("raises the monitored event for a batch that landed a degraded blob", () => {
    reportDegradedMetadata(
      { organizationId: ORGANIZATION_ID, computeTargetId: COMPUTE_TARGET_ID },
      2
    );

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
    // A whole-object match, so a NEW facet has to be declared here rather than
    // slipping into a monitored payload unreviewed.
    expect(mocks.logWarn).toHaveBeenCalledWith(METADATA_DEGRADED_EVENT, {
      organizationId: ORGANIZATION_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      degradedSessionCount: 2,
      occurrences: 1,
    });
  });

  it("stays silent when no session degraded", () => {
    // A degradation report, so a `0` would be traffic rather than signal.
    reportDegradedMetadata(
      { organizationId: ORGANIZATION_ID, computeTargetId: COMPUTE_TARGET_ID },
      0
    );

    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it("collapses repetition on the same key inside one window", () => {
    // The amplification bound. A blob that stays oversized re-declares on every
    // pass forever, so an un-throttled emission is one warning per request from
    // one session.
    for (let attempt = 0; attempt < 5; attempt++) {
      reportDegradedMetadata(
        { organizationId: ORGANIZATION_ID, computeTargetId: COMPUTE_TARGET_ID },
        1
      );
    }

    expect(mocks.logWarn).toHaveBeenCalledTimes(1);
  });

  it("still emits for a different compute target in the same window", () => {
    // The first occurrence on a key with no live window always emits, so a
    // genuinely new (org, target) degrade is never the one the bound eats.
    reportDegradedMetadata(
      { organizationId: ORGANIZATION_ID, computeTargetId: COMPUTE_TARGET_ID },
      1
    );
    reportDegradedMetadata(
      { organizationId: ORGANIZATION_ID, computeTargetId: "target-other" },
      1
    );

    expect(mocks.logWarn).toHaveBeenCalledTimes(2);
  });
});
