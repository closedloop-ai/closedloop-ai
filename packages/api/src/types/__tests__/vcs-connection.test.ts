import { describe, expect, it } from "vitest";
import { GitHubInstallationStatus } from "../github";
import {
  GITHUB_DEFAULT_BASE_URL,
  projectGitHubInstallationToVcsConnection,
  VcsAuthKind,
} from "../vcs-connection";
import { VcsConnectionStatus } from "../vcs-neutral";

describe("VcsConnection projection over GitHubInstallation", () => {
  const base = {
    id: "inst-row-id",
    organizationId: "org-1",
    installationId: "12345",
    status: GitHubInstallationStatus.Active,
  };

  it("projects a GitHub installation into the neutral connection shape", () => {
    const conn = projectGitHubInstallationToVcsConnection(base);
    expect(conn).toEqual({
      id: "inst-row-id",
      provider: "github",
      authKind: VcsAuthKind.AppInstallation,
      baseUrl: GITHUB_DEFAULT_BASE_URL,
      status: VcsConnectionStatus.Active,
      organizationId: "org-1",
      providerConnectionId: "12345",
    });
  });

  it("preserves a null organizationId (unclaimed installation)", () => {
    const conn = projectGitHubInstallationToVcsConnection({
      ...base,
      organizationId: null,
    });
    expect(conn.organizationId).toBeNull();
  });

  it("maps every installation status through the neutral status enum", () => {
    for (const status of Object.values(GitHubInstallationStatus)) {
      const conn = projectGitHubInstallationToVcsConnection({
        ...base,
        status,
      });
      expect(Object.values(VcsConnectionStatus)).toContain(conn.status);
    }
  });

  it("defaults baseUrl to the public GitHub host", () => {
    expect(GITHUB_DEFAULT_BASE_URL).toBe("https://github.com");
    expect(projectGitHubInstallationToVcsConnection(base).baseUrl).toBe(
      "https://github.com"
    );
  });
});
