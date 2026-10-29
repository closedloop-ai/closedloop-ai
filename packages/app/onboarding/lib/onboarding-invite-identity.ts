import type { AuthSnapshot } from "../../shared/auth/auth-adapter";

/**
 * Who this run's invite evidence belongs to (ISS-11670 review): Desktop keeps
 * the host mounted across sign-out and organization switches.
 */
export function inviteEvidenceIdentity(
  authSnapshot: Pick<AuthSnapshot, "orgId" | "userId">
): string | null {
  return authSnapshot.userId
    ? `${authSnapshot.userId}:${authSnapshot.orgId ?? ""}`
    : null;
}
