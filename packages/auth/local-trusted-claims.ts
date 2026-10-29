import type { useAuth } from "@clerk/nextjs";
import {
  LOCAL_TRUSTED_ORG_ROLE,
  LOCAL_TRUSTED_SESSION_ID,
  type LocalTrustedIdentity,
} from "./auth-mode";

/**
 * The synthetic session's JWT claims, shared by the server's `auth()` projection
 * (`local-trusted-session.ts`, which is `server-only`) and the browser's
 * `useAuth()` projection (`local-trusted-hooks.ts`), so the two cannot disagree
 * about the session they both describe.
 */
type SignedInWithOrganization = Extract<
  ReturnType<typeof useAuth>,
  { orgId: string }
>;
export type LocalTrustedSessionClaims =
  SignedInWithOrganization["sessionClaims"];

// A far-future expiry so the synthetic claims never read as "expired"; the
// values are inert (no signature is ever verified for this session).
export const SYNTHETIC_ISSUED_AT_SECONDS = 0;
const SYNTHETIC_EXPIRY_SECONDS = 4_102_444_800; // 2100-01-01T00:00:00Z

export function buildLocalTrustedSessionClaims(
  identity: LocalTrustedIdentity
): LocalTrustedSessionClaims {
  return {
    __raw: "",
    azp: undefined,
    exp: SYNTHETIC_EXPIRY_SECONDS,
    iat: SYNTHETIC_ISSUED_AT_SECONDS,
    iss: "https://local-trusted.e2e.test",
    nbf: SYNTHETIC_ISSUED_AT_SECONDS,
    org_id: identity.orgId,
    org_permissions: [],
    org_role: LOCAL_TRUSTED_ORG_ROLE,
    org_slug: identity.orgSlug,
    sid: LOCAL_TRUSTED_SESSION_ID,
    sub: identity.userId,
  };
}

/** The `has()` both projections answer with: the synthetic org-admin role only. */
export function hasLocalTrustedRole(params: { role?: string }): boolean {
  return params.role === LOCAL_TRUSTED_ORG_ROLE;
}
