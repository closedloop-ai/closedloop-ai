import {
  GitHubOperationProviderResultStatus,
  GitHubProviderFailureStage,
  GitHubProviderResultStatus,
} from "@repo/github";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetInstallationOctokit, mockOctokit, mockLogWarn } = vi.hoisted(
  () => ({
    mockGetInstallationOctokit: vi.fn(),
    mockOctokit: { marker: "installation-octokit" },
    mockLogWarn: vi.fn(),
  })
);

vi.mock("@repo/github/installation-auth", () => ({
  getInstallationOctokit: (installationId: string) =>
    mockGetInstallationOctokit(installationId) ?? Promise.resolve(mockOctokit),
}));
vi.mock("@repo/observability/log", () => ({
  log: { warn: mockLogWarn },
}));

import {
  acquireInstallationClient,
  acquireInstallationClientWithStage,
  readWithInstallationClient,
} from "./installation-client";

const RATE_LIMITED_MINT = Object.assign(new Error("token endpoint throttled"), {
  status: 429,
  headers: { "retry-after": "45" },
});

describe("acquireInstallationClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the client as a success value", async () => {
    await expect(acquireInstallationClient("install-1")).resolves.toEqual({
      status: GitHubProviderResultStatus.Success,
      value: mockOctokit,
    });
    expect(mockGetInstallationOctokit).toHaveBeenCalledWith("install-1");
  });

  it("returns a rate-limit failure carrying the retry signal instead of throwing", async () => {
    mockGetInstallationOctokit.mockReturnValueOnce(
      Promise.reject(RATE_LIMITED_MINT)
    );

    await expect(acquireInstallationClient("install-1")).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 45,
    });
  });

  it("returns an unavailable failure for a non-rate-limit rejection", async () => {
    mockGetInstallationOctokit.mockReturnValueOnce(
      Promise.reject(new Error("token exchange failed"))
    );

    await expect(acquireInstallationClient("install-1")).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });

  it.each([
    [404, GitHubProviderResultStatus.ProviderInstallationNotFound],
    [401, GitHubProviderResultStatus.CredentialUnauthorized],
    [403, GitHubProviderResultStatus.ProviderPermissionFiltered],
  ])(
    "classifies HTTP %i at installation acquisition",
    async (status, expected) => {
      mockGetInstallationOctokit.mockReturnValueOnce(
        Promise.reject(Object.assign(new Error("mint rejected"), { status }))
      );

      await expect(
        acquireInstallationClientWithStage("install-1")
      ).resolves.toEqual({
        status: expected,
        stage: GitHubProviderFailureStage.InstallationClientAcquisition,
      });
    }
  );

  it.each([400, 405, 422, 501])(
    "terminally classifies installation HTTP %i for materialization callers",
    async (status) => {
      mockGetInstallationOctokit.mockReturnValueOnce(
        Promise.reject(Object.assign(new Error("mint rejected"), { status }))
      );

      await expect(
        acquireInstallationClientWithStage("install-1")
      ).resolves.toEqual({
        status: GitHubOperationProviderResultStatus.InvalidResponse,
        stage: GitHubProviderFailureStage.InstallationClientAcquisition,
      });
    }
  );

  it.each([408, 500, 502, 503, 504])(
    "keeps installation HTTP %i retryable for materialization callers",
    async (status) => {
      mockGetInstallationOctokit.mockReturnValueOnce(
        Promise.reject(Object.assign(new Error("mint unavailable"), { status }))
      );

      await expect(
        acquireInstallationClientWithStage("install-1")
      ).resolves.toEqual({
        status: GitHubProviderResultStatus.ProviderUnavailable,
        stage: GitHubProviderFailureStage.InstallationClientAcquisition,
      });
    }
  );

  it("preserves the legacy acquisition contract for a permanent response", async () => {
    mockGetInstallationOctokit.mockReturnValueOnce(
      Promise.reject(Object.assign(new Error("mint rejected"), { status: 422 }))
    );

    await expect(acquireInstallationClient("install-1")).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
    const logs = JSON.stringify(mockLogWarn.mock.calls);
    expect(logs).not.toContain("mint rejected");
    expect(mockLogWarn).toHaveBeenCalledWith(
      "[github/installation-client] Client acquisition failed",
      {
        installationId: "install-1",
        stage: GitHubProviderFailureStage.InstallationClientAcquisition,
        status: GitHubOperationProviderResultStatus.InvalidResponse,
      }
    );
  });
});

describe("readWithInstallationClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("threads the acquired client into the read and returns its result", async () => {
    const read = vi.fn().mockResolvedValue({
      status: GitHubProviderResultStatus.Success,
      value: "read-value",
    });

    const result = await readWithInstallationClient("install-1", read);

    expect(read).toHaveBeenCalledWith(mockOctokit);
    expect(result).toEqual({
      status: GitHubProviderResultStatus.Success,
      value: "read-value",
    });
  });

  it("reports a failed acquisition as the read's own failure shape without running the read", async () => {
    mockGetInstallationOctokit.mockReturnValueOnce(
      Promise.reject(RATE_LIMITED_MINT)
    );
    const read = vi.fn();

    const result = await readWithInstallationClient("install-1", read);

    expect(result).toEqual({
      status: GitHubProviderResultStatus.ProviderRateLimit,
      retryAfterSeconds: 45,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("passes a read failure through unchanged", async () => {
    const read = vi.fn().mockResolvedValue({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });

    await expect(
      readWithInstallationClient("install-1", read)
    ).resolves.toEqual({
      status: GitHubProviderResultStatus.ProviderUnavailable,
    });
  });

  it("does not swallow a defect thrown by the read itself", async () => {
    const defect = new Error("mapper bug");
    const read = vi.fn().mockRejectedValue(defect);

    // A throw from the read is a bug, not a provider outage; misreporting it as
    // ProviderUnavailable would hide it behind a retry.
    await expect(readWithInstallationClient("install-1", read)).rejects.toBe(
      defect
    );
  });
});
