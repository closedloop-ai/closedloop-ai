/**
 * Unit tests for webhook service functions.
 *
 * Tests the following functions:
 * - validateRequest: validates webhook request by parsing body and headers
 */
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn(),
}));

// Import after mocking
import { headers } from "next/headers";
import { validateRequest } from "@/app/webhooks/github/webhook-service";

const mockHeaders = headers as Mock;

describe("validateRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts body, signature, and eventType from request", async () => {
    const requestBody = JSON.stringify({ action: "opened" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=abcdef123456",
        "x-github-event": "pull_request",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headerValues = {
          "x-hub-signature-256": "sha256=abcdef123456",
          "x-github-event": "pull_request",
        };
        return headerValues[key as keyof typeof headerValues] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBe("pull_request");
  });

  it("returns null signature when header is missing", async () => {
    const requestBody = JSON.stringify({ action: "opened" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headerValues = {
          "x-github-event": "pull_request",
        };
        return headerValues[key as keyof typeof headerValues] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBeNull();
    expect(result.eventType).toBe("pull_request");
  });

  it("returns null eventType when header is missing", async () => {
    const requestBody = JSON.stringify({ action: "opened" });
    const request = new Request("http://localhost", {
      method: "POST",
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-hub-signature-256": "sha256=abcdef123456",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headerValues = {
          "x-hub-signature-256": "sha256=abcdef123456",
        };
        return headerValues[key as keyof typeof headerValues] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe(requestBody);
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBeNull();
  });

  it("handles empty request body", async () => {
    const request = new Request("http://localhost", {
      method: "POST",
      body: "",
      headers: {
        "x-hub-signature-256": "sha256=abcdef123456",
        "x-github-event": "ping",
      },
    });

    mockHeaders.mockResolvedValue({
      get: (key: string) => {
        const headerValues = {
          "x-hub-signature-256": "sha256=abcdef123456",
          "x-github-event": "ping",
        };
        return headerValues[key as keyof typeof headerValues] || null;
      },
    });

    const result = await validateRequest(request);

    expect(result.body).toBe("");
    expect(result.signature).toBe("sha256=abcdef123456");
    expect(result.eventType).toBe("ping");
  });
});
