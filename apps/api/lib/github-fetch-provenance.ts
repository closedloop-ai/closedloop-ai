import { GitHubCredentialKind } from "@repo/api/src/types/github";
import type {
  GitHubFetchCredentialType,
  GitHubFetchMechanism,
  GitHubFetchTrigger,
  GitHubSyncResultReason,
} from "@repo/api/src/types/github-read-model";
import {
  GitHubFetchCredentialType as GitHubFetchCredentialTypeValue,
  GitHubFetchMechanism as GitHubFetchMechanismValue,
  GitHubFetchTrigger as GitHubFetchTriggerValue,
  GitHubSyncResultReason as GitHubSyncResultReasonValue,
} from "@repo/api/src/types/github-read-model";

export type GitHubFetchProvenance = {
  credentialType: GitHubFetchCredentialType;
  credentialOwnerId?: string | null;
  mechanism: GitHubFetchMechanism;
  trigger: GitHubFetchTrigger;
  observedAt?: Date;
  resultReason: GitHubSyncResultReason;
};

export function githubAppWebhookFetchProvenance(
  observedAt = new Date()
): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.GitHubApp,
    mechanism: GitHubFetchMechanismValue.Webhook,
    trigger: GitHubFetchTriggerValue.Webhook,
    observedAt,
    resultReason: GitHubSyncResultReasonValue.Success,
  };
}

/**
 * Provenance for a row the bounded backfill sweep wrote.
 *
 * `credentialType` is a parameter and not a constant because ISS-7721 runs this
 * same sweep on a POOLED USER TOKEN for an org with no App installation: a
 * `github_app` stamp there names a credential the org does not have, and
 * `credentialOwnerId` is what says whose grant actually fetched it. The owner
 * key stays omitted rather than null when there is no owner, so an
 * installation-lane stamp is byte-identical to the one this lane wrote before.
 */
export function backfillFetchProvenance({
  credentialType = GitHubFetchCredentialTypeValue.GitHubApp,
  credentialOwnerId = null,
  observedAt = new Date(),
}: {
  credentialType?: GitHubFetchCredentialType;
  credentialOwnerId?: string | null;
  observedAt?: Date;
} = {}): GitHubFetchProvenance {
  return {
    credentialType,
    ...(credentialOwnerId ? { credentialOwnerId } : {}),
    mechanism: GitHubFetchMechanismValue.Backfill,
    trigger: GitHubFetchTriggerValue.Backfill,
    observedAt,
    resultReason: GitHubSyncResultReasonValue.Success,
  };
}

/** GraphQL-lane provenance. Credential-parameterized for the same reason as `backfillFetchProvenance`. */
export function graphqlFetchProvenance({
  credentialType = GitHubFetchCredentialTypeValue.GitHubApp,
  credentialOwnerId = null,
  observedAt = new Date(),
  resultReason = GitHubSyncResultReasonValue.Success,
  trigger,
}: {
  credentialType?: GitHubFetchCredentialType;
  credentialOwnerId?: string | null;
  observedAt?: Date;
  resultReason?: GitHubSyncResultReason;
  trigger: GitHubFetchTrigger;
}): GitHubFetchProvenance {
  return {
    credentialType,
    ...(credentialOwnerId ? { credentialOwnerId } : {}),
    mechanism: GitHubFetchMechanismValue.Graphql,
    trigger,
    observedAt,
    resultReason,
  };
}

export function githubAppRestFetchProvenance({
  observedAt = new Date(),
  resultReason = GitHubSyncResultReasonValue.Success,
  trigger = GitHubFetchTriggerValue.SurfaceOpen,
}: {
  observedAt?: Date;
  resultReason?: GitHubSyncResultReason;
  trigger?: GitHubFetchTrigger;
} = {}): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.GitHubApp,
    mechanism: GitHubFetchMechanismValue.Rest,
    trigger,
    observedAt,
    resultReason,
  };
}

export function userOAuthRestFetchProvenance({
  credentialOwnerId,
  observedAt = new Date(),
  resultReason = GitHubSyncResultReasonValue.Success,
  trigger = GitHubFetchTriggerValue.UserAction,
}: {
  credentialOwnerId: string;
  observedAt?: Date;
  resultReason?: GitHubSyncResultReason;
  trigger?: GitHubFetchTrigger;
}): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.UserOAuth,
    credentialOwnerId,
    mechanism: GitHubFetchMechanismValue.Rest,
    trigger,
    observedAt,
    resultReason,
  };
}

/**
 * FEA-2732: provenance for a row written by the desktop → cloud sync lane (local
 * `gh` enrichment / gh_pr_create parses). Tagged with the DesktopSync
 * mechanism/trigger so webhook-wins conflict resolution can tell it apart from
 * any GitHub-App-sourced write and treat it as gap-fill-only against those.
 */
export function desktopSyncFetchProvenance(
  observedAt = new Date()
): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.DesktopSync,
    mechanism: GitHubFetchMechanismValue.DesktopSync,
    trigger: GitHubFetchTriggerValue.DesktopSync,
    observedAt,
    resultReason: GitHubSyncResultReasonValue.Success,
  };
}

/**
 * FEA-2732: true when a stored `fetch_mechanism` value came from a GitHub-App
 * producer (webhook / backfill / GraphQL / REST) — the authoritative sources
 * the desktop must not overwrite (webhook-wins; desktop fills gaps only).
 */
export function isGitHubAppFetchMechanism(
  mechanism: string | null | undefined
): boolean {
  return (
    mechanism === GitHubFetchMechanismValue.Webhook ||
    mechanism === GitHubFetchMechanismValue.Backfill ||
    mechanism === GitHubFetchMechanismValue.Graphql ||
    mechanism === GitHubFetchMechanismValue.Rest
  );
}

export function gitHubFetchProvenanceData(
  provenance: GitHubFetchProvenance | null | undefined
) {
  if (!provenance) {
    return {};
  }
  return {
    fetchCredentialType: provenance.credentialType,
    fetchCredentialOwnerId: provenance.credentialOwnerId ?? null,
    fetchMechanism: provenance.mechanism,
    fetchTrigger: provenance.trigger,
    fetchObservedAt: provenance.observedAt ?? new Date(),
    fetchResultReason: provenance.resultReason,
  };
}

/**
 * Which fetch-credential lane a resolved credential kind belongs to.
 *
 * A `Record` and not a ternary: four producers had independently written
 * `kind === Installation ? github_app : user_oauth`, so a fifth credential kind
 * would have been silently stamped `user_oauth` at every one of them. The map
 * cannot be written without naming every member, so a new kind fails `tsc`
 * here instead of mislabelling a persisted row.
 */
const FETCH_CREDENTIAL_TYPE_BY_KIND: Record<
  GitHubCredentialKind,
  GitHubFetchCredentialType
> = {
  [GitHubCredentialKind.Installation]: GitHubFetchCredentialTypeValue.GitHubApp,
  [GitHubCredentialKind.OauthUser]: GitHubFetchCredentialTypeValue.UserOAuth,
  [GitHubCredentialKind.GithubAppUser]:
    GitHubFetchCredentialTypeValue.UserOAuth,
  // Unreachable through either resolver — both deny rather than hand back a
  // `none` client — but `unauthenticated` is the only honest stamp for a read
  // no credential performed, and mapping it to `user_oauth` would name a grant
  // that does not exist.
  [GitHubCredentialKind.None]: GitHubFetchCredentialTypeValue.Unauthenticated,
};

export function fetchCredentialTypeFromKind(
  kind: GitHubCredentialKind
): GitHubFetchCredentialType {
  return FETCH_CREDENTIAL_TYPE_BY_KIND[kind];
}
