/**
 * Route tests for POST /ai/prd.
 *
 * Covers FEA-2560: the request body is Zod/UIMessage-validated (shape + size
 * bounds) before it reaches `agents.generatePRD`, so malformed or oversized
 * `messages[]` payloads are rejected with a 4xx instead of being forwarded to
 * the agent (which would surface as a cryptic 500 or resource exhaustion).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

let mockIsAuthenticated = true;

vi.mock("@repo/auth/server", () => ({
  auth: () => Promise.resolve({ isAuthenticated: mockIsAuthenticated }),
}));

// Keep the real `safeValidateUIMessages` (the validation under test); stub only
// the streaming entrypoint so the route does not spin up a real agent stream.
const streamSentinel = new Response("stream", { status: 200 });
vi.mock("@repo/ai/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/ai/server")>();
  return {
    ...actual,
    createAgentUIStreamResponse: vi.fn(() => streamSentinel),
  };
});

// Spy on the logger so the streaming `onError` handler's telemetry can be
// asserted without emitting real log output.
vi.mock("@repo/observability/log", async () => {
  const { createLogMockModule } = await import("../fixtures/mock-modules");
  return createLogMockModule();
});

// --- Imports (after mocks) ---

import { createAgentUIStreamResponse } from "@repo/ai/server";
import { log } from "@repo/observability/log";
import { POST } from "@/app/ai/prd/route";
import { createMockRequest } from "../utils/auth-helpers";

const validMessages = [
  { id: "1", role: "user", parts: [{ type: "text", text: "Draft a PRD" }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockIsAuthenticated = true;
});

describe("POST /ai/prd", () => {
  it("returns 401 when the request is not authenticated", async () => {
    mockIsAuthenticated = false;

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: validMessages },
      })
    );

    expect(response.status).toBe(401);
    expect(createAgentUIStreamResponse).not.toHaveBeenCalled();
  });

  it("forwards validated messages to the agent for a well-formed body", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: validMessages },
      })
    );

    expect(response).toBe(streamSentinel);
    expect(createAgentUIStreamResponse).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(createAgentUIStreamResponse).mock.calls[0][0];
    expect(callArg.uiMessages).toHaveLength(1);
  });

  it("passes an onError that logs the failure and returns a controlled message", async () => {
    await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: validMessages },
      })
    );

    // FEA-2692: streaming errors thrown after the Response is returned reach
    // this handler (not the route's try/catch). It must log for telemetry and
    // return a controlled, non-leaking message to surface in the data stream.
    const { onError } = vi.mocked(createAgentUIStreamResponse).mock.calls[0][0];
    expect(onError).toBeTypeOf("function");

    const clientMessage = onError?.(new Error("upstream boom"));

    expect(log.error).toHaveBeenCalledWith("upstream boom");
    expect(clientMessage).toBe(
      "Something went wrong while generating the PRD."
    );
  });

  it("returns 400 when messages is missing or not an array", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: "not-an-array" },
      })
    );

    expect(response.status).toBe(400);
    expect(createAgentUIStreamResponse).not.toHaveBeenCalled();
  });

  it("returns 400 when a message has a malformed shape", async () => {
    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: [{ not: "a valid message" }] },
      })
    );

    expect(response.status).toBe(400);
    // Asserts the per-message `safeValidateUIMessages` layer ran (its distinct
    // error envelope), not just the coarse array schema.
    const json = await response.json();
    expect(json).toMatchObject({
      success: false,
      error: "Invalid messages payload",
    });
    expect(createAgentUIStreamResponse).not.toHaveBeenCalled();
  });

  it("returns 400 when the message count exceeds the bound", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => ({
      id: String(i),
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    }));

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: tooMany },
      })
    );

    expect(response.status).toBe(400);
    expect(createAgentUIStreamResponse).not.toHaveBeenCalled();
  });

  it("returns 413 when the request body exceeds the size bound", async () => {
    const oversized = [
      {
        id: "1",
        role: "user",
        parts: [{ type: "text", text: "x".repeat(1_100_000) }],
      },
    ];

    const response = await POST(
      createMockRequest({
        method: "POST",
        url: "http://localhost:3002/ai/prd",
        body: { messages: oversized },
      })
    );

    expect(response.status).toBe(413);
    expect(createAgentUIStreamResponse).not.toHaveBeenCalled();
  });
});
