/**
 * @file parse-claude-compaction-metadata.test.ts
 * @description ISS-7258 M2: the five `compactMetadata` scalars a compaction
 * marker now carries, and the omission contract that keeps every session
 * WITHOUT them serializing exactly as it did before.
 *
 * The dropped siblings are asserted as deliberately dropped, not merely absent:
 * `preservedSegment` / `preservedMessages` are uuid manifests nothing can join
 * to, and `preCompactDiscoveredTools` is an array the D3 flat-scalars ruling
 * excludes. A later reader restoring any of them would breach the 100-item
 * persist cap, so the test states the intent rather than leaving it to a diff.
 */
import { describe, expect, it } from "vitest";
import type { NormalizedCompaction } from "../types";
import { parseClaudeTranscript } from "./parse-claude";

const SCALARS = {
  trigger: "manual",
  preTokens: 552_254,
  postTokens: 19_491,
  cumulativeDroppedTokens: 532_763,
  durationMs: 118_054,
};

/**
 * The marker. `isCompactSummary` is what makes a compaction entry exist, and it
 * carries NO `compactMetadata` — measured 173/173 across the live corpus.
 */
function markerLine(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid: "compact-1",
    timestamp: "2026-07-09T12:00:00.000Z",
    isCompactSummary: true,
    message: { role: "user", content: "summary" },
    ...fields,
  });
}

/**
 * The boundary. A `system` record whose own `isCompactSummary` is false, naming
 * its marker through `preservedSegment.anchorUuid` — the join is exact on
 * 173/173, while the boundary's own uuid matches a marker 0 times.
 */
function boundaryLine(
  metadata: Record<string, unknown>,
  anchor = "compact-1"
): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    // Derived from the anchor: the parser dedupes records by uuid, so two
    // boundaries sharing one would silently drop the second.
    uuid: `boundary-${anchor}`,
    timestamp: "2026-07-09T12:00:01.000Z",
    compactMetadata: {
      ...metadata,
      preCompactDiscoveredTools: ["Bash", "Read", "Edit"],
      preservedSegment: { headUuid: "h", anchorUuid: anchor, tailUuid: "t" },
      preservedMessages: {
        anchorUuid: anchor,
        uuids: ["u1"],
        allUuids: ["u2"],
      },
    },
  });
}

async function compactionsFrom(
  lines: string[]
): Promise<NormalizedCompaction[]> {
  const session = await parseClaudeTranscript(lines, { sessionId: "compact" });
  return (session?.compactions ?? []) as NormalizedCompaction[];
}

describe("compactMetadata scalars (ISS-7258 M2)", () => {
  it("joins the boundary's five scalars onto its marker", async () => {
    const [compaction] = await compactionsFrom([
      markerLine(),
      boundaryLine(SCALARS),
    ]);

    expect(compaction).toEqual({
      uuid: "compact-1",
      timestamp: "2026-07-09T12:00:00.000Z",
      ...SCALARS,
    });
  });

  it("joins regardless of which record arrives first", async () => {
    // The boundary can precede its marker, which is why the merge happens at
    // build time rather than inline.
    const [compaction] = await compactionsFrom([
      boundaryLine(SCALARS),
      markerLine(),
    ]);

    expect(compaction).toMatchObject(SCALARS);
  });

  it("reads NOTHING from a marker that carries compactMetadata itself", async () => {
    // The shape this implementation originally assumed, and the corpus never
    // produces: 173/173 boundaries are `system`/`compact_boundary` with
    // `isCompactSummary` false. A marker-carried payload must not be a second,
    // undocumented source.
    const [compaction] = await compactionsFrom([
      markerLine({ compactMetadata: { ...SCALARS } }),
    ]);

    expect(compaction).toEqual({
      uuid: "compact-1",
      timestamp: "2026-07-09T12:00:00.000Z",
    });
  });

  it("drops the two manifests and the discovered-tools array", async () => {
    const [compaction] = await compactionsFrom([
      markerLine(),
      boundaryLine(SCALARS),
    ]);

    // The toEqual above pins the exact key set; these name WHY, so a reader who
    // adds one back meets the intent rather than an opaque failure.
    expect(compaction).not.toHaveProperty("preservedSegment");
    expect(compaction).not.toHaveProperty("preservedMessages");
    expect(compaction).not.toHaveProperty("preCompactDiscoveredTools");
  });

  it("omits every scalar when no boundary named the marker", async () => {
    // The byte-identical contract: a pre-compactMetadata session, and every
    // Codex compaction, must serialize as it did before this shipped.
    const [compaction] = await compactionsFrom([
      markerLine(),
      boundaryLine(SCALARS, "some-other-marker"),
    ]);

    expect(compaction).toEqual({
      uuid: "compact-1",
      timestamp: "2026-07-09T12:00:00.000Z",
    });
  });

  it("omits individually impossible counts rather than storing them", async () => {
    // Each renders as a confident real measurement if stored. A count that
    // cannot be true must be ABSENT, never coerced to 0 or carried through.
    const [compaction] = await compactionsFrom([
      markerLine(),
      boundaryLine({
        trigger: "auto",
        preTokens: -1,
        postTokens: 1.5,
        cumulativeDroppedTokens: Number.MAX_SAFE_INTEGER + 2,
        durationMs: 42,
      }),
    ]);

    expect(compaction).toEqual({
      uuid: "compact-1",
      timestamp: "2026-07-09T12:00:00.000Z",
      trigger: "auto",
      durationMs: 42,
    });
  });

  it("omits a non-numeric count and a blank trigger", async () => {
    // `Number("")` is 0 and `+true` is 1; a lenient read stores both as
    // measurements.
    const [compaction] = await compactionsFrom([
      markerLine(),
      boundaryLine({
        trigger: "",
        preTokens: "",
        postTokens: true,
        cumulativeDroppedTokens: "12",
        durationMs: null,
      }),
    ]);

    expect(compaction).toEqual({
      uuid: "compact-1",
      timestamp: "2026-07-09T12:00:00.000Z",
    });
  });

  it("keeps each marker's own scalars across several compactions", async () => {
    const compactions = await compactionsFrom([
      markerLine({ uuid: "c1" }),
      boundaryLine({ trigger: "manual", preTokens: 10 }, "c1"),
      markerLine({ uuid: "c2", timestamp: "2026-07-09T13:00:00.000Z" }),
      boundaryLine({ trigger: "auto", preTokens: 20 }, "c2"),
    ]);

    expect(compactions.map((c) => [c.uuid, c.trigger, c.preTokens])).toEqual([
      ["c1", "manual", 10],
      ["c2", "auto", 20],
    ]);
  });
});
