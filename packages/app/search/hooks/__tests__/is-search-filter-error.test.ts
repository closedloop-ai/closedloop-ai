import { describe, expect, it } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { isSearchFilterError } from "../use-search";

// The search route 400s only for a malformed query/filter (`badRequestResponse`
// in apps/api/app/search/route.ts). Every other 4xx is auth/not-found/rate-limit
// and must NOT be surfaced verbatim as the inline filter banner, or a 401/403
// would leak an auth message into the results area and mask the generic failure.
describe("isSearchFilterError", () => {
  it("classifies a 400 as a filter error (message is safe to show inline)", () => {
    const error = new ApiError("Unknown priority value: huge", 400);
    expect(isSearchFilterError(error)).toBe(true);
  });

  it.each([
    401, 403, 404, 429,
  ])("does not classify a %i as a filter error", (status) => {
    const error = new ApiError("nope", status);
    expect(isSearchFilterError(error)).toBe(false);
  });

  it("does not classify a 5xx as a filter error", () => {
    const error = new ApiError("boom", 500);
    expect(isSearchFilterError(error)).toBe(false);
  });

  it("does not classify a plain Error or non-error value as a filter error", () => {
    expect(isSearchFilterError(new Error("Unknown priority value: huge"))).toBe(
      false
    );
    expect(isSearchFilterError("string")).toBe(false);
    expect(isSearchFilterError(null)).toBe(false);
  });
});
