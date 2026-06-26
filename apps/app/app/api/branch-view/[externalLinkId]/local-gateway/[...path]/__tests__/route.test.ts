// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuth = vi.hoisted(() => vi.fn());
const mockExecuteOperation = vi.hoisted(() => vi.fn());
const mockSetRefreshToken = vi.hoisted(() => vi.fn());

vi.mock("@repo/auth/server", () => ({
  auth: mockAuth,
}));

vi.mock("@/env", () => ({
  env: {
    INTERNAL_API_SECRET: "internal-secret",
  },
}));

vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "http://api.test",
}));

vi.mock("@/lib/engineer/relay-client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/engineer/relay-client")
  >("@/lib/engineer/relay-client");
  return {
    ...actual,
    RelayClient: vi.fn(function RelayClient() {
      return {
        executeOperation: mockExecuteOperation,
        setRefreshToken: mockSetRefreshToken,
      };
    }),
  };
});

const { GET, POST } = await import("../route");

function createRequest(
  method: "GET" | "POST",
  url: string,
  init: RequestInit = {}
): Parameters<typeof GET>[0] {
  const nextUrl = new URL(url);
  const request = new Request(nextUrl, { ...init, method });
  Object.defineProperty(request, "nextUrl", { value: nextUrl });
  return request as Parameters<typeof GET>[0];
}

const routeParams = {
  params: Promise.resolve({
    externalLinkId: "ext-1",
    path: ["git", "local-changes", "commit-push"],
  }),
};

describe("Branch View local gateway route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      userId: "user_123",
      getToken: vi.fn().mockResolvedValue("auth-token"),
    });
    mockExecuteOperation.mockResolvedValue({
      value: {
        status: 200,
        body: { success: true },
      },
    });
  });

  it("passes browser command-signing fields into RelayClient local-content execution", async () => {
    const response = await POST(
      createRequest(
        "POST",
        "http://app.test/api/branch-view/ext-1/local-gateway/git/local-changes/commit-push",
        {
          body: JSON.stringify({
            repoPath: "/repo",
            repoFullName: "acme/widget",
            headBranch: "feature",
            prNumber: "42",
            message: "Update widget",
          }),
          headers: {
            "content-type": "application/json",
            "x-compute-target": "target-1",
            "x-command-id": "cmd-signed",
            "x-command-public-key-fingerprint": "fingerprint",
            "x-command-signature": "signature",
            "x-command-signature-payload": "payload",
          },
        }
      ),
      routeParams
    );

    expect(response.status).toBe(200);
    expect(mockExecuteOperation).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-desktop-approval-reason":
            "Commit and push local Branch View changes for acme/widget#42",
          "x-desktop-force-approval": "1",
        }),
        path: "/api/gateway/git/local-changes/commit-push",
      }),
      {
        commandId: "cmd-signed",
        publicKeyFingerprint: "fingerprint",
        signature: "signature",
        signaturePayload: "payload",
      },
      { localContent: true }
    );
  });

  it("rejects incomplete command-signing fields before creating a relay command", async () => {
    const response = await GET(
      createRequest(
        "GET",
        "http://app.test/api/branch-view/ext-1/local-gateway/git/local-changes?repoPath=/repo&repoFullName=acme/widget&headBranch=feature&prNumber=42",
        {
          headers: {
            "x-compute-target": "target-1",
            "x-command-id": "cmd-partial",
          },
        }
      ),
      {
        params: Promise.resolve({
          externalLinkId: "ext-1",
          path: ["git", "local-changes"],
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Incomplete command signing headers",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON bodies before creating a relay command", async () => {
    const response = await POST(
      createRequest(
        "POST",
        "http://app.test/api/branch-view/ext-1/local-gateway/git/local-changes/diff",
        {
          body: "{",
          headers: {
            "content-type": "application/json",
            "x-compute-target": "target-1",
          },
        }
      ),
      {
        params: Promise.resolve({
          externalLinkId: "ext-1",
          path: ["git", "local-changes", "diff"],
        }),
      }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON body",
    });
    expect(mockExecuteOperation).not.toHaveBeenCalled();
  });

  it("returns 502 when the relay response is missing the HTTP envelope", async () => {
    mockExecuteOperation.mockResolvedValueOnce({
      value: { success: true },
    });

    const response = await GET(
      createRequest(
        "GET",
        "http://app.test/api/branch-view/ext-1/local-gateway/git/local-changes?repoPath=/repo&repoFullName=acme/widget&headBranch=feature&prNumber=42",
        {
          headers: {
            "x-compute-target": "target-1",
          },
        }
      ),
      {
        params: Promise.resolve({
          externalLinkId: "ext-1",
          path: ["git", "local-changes"],
        }),
      }
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Relay response missing expected envelope",
    });
  });
});
