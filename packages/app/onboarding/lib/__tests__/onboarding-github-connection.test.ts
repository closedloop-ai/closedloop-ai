/**
 * ISS-8352: the onboarding GitHub connection derivation and the completion
 * signal it hands the ISS-8349 engine. Pure data — no React.
 */

import type { GitHubIntegrationStatus } from "@repo/api/src/types/github";
import {
  GitHubDataConnectionSource,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import type { ServerOnboardingContext } from "@repo/api/src/types/onboarding-guided";
import {
  AccountProvider,
  AccountStatus,
  KnownFlag,
  OnboardingHost,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase";
import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { OnboardingGitHubConnectionSource } from "../../components/guided-onboarding-data";
import {
  deriveGuidedOnboardingGitHubConnection,
  deriveOnboardingGitHubConnection,
  parseAccountProvider,
  resolveOnboardingGitHubContext,
} from "../onboarding-github-connection";

describe("parseAccountProvider", () => {
  it("accepts each known provider by its wire spelling", () => {
    expect(parseAccountProvider(AccountProvider.Email)).toBe(
      AccountProvider.Email
    );
    expect(parseAccountProvider(AccountProvider.GitHub)).toBe(
      AccountProvider.GitHub
    );
    expect(parseAccountProvider(AccountProvider.Google)).toBe(
      AccountProvider.Google
    );
  });

  it("returns null for an absent provider", () => {
    expect(parseAccountProvider(null)).toBeNull();
    expect(parseAccountProvider(undefined)).toBeNull();
    expect(parseAccountProvider("")).toBeNull();
  });

  it("returns null for a provider this build does not know", () => {
    // The version-skew case: a peer on a newer build names a provider that did
    // not exist when this bundle shipped. It must not become a known one.
    expect(parseAccountProvider("gitlab")).toBeNull();
    expect(parseAccountProvider("GitHub")).toBeNull();
  });

  it("returns null for a prototype key rather than the prototype object", () => {
    // A bare index into an object literal answers `__proto__` with
    // `Object.prototype`, which is truthy and would escape a `?? null`.
    expect(parseAccountProvider("__proto__")).toBeNull();
    expect(parseAccountProvider("constructor")).toBeNull();
    expect(parseAccountProvider("toString")).toBeNull();
  });
});

describe("deriveGuidedOnboardingGitHubConnection", () => {
  it("renders the Web prompt from a modern measured absence before status settles", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Web,
        status: undefined,
      })
    ).toEqual({ action: GitHubConnectAction.Connect, status: "disconnected" });
  });

  it("keeps the Web prompt when the secondary status read fails", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Web,
        status: null,
      })
    ).toEqual({ action: GitHubConnectAction.Connect, status: "disconnected" });
  });

  it("does not let a stale positive status override a measured Web absence", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Web,
        status: grantConnectedStatus(),
      })
    ).toEqual({ action: GitHubConnectAction.Connect, status: "disconnected" });
  });

  it("preserves a positive snapshot while a separate status read is stale", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubConnected: true,
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Web,
        status: revokedStatus(),
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.Grant,
      status: "connected",
    });
  });

  it("keeps reconnect wording for a measured revoked grant", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Web,
        status: revokedStatus(),
      })
    ).toEqual({
      action: GitHubConnectAction.Reconnect,
      status: "disconnected",
    });
  });

  it("preserves the GitHub provider fallback from an older API", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext(),
        host: OnboardingHost.Web,
        status: undefined,
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.AccountProvider,
      status: "connected",
    });
  });

  it("preserves Desktop's provider fallback", () => {
    expect(
      deriveGuidedOnboardingGitHubConnection({
        context: snapshotContext({
          githubDataConnectionStatusMeasured: true,
        }),
        host: OnboardingHost.Desktop,
        status: undefined,
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.AccountProvider,
      status: "connected",
    });
  });
});

describe("deriveOnboardingGitHubConnection", () => {
  it("reports connected from a live user grant", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "google",
        authenticated: true,
        status: grantConnectedStatus(),
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.Grant,
      status: "connected",
    });
  });

  it("treats a GitHub sign-in as satisfying the step while the status is unread", () => {
    // The acceptance criterion: a GitHub-auth user must never be shown a
    // Connect prompt they have already satisfied, including in the window
    // before the integration status resolves.
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "github",
        authenticated: true,
        status: null,
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.AccountProvider,
      status: "connected",
    });
  });

  it("lets a measured disconnection outrank the GitHub sign-in inference", () => {
    // A revoked grant is evidence; the provider is only an inference. Reporting
    // connected here would hide a repair the user actually needs.
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "github",
        authenticated: true,
        status: revokedStatus(),
      })
    ).toEqual({
      action: GitHubConnectAction.Reconnect,
      status: "disconnected",
    });
  });

  it("stays unknown for a Google sign-in whose status has not resolved", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "google",
        authenticated: true,
        status: undefined,
      })
    ).toEqual({ status: "unknown" });
  });

  it("stays unknown for an email account whose GitHub status has not resolved", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: AccountProvider.Email,
        authenticated: true,
        status: undefined,
      })
    ).toEqual({ status: "unknown" });
  });

  it("stays unknown while the session is still settling", () => {
    // An unsettled session means any status in hand predates the account we are
    // about to have, so neither branch may be claimed.
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "google",
        authSettled: false,
        authenticated: false,
        status: grantConnectedStatus(),
      })
    ).toEqual({ status: "unknown" });
  });

  it("stays unknown while settling even when the provider reads github", () => {
    // Mid handoff the provider string still names the account being left
    // behind, so it may not stand in for the gate the way a settled UNKNOWN
    // lets it (whitlockk, ISS-8352 review).
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "github",
        authSettled: false,
        authenticated: true,
        status: undefined,
      })
    ).toEqual({ status: "unknown" });
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: "github",
        authSettled: false,
        authenticated: true,
        status: undefined,
      })
    ).toEqual({
      accountProvider: AccountProvider.GitHub,
      githubConnected: false,
    });
  });

  it("keeps a GitHub sign-in connected under a legacy-only payload", () => {
    // `connected` predates the data-connection predicate and reports only the
    // org's App installation, so its `false` cannot contradict the sign-in. A
    // version-skewed client must not re-prompt a GitHub-auth user (davetho,
    // ISS-8352 review).
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "github",
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      source: OnboardingGitHubConnectionSource.AccountProvider,
      status: "connected",
    });
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: "github",
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      accountProvider: AccountProvider.GitHub,
      githubConnected: true,
    });
  });

  it("still prompts a non-GitHub sign-in under a legacy-only payload", () => {
    // The legacy `false` is a real absence of any connection for a user whose
    // sign-in carries no grant of its own.
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "google",
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      action: GitHubConnectAction.Connect,
      status: "disconnected",
    });
  });

  it("still prompts an email account under a legacy-only payload", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: AccountProvider.Email,
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      action: GitHubConnectAction.Connect,
      status: "disconnected",
    });
  });

  it("still prompts a signed-out visitor under a legacy-only payload", () => {
    // There is no sign-in to trust yet, so a stale provider string may not
    // stand in for one.
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "github",
        authenticated: false,
        status: { connected: false },
      })
    ).toEqual({
      action: GitHubConnectAction.Connect,
      status: "disconnected",
    });
  });

  it("offers a first-time connect when the status reports no grant", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "google",
        authenticated: true,
        status: {
          connected: false,
          githubDataConnection: {
            connected: false,
            oauthRequiredReasons: [GitHubOAuthRequiredReason.NoUserGrant],
            sources: [],
          },
        },
      })
    ).toEqual({
      action: GitHubConnectAction.Connect,
      status: "disconnected",
    });
  });

  it("does not credit an unknown provider with a GitHub sign-in", () => {
    expect(
      deriveOnboardingGitHubConnection({
        accountProvider: "gitlab",
        authenticated: true,
        status: null,
      })
    ).toEqual({ status: "unknown" });
  });
});

describe("resolveOnboardingGitHubContext", () => {
  it("folds a connection into the engine's own context fields", () => {
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: "github",
        authenticated: true,
        status: null,
      })
    ).toEqual({
      accountProvider: AccountProvider.GitHub,
      githubConnected: true,
    });
  });

  it("folds an unknown connection to INCOMPLETE, never complete", () => {
    // The acceptance criterion for old and unknown payloads. `githubConnected`
    // false is what keeps the completion card counting the step as outstanding.
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: "gitlab",
        authenticated: true,
        status: undefined,
      })
    ).toEqual({ accountProvider: null, githubConnected: false });
  });

  it("folds a measured disconnection to incomplete", () => {
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: "google",
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      accountProvider: AccountProvider.Google,
      githubConnected: false,
    });
  });

  it("folds email account setup to incomplete GitHub state", () => {
    expect(
      resolveOnboardingGitHubContext({
        accountProvider: AccountProvider.Email,
        authenticated: true,
        status: { connected: false },
      })
    ).toEqual({
      accountProvider: AccountProvider.Email,
      githubConnected: false,
    });
  });
});

/** A status carrying a live user OAuth grant, the modern payload shape. */
function grantConnectedStatus(): GitHubIntegrationStatus {
  return {
    connected: false,
    githubDataConnection: {
      connected: true,
      oauthRequiredReasons: [],
      sources: [GitHubDataConnectionSource.UserOAuth],
    },
  };
}

/** A status whose user grant was revoked — the repair case. */
function revokedStatus(): GitHubIntegrationStatus {
  return {
    connected: false,
    githubDataConnection: {
      connected: false,
      oauthRequiredReasons: [GitHubOAuthRequiredReason.CredentialRevoked],
      sources: [],
    },
  };
}

function snapshotContext(
  overrides: Partial<ServerOnboardingContext> = {}
): ServerOnboardingContext {
  return {
    accountProvider: AccountProvider.GitHub,
    accountStatus: AccountStatus.Established,
    desktopAppDownloaded: true,
    githubConnected: false,
    membership: OrganizationMembership.FirstUser,
    organizationHasSyncedSessionData: KnownFlag.No,
    teamInvited: true,
    tourCompleted: false,
    ...overrides,
  };
}
