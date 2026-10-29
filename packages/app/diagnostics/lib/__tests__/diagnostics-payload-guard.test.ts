import { describe, expect, it } from "vitest";
import type { DiagnosticsPayload } from "../diagnostics-payload";
import {
  readBackfillSection,
  readCoverageSection,
  readLinksSection,
  readReposSection,
  readWithheldSection,
} from "../diagnostics-payload-guard";

/**
 * ISS-10004 AC2 — every reader's REFUSAL branch, one shape each.
 *
 * The surface suite drives one malformed field through the rendered page, which
 * proves the ladder. It cannot prove the guard: a reader that refused
 * `linkTotals` and threw on everything else would leave it green. These are the
 * shapes that actually differ, and the three answers they must not confuse —
 * READABLE, ABSENT ("this producer cannot tell you") and MALFORMED.
 *
 * Each malformed fixture is one a section would THROW on: `.map` over a
 * non-array, `.totalLinks` off a non-record, `axis.buckets.map` over an axis
 * that carries none. A guard that only checked the outermost container would
 * pass the element cases and still take the page down.
 */

const WELL_FORMED = {
  backfill: {
    artifactLinks: { lastScannedAt: null, totalScanned: 1 },
    prBackfill: { lastScannedAt: null, totalScanned: 2 },
  },
  linkStats: [{ count: 1, method: "pr-body", relation: "implements" }],
  linkTotals: { linkedArtifacts: 0, linkedSessions: 0, totalLinks: 1 },
  repos: [
    {
      defaultBranch: "main",
      gitDir: "/g/.git",
      id: "r1",
      lastSeenAt: "2026-09-11T00:00:00.000Z",
      remoteUrl: null,
      repoFullName: "acme/one",
      worktreeCount: 1,
    },
  ],
} as DiagnosticsPayload;

/** `payload` is typed, but what arrives crossed a process boundary. */
function malformed(overrides: Record<string, unknown>): DiagnosticsPayload {
  return { ...WELL_FORMED, ...overrides } as unknown as DiagnosticsPayload;
}

const COVERAGE_CELL = {
  coverage: 0.5,
  coveredSpendUsd: 1,
  lowSample: false,
  sessionCount: 3,
  spendHighConfUsd: 1,
  spendLowConfUsd: 0,
  spendMediumConfUsd: 1,
  totalSpendUsd: 2,
};

function withCoverage(activityCoverage: unknown): DiagnosticsPayload {
  return malformed({ activityCoverage });
}

const WITHHELD_ROW = {
  earliestChildStartedAt: "2026-09-11T00:00:00.000Z",
  latestChildEndedAt: "2026-09-11T01:00:00.000Z",
  observedAt: "2026-09-11T02:00:00.000Z",
  reason: "no-subagent-permission",
  rootRawId: "raw-1",
  sourcePath: "/store/one",
  windowPartial: false,
  withheldCacheTokens: 128,
  withheldCount: 2,
  withheldTokens: 4096,
};

function withheldRow(
  overrides: Record<string, unknown>
): Record<string, unknown> {
  return { ...WITHHELD_ROW, ...overrides };
}

describe("diagnostics payload guard — a well-formed payload is read, not refused", () => {
  it("reads every section", () => {
    expect(readReposSection(WELL_FORMED)).toHaveLength(1);
    expect(readBackfillSection(WELL_FORMED)).not.toBeNull();
    expect(readLinksSection(WELL_FORMED)).toStrictEqual({
      linkStats: WELL_FORMED.linkStats,
      linkTotals: WELL_FORMED.linkTotals,
    });
  });

  it("reads a full coverage payload, buckets and all", () => {
    const activityCoverage = {
      axes: [
        {
          axis: "harness",
          buckets: [{ bucket: "claude", cell: COVERAGE_CELL }],
        },
      ],
      overall: COVERAGE_CELL,
      staleSessionCount: 0,
      unrecognizedFormulaSessionCount: 0,
    };

    expect(readCoverageSection(withCoverage(activityCoverage))).toStrictEqual({
      coverage: activityCoverage,
    });
  });
});

describe("diagnostics payload guard — ABSENT is not MALFORMED", () => {
  /**
   * ISS-5266 / ISS-6758: an absent optional key is the producer saying "I cannot
   * tell you", and the sections render that as UNKNOWN. Refusing it as malformed
   * would report a version-skewed producer as a corrupt one.
   */
  it("passes an absent withheld key through as undefined", () => {
    expect(readWithheldSection(WELL_FORMED)).toStrictEqual({
      scans: undefined,
      withheld: undefined,
    });
  });

  it("passes an absent coverage key through as undefined", () => {
    expect(readCoverageSection(WELL_FORMED)).toStrictEqual({
      coverage: undefined,
    });
  });

  it("reads an EMPTY withheld set as a real answer, not as absence", () => {
    expect(
      readWithheldSection(
        malformed({ opencodeWithheld: [], opencodeWithheldScans: [] })
      )
    ).toStrictEqual({ scans: [], withheld: [] });
  });
});

describe("diagnostics payload guard — a malformed section is refused", () => {
  it.each([
    ["repos is not an array", { repos: "nope" }],
    ["a repo row is not indexable", { repos: [null] }],
  ])("refuses repos when %s", (_name, overrides) => {
    expect(readReposSection(malformed(overrides))).toBeNull();
  });

  it.each([
    ["backfill is absent", { backfill: undefined }],
    ["artifactLinks is missing", { backfill: { prBackfill: {} } }],
    [
      "prBackfill is present but malformed",
      { backfill: { artifactLinks: {}, prBackfill: "nope" } },
    ],
  ])("refuses backfill when %s", (_name, overrides) => {
    expect(readBackfillSection(malformed(overrides))).toBeNull();
  });

  it("accepts backfill without prBackfill (absent means the host cannot tell)", () => {
    expect(
      readBackfillSection(malformed({ backfill: { artifactLinks: {} } }))
    ).not.toBeNull();
  });

  it.each([
    ["linkTotals is absent", { linkTotals: undefined }],
    ["linkStats is not an array", { linkStats: 7 }],
    ["a link row is not indexable", { linkStats: [null] }],
  ])("refuses links when %s", (_name, overrides) => {
    expect(readLinksSection(malformed(overrides))).toBeNull();
  });

  it.each([
    ["withheld is present but not an array", { opencodeWithheld: {} }],
    ["a withheld row is not indexable", { opencodeWithheld: ["row"] }],
    ["scans are present but not an array", { opencodeWithheldScans: 3 }],
  ])("refuses withheld when %s", (_name, overrides) => {
    expect(readWithheldSection(malformed(overrides))).toBeNull();
  });

  it.each([
    ["overall is missing", { axes: [] }],
    ["axes is not an array", { axes: {}, overall: COVERAGE_CELL }],
    // The element case: `CoverageRows` maps `axis.buckets`, so an axis without
    // them reaches `undefined.map` exactly as a missing `linkTotals` does.
    [
      "an axis carries no buckets",
      { axes: [{ axis: "harness" }], overall: COVERAGE_CELL },
    ],
    [
      "a bucket carries no cell",
      {
        axes: [{ axis: "harness", buckets: [{ bucket: "claude" }] }],
        overall: COVERAGE_CELL,
      },
    ],
  ])("refuses coverage when %s", (_name, activityCoverage) => {
    expect(readCoverageSection(withCoverage(activityCoverage))).toBeNull();
  });

  it("refuses every section when the payload itself is not an object", () => {
    const notAnObject =
      "diagnostics unavailable" as unknown as DiagnosticsPayload;

    expect(readReposSection(notAnObject)).toBeNull();
    expect(readBackfillSection(notAnObject)).toBeNull();
    expect(readLinksSection(notAnObject)).toBeNull();
    // The two optional readers answer ABSENT rather than MALFORMED: nothing is
    // present to be corrupt, and that is the claim their sections render.
    expect(readWithheldSection(notAnObject)).toStrictEqual({
      scans: undefined,
      withheld: undefined,
    });
    expect(readCoverageSection(notAnObject)).toStrictEqual({
      coverage: undefined,
    });
  });
});

/**
 * davetho review. `isRecordArray` cleared `[{}]`, so a partial row reached
 * `WithheldSection` and `formatTokens(row.withheldTokens)` died on
 * `undefined.toLocaleString()` — the malformed-payload path crashing instead of
 * refusing Withheld alone. These are the fields whose absence the renderer
 * cannot survive: it calls a method on the token counts and does arithmetic
 * with the count.
 */
describe("diagnostics payload guard — a PARTIAL withheld row is refused", () => {
  it("reads a complete row", () => {
    expect(
      readWithheldSection(malformed({ opencodeWithheld: [WITHHELD_ROW] }))
    ).toStrictEqual({ scans: undefined, withheld: [WITHHELD_ROW] });
  });

  it("refuses the empty row that used to reach the renderer", () => {
    expect(
      readWithheldSection(malformed({ opencodeWithheld: [{}] }))
    ).toBeNull();
  });

  it.each([
    ["withheldTokens absent", { withheldTokens: undefined }],
    ["withheldCacheTokens absent", { withheldCacheTokens: undefined }],
    ["withheldCount absent", { withheldCount: undefined }],
    ["withheldCount not finite", { withheldCount: Number.NaN }],
    ["withheldTokens a string", { withheldTokens: "4096" }],
    ["rootRawId absent", { rootRawId: undefined }],
    ["sourcePath absent", { sourcePath: undefined }],
    ["reason absent", { reason: undefined }],
    ["observedAt absent", { observedAt: undefined }],
    ["windowPartial absent", { windowPartial: undefined }],
    ["earliestChildStartedAt a number", { earliestChildStartedAt: 0 }],
  ])("refuses a row with %s", (_name, overrides) => {
    expect(
      readWithheldSection(
        malformed({ opencodeWithheld: [withheldRow(overrides)] })
      )
    ).toBeNull();
  });

  /** `null` is a VALUE on these two, not an absence — it renders as unavailable. */
  it("keeps null token counts, which are a real answer", () => {
    const row = withheldRow({
      withheldCacheTokens: null,
      withheldTokens: null,
    });
    expect(
      readWithheldSection(malformed({ opencodeWithheld: [row] }))
    ).toStrictEqual({ scans: undefined, withheld: [row] });
  });

  it.each([
    ["sourcePath absent", { sourcePath: undefined }],
    ["observedAt absent", { observedAt: undefined }],
  ])("refuses a scan row with %s", (_name, overrides) => {
    expect(
      readWithheldSection(
        malformed({
          opencodeWithheldScans: [
            {
              observedAt: "2026-09-11T02:00:00.000Z",
              sourcePath: "/s",
              ...overrides,
            },
          ],
        })
      )
    ).toBeNull();
  });
});
