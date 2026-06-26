import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getInstallationAccessToken,
  getInstallationOctokit,
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
    mockAuth.mockResolvedValue({ token: "installation-token" });
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
});
