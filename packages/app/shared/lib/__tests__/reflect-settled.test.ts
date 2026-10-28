import { describe, expect, it } from "vitest";
import { reflectToSettled } from "../reflect-settled";

describe("reflectToSettled", () => {
  it("resolves a fulfilled result for a resolved promise", async () => {
    const result = await reflectToSettled(Promise.resolve("ok"));

    expect(result).toEqual({ status: "fulfilled", value: "ok" });
  });

  it("resolves a rejected result for a rejected promise instead of throwing", async () => {
    const error = new Error("boom");

    await expect(reflectToSettled(Promise.reject(error))).resolves.toEqual({
      status: "rejected",
      reason: error,
    });
  });
});
