import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInstallationAccessToken,
  getInstallationOctokit,
  resetInstallationAuthCachesForTests,
} from "../installation-auth";

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(() => mockAuth),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn(),
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
    });
    expect(mockAuth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 456,
    });
    expect(Octokit).toHaveBeenCalledWith({ auth: "installation-token" });
  });

  it("returns the installation access token without constructing a user-token client", async () => {
    await expect(getInstallationAccessToken("789")).resolves.toBe(
      "installation-token"
    );
    expect(mockAuth).toHaveBeenCalledWith({
      type: "installation",
      installationId: 789,
    });
    expect(Octokit).not.toHaveBeenCalled();
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
    expect(Octokit).toHaveBeenCalledTimes(1);
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
    expect(Octokit).toHaveBeenCalledTimes(2);
    expect(Octokit).toHaveBeenLastCalledWith({ auth: "second-token" });
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
    expect(Octokit).toHaveBeenCalledTimes(502);
  });
});
