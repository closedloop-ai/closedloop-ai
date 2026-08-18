/**
 * Shared fixture builders for GitHub App installation lifecycle webhook
 * payloads (`created`, `deleted`, `suspend`, `unsuspend`) plus the
 * `GitHubInstallation` row the handlers read back.
 *
 * They live here rather than inside one suite because the installation-handler
 * tests are split by concern across `unit/webhook-installation.test.ts`
 * (create/delete plus orchestrator routing) and
 * `unit/webhook-installation-suspension.test.ts` (suspend/unsuspend), and both
 * drive the same payload shapes. Pull request and review payloads live in
 * `__tests__/fixtures/github-webhook-fixtures.ts`.
 */

import type {
  InstallationCreatedEvent,
  InstallationDeletedEvent,
  InstallationSuspendEvent,
  InstallationUnsuspendEvent,
} from "@octokit/webhooks-types";
import { VcsProviderKind } from "@repo/api/src/types/vcs-neutral";
import type { GitHubInstallation } from "@repo/database";
import { GitHubInstallationStatus } from "@repo/database";

const ACCOUNT_ID = 12_345;
const DEFAULT_SENDER_LOGIN = "test-user";
const DEFAULT_SENDER_ID = 1;
const SUSPENDER_ID = 999;
const EVENT_TIMESTAMP = "2026-02-06T00:00:00Z";

type RepositoryPayload = {
  id: number;
  node_id: string;
  full_name: string;
  name: string;
  private: boolean;
};

function createAccount(
  login: string,
  id: number,
  accountType: "Organization" | "User"
) {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: "",
    gravatar_id: "",
    url: "",
    html_url: "",
    followers_url: "",
    following_url: "",
    gists_url: "",
    starred_url: "",
    subscriptions_url: "",
    organizations_url: "",
    repos_url: "",
    events_url: "",
    received_events_url: "",
    type: accountType,
    site_admin: false,
  };
}

function createDefaultSender() {
  return createAccount(DEFAULT_SENDER_LOGIN, DEFAULT_SENDER_ID, "User");
}

function createInstallationPayload(
  installationId: number,
  accountLogin: string
) {
  return {
    id: installationId,
    account: createAccount(accountLogin, ACCOUNT_ID, "Organization"),
    target_type: "Organization",
    permissions: {
      metadata: "read",
    },
    events: ["push", "pull_request"],
    repository_selection: "all",
    access_tokens_url: "",
    repositories_url: "",
    html_url: "",
    app_id: 123,
    app_slug: "test-app",
    target_id: ACCOUNT_ID,
    created_at: EVENT_TIMESTAMP,
    updated_at: EVENT_TIMESTAMP,
    single_file_name: null,
    has_multiple_single_files: false,
    single_file_paths: [],
    suspended_by: null,
    suspended_at: null,
  };
}

/**
 * Helper to create minimal installation_created event
 */
export function createInstallationCreatedEvent(
  installationId: number,
  accountLogin: string,
  repositories: RepositoryPayload[] = []
): InstallationCreatedEvent {
  return {
    action: "created",
    installation: createInstallationPayload(installationId, accountLogin),
    repositories,
    sender: createDefaultSender(),
    requester: undefined,
  } as InstallationCreatedEvent;
}

/**
 * Helper to create minimal installation_deleted event
 */
export function createInstallationDeletedEvent(
  installationId: number,
  accountLogin: string
): InstallationDeletedEvent {
  return {
    action: "deleted",
    installation: createInstallationPayload(installationId, accountLogin),
    sender: createDefaultSender(),
    repositories: [],
  } as InstallationDeletedEvent;
}

/**
 * Helper to create minimal installation_suspend event
 */
export function createInstallationSuspendEvent(
  installationId: number,
  accountLogin: string,
  suspendedBy: string
): InstallationSuspendEvent {
  return {
    action: "suspend",
    installation: {
      ...createInstallationPayload(installationId, accountLogin),
      suspended_by: createAccount(suspendedBy, SUSPENDER_ID, "User"),
      suspended_at: EVENT_TIMESTAMP,
    },
    sender: createAccount(suspendedBy, SUSPENDER_ID, "User"),
  } as InstallationSuspendEvent;
}

/**
 * Helper to create minimal installation_unsuspend event
 */
export function createInstallationUnsuspendEvent(
  installationId: number,
  accountLogin: string
): InstallationUnsuspendEvent {
  return {
    action: "unsuspend",
    installation: createInstallationPayload(installationId, accountLogin),
    sender: createDefaultSender(),
  } as InstallationUnsuspendEvent;
}

/**
 * Helper to create mock installation record
 */
export function createMockInstallation(
  partial: Partial<GitHubInstallation> = {}
): GitHubInstallation {
  return {
    id: "installation-uuid",
    installationId: "123456",
    accountId: "12345",
    accountLogin: "test-org",
    accountType: "Organization",
    senderLogin: DEFAULT_SENDER_LOGIN,
    senderId: "1",
    status: GitHubInstallationStatus.ACTIVE,
    provider: VcsProviderKind.GitHub,
    providerDetail: null,
    permissions: {},
    events: [],
    repositorySelection: "all",
    organizationId: "org-uuid",
    claimedAt: new Date(),
    claimedByUserId: "user-uuid",
    suspendedAt: null,
    suspendedBy: null,
    pendingNewInstallationId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}
