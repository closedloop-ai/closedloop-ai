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

export function githubAppBackfillFetchProvenance(
  observedAt = new Date()
): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.GitHubApp,
    mechanism: GitHubFetchMechanismValue.Backfill,
    trigger: GitHubFetchTriggerValue.Backfill,
    observedAt,
    resultReason: GitHubSyncResultReasonValue.Success,
  };
}

export function githubAppGraphqlFetchProvenance({
  observedAt = new Date(),
  resultReason = GitHubSyncResultReasonValue.Success,
  trigger,
}: {
  observedAt?: Date;
  resultReason?: GitHubSyncResultReason;
  trigger: GitHubFetchTrigger;
}): GitHubFetchProvenance {
  return {
    credentialType: GitHubFetchCredentialTypeValue.GitHubApp,
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
