import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PRICING,
  getModelPricing,
  MODEL_PRICING,
  normalizeModelName,
} from "../src/tokens";

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeModelName", () => {
  it("strips date suffixes", () => {
    expect(normalizeModelName("claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5"
    );
    expect(normalizeModelName("claude-haiku-4-5-20251001")).toBe(
      "claude-haiku-4-5"
    );
  });

  it("preserves versioned model names", () => {
    expect(normalizeModelName("claude-opus-4-6")).toBe("claude-opus-4-6");
    expect(normalizeModelName("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
  });

  it("preserves already-canonical names", () => {
    expect(normalizeModelName("claude-opus-4")).toBe("claude-opus-4");
    expect(normalizeModelName("claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
  });

  it("passes through unknown models unchanged", () => {
    expect(normalizeModelName("gpt-4o")).toBe("gpt-4o");
    expect(normalizeModelName("custom-model")).toBe("custom-model");
  });
});

describe("getModelPricing", () => {
  it("retries the live pricing fetch after a failed first attempt", async () => {
    vi.resetModules();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(
        new Response(
          "| Model | Input | Output | Cache Read | Cache Write |\n| Claude Sonnet 4.5 | $3.00 | $15.00 | $0.30 | $3.75 |",
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);

    const tokens = await import("../src/tokens");
    expect(tokens.getModelPricing("claude-sonnet-4-5")).toEqual(
      MODEL_PRICING["claude-sonnet-4-5"]
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tokens.getModelPricing("claude-sonnet-4-5")).toEqual(
      MODEL_PRICING["claude-sonnet-4-5"]
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns pricing for known models", () => {
    const pricing = getModelPricing("claude-sonnet-4-5");
    expect(pricing.input).toBe(3);
    expect(pricing.output).toBe(15);
  });

  it("falls back to default for unknown models", () => {
    const pricing = getModelPricing("unknown-model");
    expect(pricing).toEqual(DEFAULT_PRICING);
  });

  it("matches by prefix", () => {
    const pricing = getModelPricing("claude-3-5-sonnet-20251001");
    expect(pricing.input).toBe(3);
    expect(pricing.output).toBe(15);
  });

  it("prefers the longest prefix for dated gpt-5-mini/nano ids", () => {
    // "gpt-5" is defined before "gpt-5-mini"/"gpt-5-nano" in MODEL_PRICING, so a
    // first-match prefix scan would misprice these dashed-date ids as gpt-5.
    expect(getModelPricing("gpt-5-mini-2025-08-07")).toEqual(
      MODEL_PRICING["gpt-5-mini"]
    );
    expect(getModelPricing("gpt-5-nano-2025-08-07")).toEqual(
      MODEL_PRICING["gpt-5-nano"]
    );
    expect(getModelPricing("gpt-5-codex-2025-08-07")).toEqual(
      MODEL_PRICING["gpt-5-codex"]
    );
  });

  it("returns big-pickle as free", () => {
    const pricing = getModelPricing("big-pickle");
    expect(pricing.input).toBe(0);
    expect(pricing.output).toBe(0);
  });

  it("MODEL_PRICING has a default fallback", () => {
    expect(MODEL_PRICING.default).toEqual(DEFAULT_PRICING);
  });

  it("drops live rows with NaN cache pricing instead of poisoning the cache", async () => {
    vi.resetModules();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            "| Model | Input | Output | Cache Read | Cache Write |",
            "| Claude Sonnet 4.5 | $9.00 | $19.00 | $0.90 | $bad |",
          ].join("\n"),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);

    const tokens = await import("../src/tokens");
    expect(tokens.getModelPricing("claude-sonnet-4-5")).toEqual(
      MODEL_PRICING["claude-sonnet-4-5"]
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(tokens.getModelPricing("claude-sonnet-4-5")).toEqual(
      MODEL_PRICING["claude-sonnet-4-5"]
    );
  });

  it("parses Free cache-write values from live pricing", async () => {
    vi.resetModules();
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          [
            "| Model | Input | Output | Cache Read | Cache Write |",
            "| GPT 5.2 | $1.75 | $14.00 | $0.175 | Free |",
          ].join("\n"),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetch);

    const tokens = await import("../src/tokens");
    tokens.getModelPricing("gpt-5.2");
    await Promise.resolve();
    await Promise.resolve();

    expect(tokens.getModelPricing("gpt-5.2")).toEqual({
      input: 1.75,
      output: 14,
      cacheRead: 0.175,
      cacheWrite: 0,
    });
  });
});
