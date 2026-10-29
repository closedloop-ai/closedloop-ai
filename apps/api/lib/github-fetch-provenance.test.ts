/**
 * Every factory here stamps a row that webhook-wins conflict resolution later
 * reads (FEA-2732), so the mechanism/trigger/credential triple is a contract,
 * not a detail. The `isGitHubAppFetchMechanism` table is keyed on the canonical
 * const so a newly added mechanism fails typecheck until it is classified.
 */

import {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backfillFetchProvenance,
  desktopSyncFetchProvenance,
  gitHubFetchProvenanceData,
  githubAppRestFetchProvenance,
  githubAppWebhookFetchProvenance,
  graphqlFetchProvenance,
  isGitHubAppFetchMechanism,
  userOAuthRestFetchProvenance,
} from "./github-fetch-provenance";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const EXPLICIT_OBSERVED_AT = new Date("2026-01-02T03:04:05.000Z");
const OWNER_ID = "user-42";

const IS_GITHUB_APP_MECHANISM = {
  [GitHubFetchMechanism.Webhook]: true,
  [GitHubFetchMechanism.Backfill]: true,
  [GitHubFetchMechanism.Graphql]: true,
  [GitHubFetchMechanism.Rest]: true,
  [GitHubFetchMechanism.DesktopSync]: false,
  [GitHubFetchMechanism.Unknown]: false,
} satisfies Record<GitHubFetchMechanism, boolean>;

describe("provenance factories", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps the webhook lane", () => {
    expect(githubAppWebhookFetchProvenance()).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Webhook,
      trigger: GitHubFetchTrigger.Webhook,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("stamps the backfill lane", () => {
    expect(backfillFetchProvenance()).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Backfill,
      trigger: GitHubFetchTrigger.Backfill,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("stamps the desktop sync lane with its own credential type", () => {
    expect(desktopSyncFetchProvenance()).toEqual({
      credentialType: GitHubFetchCredentialType.DesktopSync,
      mechanism: GitHubFetchMechanism.DesktopSync,
      trigger: GitHubFetchTrigger.DesktopSync,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("requires the caller to name the GraphQL trigger", () => {
    expect(
      graphqlFetchProvenance({ trigger: GitHubFetchTrigger.Retry })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.Retry,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("carries a non-success GraphQL result reason through", () => {
    expect(
      graphqlFetchProvenance({
        trigger: GitHubFetchTrigger.Backfill,
        resultReason: GitHubSyncResultReason.ProviderUnavailable,
        observedAt: EXPLICIT_OBSERVED_AT,
      })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.Backfill,
      observedAt: EXPLICIT_OBSERVED_AT,
      resultReason: GitHubSyncResultReason.ProviderUnavailable,
    });
  });

  it("defaults the REST lane to a surface-open trigger with no arguments", () => {
    expect(githubAppRestFetchProvenance()).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("lets the REST lane override trigger, reason, and instant", () => {
    expect(
      githubAppRestFetchProvenance({
        trigger: GitHubFetchTrigger.UserAction,
        resultReason: GitHubSyncResultReason.NoCredential,
        observedAt: EXPLICIT_OBSERVED_AT,
      })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.GitHubApp,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      observedAt: EXPLICIT_OBSERVED_AT,
      resultReason: GitHubSyncResultReason.NoCredential,
    });
  });

  it("attributes a user OAuth read to its credential owner", () => {
    expect(
      userOAuthRestFetchProvenance({ credentialOwnerId: OWNER_ID })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId: OWNER_ID,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.UserAction,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("lets a user OAuth read override trigger, reason, and instant", () => {
    expect(
      userOAuthRestFetchProvenance({
        credentialOwnerId: OWNER_ID,
        trigger: GitHubFetchTrigger.SurfaceOpen,
        resultReason: GitHubSyncResultReason.CredentialRevoked,
        observedAt: EXPLICIT_OBSERVED_AT,
      })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId: OWNER_ID,
      mechanism: GitHubFetchMechanism.Rest,
      trigger: GitHubFetchTrigger.SurfaceOpen,
      observedAt: EXPLICIT_OBSERVED_AT,
      resultReason: GitHubSyncResultReason.CredentialRevoked,
    });
  });

  it.each([
    ["webhook", githubAppWebhookFetchProvenance],
    ["desktop sync", desktopSyncFetchProvenance],
  ])("lets the %s lane override the observed instant", (_label, factory) => {
    expect(factory(EXPLICIT_OBSERVED_AT).observedAt).toBe(EXPLICIT_OBSERVED_AT);
  });

  it("lets the backfill lane override the observed instant", () => {
    expect(
      backfillFetchProvenance({ observedAt: EXPLICIT_OBSERVED_AT }).observedAt
    ).toBe(EXPLICIT_OBSERVED_AT);
  });

  it("stamps the pool lane it was drawn on, with the owning grant", () => {
    expect(
      backfillFetchProvenance({
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: OWNER_ID,
      })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId: OWNER_ID,
      mechanism: GitHubFetchMechanism.Backfill,
      trigger: GitHubFetchTrigger.Backfill,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
    expect(
      graphqlFetchProvenance({
        trigger: GitHubFetchTrigger.Backfill,
        credentialType: GitHubFetchCredentialType.UserOAuth,
        credentialOwnerId: OWNER_ID,
      })
    ).toEqual({
      credentialType: GitHubFetchCredentialType.UserOAuth,
      credentialOwnerId: OWNER_ID,
      mechanism: GitHubFetchMechanism.Graphql,
      trigger: GitHubFetchTrigger.Backfill,
      observedAt: NOW,
      resultReason: GitHubSyncResultReason.Success,
    });
  });

  it("leaves credentialOwnerId unset on every lane with no user owner", () => {
    for (const provenance of [
      githubAppWebhookFetchProvenance(),
      backfillFetchProvenance(),
      githubAppRestFetchProvenance(),
      graphqlFetchProvenance({ trigger: GitHubFetchTrigger.Backfill }),
      desktopSyncFetchProvenance(),
    ]) {
      expect(provenance.credentialOwnerId).toBeUndefined();
    }
  });
});

describe("isGitHubAppFetchMechanism", () => {
  it.each(Object.entries(IS_GITHUB_APP_MECHANISM))(
    "classifies the %s mechanism",
    (mechanism, expected) => {
      expect(isGitHubAppFetchMechanism(mechanism)).toBe(expected);
    }
  );

  it("covers every mechanism the canonical const declares", () => {
    expect(Object.keys(IS_GITHUB_APP_MECHANISM).sort()).toEqual(
      Object.values(GitHubFetchMechanism).sort()
    );
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty string", ""],
    ["an unrecognized value", "carrier-pigeon"],
  ])("rejects %s", (_label, mechanism) => {
    expect(isGitHubAppFetchMechanism(mechanism)).toBe(false);
  });

  it("accepts the mechanism each App factory actually produces", () => {
    for (const provenance of [
      githubAppWebhookFetchProvenance(),
      backfillFetchProvenance(),
      githubAppRestFetchProvenance(),
      graphqlFetchProvenance({ trigger: GitHubFetchTrigger.Backfill }),
    ]) {
      expect(isGitHubAppFetchMechanism(provenance.mechanism)).toBe(true);
    }
    expect(
      isGitHubAppFetchMechanism(desktopSyncFetchProvenance().mechanism)
    ).toBe(false);
  });
});

describe("gitHubFetchProvenanceData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("returns an empty patch for %s provenance", (_label, provenance) => {
    expect(gitHubFetchProvenanceData(provenance)).toEqual({});
  });

  it("maps every provenance field onto its column name", () => {
    expect(
      gitHubFetchProvenanceData(
        userOAuthRestFetchProvenance({
          credentialOwnerId: OWNER_ID,
          observedAt: EXPLICIT_OBSERVED_AT,
        })
      )
    ).toEqual({
      fetchCredentialType: GitHubFetchCredentialType.UserOAuth,
      fetchCredentialOwnerId: OWNER_ID,
      fetchMechanism: GitHubFetchMechanism.Rest,
      fetchTrigger: GitHubFetchTrigger.UserAction,
      fetchObservedAt: EXPLICIT_OBSERVED_AT,
      fetchResultReason: GitHubSyncResultReason.Success,
    });
  });

  it("writes an explicit null owner rather than omitting the column", () => {
    const data = gitHubFetchProvenanceData(githubAppWebhookFetchProvenance());
    expect(data.fetchCredentialOwnerId).toBeNull();
    expect(Object.hasOwn(data, "fetchCredentialOwnerId")).toBe(true);
  });

  it("substitutes the current instant when provenance carries none", () => {
    expect(
      gitHubFetchProvenanceData({
        credentialType: GitHubFetchCredentialType.Unauthenticated,
        mechanism: GitHubFetchMechanism.Unknown,
        trigger: GitHubFetchTrigger.Unknown,
        resultReason: GitHubSyncResultReason.Unknown,
      }).fetchObservedAt
    ).toEqual(NOW);
  });
});
