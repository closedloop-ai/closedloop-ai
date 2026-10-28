import {
  type GitHubInstallationInfo,
  GitHubInstallationStatus,
  type GitHubIntegrationStatus,
  GitHubOAuthRequiredReason,
} from "@repo/api/src/types/github";
import { resolveGitHubDataConnected } from "@repo/api/src/types/github-data-connected";
import { describe, expect, it } from "vitest";
import {
  GitHubConnectAction,
  hasGitHubUserGrantRecoveryReason,
  isLegacyGitHubInstallationStatus,
  resolveGitHubConnectAction,
  resolveGitHubConnectPromptAction,
  resolveGitHubGateConnected,
} from "../github-connect-action";
import {
  GITHUB_CONNECT_COPY,
  GITHUB_CONNECT_PROMPT_COPY,
} from "../github-connect-copy";

const SETUP_FRAMING_RE = /finish setup|one more step/i;

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

const RECOVERY_REASONS = [
  GitHubOAuthRequiredReason.CredentialExpired,
  GitHubOAuthRequiredReason.CredentialRevoked,
  GitHubOAuthRequiredReason.CredentialInsufficientScope,
  GitHubOAuthRequiredReason.ReconsentRequired,
] as const;

function disconnectedWithReasons(
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

/**
 * ISS-7866 added this resolver so every gated surface answers ONE question from
 * ONE place. Two surfaces used to answer it differently on the same evidence:
 * the dashboard gated on an unread status and prompted forever, while the
 * Sessions strip refused to prompt on anything but a definite absence and
 * showed a bare dash.
 */
describe("isLegacyGitHubInstallationStatus", () => {
  it("recognises a payload that carries only the legacy installation field", () => {
    expect(isLegacyGitHubInstallationStatus({ connected: false })).toBe(true);
    expect(
      isLegacyGitHubInstallationStatus({ connected: true, installation })
    ).toBe(true);
  });

  it("rejects a payload whose data connection answered the grant question", () => {
    expect(
      isLegacyGitHubInstallationStatus({
        connected: false,
        githubDataConnection: {
          connected: false,
          sources: [],
          oauthRequiredReasons: [],
        },
      })
    ).toBe(false);
  });

  it("rejects an unread status, which measured nothing at all", () => {
    expect(isLegacyGitHubInstallationStatus(null)).toBe(false);
    expect(isLegacyGitHubInstallationStatus(undefined)).toBe(false);
  });
});

describe("resolveGitHubGateConnected", () => {
  it.each([
    ["a connected status", { connected: true, installation }],
    ["a disconnected status", { connected: false }],
    ["an unread status", null],
  ] as const)(
    "answers a definite false while signed out, given %s",
    (_label, status) => {
      // Signed out is a FACT, not an unknown: with no session there is no user
      // grant and no org installation to read, and the status fetch that would
      // say so returns null and never resolves. Asserted across all three status
      // shapes because the session is what decides this — a resolver that
      // consulted the payload first would pass on the `null` row alone.
      expect(resolveGitHubGateConnected({ authenticated: false, status })).toBe(
        false
      );
    }
  );

  it("defers to the data-connection predicate once signed in", () => {
    expect(
      resolveGitHubGateConnected({
        authenticated: true,
        status: {
          connected: false,
          githubDataConnection: {
            connected: true,
            sources: [],
            oauthRequiredReasons: [],
          },
        },
      })
    ).toBe(true);
    expect(
      resolveGitHubGateConnected({
        authenticated: true,
        status: { connected: false },
      })
    ).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)(
    "keeps a %s status UNKNOWN while signed in, so an unread read never prompts",
    (_label, status) => {
      // The half ISS-5958 established and ISS-7866 deliberately left intact:
      // signed in, the status is the only evidence there is, so an unlanded read
      // must not be reported as a disconnection.
      expect(
        resolveGitHubGateConnected({ authenticated: true, status })
      ).toBeUndefined();
    }
  );
});

describe("resolveGitHubConnectAction", () => {
  it("resolves SignUp with no session, whatever the status says", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: false,
        status: { connected: true, installation },
      })
    ).toBe(GitHubConnectAction.SignUp);
  });

  it("renders nothing for a user connected by their own grant alone", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: true,
        status: {
          connected: false,
          githubDataConnection: {
            connected: true,
            sources: [],
            oauthRequiredReasons: [],
          },
        },
      })
    ).toBeNull();
  });

  it("renders nothing for an App-installed org with no personal grant", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: true,
        status: { connected: true, installation },
      })
    ).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ] as const)(
    "renders nothing while the connection is unknown (%s status)",
    (_label, status) => {
      expect(
        resolveGitHubConnectAction({ authenticated: true, status })
      ).toBeNull();
    }
  );

  it("resolves Connect — never an install — when the only reason is NoAppInstallation", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: true,
        status: disconnectedWithReasons([
          GitHubOAuthRequiredReason.NoAppInstallation,
        ]),
      })
    ).toBe(GitHubConnectAction.Connect);
  });

  it("resolves Connect for a disconnected status carrying no reasons", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: true,
        status: { connected: false },
      })
    ).toBe(GitHubConnectAction.Connect);
  });

  it.each(RECOVERY_REASONS)(
    "resolves Reconnect for user-grant recovery reason %s",
    (reason) => {
      expect(
        resolveGitHubConnectAction({
          authenticated: true,
          status: disconnectedWithReasons([reason]),
        })
      ).toBe(GitHubConnectAction.Reconnect);
    }
  );

  it("lets a recovery reason win over NoAppInstallation", () => {
    expect(
      resolveGitHubConnectAction({
        authenticated: true,
        status: disconnectedWithReasons([
          GitHubOAuthRequiredReason.NoAppInstallation,
          GitHubOAuthRequiredReason.ReconsentRequired,
        ]),
      })
    ).toBe(GitHubConnectAction.Reconnect);
  });
});

describe("hasGitHubUserGrantRecoveryReason", () => {
  it.each(RECOVERY_REASONS)("reports %s as a recovery reason", (reason) => {
    expect(hasGitHubUserGrantRecoveryReason([reason])).toBe(true);
  });

  it.each([
    GitHubOAuthRequiredReason.NoAppInstallation,
    GitHubOAuthRequiredReason.NoUserGrant,
  ])("does not report %s as a recovery reason", (reason) => {
    expect(hasGitHubUserGrantRecoveryReason([reason])).toBe(false);
  });

  it("does not report an empty reason list as a recovery reason", () => {
    expect(hasGitHubUserGrantRecoveryReason([])).toBe(false);
  });
});

describe("resolveGitHubConnectPromptAction", () => {
  it("keeps a reconnect a reconnect", () => {
    expect(
      resolveGitHubConnectPromptAction(GitHubConnectAction.Reconnect)
    ).toBe(GitHubConnectAction.Reconnect);
  });

  it.each([GitHubConnectAction.Connect, GitHubConnectAction.SignUp, null])(
    "falls back to a first-time connect for %s",
    (action) => {
      // The prompt renders only behind a session, so `SignUp` cannot reach it,
      // and a `null` action means connected-or-unknown. Offering a connect the
      // user may not need beats telling someone their access broke when it did
      // not.
      expect(resolveGitHubConnectPromptAction(action)).toBe(
        GitHubConnectAction.Connect
      );
    }
  );
});

describe("GITHUB_CONNECT_PROMPT_COPY", () => {
  it("words reconnect distinctly from connect (ISS-5958 D2)", () => {
    const connect = GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect];
    const reconnect = GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Reconnect];

    expect(reconnect.heading).not.toBe(connect.heading);
    expect(reconnect.body).not.toBe(connect.body);
    // NOT the button: it names the browser handoff, which is the same event for
    // both, so both say it the same way. The gated CTAs are where the verbs
    // differ, and `GITHUB_CONNECT_COPY` above asserts those are all distinct.
    expect(reconnect.ctaLabel).toBe(connect.ctaLabel);
  });

  it("keeps the reconnect prompt off first-time-setup framing", () => {
    // A user whose grant expired is repairing access, not setting up: "finish
    // setup" reads to them as the app having lost work they already did.
    const reconnect = GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Reconnect];
    const connect = GITHUB_CONNECT_PROMPT_COPY[GitHubConnectAction.Connect];

    expect(reconnect.heading).not.toMatch(SETUP_FRAMING_RE);
    // And no eyebrow at all: that slot is a progress marker for a flow with
    // steps, which a repair does not have.
    expect(reconnect.eyebrow).toBeUndefined();
    expect(connect.eyebrow).toMatch(SETUP_FRAMING_RE);
  });
});

describe("GITHUB_CONNECT_COPY", () => {
  it("words a reconnect apart from a first-time connect", () => {
    // Narrowed by ISS-7866 from "every action's label is unique". SignUp no
    // longer has a label of its own — see the case below — so uniqueness now
    // binds the pair that still must not read alike: a user repairing a broken
    // grant and a user who never had one are in different situations, and
    // "Connect" at someone whose access just lapsed reads as losing their setup.
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect].ctaLabel
    ).not.toBe(GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel);
    expect(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect].ctaLabel
    ).not.toBe(GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].ctaLabel);
  });

  it("gives a signed-out card the same verb as a signed-in one (ISS-7866)", () => {
    // Pinned, not merely tolerated: the `pre-auth-desktop-onboarding` prototype
    // shows "Connect GitHub" on a gated card with `signedIn={false}`, so a
    // reader who signs in must not watch the ask change words underneath them.
    // Restoring a distinct sign-up verb here is what this case exists to catch.
    expect(GITHUB_CONNECT_COPY[GitHubConnectAction.SignUp].ctaLabel).toBe(
      GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].ctaLabel
    );
  });

  it.each(Object.values(GitHubConnectAction))(
    "names the action in the %s label",
    (action) => {
      expect(GITHUB_CONNECT_COPY[action].ctaLabel).not.toBe("");
      expect(GITHUB_CONNECT_COPY[action].gatedMetricExplanation).not.toBe("");
      expect(GITHUB_CONNECT_COPY[action].deliveryBannerExplanation).not.toBe(
        ""
      );
    }
  );

  it.each(Object.values(GitHubConnectAction))(
    "opens every %s explanation with that action's own verb",
    (action) => {
      // The Insights banner and the gated card sit beside the same control, so a
      // reader must not see two verbs for one click. Before ISS-5958 the banner
      // line was a literal at the call site and said "Connect GitHub" whatever the
      // button offered.
      const copy = GITHUB_CONNECT_COPY[action];

      expect(copy.gatedMetricExplanation.startsWith(copy.ctaLabel)).toBe(true);
      expect(copy.deliveryBannerExplanation.startsWith(copy.ctaLabel)).toBe(
        true
      );
    }
  );
});
