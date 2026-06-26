import { describe, expect, it } from "vitest";
import { TelemetryAttribute } from "../src/attributes";
import { GenAiTelemetrySchema } from "../src/gen-ai";
import { genAiPayload } from "../src/test-fixtures";

describe("GenAiTelemetrySchema", () => {
  it("accepts model, response id, bounded token counts, and USD cost", () => {
    expect(
      GenAiTelemetrySchema.parse({
        [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
        [TelemetryAttribute.GenAiResponseId]: "resp_abc123",
        [TelemetryAttribute.GenAiUsageInputTokens]: 10,
        [TelemetryAttribute.GenAiUsageOutputTokens]: 20,
        [TelemetryAttribute.GenAiUsageCacheCreationInputTokens]: 3,
        [TelemetryAttribute.GenAiUsageCacheReadInputTokens]: 4,
        [TelemetryAttribute.GenAiCostUsage]: 0.0234,
      })
    ).toMatchObject({
      [TelemetryAttribute.GenAiRequestModel]: "gpt-5",
      [TelemetryAttribute.GenAiResponseId]: "resp_abc123",
      [TelemetryAttribute.GenAiCostUsage]: 0.0234,
    });
  });

  it("accepts a zero and large fractional USD cost", () => {
    for (const cost of [0, 1234.56]) {
      expect(
        GenAiTelemetrySchema.safeParse(
          genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: cost })
        ).success
      ).toBe(true);
    }
  });

  it("rejects missing model, invalid tokens, invalid cost, wrong types, and unknown attributes", () => {
    for (const payload of [
      {},
      genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: -0.01 }),
      genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: Number.NaN }),
      genAiPayload({
        [TelemetryAttribute.GenAiCostUsage]: Number.POSITIVE_INFINITY,
      }),
      genAiPayload({ [TelemetryAttribute.GenAiCostUsage]: "0.02" }),
      genAiPayload({ [TelemetryAttribute.GenAiUsageInputTokens]: -1 }),
      genAiPayload({ [TelemetryAttribute.GenAiUsageInputTokens]: 1.5 }),
      genAiPayload({
        [TelemetryAttribute.GenAiUsageInputTokens]: Number.NaN,
      }),
      genAiPayload({
        [TelemetryAttribute.GenAiUsageInputTokens]: Number.POSITIVE_INFINITY,
      }),
      genAiPayload({
        [TelemetryAttribute.GenAiUsageInputTokens]: 1_000_000_001,
      }),
      genAiPayload({ [TelemetryAttribute.GenAiUsageOutputTokens]: "20" }),
      genAiPayload({ [TelemetryAttribute.GenAiResponseId]: "" }),
      genAiPayload({ [TelemetryAttribute.GenAiResponseId]: 123 }),
      genAiPayload({ [TelemetryAttribute.GenAiResponseId]: "resp\nabc" }),
      genAiPayload({ "gen_ai.system": "anthropic" }),
    ]) {
      expect(GenAiTelemetrySchema.safeParse(payload).success).toBe(false);
    }
  });
});
