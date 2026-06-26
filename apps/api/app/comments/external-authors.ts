import { ApproverRole } from "@repo/api/src/types/user";
import {
  ExternalCommentProvider,
  type TransactionClient,
  withDb,
} from "@repo/database";

const UNKNOWN_GITHUB_USER_LOGIN = "unknown-github-user";
const UNKNOWN_GITHUB_USER_DISPLAY_NAME = "Unknown GitHub user";

/**
 * Minimal GitHub user payload accepted from REST, GraphQL, and webhook event
 * producers when resolving external comment attribution.
 */
export type ExternalGitHubUser = {
  id?: number | string | null;
  node_id?: string | null;
  login?: string | null;
  avatar_url?: string | null;
  html_url?: string | null;
};

/**
 * GitHub object that caused an external author to be materialized. The source is
 * part of ghost identity generation when GitHub omits/deletes user data.
 */
export type ExternalGitHubAuthorSource = {
  sourceKind: "issue_comment" | "review_comment" | "review" | "review_thread";
  githubObjectId: string;
  repositoryId?: string;
  pullNumber?: number;
};

/**
 * Input required to resolve a GitHub webhook/list author into an organization
 * scoped platform user or deterministic inactive shadow user.
 */
export type ResolveExternalGitHubAuthorInput = {
  organizationId: string;
  author: ExternalGitHubUser | null;
  source: ExternalGitHubAuthorSource;
};

/**
 * Normalized provider identity stored on `ExternalCommentAuthor` and used for
 * stable ownership checks. `providerUserId` is numeric/string GitHub id when
 * present, then `node:<node_id>`, then source-scoped ghost id.
 */
export type NormalizedExternalGitHubAuthor = {
  provider: typeof ExternalCommentProvider.GITHUB;
  providerUserId: string;
  providerNodeId: string | null;
  providerLogin: string;
  normalizedLogin: string;
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  isGhost: boolean;
};

type ResolvedExternalAuthorUser = {
  id: string;
  clerkId: string;
  organizationId: string;
  active: boolean;
  email: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  githubUsername: string | null;
};

type ExternalCommentAuthorRecord = {
  id: string;
  organizationId: string;
  provider: typeof ExternalCommentProvider.GITHUB;
  providerUserId: string;
  providerNodeId: string | null;
  providerLogin: string;
  normalizedProviderLogin: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  userId: string;
  user?: ResolvedExternalAuthorUser | null;
};

export type ResolvedExternalGitHubAuthor = {
  identity: NormalizedExternalGitHubAuthor;
  user: ResolvedExternalAuthorUser;
  externalAuthor: ExternalCommentAuthorRecord;
  source: "github_user_connection" | "external_comment_author" | "shadow_user";
};

type PlannedExternalAuthorDb = Pick<
  TransactionClient,
  "externalCommentAuthor" | "gitHubUserConnection" | "user"
>;

type ExistingExternalAuthorDisposition =
  | { action: "reuse"; user: ResolvedExternalAuthorUser }
  | { action: "shadow" };

const USER_SELECT = {
  id: true,
  clerkId: true,
  organizationId: true,
  active: true,
  email: true,
  firstName: true,
  lastName: true,
  avatarUrl: true,
  githubUsername: true,
} as const;

const EXTERNAL_AUTHOR_SELECT = {
  id: true,
  organizationId: true,
  provider: true,
  providerUserId: true,
  providerNodeId: true,
  providerLogin: true,
  normalizedProviderLogin: true,
  displayName: true,
  avatarUrl: true,
  profileUrl: true,
  userId: true,
  user: { select: USER_SELECT },
} as const;

/**
 * Normalizes GitHub logins for durable identity comparisons and storage.
 */
export function normalizeGitHubLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * Converts a nullable GitHub author payload into the provider identity used for
 * external comment attribution.
 */
export function normalizeExternalGitHubAuthor(
  author: ExternalGitHubUser | null,
  source: ExternalGitHubAuthorSource
): NormalizedExternalGitHubAuthor {
  const providerNodeId = trimToNull(author?.node_id);
  const providerId = normalizeGitHubUserId(author?.id);
  const providerUserId =
    providerId ??
    (providerNodeId ? `node:${providerNodeId}` : ghostProviderUserId(source));
  const isGhost = providerUserId.startsWith("ghost:");
  const providerLogin = normalizeProviderLogin(author?.login, isGhost);
  const normalizedLogin = normalizeGitHubLogin(providerLogin);

  return {
    provider: ExternalCommentProvider.GITHUB,
    providerUserId,
    providerNodeId,
    providerLogin,
    normalizedLogin,
    displayName:
      providerLogin === UNKNOWN_GITHUB_USER_LOGIN
        ? UNKNOWN_GITHUB_USER_DISPLAY_NAME
        : providerLogin,
    avatarUrl: isGhost ? null : trimToNull(author?.avatar_url),
    profileUrl: isGhost ? null : trimToNull(author?.html_url),
    isGhost,
  };
}

/**
 * Resolves a GitHub comment author to an internal user without trusting local
 * username-only matches. Unlinked external authors are represented by
 * deterministic inactive shadow users.
 */
export async function resolveExternalGitHubAuthor(
  input: ResolveExternalGitHubAuthorInput
): Promise<ResolvedExternalGitHubAuthor> {
  return await withDb.tx((tx) => resolveExternalGitHubAuthorWithDb(tx, input));
}

/**
 * Resolves a GitHub author using an existing transaction. Webhook handlers use
 * this form so owner resolution and author materialization remain atomic.
 */
export function resolveExternalGitHubAuthorInTransaction(
  tx: PlannedExternalAuthorDb,
  input: ResolveExternalGitHubAuthorInput
): Promise<ResolvedExternalGitHubAuthor> {
  return resolveExternalGitHubAuthorWithDb(tx, input);
}

async function resolveExternalGitHubAuthorWithDb(
  db: PlannedExternalAuthorDb,
  input: ResolveExternalGitHubAuthorInput
): Promise<ResolvedExternalGitHubAuthor> {
  const identity = normalizeExternalGitHubAuthor(input.author, input.source);

  const linkedConnection = await db.gitHubUserConnection.findFirst({
    where: {
      organizationId: input.organizationId,
      revokedAt: null,
      user: { active: true },
      OR: gitHubConnectionIdentityPredicates(identity),
    },
    select: { user: { select: USER_SELECT } },
  });

  if (linkedConnection?.user) {
    const externalAuthor = await upsertExternalAuthor(
      db,
      input.organizationId,
      identity,
      linkedConnection.user.id
    );
    return {
      identity,
      user: linkedConnection.user,
      externalAuthor,
      source: "github_user_connection",
    };
  }

  const existingExternalAuthor = await db.externalCommentAuthor.findUnique({
    where: externalAuthorUniqueWhere(input.organizationId, identity),
    select: EXTERNAL_AUTHOR_SELECT,
  });

  const existingDisposition = classifyExistingExternalAuthor(
    input.organizationId,
    identity,
    existingExternalAuthor
  );
  if (existingExternalAuthor && existingDisposition.action === "reuse") {
    const externalAuthor = await upsertExternalAuthor(
      db,
      input.organizationId,
      identity,
      existingDisposition.user.id
    );
    return {
      identity,
      user: existingDisposition.user,
      externalAuthor,
      source: "external_comment_author",
    };
  }

  const shadowUser = await upsertShadowUser(db, input.organizationId, identity);
  const externalAuthor = await upsertExternalAuthor(
    db,
    input.organizationId,
    identity,
    shadowUser.id
  );

  return {
    identity,
    user: shadowUser,
    externalAuthor,
    source: "shadow_user",
  };
}

function normalizeGitHubUserId(id: ExternalGitHubUser["id"]): string | null {
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }

  if (typeof id !== "string") {
    return null;
  }

  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProviderLogin(
  login: ExternalGitHubUser["login"],
  isGhost: boolean
): string {
  if (isGhost) {
    return UNKNOWN_GITHUB_USER_LOGIN;
  }

  return trimToNull(login) ?? UNKNOWN_GITHUB_USER_LOGIN;
}

function ghostProviderUserId(source: ExternalGitHubAuthorSource): string {
  return `ghost:${source.sourceKind}:${source.githubObjectId}`;
}

function trimToNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function externalAuthorUniqueWhere(
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor
) {
  return {
    organizationId_provider_providerUserId: {
      organizationId,
      provider: identity.provider,
      providerUserId: identity.providerUserId,
    },
  };
}

function gitHubConnectionIdentityPredicates(
  identity: NormalizedExternalGitHubAuthor
) {
  const predicates: Array<{ githubUserId: string } | { githubNodeId: string }> =
    [{ githubUserId: identity.providerUserId }];

  if (identity.providerUserId.startsWith("node:") && identity.providerNodeId) {
    predicates.push({ githubNodeId: identity.providerNodeId });
  }

  return predicates;
}

function classifyExistingExternalAuthor(
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor,
  externalAuthor: ExternalCommentAuthorRecord | null
): ExistingExternalAuthorDisposition {
  const user = externalAuthor?.user;
  if (!user || user.organizationId !== organizationId) {
    return { action: "shadow" };
  }

  if (user.active) {
    return { action: "reuse", user };
  }

  return isDeterministicShadowUser(organizationId, identity, user)
    ? { action: "reuse", user }
    : { action: "shadow" };
}

function isDeterministicShadowUser(
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor,
  user: ResolvedExternalAuthorUser
): boolean {
  const shadow = shadowUserIdentity(organizationId, identity);
  return user.clerkId === shadow.clerkId;
}

function externalAuthorData(
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor,
  userId: string
) {
  return {
    organizationId,
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    providerNodeId: identity.providerNodeId,
    providerLogin: identity.providerLogin,
    normalizedProviderLogin: identity.normalizedLogin,
    displayName: identity.displayName,
    avatarUrl: identity.avatarUrl,
    profileUrl: identity.profileUrl,
    userId,
  };
}

function upsertExternalAuthor(
  db: PlannedExternalAuthorDb,
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor,
  userId: string
) {
  const data = externalAuthorData(organizationId, identity, userId);
  const lastSeenAt = new Date();

  return db.externalCommentAuthor.upsert({
    where: externalAuthorUniqueWhere(organizationId, identity),
    create: { ...data, lastSeenAt },
    update: { ...data, lastSeenAt },
    select: EXTERNAL_AUTHOR_SELECT,
  });
}

function shadowUserIdentity(
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor
) {
  return {
    clerkId: `github-shadow:${organizationId}:${identity.providerUserId}`,
    email: `github-shadow+${organizationId}+${identity.providerUserId}@invalid.closedloop.local`,
  };
}

function upsertShadowUser(
  db: PlannedExternalAuthorDb,
  organizationId: string,
  identity: NormalizedExternalGitHubAuthor
) {
  const shadow = shadowUserIdentity(organizationId, identity);
  const data = {
    active: false,
    firstName: identity.providerLogin,
    lastName: "GitHub",
    avatarUrl: identity.avatarUrl,
    githubUsername: identity.normalizedLogin,
  };

  return db.user.upsert({
    where: {
      clerkId_organizationId: {
        clerkId: shadow.clerkId,
        organizationId,
      },
    },
    create: {
      clerkId: shadow.clerkId,
      organizationId,
      email: shadow.email,
      role: ApproverRole.Engineer,
      ...data,
    },
    update: data,
    select: USER_SELECT,
  });
}
