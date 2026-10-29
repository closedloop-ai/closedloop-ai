import { OrganizationMembersErrorCode } from "@repo/api/src/types/organization-members";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logError: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: mocks.logError,
    flush: vi.fn(async () => undefined),
    info: vi.fn(),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn(),
}));

import {
  ClerkFailureKind,
  clerkFailureResponse,
  toClerkOperationFailure,
} from "./clerk-error-mapping";

const CONTEXT = {
  entity: "Organization",
  message: "Failed to list organization members",
};

describe("toClerkOperationFailure", () => {
  it("classifies a provider 404 as not found", () => {
    expect(toClerkOperationFailure({ status: 404 }).code).toBe(
      ClerkFailureKind.NotFound
    );
  });

  it("classifies a transport failure as provider-unavailable, never not-found", () => {
    expect(toClerkOperationFailure(new Error("ECONNRESET")).code).toBe(
      ClerkFailureKind.ProviderUnavailable
    );
  });

  it("classifies a provider 500 as provider-unavailable", () => {
    expect(toClerkOperationFailure({ status: 500 }).code).toBe(
      ClerkFailureKind.ProviderUnavailable
    );
  });

  it("keeps the thrown value so the route can log and attribute it", () => {
    const thrown = new Error("clerk unreachable");
    expect(toClerkOperationFailure(thrown).cause).toBe(thrown);
  });
});

describe("clerkFailureResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers a not-found failure with a 404 naming the entity", async () => {
    const response = clerkFailureResponse(
      toClerkOperationFailure({ status: 404 }),
      CONTEXT
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe("Organization not found");
  });

  it("answers an unreachable provider with a 503 carrying the code", async () => {
    const response = clerkFailureResponse(
      toClerkOperationFailure(new Error("clerk unreachable")),
      CONTEXT
    );

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe("Failed to list organization members");
    expect(body.code).toBe(OrganizationMembersErrorCode.ProviderUnavailable);
  });
});
