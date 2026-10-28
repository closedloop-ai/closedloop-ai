import { Status } from "@repo/api/src/types/result";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  authOptions: [] as unknown[],
  userId: "0199a1b2-0000-7000-8000-000000000002",
  organizationId: "0199a1b2-0000-7000-8000-000000000001",
  recordFeedback: vi.fn(),
}));

vi.mock("../auth", async () => {
  const { createTestAuthContext } = await import(
    "@/__tests__/utils/auth-helpers"
  );
  const { buildSessionMeshAuthMock } = await import(
    "@/__tests__/support/session-mesh/with-session-mesh-auth.test-helpers"
  );
  return {
    withSessionMeshAuth: buildSessionMeshAuthMock(mocks, createTestAuthContext),
  };
});
vi.mock("../service", () => ({
  sessionMeshService: { recordFeedback: mocks.recordFeedback },
}));

const WRITE_SCOPE = { requiredScopes: ["write"] };
const feedback = {
  idempotencyKey: "fb-1",
  kind: "useful",
  rationale: "avoided a conflict",
};

function post(body: unknown) {
  return POST(
    new NextRequest("https://api.example.test/session-mesh/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) }
  );
}

describe("POST /session-mesh/feedback", () => {
  it("rejects overhead feedback that omits its measurement", async () => {
    const response = await post({ ...feedback, kind: "coordination_overhead" });

    expect(response.status).toBe(400);
    expect(mocks.recordFeedback).not.toHaveBeenCalled();
  });

  it("maps a Forbidden feedback result to 403 session_mesh_feedback_forbidden", async () => {
    mocks.recordFeedback.mockResolvedValue({
      ok: false,
      error: Status.Forbidden,
    });

    const response = await post(feedback);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "session_mesh_feedback_forbidden",
    });
  });

  it("forwards the validated feedback with the caller org and user ids", async () => {
    mocks.recordFeedback.mockResolvedValue({ ok: true, value: { id: "e-1" } });

    const response = await post({ ...feedback, estimatedTimeSavedMinutes: 5 });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { event: { id: "e-1" } },
    });
    expect(mocks.recordFeedback).toHaveBeenCalledWith(
      {
        organizationId: mocks.organizationId,
        userId: mocks.userId,
        idempotencyKey: "fb-1",
        kind: "useful",
        rationale: "avoided a conflict",
        estimatedTimeSavedMinutes: 5,
      },
      undefined
    );
  });
});

describe("session mesh auth wiring", () => {
  it("passes the write scope to the auth wrapper for mutating handlers", () => {
    expect(mocks.authOptions).toEqual([WRITE_SCOPE]);
  });
});

describe("feedback route failures", () => {
  it("returns a 500 when recording throws", async () => {
    mocks.recordFeedback.mockRejectedValue(new Error("db down"));

    const response = await post(feedback);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to record Session Mesh feedback",
    });
  });
});
