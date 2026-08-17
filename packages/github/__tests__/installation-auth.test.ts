import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInstallationAccessToken,
  getInstallationOctokit,
  resetInstallationAuthCachesForTests,
} from "../installation-auth";

const { mockAuth, mockAppRequest } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockAppRequest: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => mockAuth),
}));

vi.mock("@octokit/rest", () => ({
  // Must be constructible (`new Octokit(...)`), so a function expression
  // rather than an arrow; returning an object gives each construction its own
  // identity while exposing the `request` handed to the app auth strategy.
  Octokit: vi.fn(function octokitMock() {
    return { request: mockAppRequest };
  }),
}));

vi.mock("../keys", () => ({
  keys: () => ({
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: "private-key",
  }),
}));

describe("installation auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    resetInstallationAuthCachesForTests();
    mockAuth.mockResolvedValue({ token: "installation-token" });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an installation-authenticated Octokit from package-owned auth", async () => {
    await getInstallationOctokit("456");

    expect(createAppAuth).toHaveBeenCalledWith({
      appId: "123",
      privateKey: "private-key",
      // The token exchange runs through a client built with the bounded fetch,
      // so a hung token endpoint cannot outlive the caller's own deadline.
      request: mockAppRequest,
    });
    expect(mockAuth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 456,
    });
    expect(Octokit).toHaveBeenCalledWith({
      auth: "installation-token",
      request: { fetch: expect.any(Function) },
    });
  });

  it("bounds every GitHub call with a per-request timeout signal", async () => {
    await getInstallationOctokit("456");

    const options = vi.mocked(Octokit).mock.calls[0]?.[0] as {
      request: { fetch: typeof fetch };
    };
    const wrappedFetch = options.request.fetch;

    const underlyingFetch = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal("fetch", underlyingFetch);
    try {
      await wrappedFetch("https://api.github.com/repos/o/r/git/blobs/sha");
    } finally {
      vi.unstubAllGlobals();
    }

    expect(underlyingFetch).toHaveBeenCalledTimes(1);
    const init = underlyingFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  });

  it("returns the installation access token without constructing a user-token client", async () => {
    await expect(getInstallationAccessToken("789")).resolves.toBe(
      "installation-token"
    );
    expect(mockAuth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 789,
    });
    expect(installationClientConstructions()).toBe(0);
  });

  it("reuses app auth, installation tokens, and Octokit clients while the token is fresh", async () => {
    mockAuth.mockResolvedValue({
      token: "cached-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });

    await getInstallationOctokit("456");
    await getInstallationOctokit("456");
    await getInstallationAccessToken("456");

    expect(createAppAuth).toHaveBeenCalledTimes(1);
    expect(mockAuth).toHaveBeenCalledTimes(1);
    expect(installationClientConstructions()).toBe(1);
  });

  it("evicts expired installation tokens and their Octokit clients", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T01:00:00Z"));
    mockAuth
      .mockResolvedValueOnce({
        token: "first-token",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .mockResolvedValueOnce({
        token: "second-token",
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      });

    await getInstallationOctokit("456");
    vi.setSystemTime(new Date("2026-07-03T01:59:01Z"));
    await getInstallationOctokit("456");

    expect(mockAuth).toHaveBeenCalledTimes(2);
    expect(installationClientConstructions()).toBe(2);
    expect(Octokit).toHaveBeenLastCalledWith({
      auth: "second-token",
      request: { fetch: expect.any(Function) },
    });
  });

  it("caps cached installation tokens and Octokit clients", async () => {
    mockAuth.mockImplementation(
      async ({ installationId }: { installationId: number }) => ({
        token: `token-${installationId}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    );

    for (let installationId = 1; installationId <= 501; installationId++) {
      await getInstallationOctokit(String(installationId));
    }
    await getInstallationOctokit("1");

    expect(mockAuth).toHaveBeenCalledTimes(502);
    expect(installationClientConstructions()).toBe(502);
  });
});

/**
 * Installation-authenticated client constructions, excluding the single
 * unauthenticated client whose `request` bounds the app-auth token exchange.
 */
function installationClientConstructions(): number {
  return vi.mocked(Octokit).mock.calls.filter((call) => Boolean(call[0]?.auth))
    .length;
}
