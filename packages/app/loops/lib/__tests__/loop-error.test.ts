import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { getLoopIdFromError } from "../loop-error";

describe("getLoopIdFromError", () => {
  it("returns null for non-ApiError values", () => {
    expect(getLoopIdFromError(new Error("boom"))).toBeNull();
    expect(getLoopIdFromError(null)).toBeNull();
    expect(getLoopIdFromError("loop-1")).toBeNull();
    expect(getLoopIdFromError({ loopId: "loop-1" })).toBeNull();
  });

  it("reads loopId from error.details", () => {
    const error = new ApiError("conflict", 409, {
      details: { loopId: "loop-details" },
    });

    expect(getLoopIdFromError(error)).toBe("loop-details");
  });

  it("reads loopId from error.data when details has none", () => {
    const error = new ApiError("conflict", 409, {
      data: { loopId: "loop-data" },
    });

    expect(getLoopIdFromError(error)).toBe("loop-data");
  });

  it("reads loopId from nested error.data.data", () => {
    const error = new ApiError("conflict", 409, {
      data: { data: { loopId: "loop-nested" } },
    });

    expect(getLoopIdFromError(error)).toBe("loop-nested");
  });

  it("prefers details over data when both carry a loopId", () => {
    const error = new ApiError("conflict", 409, {
      data: { loopId: "loop-data" },
      details: { loopId: "loop-details" },
    });

    expect(getLoopIdFromError(error)).toBe("loop-details");
  });

  it("returns null when no location carries a loopId", () => {
    const error = new ApiError("conflict", 409, {
      data: { other: "x" },
      details: { other: "y" },
    });

    expect(getLoopIdFromError(error)).toBeNull();
  });

  it("ignores empty-string and non-string loopId values", () => {
    expect(
      getLoopIdFromError(new ApiError("c", 409, { details: { loopId: "" } }))
    ).toBeNull();
    expect(
      getLoopIdFromError(new ApiError("c", 409, { data: { loopId: 42 } }))
    ).toBeNull();
  });
});
