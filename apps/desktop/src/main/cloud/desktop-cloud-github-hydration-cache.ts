import { createHash } from "node:crypto";

type HydrationIdentityScope = {
  userId?: string | null;
  organizationId?: string | null;
  profileId?: string | null;
  computeTargetId?: string | null;
};

type SessionIdentity = {
  userId: string;
  organizationId: string;
};

const LIST_TTL_MS = 90_000;
const DETAIL_TTL_MS = 30_000;
const SESSION_CREDENTIAL_SCOPE_PREFIX = "session";

/** Collect the stable repository dimension used by cloud hydration caches. */
export function collectHydrationRepoNames(
  rows: readonly { repoFullName: string | null }[]
): string[] {
  const repoNames = new Set<string>();
  for (const row of rows) {
    if (row.repoFullName) {
      repoNames.add(row.repoFullName);
    }
  }
  return [...repoNames].sort();
}

/** Compose the account- and compute-target-scoped persisted cache identity. */
export function cloudHydrationCacheIdentity(
  credentialScope: string,
  apiOrigin: string,
  scope: HydrationIdentityScope | null
): string {
  return [
    credentialScope,
    apiOrigin,
    scope?.organizationId ?? "unknown-org",
    scope?.userId ?? "unknown-user",
    scope?.profileId ?? "unknown-profile",
    scope?.computeTargetId ?? "unknown-target",
  ].join("|");
}

/** Derive a stable cache scope without retaining a legacy API key. */
export function cloudHydrationKeyFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/** Account-scoped session-lane credential scope: `session:<orgId>:<userId>`. */
export function cloudHydrationSessionScope(identity: SessionIdentity): string {
  return [
    SESSION_CREDENTIAL_SCOPE_PREFIX,
    identity.organizationId,
    identity.userId,
  ].join(":");
}

/** Prevent a token resolved across an account switch from using stale scope. */
export function isSameCloudHydrationSession(
  expected: SessionIdentity,
  current: SessionIdentity | null
): boolean {
  return (
    current?.userId === expected.userId &&
    current.organizationId === expected.organizationId
  );
}

/** Resolve the cache lifetime for list versus detail hydration. */
export function cloudHydrationTtl(scope: "list" | "detail"): number {
  return scope === "detail" ? DETAIL_TTL_MS : LIST_TTL_MS;
}
