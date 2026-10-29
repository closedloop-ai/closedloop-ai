/**
 * ISS-6114 review: the Codex runtime-metadata half of `detail-content.test.ts`,
 * split out when adding the canonical-key LOC/$ case pushed that file past the
 * 1,000-line ceiling.
 *
 * Split by RESPONSIBILITY and at the seam that carries no allowlisted debt: the
 * LOC/$ block is the obvious cluster by subject, but its two version-skew cases
 * must name the retired `klocPerDollar` field and are pinned in
 * `scripts/lint/source-gate-allowlist.json` BY FILE PATH. Moving them would have
 * orphaned that entry and needed a new one, which the shrink-only ratchet
 * rejects. Codex runtime metadata is an unrelated concern and moves cleanly.
 */
import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import { extractCodexRuntimeMetadata } from "../codex-runtime-metadata";

type SessionMetadata = AgentSessionDetail["metadata"];

function codexMetadata(overrides: Record<string, unknown>): SessionMetadata {
  return { branch: "fea-3703", ...overrides } as SessionMetadata;
}

function tokenSnapshot(usage: unknown): unknown {
  return {
    timestamp: "2026-07-22T00:00:00.000Z",
    model: "gpt-5",
    lastTokenUsage: usage,
  };
}

describe("extractCodexRuntimeMetadata (FEA-3703)", () => {
  it("returns null for non-Codex sessions (no signal present)", () => {
    expect(extractCodexRuntimeMetadata(null)).toBeNull();
    expect(extractCodexRuntimeMetadata(codexMetadata({}))).toBeNull();
  });

  it("surfaces a fully populated snapshot (context window, latest usage, both rate-limit windows) with utilization", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 200_000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 40_000,
            output: 8000,
            cacheRead: 10_000,
            cacheWrite: 2000,
          }),
        ],
        codexRateLimits: {
          // resets_at values are absolute Unix epoch-seconds, matching the raw
          // Codex payload shape (see golden-sessions fixtures).
          primary: {
            used_percent: 42.6,
            window_minutes: 300,
            resets_at: 1_780_960_632,
          },
          secondary: {
            used_percent: 5,
            window_minutes: 10_080,
            resets_at: 1_782_423_905,
          },
        },
      })
    );
    expect(result).not.toBeNull();
    expect(result?.modelContextWindow).toBe(200_000);
    expect(result?.latestTokenUsage).toEqual({
      input: 40_000,
      output: 8000,
      cacheRead: 10_000,
      cacheWrite: 2000,
      total: 60_000,
    });
    // 60000 / 200000 = 30%
    expect(result?.contextWindowUtilizationPercent).toBeCloseTo(30);
    expect(result?.rateLimits?.primary).toEqual({
      usedPercent: 42.6,
      windowMinutes: 300,
      // resets_at is passed through verbatim as an absolute epoch-seconds value.
      resetsAtEpochSeconds: 1_780_960_632,
    });
    expect(result?.rateLimits?.secondary?.usedPercent).toBe(5);
  });

  it("preserves the PARTIAL case: only a context window, no usage, no rate limits", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({ modelContextWindow: 128_000 })
    );
    expect(result).toEqual({
      modelContextWindow: 128_000,
      latestTokenUsage: null,
      // utilization is undefined without a latest snapshot
      contextWindowUtilizationPercent: null,
      rateLimits: null,
    });
  });

  it("preserves the PARTIAL case: only rate limits (one window), no context window / usage", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        codexRateLimits: {
          primary: { used_percent: 90, window_minutes: null, resets_at: null },
          secondary: null,
        },
      })
    );
    expect(result?.modelContextWindow).toBeNull();
    expect(result?.latestTokenUsage).toBeNull();
    expect(result?.contextWindowUtilizationPercent).toBeNull();
    expect(result?.rateLimits?.primary).toEqual({
      usedPercent: 90,
      windowMinutes: null,
      resetsAtEpochSeconds: null,
    });
    expect(result?.rateLimits?.secondary).toBeNull();
  });

  it("returns null for the RESET snapshot: rate_limits present but every window null", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({ codexRateLimits: { primary: null, secondary: null } })
    );
    expect(result).toBeNull();
  });

  it("reads defensively against a MALFORMED synced blob (no throw, no bad values)", () => {
    // wrong-typed context window + non-array usage + non-object rate limits
    expect(
      extractCodexRuntimeMetadata(
        codexMetadata({
          modelContextWindow: "200000",
          codexLastTokenUsage: "nope",
          codexRateLimits: 42,
        })
      )
    ).toBeNull();
    // negative context window is dropped
    expect(
      extractCodexRuntimeMetadata(codexMetadata({ modelContextWindow: -5 }))
    ).toBeNull();
    // malformed used_percent is clamped/dropped, not leaked
    const clamped = extractCodexRuntimeMetadata(
      codexMetadata({
        codexRateLimits: {
          primary: { used_percent: 150, window_minutes: -1, resets_at: "x" },
          secondary: null,
        },
      })
    );
    expect(clamped?.rateLimits?.primary).toEqual({
      usedPercent: 100,
      windowMinutes: null,
      resetsAtEpochSeconds: null,
    });
  });

  it("falls back to the last GOOD snapshot when the freshest entry is malformed/zero (staleness/last-good)", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 100_000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 1000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
          }),
          tokenSnapshot({
            input: 9000,
            output: 1000,
            cacheRead: 0,
            cacheWrite: 0,
          }),
          // trailing garbage / zero-only entries must not blank the reading
          tokenSnapshot({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
          tokenSnapshot("garbage"),
        ],
      })
    );
    // last GOOD = the {9000,1000} snapshot, total 10000 -> 10% of 100000
    expect(result?.latestTokenUsage?.total).toBe(10_000);
    expect(result?.contextWindowUtilizationPercent).toBeCloseTo(10);
  });

  it("clamps utilization to 100% when a turn exceeds the reported window (never a >100% lie)", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        modelContextWindow: 1000,
        codexLastTokenUsage: [
          tokenSnapshot({
            input: 2000,
            output: 500,
            cacheRead: 0,
            cacheWrite: 0,
          }),
        ],
      })
    );
    expect(result?.contextWindowUtilizationPercent).toBe(100);
  });

  it("never surfaces raw reasoning content — only aggregate COUNTS are read from the snapshot", () => {
    const result = extractCodexRuntimeMetadata(
      codexMetadata({
        codexLastTokenUsage: [
          {
            timestamp: "2026-07-22T00:00:00.000Z",
            model: "gpt-5",
            // an attacker-shaped blob carrying prose alongside the counts
            reasoning:
              "SECRET private chain of thought that must never surface",
            text: "raw assistant message body",
            lastTokenUsage: {
              input: 5,
              output: 3,
              cacheRead: 0,
              cacheWrite: 0,
              reasoningText: "also secret",
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
    // The view model has ONLY numeric count fields — no reasoning/text leak.
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("raw assistant message");
  });
});
