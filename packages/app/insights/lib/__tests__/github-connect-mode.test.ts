import {
  type GitHubInstallationInfo,
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import {
  GitHubConnectMode,
  resolveGitHubConnectMode,
  resolveGitHubDataConnected,
} from "../github-connect-mode";

const installation: GitHubInstallationInfo = {
  id: "inst-1",
  installationId: "12345",
  accountLogin: "acme",
  accountType: "Organization",
  status: GitHubInstallationStatus.Active,
  repositorySelection: "all",
  repositoryCount: 3,
  claimedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function statusWithReasons(
  reasons: GitHubOAuthRequiredReason[]
): GitHubIntegrationStatus {
  return {
    connected: false,
    githubDataConnection: {
      connected: false,
      sources: [],
      oauthRequiredReasons: reasons,
    },
  };
}

describe("resolveGitHubConnectMode", () => {
  const recoveryReasons = [
    GitHubOAuthRequiredReason.CredentialExpired,
    GitHubOAuthRequiredReason.CredentialRevoked,
    GitHubOAuthRequiredReason.CredentialInsufficientScope,
    GitHubOAuthRequiredReason.ReconsentRequired,
  ] as const;

  it.each(
    recoveryReasons
  )("enters Authorize for user-grant recovery reason %s", (reason) => {
    expect(resolveGitHubConnectMode(statusWithReasons([reason]))).toBe(
      GitHubConnectMode.Authorize
    );
  });

  it("enters Install when the only reason is NoAppInstallation", () => {
    expect(
      resolveGitHubConnectMode(
        statusWithReasons([GitHubOAuthRequiredReason.NoAppInstallation])
      )
    ).toBe(GitHubConnectMode.Install);
  });

  it("lets a recovery reason win over NoAppInstallation", () => {
    expect(
      resolveGitHubConnectMode(
        statusWithReasons([
          GitHubOAuthRequiredReason.NoAppInstallation,
          GitHubOAuthRequiredReason.ReconsentRequired,
        ])
      )
    ).toBe(GitHubConnectMode.Authorize);
  });

  it("falls through to Authorize for reasons that are neither recovery nor NoAppInstallation", () => {
    expect(
      resolveGitHubConnectMode(
        statusWithReasons([GitHubOAuthRequiredReason.NoUserGrant])
      )
    ).toBe(GitHubConnectMode.Authorize);
  });

  it("falls through to Authorize for an empty reasons array", () => {
    expect(resolveGitHubConnectMode(statusWithReasons([]))).toBe(
      GitHubConnectMode.Authorize
    );
  });

  it("enters Install for a disconnected org with no reasons carrier", () => {
    expect(resolveGitHubConnectMode({ connected: false })).toBe(
      GitHubConnectMode.Install
    );
  });

  it("enters Authorize for a connected org with no reasons carrier", () => {
    expect(resolveGitHubConnectMode({ connected: true, installation })).toBe(
      GitHubConnectMode.Authorize
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)("enters Authorize for a %s status", (_label, status) => {
    expect(resolveGitHubConnectMode(status)).toBe(GitHubConnectMode.Authorize);
  });
});

describe("resolveGitHubDataConnected", () => {
  it("prefers githubDataConnection.connected === true over legacy connected", () => {
    expect(
      resolveGitHubDataConnected({
        connected: false,
        githubDataConnection: {
          connected: true,
          sources: [],
          oauthRequiredReasons: [],
        },
      })
    ).toBe(true);
  });

  it("prefers githubDataConnection.connected === false over legacy connected", () => {
    expect(
      resolveGitHubDataConnected({
        connected: true,
        installation,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [],
        },
      })
    ).toBe(false);
  });

  it("falls back to legacy connected === true when the carrier is absent", () => {
    expect(resolveGitHubDataConnected({ connected: true, installation })).toBe(
      true
    );
  });

  it("falls back to legacy connected === false when the carrier is absent", () => {
    expect(resolveGitHubDataConnected({ connected: false })).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)("returns undefined for a %s status", (_label, status) => {
    expect(resolveGitHubDataConnected(status)).toBeUndefined();
  });
});
