import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { CLERK_OAUTH_STRATEGY } from "@repo/app/shared/lib/clerk-oauth-strategy";
import {
  deriveSignInMethods,
  type SignInExternalAccount,
  SignInMethodStatus,
} from "@repo/app/shared/lib/sign-in-methods";
import { describe, expect, it } from "vitest";

const VERIFIED = "verified";
const UNVERIFIED = "unverified";
const GITHUB_OAUTH_STRATEGY =
  CLERK_OAUTH_STRATEGY[DesktopSignInProvider.GitHub];
const PASSWORD_STRATEGY = "password";

function githubAccount(
  overrides: Partial<SignInExternalAccount> = {}
): SignInExternalAccount {
  return {
    emailAddress: "person@example.com",
    provider: DesktopSignInProvider.GitHub,
    username: "octocat",
    verificationStatus: VERIFIED,
    ...overrides,
  };
}

function connectionFor(
  connections: ReturnType<typeof deriveSignInMethods>,
  provider: string
) {
  const found = connections.find(
    (connection) => connection.provider === provider
  );
  if (found === undefined) {
    throw new Error(`no connection derived for ${provider}`);
  }
  return found;
}

describe("deriveSignInMethods", () => {
  it("reports a verified account as connected, with its username as the detail", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount()],
      lastAuthenticationStrategy: null,
    });

    const github = connectionFor(connections, DesktopSignInProvider.GitHub);
    expect(github.status).toBe(SignInMethodStatus.Connected);
    expect(github.detail).toBe("octocat");
  });

  it("keeps an unverified account distinct from a connected one", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount({ verificationStatus: UNVERIFIED })],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).status
    ).toBe(SignInMethodStatus.Unverified);
  });

  it("treats an account with no verification record as unverified, not connected", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount({ verificationStatus: null })],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).status
    ).toBe(SignInMethodStatus.Unverified);
  });

  it("reports a provider the user holds no account for as disconnected with no detail", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount()],
      lastAuthenticationStrategy: null,
    });

    const google = connectionFor(connections, DesktopSignInProvider.Google);
    expect(google.status).toBe(SignInMethodStatus.Disconnected);
    expect(google.detail).toBeNull();
  });

  it("prefers the username over the email address as the detail", () => {
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount({
          emailAddress: "ignored@example.com",
          username: "octocat",
        }),
      ],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).detail
    ).toBe("octocat");
  });

  it("falls back to the email address when there is no username", () => {
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount({
          emailAddress: "person@example.com",
          username: undefined,
        }),
      ],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).detail
    ).toBe("person@example.com");
  });

  it("never turns a blank email address into a detail", () => {
    // Clerk types `emailAddress` as a non-optional string, so an account with
    // none carries "". Rendering that as the detail would print a naked
    // separator and claim the account is identified by nothing.
    const connections = deriveSignInMethods({
      accounts: [githubAccount({ emailAddress: "", username: undefined })],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).detail
    ).toBeNull();
  });

  it("returns a provider outside the known set instead of dropping it", () => {
    // The omission defect: a section titled "Sign-in methods" that silently
    // hides a real, verified way into the account is a UI lying by omission.
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount(),
        {
          emailAddress: "person@example.com",
          provider: "gitlab",
          username: "person",
          verificationStatus: VERIFIED,
        },
      ],
      lastAuthenticationStrategy: null,
    });

    const gitlab = connectionFor(connections, "gitlab");
    expect(gitlab.status).toBe(SignInMethodStatus.Connected);
    expect(gitlab.isKnownProvider).toBe(false);
    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).isKnownProvider
    ).toBe(true);
  });

  it("lists every known provider before any unknown one", () => {
    const connections = deriveSignInMethods({
      accounts: [{ provider: "gitlab", verificationStatus: VERIFIED }],
      lastAuthenticationStrategy: null,
    });

    expect(connections.map((connection) => connection.provider)).toEqual([
      DesktopSignInProvider.GitHub,
      DesktopSignInProvider.Google,
      "gitlab",
    ]);
  });

  it("badges the provider named by an oauth last-authentication strategy", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount()],
      lastAuthenticationStrategy: GITHUB_OAUTH_STRATEGY,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).isCurrentSignIn
    ).toBe(true);
    expect(
      connectionFor(connections, DesktopSignInProvider.Google).isCurrentSignIn
    ).toBe(false);
  });

  it("badges nothing when the client records no last-authentication strategy", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount()],
      lastAuthenticationStrategy: null,
    });

    expect(connections.some((connection) => connection.isCurrentSignIn)).toBe(
      false
    );
  });

  it("drops the badge once the provider it names is disconnected", () => {
    // `client.lastAuthenticationStrategy` is historical and a removal does not
    // clear it, so an ungated read renders "Available" and "Current sign-in" on
    // the same row — reachable right after disconnecting the provider the
    // session was started with.
    const connections = deriveSignInMethods({
      accounts: [],
      lastAuthenticationStrategy: GITHUB_OAUTH_STRATEGY,
    });

    const github = connectionFor(connections, DesktopSignInProvider.GitHub);
    expect(github.status).toBe(SignInMethodStatus.Disconnected);
    expect(github.isCurrentSignIn).toBe(false);
  });

  it("drops the badge for an account that never finished connecting", () => {
    const connections = deriveSignInMethods({
      accounts: [githubAccount({ verificationStatus: UNVERIFIED })],
      lastAuthenticationStrategy: GITHUB_OAUTH_STRATEGY,
    });

    const github = connectionFor(connections, DesktopSignInProvider.GitHub);
    expect(github.status).toBe(SignInMethodStatus.Unverified);
    expect(github.isCurrentSignIn).toBe(false);
  });

  it("badges nothing for a password sign-in, even with exactly one connected provider", () => {
    // The tempting fallback — "badge the only verified account" — is wrong, not
    // imprecise: this user signed in with a password and GitHub is not how they
    // got here.
    const connections = deriveSignInMethods({
      accounts: [githubAccount()],
      lastAuthenticationStrategy: PASSWORD_STRATEGY,
    });

    expect(connections.some((connection) => connection.isCurrentSignIn)).toBe(
      false
    );
  });

  it("derives one connection per provider when Clerk returns duplicates", () => {
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount({ username: "first" }),
        githubAccount({ username: "second" }),
      ],
      lastAuthenticationStrategy: null,
    });

    expect(
      connections.filter(
        (connection) => connection.provider === DesktopSignInProvider.GitHub
      )
    ).toHaveLength(1);
  });

  it("lets a verified duplicate win over a stale unverified one that arrived first", () => {
    // First-wins would report the provider the user is actually signed in with
    // as "Not finished" and offer to finish a connection that is already done.
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount({ username: "stale", verificationStatus: UNVERIFIED }),
        githubAccount({ username: "live", verificationStatus: VERIFIED }),
      ],
      lastAuthenticationStrategy: null,
    });

    const github = connectionFor(connections, DesktopSignInProvider.GitHub);
    expect(github.status).toBe(SignInMethodStatus.Connected);
    expect(github.detail).toBe("live");
  });

  it("keeps the first unverified account when no duplicate is verified", () => {
    const connections = deriveSignInMethods({
      accounts: [
        githubAccount({ username: "first", verificationStatus: UNVERIFIED }),
        githubAccount({ username: "second", verificationStatus: UNVERIFIED }),
      ],
      lastAuthenticationStrategy: null,
    });

    expect(
      connectionFor(connections, DesktopSignInProvider.GitHub).detail
    ).toBe("first");
  });
});
