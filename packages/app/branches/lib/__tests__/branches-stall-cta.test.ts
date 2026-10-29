import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import {
  BranchesStallCtaKind,
  resolveBranchesStallCta,
  resolveBranchesStallCtaSignals,
} from "../branches-stall-cta";

/**
 * ISS-10645 — the operator's 2026-09-17 ruling: which ask a stalled Branches
 * load makes depends on the READER, and the two readers the ticket names are
 * disjoint. A guest has no account; someone signed in without GitHub already has
 * one and must never be told to create it.
 */
describe("resolveBranchesStallCta", () => {
  it("asks a guest to create an account", () => {
    expect(
      resolveBranchesStallCta({ hasAccount: false, isGitHubConnected: false })
    ).toBe(BranchesStallCtaKind.CreateAccount);
  });

  it("asks a signed-in reader without GitHub to connect, never to sign up", () => {
    expect(
      resolveBranchesStallCta({ hasAccount: true, isGitHubConnected: false })
    ).toBe(BranchesStallCtaKind.ConnectGitHub);
  });

  it("asks a signed-in, connected reader for nothing", () => {
    expect(
      resolveBranchesStallCta({ hasAccount: true, isGitHubConnected: true })
    ).toBe(BranchesStallCtaKind.None);
  });
});

describe("resolveBranchesStallCtaSignals", () => {
  it("treats a sessionless reader as having no account", () => {
    expect(
      resolveBranchesStallCtaSignals(GitHubConnectAction.SignUp).hasAccount
    ).toBe(false);
  });

  it("does not call a signed-in reader sessionless", () => {
    expect(
      resolveBranchesStallCtaSignals(GitHubConnectAction.Connect).hasAccount
    ).toBe(true);
  });

  it.each([GitHubConnectAction.Connect, GitHubConnectAction.Reconnect])(
    "reports %s as not connected",
    (githubConnectAction) => {
      expect(
        resolveBranchesStallCtaSignals(githubConnectAction).isGitHubConnected
      ).toBe(false);
    }
  );

  it("reports a null action as connected, so an unread status never prompts", () => {
    expect(resolveBranchesStallCtaSignals(null).isGitHubConnected).toBe(true);
  });
});
