/**
 * ISS-9171: dedicated behavioral coverage for `codex-runtime-metadata.ts`'s
 * public entry point, `extractCodexRuntimeMetadata`. Exercises the internal
 * helpers (`optionalTokenCount`, `optionalPercent`, `clampPercentValue`,
 * `optionalFiniteNonNegative`, `readCodexTokenCounts`, `latestCodexTokenCounts`,
 * `readCodexRateLimitWindow`) only through the exported function, per the
 * file's own contract: defensive coercion of an untyped, possibly
 * cloud-synced metadata blob into a fully-nullable view model.
 */
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { extractCodexRuntimeMetadata } from "../codex-runtime-metadata";

type SessionMetadata = AgentSessionDetail["metadata"];

function asMetadata(value: unknown): SessionMetadata {
  return value as unknown as SessionMetadata;
}

function snapshot(usage: unknown): unknown {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    model: "gpt-5",
    lastTokenUsage: usage,
  };
}

describe("extractCodexRuntimeMetadata", () => {
  describe("blob-level guards", () => {
    it("returns null for null metadata", () => {
      expect(extractCodexRuntimeMetadata(null)).toBeNull();
    });

    it("returns null for undefined metadata", () => {
      expect(
        extractCodexRuntimeMetadata(undefined as unknown as SessionMetadata)
      ).toBeNull();
    });

    it("returns null for a string blob", () => {
      expect(
        extractCodexRuntimeMetadata(asMetadata("not-an-object"))
      ).toBeNull();
    });

    it("returns null for a number blob", () => {
      expect(extractCodexRuntimeMetadata(asMetadata(42))).toBeNull();
    });

    it("returns null for an array blob", () => {
      expect(extractCodexRuntimeMetadata(asMetadata([1, 2, 3]))).toBeNull();
    });

    it("returns null for an empty object (no signals present)", () => {
      expect(extractCodexRuntimeMetadata(asMetadata({}))).toBeNull();
    });

    it("returns null when only unrelated keys are present", () => {
      expect(
        extractCodexRuntimeMetadata(
          asMetadata({ branch: "main", sessionId: "abc" })
        )
      ).toBeNull();
    });
  });

  describe("modelContextWindow", () => {
    it("returns a valid finite non-negative number", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 128_000 })
      );
      expect(result?.modelContextWindow).toBe(128_000);
    });

    it("nulls out a negative value while preserving the rest of the record", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: -5,
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result).not.toBeNull();
      expect(result?.modelContextWindow).toBeNull();
    });

    it("nulls out NaN", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: Number.NaN,
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.modelContextWindow).toBeNull();
    });

    it("nulls out Infinity", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: Number.POSITIVE_INFINITY,
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.modelContextWindow).toBeNull();
    });

    it("nulls out a non-number (wrong-typed) value", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: "200000",
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.modelContextWindow).toBeNull();
    });

    // TRIPWIRE (ISS-9171): pins current main behavior, which looks odd. This
    // blob crosses the cloud sync boundary, so a fractional context window is a
    // corrupt reading, and flooring it renders a credible-looking 128,000-token
    // window rather than the unavailable state AGENTS.md ("Handling Bad or
    // Nonsensical Data") calls for. A coverage PR never changes behavior; this
    // test pins the current answer so a behavior PR breaks here on purpose.
    it("floors a fractional value", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 128_000.9 })
      );
      expect(result?.modelContextWindow).toBe(128_000);
    });

    it("accepts zero as a real (if degenerate) signal, distinct from absent", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 0 })
      );
      expect(result).not.toBeNull();
      expect(result?.modelContextWindow).toBe(0);
    });
  });

  describe("codexLastTokenUsage", () => {
    it("populates latestTokenUsage from a single valid entry", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            snapshot({ input: 100, output: 50, cacheRead: 10, cacheWrite: 5 }),
          ],
        })
      );
      expect(result?.latestTokenUsage).toEqual({
        input: 100,
        output: 50,
        cacheRead: 10,
        cacheWrite: 5,
        total: 165,
      });
    });

    it("returns null latestTokenUsage for an empty array", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 1000, codexLastTokenUsage: [] })
      );
      expect(result?.latestTokenUsage).toBeNull();
    });

    it("returns null latestTokenUsage when the field is not an array", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 1000, codexLastTokenUsage: "nope" })
      );
      expect(result?.latestTokenUsage).toBeNull();
    });

    it("rejects an all-zero entry — a zero total never counts as a last-good reading", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 1000,
          codexLastTokenUsage: [
            snapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.latestTokenUsage).toBeNull();
    });

    it("scans backward past a trailing malformed entry to find the last good one", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            snapshot({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }), // total 10, would be shadowed
            snapshot({ input: 300, output: 100, cacheRead: 0, cacheWrite: 0 }), // last good: total 400
            "garbage-not-an-object",
          ],
        })
      );
      expect(result?.latestTokenUsage?.total).toBe(400);
    });

    it("scans backward past a trailing all-zero entry to find the last good one", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            snapshot({ input: 20, output: 5, cacheRead: 0, cacheWrite: 0 }), // last good: total 25
            snapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.latestTokenUsage?.total).toBe(25);
    });

    it("returns null when every entry is malformed or zero", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 1000,
          codexLastTokenUsage: [
            "garbage",
            snapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
            snapshot(null),
          ],
        })
      );
      expect(result?.latestTokenUsage).toBeNull();
    });

    // TRIPWIRE (ISS-9171): pins current main behavior, which looks odd. A
    // wrong-typed counter in a cloud-synced snapshot becomes 0 and the entry is
    // still reported as a valid total, so the panel presents a silently
    // undercounted turn and a credible but wrong utilization percentage.
    // AGENTS.md ("Handling Bad or Nonsensical Data") would reject the snapshot
    // and fall back to the last-good/null path instead. A coverage PR never
    // changes behavior; this test pins the current answer so a behavior PR
    // breaks here on purpose.
    it("defaults an individual malformed count field to 0 rather than rejecting the whole entry", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            snapshot({
              input: "not-a-number",
              output: 40,
              cacheRead: 0,
              cacheWrite: 0,
            }),
          ],
        })
      );
      expect(result?.latestTokenUsage).toEqual({
        input: 0,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        total: 40,
      });
    });

    it("never surfaces raw text fields alongside the numeric counts", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            {
              timestamp: "2026-01-01T00:00:00.000Z",
              reasoning: "private chain of thought",
              lastTokenUsage: {
                input: 5,
                output: 3,
                cacheRead: 0,
                cacheWrite: 0,
                reasoningText: "also private",
              },
            },
          ],
        })
      );
      expect(result?.latestTokenUsage).toEqual({
        input: 5,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        total: 8,
      });
      expect(JSON.stringify(result)).not.toContain("private");
    });
  });

  describe("codexRateLimits", () => {
    it("populates rateLimits from a valid primary window", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexRateLimits: {
            primary: {
              used_percent: 42.6,
              window_minutes: 300,
              resets_at: 1_780_960_632,
            },
            secondary: null,
          },
        })
      );
      expect(result?.rateLimits?.primary).toEqual({
        usedPercent: 42.6,
        windowMinutes: 300,
        resetsAtEpochSeconds: 1_780_960_632,
      });
      expect(result?.rateLimits?.secondary).toBeNull();
    });

    it("returns null rateLimits when both windows are null", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 1000,
          codexRateLimits: { primary: null, secondary: null },
        })
      );
      expect(result?.rateLimits).toBeNull();
    });

    it("returns null rateLimits when both windows are malformed (no recognized fields)", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 1000,
          codexRateLimits: { primary: { unrelated: 1 }, secondary: "nope" },
        })
      );
      expect(result?.rateLimits).toBeNull();
    });

    it("returns null rateLimits when codexRateLimits itself is not an object", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 1000, codexRateLimits: "nope" })
      );
      expect(result?.rateLimits).toBeNull();
    });

    it("populates only secondary when primary is absent", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexRateLimits: {
            secondary: {
              used_percent: 5,
              window_minutes: 10_080,
              resets_at: 1_782_423_905,
            },
          },
        })
      );
      expect(result?.rateLimits?.primary).toBeNull();
      expect(result?.rateLimits?.secondary).toEqual({
        usedPercent: 5,
        windowMinutes: 10_080,
        resetsAtEpochSeconds: 1_782_423_905,
      });
    });

    it("clamps used_percent above 100 down to 100", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexRateLimits: { primary: { used_percent: 150 }, secondary: null },
        })
      );
      expect(result?.rateLimits?.primary?.usedPercent).toBe(100);
    });

    it("clamps a negative used_percent up to 0", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexRateLimits: { primary: { used_percent: -10 }, secondary: null },
        })
      );
      expect(result?.rateLimits?.primary?.usedPercent).toBe(0);
    });

    it("nulls a malformed window_minutes/resets_at without discarding a valid used_percent", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexRateLimits: {
            primary: {
              used_percent: 20,
              window_minutes: -1,
              resets_at: "not-a-number",
            },
            secondary: null,
          },
        })
      );
      expect(result?.rateLimits?.primary).toEqual({
        usedPercent: 20,
        windowMinutes: null,
        resetsAtEpochSeconds: null,
      });
    });
  });

  describe("contextWindowUtilizationPercent", () => {
    it("computes (total / modelContextWindow) * 100 when both are present", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 200_000,
          codexLastTokenUsage: [
            snapshot({
              input: 40_000,
              output: 8000,
              cacheRead: 10_000,
              cacheWrite: 2000,
            }),
          ],
        })
      );
      // total = 60,000 / 200,000 = 30%
      expect(result?.contextWindowUtilizationPercent).toBeCloseTo(30);
    });

    it("clamps utilization to 100 when usage exceeds the reported window", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 1000,
          codexLastTokenUsage: [
            snapshot({ input: 2000, output: 500, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.contextWindowUtilizationPercent).toBe(100);
    });

    it("is null when modelContextWindow is missing", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.modelContextWindow).toBeNull();
      expect(result?.contextWindowUtilizationPercent).toBeNull();
    });

    it("is null when latestTokenUsage is missing", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({ modelContextWindow: 128_000 })
      );
      expect(result?.latestTokenUsage).toBeNull();
      expect(result?.contextWindowUtilizationPercent).toBeNull();
    });

    it("is null when modelContextWindow is exactly 0, even with a valid latestTokenUsage", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          modelContextWindow: 0,
          codexLastTokenUsage: [
            snapshot({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
          ],
        })
      );
      expect(result?.modelContextWindow).toBe(0);
      expect(result?.contextWindowUtilizationPercent).toBeNull();
    });
  });

  describe("full metadata blob", () => {
    it("populates every field from a fully-formed Codex payload", () => {
      const result = extractCodexRuntimeMetadata(
        asMetadata({
          branch: "fea-3703",
          modelContextWindow: 400_000,
          codexLastTokenUsage: [
            snapshot({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }), // stale, superseded
            snapshot({
              input: 80_000,
              output: 20_000,
              cacheRead: 0,
              cacheWrite: 0,
            }), // last good: total 100,000
          ],
          codexRateLimits: {
            primary: {
              used_percent: 25,
              window_minutes: 300,
              resets_at: 1_780_960_632,
            },
            secondary: {
              used_percent: 60,
              window_minutes: 10_080,
              resets_at: 1_782_423_905,
            },
          },
        })
      );

      expect(result).toEqual({
        modelContextWindow: 400_000,
        latestTokenUsage: {
          input: 80_000,
          output: 20_000,
          cacheRead: 0,
          cacheWrite: 0,
          total: 100_000,
        },
        // 100,000 / 400,000 = 25%
        contextWindowUtilizationPercent: 25,
        rateLimits: {
          primary: {
            usedPercent: 25,
            windowMinutes: 300,
            resetsAtEpochSeconds: 1_780_960_632,
          },
          secondary: {
            usedPercent: 60,
            windowMinutes: 10_080,
            resetsAtEpochSeconds: 1_782_423_905,
          },
        },
      });
    });
  });
});
