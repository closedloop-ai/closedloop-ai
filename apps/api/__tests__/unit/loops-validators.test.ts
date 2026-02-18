import { describe, expect, it } from "vitest";
import { loopEventPayloadValidator } from "@/app/loops/validators";

describe("loop event payload validator", () => {
  it("accepts small envelope payload", () => {
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      data: { chunk: "ok" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects oversized envelope payload", () => {
    const big = "x".repeat(21_000_000);
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      data: { chunk: big },
    });
    expect(result.success).toBe(false);
  });

  it("rejects oversized flattened payload", () => {
    const big = "x".repeat(21_000_000);
    const result = loopEventPayloadValidator.safeParse({
      type: "output",
      chunk: big,
    });
    expect(result.success).toBe(false);
  });
});
