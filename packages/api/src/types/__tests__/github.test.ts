import { describe, expect, it } from "vitest";
import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "../github";

describe("GitHub integration contract values", () => {
  it("pins GitHub data connection source wire values", () => {
    expect(GitHubDataConnectionSource.GitHubApp).toBe("github_app");
    expect(GitHubDataConnectionSource.UserOAuth).toBe("user_oauth");
  });

  it("pins OAuth-required reason wire values", () => {
    expect(GitHubOAuthRequiredReason.NoAppInstallation).toBe(
      "no_app_installation"
    );
    expect(GitHubOAuthRequiredReason.NoUserGrant).toBe("no_user_grant");
    expect(GitHubOAuthRequiredReason.CredentialExpired).toBe(
      "credential_expired"
    );
    expect(GitHubOAuthRequiredReason.CredentialRevoked).toBe(
      "credential_revoked"
    );
    expect(GitHubOAuthRequiredReason.CredentialInsufficientScope).toBe(
      "credential_insufficient_scope"
    );
    expect(GitHubOAuthRequiredReason.ReconsentRequired).toBe(
      "reconsent_required"
    );
  });
});
