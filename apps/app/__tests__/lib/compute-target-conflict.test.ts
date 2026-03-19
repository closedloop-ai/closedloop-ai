/**
 * Unit tests for parseComputeTargetConflict utility.
 * Verifies correct extraction of ComputeTargetConflictBody from unknown errors.
 */

import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-error";
import { parseComputeTargetConflict } from "@/lib/compute-target-conflict";

const makeValidConflictBody = () => ({
  error: "multiple_targets" as const,
  message: "Multiple compute targets available",
  availableTargets: [
    { id: "ct-1", machineName: "Mikes-MacBook", status: "online" },
    { id: "ct-2", machineName: "Office-Desktop", status: "offline" },
  ],
});

describe("parseComputeTargetConflict", () => {
  it("returns null for a plain Error", () => {
    const result = parseComputeTargetConflict(new Error("generic error"));

    expect(result).toBeNull();
  });

  it("returns null for a non-Error value", () => {
    const result = parseComputeTargetConflict("string error");

    expect(result).toBeNull();
  });

  it("returns null for ApiError with a non-409 status", () => {
    const error = new ApiError("Not Found", 404);

    expect(parseComputeTargetConflict(error)).toBeNull();
  });

  it("returns null for ApiError 409 with no data", () => {
    const error = new ApiError("Conflict", 409);

    expect(parseComputeTargetConflict(error)).toBeNull();
  });

  it("returns null for ApiError 409 where availableTargets is absent", () => {
    const error = new ApiError("Conflict", 409, undefined, {
      error: "multiple_targets",
      message: "no targets field",
    });

    expect(parseComputeTargetConflict(error)).toBeNull();
  });

  it("returns null for ApiError 409 where availableTargets is not an array", () => {
    const error = new ApiError("Conflict", 409, undefined, {
      error: "multiple_targets",
      message: "bad shape",
      availableTargets: "not-an-array",
    });

    expect(parseComputeTargetConflict(error)).toBeNull();
  });

  it("returns the conflict body for a valid 409 with availableTargets array", () => {
    const body = makeValidConflictBody();
    const error = new ApiError("Conflict", 409, undefined, body);

    const result = parseComputeTargetConflict(error);

    expect(result).toBe(body);
  });

  it("returns the conflict body when availableTargets is an empty array", () => {
    const body = {
      error: "multiple_targets" as const,
      message: "No targets online",
      availableTargets: [],
    };
    const error = new ApiError("Conflict", 409, undefined, body);

    const result = parseComputeTargetConflict(error);

    expect(result).toBe(body);
  });
});
