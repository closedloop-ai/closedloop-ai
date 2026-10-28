/**
 * @file transcript-byte-inventory.test.ts
 * @description ISS-8506 — the PURE FOLD half of the byte inventory: given an
 * already-enumerated ref list, it must never state a total it did not measure.
 * These cases pin the reconciliation identity, the classification precedence,
 * the two dedup views, the input cap, and the values it refuses outright.
 *
 * What the sweep actually WALKS — the harness probes,
 * `collectTranscriptByteInventory`, and the walk-skip plumbing — is the sibling
 * `transcript-byte-inventory-enumeration.test.ts`. Shared fixtures live in
 * `transcript-byte-inventory-fixtures.ts`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import type { CodexRolloutLinkage } from "../src/main/collectors/codex/codex-subagent-rollouts.js";
import {
  capListing,
  MAX_INVENTORY_FILES,
} from "../src/main/transcript-sync/transcript-byte-inventory.js";
import {
  countDiscoveredSessions,
  isMeasurableByteSize,
} from "../src/main/transcript-sync/transcript-byte-inventory-fold.js";
import {
  TranscriptByteLane,
  TranscriptExclusionReason,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { codexRefsFromRollouts } from "../src/main/transcript-sync/transcript-discovery.js";
import {
  subagentFileKey,
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { codexLinkage } from "./normalized-session-test-utils.js";
import {
  build,
  measuredProbes,
  opencodeStore,
  ref,
  SCAN_START,
  stat,
  unmaterializedOpencodeProbe,
} from "./transcript-byte-inventory-fixtures.js";

test("discovered bytes reconcile exactly against eligible plus excluded", () => {
  const inventory = build(
    [ref("/a"), ref("/b", "sess-2"), ref("/c", "sess-3")],
    {
      "/a": stat({ size: 500, ino: 1 }),
      "/b": stat({ size: 0, ino: 2 }),
      "/c": stat({ size: 250, ino: 3, isSymbolicLink: true }),
    }
  );

  assert.equal(inventory.eligibleParseBytes, 500);
  assert.equal(inventory.excludedBytes, 250);
  assert.equal(inventory.discoveredBytes, 750);
  assert.equal(
    inventory.discoveredBytes,
    inventory.eligibleParseBytes + inventory.excludedBytes
  );
});

test("each exclusion reason is tallied with its own files and bytes", () => {
  const inventory = build(
    [
      ref("/link", "s1"),
      ref("/dir", "s2"),
      ref("/growing", "s3"),
      ref("/empty", "s4"),
      ref("/gone", "s5"),
    ],
    {
      "/link": stat({ size: 11, ino: 1, isSymbolicLink: true }),
      "/dir": stat({ size: 22, ino: 2, isFile: false }),
      // Written at scanStart or later: whatever size we read is already stale.
      "/growing": stat({ size: 33, ino: 3, mtimeMs: SCAN_START }),
      "/empty": stat({ size: 0, ino: 4 }),
      "/gone": undefined,
    }
  );

  const tallies = inventory.exclusionsByReason;
  assert.deepEqual(tallies[TranscriptExclusionReason.Symlink], {
    files: 1,
    bytes: 11,
  });
  assert.deepEqual(tallies[TranscriptExclusionReason.NotRegularFile], {
    files: 1,
    bytes: 22,
  });
  assert.deepEqual(tallies[TranscriptExclusionReason.Unstable], {
    files: 1,
    bytes: 33,
  });
  assert.deepEqual(tallies[TranscriptExclusionReason.Empty], {
    files: 1,
    bytes: 0,
  });
  // An unreadable entry has an unknowable size, so it credits zero bytes — but
  // it must still be counted, or a locked corpus looks like an empty one.
  assert.deepEqual(tallies[TranscriptExclusionReason.Unreadable], {
    files: 1,
    bytes: 0,
  });
  assert.equal(inventory.eligibleParseBytes, 0);
});

test("an unreadable file impairs the measurement rather than reading as zero", () => {
  const inventory = build([ref("/gone")], { "/gone": undefined });

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.deepEqual(
    inventory.impairments.map((entry) => entry.reason),
    [TranscriptImpairmentReason.FileUnreadable]
  );
  assert.equal(inventory.impairments[0]?.count, 1);
});

test("a zero-byte file being written is unstable, never empty", () => {
  // Precedence matters: a transcript mid-write is momentarily zero bytes, and
  // calling that "empty" reports a live, growing session as nothing to parse.
  const inventory = build([ref("/growing")], {
    "/growing": stat({ size: 0, mtimeMs: SCAN_START + 1 }),
  });

  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.Unstable].files,
    1
  );
  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.Empty].files,
    0
  );
});

test("a symlink is excluded rather than followed to its target's size", () => {
  const inventory = build([ref("/link")], {
    "/link": stat({ size: 900, isSymbolicLink: true, isFile: true }),
  });

  assert.equal(inventory.eligibleParseBytes, 0);
  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.Symlink].bytes,
    900
  );
});

test("the same path reaching discovery twice is measured exactly once", () => {
  const inventory = build([ref("/a"), ref("/a")], {
    "/a": stat({ size: 400 }),
  });

  assert.equal(inventory.discoveredBytes, 400);
  assert.equal(inventory.eligibleParseBytes, 400);
  assert.equal(inventory.physicalBytes, 400);
});

test("a hardlink is one file on disk and two rows in the archive lane", () => {
  // The two denominators answer different questions and must not be collapsed:
  // physical bytes say how much of this disk is transcripts; attributable bytes
  // say how much the archive lane would account for, and a hardlink is two
  // separate uploads.
  const inventory = build(
    [
      ref("/one", "sess-1", TRANSCRIPT_MAIN_FILE_KEY),
      ref("/two", "sess-2", TRANSCRIPT_MAIN_FILE_KEY),
    ],
    {
      "/one": stat({ size: 600, dev: 1, ino: 42 }),
      "/two": stat({ size: 600, dev: 1, ino: 42 }),
    }
  );

  assert.equal(inventory.physicalBytes, 600);
  assert.equal(inventory.attributableRawBytes, 1200);
  assert.equal(inventory.eligibleFiles.length, 2);
});

test("an absent harness is a real zero and keeps the inventory complete", () => {
  const inventory = build([], {}, [
    {
      harness: TranscriptSourceHarness.Claude,
      outcome: TranscriptHarnessOutcome.Measured,
      impairments: [],
    },
    {
      harness: TranscriptSourceHarness.Codex,
      outcome: TranscriptHarnessOutcome.Absent,
      impairments: [],
    },
  ]);

  // Not installed is a fact, not a gap: a machine without Codex genuinely has
  // zero Codex bytes.
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(inventory.eligibleParseBytes, 0);
});

test("a blocked root leaves the measurement partial, never a confident total", () => {
  const inventory = build([ref("/a")], { "/a": stat({ size: 300 }) }, [
    {
      harness: TranscriptSourceHarness.Claude,
      outcome: TranscriptHarnessOutcome.Measured,
      impairments: [],
    },
    {
      harness: TranscriptSourceHarness.Codex,
      outcome: TranscriptHarnessOutcome.Impaired,
      impairments: [
        {
          reason: TranscriptImpairmentReason.RootBlocked,
          harness: TranscriptSourceHarness.Codex,
          path: "~/.codex/sessions",
        },
      ],
    },
  ]);

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(inventory.impairments[0]?.path, "~/.codex/sessions");
});

test("unavailable is reachable when something blocked us and nothing was measured", () => {
  // The reachability case. Round 1 of the plan review found `unavailable` could
  // never be produced, which made a fully locked machine indistinguishable from
  // an empty one.
  const inventory = build([], {}, [
    {
      harness: TranscriptSourceHarness.Claude,
      outcome: TranscriptHarnessOutcome.Impaired,
      impairments: [
        {
          reason: TranscriptImpairmentReason.RootBlocked,
          harness: TranscriptSourceHarness.Claude,
          path: "~/.claude/projects",
        },
      ],
    },
    {
      harness: TranscriptSourceHarness.Codex,
      outcome: TranscriptHarnessOutcome.Absent,
      impairments: [],
    },
    {
      harness: TranscriptSourceHarness.OpenCode,
      outcome: TranscriptHarnessOutcome.Absent,
      impairments: [],
    },
  ]);

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Unavailable
  );
  assert.notEqual(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
});

test("capListing truncates to the cap and reports what it dropped", () => {
  const items = Array.from({ length: MAX_INVENTORY_FILES + 3 }, (_, i) => i);

  const capped = capListing(items);

  // Truncate-and-report, never discard: a good prefix is still a measurement.
  assert.equal(capped.items.length, MAX_INVENTORY_FILES);
  assert.equal(capped.truncated, 3);
  assert.equal(capped.items[0], 0);
});

test("capListing leaves a listing at the cap untouched", () => {
  const items = Array.from({ length: MAX_INVENTORY_FILES }, (_, i) => i);

  assert.equal(capListing(items).truncated, 0);
});

test("an absent optional field is OMITTED, never serialized as null", () => {
  // AC: "absent values remain absent rather than serializing null unless the
  // receiving contract is nullable". A version-skewed peer distinguishes a
  // missing key from an explicit null, and `"path" in impairment` is the only
  // check that can tell them apart — `impairment.path === undefined` is true
  // for both.
  const inventory = build([ref("/gone")], { "/gone": undefined });

  const impairment = inventory.impairments[0];
  assert.equal(impairment?.reason, TranscriptImpairmentReason.FileUnreadable);
  assert.equal("path" in (impairment ?? {}), false);
  assert.equal("count" in (impairment ?? {}), true);
  assert.equal(
    JSON.stringify(impairment).includes("null"),
    false,
    "a round-tripped impairment must carry no null field"
  );
});

test("a file being written impairs the measurement, not just its own row", () => {
  // The AC names `unstable` beside `unreadable`, and for the same reason: an
  // unstable file is excluded from eligibleParseBytes but WILL be parsed once it
  // settles, so a `complete` label hands the parse lane a denominator its own
  // numerator will overrun.
  const inventory = build([ref("/being-written")], {
    "/being-written": stat({ size: 900, mtimeMs: SCAN_START + 1 }),
  });

  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.Unstable].files,
    1
  );
  assert.deepEqual(inventory.impairments, [
    {
      reason: TranscriptImpairmentReason.FileUnstable,
      harness: TranscriptSourceHarness.Claude,
      count: 1,
    },
  ]);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial,
    "a total that omits a file the parser will read is not complete"
  );
});

test("a settled file leaves the measurement complete", () => {
  // The counterfactual for the case above: impairing on every file would pass it
  // while making `complete` unreachable.
  const inventory = build([ref("/settled")], {
    "/settled": stat({ size: 900 }),
  });

  assert.deepEqual(inventory.impairments, []);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
});

test("every impossible size is refused, not just negative and non-finite", () => {
  // Each of these renders downstream as a confident number of bytes. The two
  // that get remembered are the last two; the first three are the ones that
  // actually reach a total.
  for (const size of [
    1.5,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MAX_VALUE,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(
      isMeasurableByteSize(size),
      false,
      `${size} must not be accepted as a byte count`
    );
  }
  for (const size of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(isMeasurableByteSize(size), true, `${size} is a real size`);
  }
});

test("a file with an impossible size credits nothing and impairs", () => {
  const inventory = build([ref("/fractional"), ref("/ok", "sess-2")], {
    "/fractional": stat({ size: 1.5 }),
    "/ok": stat({ size: 200, ino: 2 }),
  });

  assert.equal(
    inventory.discoveredBytes,
    200,
    "a size we know is false must not enter the total"
  );
  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.ImplausibleSize]
      .files,
    1
  );
  assert.equal(
    inventory.exclusionsByReason[TranscriptExclusionReason.ImplausibleSize]
      .bytes,
    0
  );
  assert.equal(
    inventory.impairments.some(
      (impairment) =>
        impairment.reason === TranscriptImpairmentReason.FileSizeImplausible
    ),
    true
  );
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    inventory.discoveredBytes,
    inventory.eligibleParseBytes + inventory.excludedBytes,
    "the reconciliation identity survives a refused size"
  );
});

test("an OpenCode store credits the parse lane and is never an archive row", () => {
  // What the collector parses is `opencode.db`, not a projection. It has no
  // `(externalSessionId, fileKey)` identity, so it cannot be an upload row and
  // must not inflate `attributableRawBytes`.
  const inventory = build(
    [],
    { "/oc/opencode.db": stat({ size: 500, ino: 1 }) },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
    [opencodeStore("/oc/opencode.db")]
  );

  assert.equal(inventory.discoveredBytes, 500);
  assert.equal(inventory.eligibleParseBytes, 500);
  assert.equal(inventory.physicalBytes, 500);
  assert.equal(inventory.attributableRawBytes, 0);
  assert.deepEqual(inventory.eligibleFiles, []);
});

test("a materialized OpenCode projection credits the upload lane only", () => {
  // The projection is a derived COPY of the store. Crediting it to the parse
  // partition too would count every OpenCode byte twice on a machine that has
  // consented — the double count the ticket's first AC forbids.
  const inventory = build(
    [
      ref(
        "/state/m/oc-1/main.jsonl",
        "oc-1",
        TRANSCRIPT_MAIN_FILE_KEY,
        TranscriptSourceHarness.OpenCode
      ),
    ],
    {
      "/oc/opencode.db": stat({ size: 500, ino: 1 }),
      "/state/m/oc-1/main.jsonl": stat({ size: 300, ino: 2 }),
    },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
    [opencodeStore("/oc/opencode.db")]
  );

  assert.equal(inventory.discoveredBytes, 500);
  assert.equal(inventory.eligibleParseBytes, 500);
  assert.equal(inventory.attributableRawBytes, 300);
  assert.equal(inventory.eligibleFiles[0]?.externalSessionId, "oc-1");
  assert.equal(
    inventory.physicalBytes,
    800,
    "a disk view counts the projection beside the store it was derived from"
  );
  assert.equal(
    inventory.discoveredBytes,
    inventory.eligibleParseBytes + inventory.excludedBytes,
    "the identity is over the parse partition and the projection is outside it"
  );
});

test("an unmaterialized projection shortens the upload lane and leaves the parse lane complete", () => {
  // The ordinary pre-consent machine with OpenCode installed. Before the
  // 2026-09-02 ruling one impairment made the whole inventory partial and the
  // onboarding screen got no number at all; the store was measurable the whole
  // time.
  const inventory = build(
    [ref("/claude/a.jsonl")],
    {
      "/claude/a.jsonl": stat({ size: 100, ino: 1 }),
      "/oc/opencode.db": stat({ size: 500, ino: 2 }),
    },
    [...measuredProbes(), unmaterializedOpencodeProbe()],
    [opencodeStore("/oc/opencode.db")]
  );

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(inventory.eligibleParseBytes, 600);
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial,
    "the projection's size is unknowable until the sweeper writes it"
  );
  // The evidence still says impaired: the harness was not FULLY seen. Which
  // lane may state a number is the per-lane completeness, not the outcome.
  assert.equal(
    inventory.evidence.find(
      (entry) => entry.harness === TranscriptSourceHarness.OpenCode
    )?.outcome,
    TranscriptHarnessOutcome.Impaired
  );
});

test("an OpenCode-only machine before consent is complete for parse and unavailable for upload", () => {
  // No harness was measured for the upload lane and something blocked it, so
  // that lane has NO number — while the parse lane has a real one.
  const inventory = build(
    [],
    { "/oc/opencode.db": stat({ size: 500, ino: 2 }) },
    [unmaterializedOpencodeProbe()],
    [opencodeStore("/oc/opencode.db")]
  );

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Unavailable
  );
});

test("a file-level impairment is scoped to the lane that reads the file", () => {
  // An unreadable projection shortens only the upload total; an unreadable
  // store shortens only the parse total; an unreadable Claude transcript
  // shortens both and carries NO lane key, so an older reader that does not
  // know the field degrades to the conservative answer.
  const projection = build(
    [
      ref(
        "/state/m/oc-1/main.jsonl",
        "oc-1",
        TRANSCRIPT_MAIN_FILE_KEY,
        TranscriptSourceHarness.OpenCode
      ),
    ],
    { "/state/m/oc-1/main.jsonl": undefined },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ]
  );
  assert.deepEqual(projection.impairments, [
    {
      reason: TranscriptImpairmentReason.FileUnreadable,
      harness: TranscriptSourceHarness.OpenCode,
      count: 1,
      lane: TranscriptByteLane.Upload,
    },
  ]);
  assert.equal(
    projection.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(
    projection.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    projection.exclusionsByReason[TranscriptExclusionReason.Unreadable].files,
    0,
    "an upload-only file is outside the parse partition's exclusion tallies"
  );

  const store = build(
    [],
    { "/oc/opencode.db": undefined },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
    [opencodeStore("/oc/opencode.db")]
  );
  assert.equal(store.impairments[0]?.lane, TranscriptByteLane.Parse);
  assert.equal(
    store.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    store.uploadCompleteness,
    TranscriptInventoryCompleteness.Complete
  );

  const both = build([ref("/gone")], { "/gone": undefined });
  assert.equal("lane" in (both.impairments[0] ?? {}), false);
  assert.equal(both.parseCompleteness, TranscriptInventoryCompleteness.Partial);
  assert.equal(
    both.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
});

test("an excluded projection leaves a trace on the upload lane's own tally", () => {
  // A symlinked or empty projection is outside the parse partition, so it must
  // not enter `exclusionsByReason` — but it must not vanish either, or an
  // upload total of 0 beside a real OpenCode session reads as complete.
  const inventory = build(
    [
      ref(
        "/state/m/oc-1/main.jsonl",
        "oc-1",
        TRANSCRIPT_MAIN_FILE_KEY,
        TranscriptSourceHarness.OpenCode
      ),
      ref("/claude/link.jsonl", "sess-2"),
    ],
    {
      "/state/m/oc-1/main.jsonl": stat({ size: 4242, isSymbolicLink: true }),
      "/claude/link.jsonl": stat({ size: 7, ino: 2, isSymbolicLink: true }),
    },
    [
      ...measuredProbes(),
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ]
  );

  assert.equal(inventory.attributableRawBytes, 0);
  assert.deepEqual(
    inventory.uploadExclusionsByReason[TranscriptExclusionReason.Symlink],
    { files: 2, bytes: 4249 },
    "both lanes' symlinks are kept out of the upload set, and both are traced"
  );
  assert.deepEqual(
    inventory.exclusionsByReason[TranscriptExclusionReason.Symlink],
    { files: 1, bytes: 7 },
    "only the parse-lane symlink is in the parse partition"
  );
  assert.equal(
    inventory.discoveredBytes,
    inventory.eligibleParseBytes + inventory.excludedBytes
  );
});

test("a symlinked store impairs the parse lane instead of reading as a confident zero", () => {
  // The store is OpenCode's ENTIRE parse-lane input, and SQLite opens it
  // through the link. Excluding it as a symlink is the ticket's rule and stays;
  // but without an impairment the result is parse `complete` at 0 bytes on a
  // machine with a real store — the plausible zero this module exists to refuse.
  const inventory = build(
    [],
    { "/oc/opencode.db": stat({ size: 25, isSymbolicLink: true }) },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
    [opencodeStore("/oc/opencode.db")]
  );

  assert.equal(inventory.eligibleParseBytes, 0);
  assert.deepEqual(inventory.impairments, [
    {
      reason: TranscriptImpairmentReason.RawStoreIndirect,
      harness: TranscriptSourceHarness.OpenCode,
      count: 1,
      lane: TranscriptByteLane.Parse,
    },
  ]);
  // The root was read, so this is `partial` like any other file-level gap,
  // not `unavailable` — but never `complete`.
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Complete,
    "the store is not an upload row, so the upload lane is untouched"
  );

  // The counterfactual: a symlinked TRANSCRIPT is still a plain exclusion. Its
  // session is one of many, and the collector does not follow it.
  const transcript = build([ref("/claude/link.jsonl")], {
    "/claude/link.jsonl": stat({ size: 25, isSymbolicLink: true }),
  });
  assert.deepEqual(transcript.impairments, []);
});

test("an upload-lane sum that would leave the exact-integer range says so on that lane", () => {
  // The parse guard alone would let a projection set past 2^53 render as a
  // confident total. Two valid projections whose sum is not exact.
  const half = Number.MAX_SAFE_INTEGER - 1;
  const inventory = build(
    [
      ref(
        "/state/m/a/main.jsonl",
        "a",
        TRANSCRIPT_MAIN_FILE_KEY,
        TranscriptSourceHarness.OpenCode
      ),
      ref(
        "/state/m/b/main.jsonl",
        "b",
        TRANSCRIPT_MAIN_FILE_KEY,
        TranscriptSourceHarness.OpenCode
      ),
    ],
    {
      "/state/m/a/main.jsonl": stat({ size: half, ino: 1 }),
      "/state/m/b/main.jsonl": stat({ size: half, ino: 2 }),
    },
    [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ]
  );

  assert.equal(
    inventory.attributableRawBytes,
    half,
    "the second row is not summed"
  );
  assert.equal(inventory.eligibleFiles.length, 1);
  assert.deepEqual(
    inventory.impairments.filter(
      (impairment) =>
        impairment.reason === TranscriptImpairmentReason.TotalExceedsPrecision
    ),
    [
      {
        reason: TranscriptImpairmentReason.TotalExceedsPrecision,
        harness: TranscriptSourceHarness.OpenCode,
        lane: TranscriptByteLane.Upload,
      },
    ]
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete,
    "nothing on the parse lane overflowed"
  );
});

test("a corpus that would leave the exact-integer range says so", () => {
  // Two individually-valid sizes whose SUM is not exact. Beyond 2^53 addition
  // silently rounds and the total still renders as a plausible figure.
  const half = Number.MAX_SAFE_INTEGER - 1;
  const inventory = build([ref("/a"), ref("/b", "sess-2")], {
    "/a": stat({ size: half, ino: 1 }),
    "/b": stat({ size: half, ino: 2 }),
  });

  assert.equal(
    inventory.discoveredBytes,
    half,
    "the second file is not summed"
  );
  assert.equal(Number.isSafeInteger(inventory.discoveredBytes), true);
  assert.deepEqual(
    inventory.impairments.filter(
      (impairment) =>
        impairment.reason === TranscriptImpairmentReason.TotalExceedsPrecision
    ),
    [
      {
        reason: TranscriptImpairmentReason.TotalExceedsPrecision,
        harness: TranscriptSourceHarness.Claude,
        lane: TranscriptByteLane.Parse,
      },
      {
        reason: TranscriptImpairmentReason.TotalExceedsPrecision,
        harness: TranscriptSourceHarness.Claude,
        lane: TranscriptByteLane.Upload,
      },
    ],
    "a Claude file is in both lanes, so both sums overflow and each says so"
  );
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
});

test("countDiscoveredSessions collapses a session's main file and its subagent sidechains into one count", () => {
  const counts = countDiscoveredSessions([
    ref("/a/sess-1.jsonl", "sess-1", TRANSCRIPT_MAIN_FILE_KEY),
    ref("/a/sess-1/subagents/x.jsonl", "sess-1", subagentFileKey("x")),
    ref("/a/sess-1/subagents/y.jsonl", "sess-1", subagentFileKey("y")),
  ]);

  assert.deepEqual(counts, [
    { harness: TranscriptSourceHarness.Claude, sessionCount: 1 },
  ]);
});

test("a Codex descendant rollout counts under its root session, not as a second session", () => {
  const byId = new Map<string, CodexRolloutLinkage>([
    ["root", codexLinkage("root", null, 0, "/codex/root.jsonl")],
    ["child", codexLinkage("child", "root", 1, "/codex/child.jsonl")],
    [
      "grandchild",
      codexLinkage("grandchild", "child", 1, "/codex/grandchild.jsonl"),
    ],
  ]);

  const counts = countDiscoveredSessions(codexRefsFromRollouts(byId));

  assert.deepEqual(counts, [
    { harness: TranscriptSourceHarness.Codex, sessionCount: 1 },
  ]);
});

test("OpenCode never gets a session-count row, unlike a harness measured in the same call", () => {
  const counts = countDiscoveredSessions([
    ref("/claude/sess-1.jsonl", "sess-1"),
    ref(
      "/oc/sess-2/main.jsonl",
      "sess-2",
      TRANSCRIPT_MAIN_FILE_KEY,
      TranscriptSourceHarness.OpenCode
    ),
  ]);

  assert.equal(
    counts.some((entry) => entry.harness === TranscriptSourceHarness.OpenCode),
    false,
    "OpenCode's materialized refs are not a faithful session enumeration"
  );
  assert.deepEqual(counts, [
    { harness: TranscriptSourceHarness.Claude, sessionCount: 1 },
  ]);
});

test("a harness absent from this call's refs is omitted rather than reported as zero", () => {
  const counts = countDiscoveredSessions([
    ref("/claude/sess-1.jsonl", "sess-1"),
  ]);

  assert.equal(
    counts.some((entry) => entry.harness === TranscriptSourceHarness.Codex),
    false,
    "we never enumerated Codex in this call, so it gets no entry at all"
  );
  assert.deepEqual(counts, [
    { harness: TranscriptSourceHarness.Claude, sessionCount: 1 },
  ]);
});

test("the inventory publishes sessionsByHarness computed from the same refs the byte totals came from", () => {
  const inventory = build(
    [
      ref("/a", "sess-1"),
      ref("/a/sub.jsonl", "sess-1", subagentFileKey("x")),
      ref("/b", "sess-2"),
    ],
    {
      "/a": stat({ size: 100, ino: 1 }),
      "/a/sub.jsonl": stat({ size: 50, ino: 2 }),
      "/b": stat({ size: 200, ino: 3 }),
    }
  );

  assert.deepEqual(inventory.sessionsByHarness, [
    { harness: TranscriptSourceHarness.Claude, sessionCount: 2 },
  ]);
  assert.equal(
    inventory.discoveredBytes,
    350,
    "the same three refs feed both the byte totals and the session count"
  );
});
