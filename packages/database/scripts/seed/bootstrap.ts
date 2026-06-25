/**
 * Synthetic user/org bootstrap for environments that have no pre-existing
 * authenticated user (CI preview schemas, the PR-test smoke DB). PRD-153 / FR-005
 * require the seed to run under an authenticated user's organization; for
 * synthetic-first previews we create that precondition directly instead of
 * cloning production/stage data.
 *
 * Identity anchor (FEA-1715): the synthetic *data* is always 100% synthetic, but
 * the *identity* it hangs off is configurable. When the team-provisioned "Seed
 * Sandbox" Clerk org + user ids are supplied as non-secret config
 * (SEED_SANDBOX_CLERK_ORG_ID / SEED_SANDBOX_CLERK_USER_ID), the bootstrap binds
 * the org/user rows to those REAL clerkIds so a human who is a member of the
 * Sandbox org can authenticate with their own login and actually see the seeded
 * data (reads are scoped by the active Clerk org — see
 * apps/api/lib/auth/resolve-any-auth-context.ts). Until the Sandbox identity is
 * provisioned, the bootstrap falls back to clearly-synthetic placeholder Clerk
 * IDs that no human signs in as (current behavior). Either way the clerkIds come
 * from config/constants, never copied prod credentials (FR-008).
 *
 * Idempotent: the upserts key on the stable business unique keys (clerkId, and
 * (clerkId, organizationId) for the user) — NOT the deterministic id — so reruns,
 * and a pre-existing synthetic row under a different id, converge without
 * tripping a slug/clerkId unique-constraint violation.
 */
import { z } from "zod";
import type { PrismaClient } from "../../generated/client";
import { deterministicUuid } from "./helpers";
import { SeedSetupFailureMarker } from "./setup-failure";

export const BOOTSTRAP_ORG_ID = deterministicUuid(
  "preview-bootstrap-organization-v1"
);
export const BOOTSTRAP_USER_ID = deterministicUuid("preview-bootstrap-user-v1");

// Synthetic fallback identity. Clearly-synthetic placeholder Clerk IDs / slug /
// email (FR-008 — never real credentials). Used for unit/integration tests that
// bypass Clerk auth and for any environment where the Sandbox identity has not
// been provisioned yet.
const SYNTHETIC_ORG_CLERK_ID = "seed_preview_org_synthetic";
const SYNTHETIC_USER_CLERK_ID = "seed_preview_user_synthetic";
const SYNTHETIC_ORG_SLUG = "preview-seed-org";
const SYNTHETIC_ORG_NAME = "Preview Seed Organization";
// Placeholder email: `seed-` prefix + example.com domain so the credential
// audit (credential-audit.test.ts) recognizes it as synthetic, not a real one.
const SYNTHETIC_USER_EMAIL = "seed-preview-bootstrap@example.com";

// Sandbox identity DB-side defaults. Distinct from the synthetic defaults so the
// two identities never collide on the Organization `slug` (or User `email`)
// unique constraint if a schema is re-seeded across the synthetic→sandbox
// cut-over. Still clearly synthetic (example.com email); only the clerkIds —
// supplied via config — are real, non-prod fixtures.
const SANDBOX_DEFAULT_ORG_SLUG = "seed-sandbox";
const SANDBOX_DEFAULT_ORG_NAME = "Seed Sandbox";
const SANDBOX_DEFAULT_USER_EMAIL = "seed-sandbox@example.com";
// The Sandbox bootstrap user is only a data-ownership anchor (createdById /
// assigneeId on the seeded rows) — no human authenticates as it (visibility is
// scoped by the active Clerk ORG, not the user). So SEED_SANDBOX_CLERK_USER_ID
// is optional and defaults to this synthetic clerkId; override it only if you
// want authored-by/assignee to resolve to a real "Seed Bot" Clerk user.
const SANDBOX_DEFAULT_USER_CLERK_ID = "seed_sandbox_user_synthetic";

export type BootstrapResult = {
  organizationId: string;
  userId: string;
};

export const BootstrapIdentitySource = {
  Sandbox: "sandbox",
  Synthetic: "synthetic",
} as const;
export type BootstrapIdentitySource =
  (typeof BootstrapIdentitySource)[keyof typeof BootstrapIdentitySource];

export type ResolvedBootstrapIdentity = {
  orgClerkId: string;
  userClerkId: string;
  orgSlug: string;
  orgName: string;
  userEmail: string;
  source: BootstrapIdentitySource;
};

/**
 * Idempotently ensures a single Organization + User exist so the seed can
 * resolve an authenticated user, bound to the configured Sandbox identity when
 * provisioned and the synthetic fallback otherwise. Returns the deterministic
 * IDs.
 */
export async function ensureBootstrapUser(
  prisma: PrismaClient
): Promise<BootstrapResult> {
  try {
    // Resolve identity (incl. the sandbox config validation) inside the try so a
    // misconfiguration ZodError is wrapped with the Bootstrap setup-failure
    // marker like every other bootstrap failure.
    const identity = resolveBootstrapIdentity(process.env);
    const organizationId = resolveBootstrapOrgId(identity.orgClerkId);
    const userId = resolveBootstrapUserId(identity.userClerkId);
    // Key the upserts on the stable business unique keys (clerkId / (clerkId,
    // organizationId)), not the deterministic id, so reruns converge even if the
    // id constant is ever bumped — and so a pre-existing synthetic row under a
    // different id does not trip a slug/clerkId unique-constraint violation.
    const organization = await prisma.organization.upsert({
      where: { clerkId: identity.orgClerkId },
      update: {},
      create: {
        id: organizationId,
        clerkId: identity.orgClerkId,
        name: identity.orgName,
        slug: identity.orgSlug,
      },
    });
    const user = await prisma.user.upsert({
      where: {
        clerkId_organizationId: {
          clerkId: identity.userClerkId,
          organizationId: organization.id,
        },
      },
      update: {},
      create: {
        id: userId,
        clerkId: identity.userClerkId,
        organizationId: organization.id,
        email: identity.userEmail,
      },
    });
    return { organizationId: organization.id, userId: user.id };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${SeedSetupFailureMarker.Bootstrap}: ${detail}`);
  }
}

/**
 * Resolves the effective seed target from the explicit CLI target and (when
 * `--bootstrap-user` ran) the synthetic bootstrap identity. Precedence:
 * explicit CLI flags > the bootstrap identity > legacy resolution (both
 * undefined → the seed falls back to the oldest-user lookup).
 *
 * Without this, `--bootstrap-user` would create the synthetic org/user but then
 * the legacy oldest-user lookup could seed a *different* pre-existing org in a
 * stale/mis-targeted schema (review: shafty023 on seed.ts).
 */
export function applyBootstrapTarget(
  cliTarget: { organizationId?: string; userId?: string },
  bootstrap: BootstrapResult | undefined
): { organizationId?: string; userId?: string } {
  return {
    organizationId: cliTarget.organizationId ?? bootstrap?.organizationId,
    userId: cliTarget.userId ?? bootstrap?.userId,
  };
}

// Sandbox identity config. SEED_SANDBOX_CLERK_ORG_ID is the load-bearing field
// (visibility is scoped by the active Clerk org). SEED_SANDBOX_CLERK_USER_ID is
// OPTIONAL — the bootstrap user is only a data-ownership anchor nobody logs in
// as, so it defaults to a synthetic clerkId. A user id WITHOUT an org id is
// rejected (a user can't define the sandbox on its own). The optional
// slug/name/email overrides are sandbox-only: they are rejected without the org
// id so they can never re-skin the SYNTHETIC identity (e.g. leaving
// SEED_SANDBOX_ORG_SLUG=seed-sandbox set during a cut-over rollback would
// otherwise make the synthetic org grab the sandbox slug and collide on the next
// sandbox enable — review: thadeusb).
const sandboxIdentitySchema = z
  .object({
    orgClerkId: z.string().trim().min(1).optional(),
    userClerkId: z.string().trim().min(1).optional(),
    orgSlug: z.string().trim().min(1).optional(),
    orgName: z.string().trim().min(1).optional(),
    userEmail: z.string().trim().min(1).optional(),
  })
  .refine(
    (config) =>
      config.userClerkId === undefined || config.orgClerkId !== undefined,
    {
      message:
        "SEED_SANDBOX_CLERK_USER_ID requires SEED_SANDBOX_CLERK_ORG_ID to be set.",
    }
  )
  .refine(
    (config) =>
      // Overrides are gated on the load-bearing org id (sandbox mode).
      config.orgClerkId !== undefined ||
      (config.orgSlug === undefined &&
        config.orgName === undefined &&
        config.userEmail === undefined),
    {
      message:
        "SEED_SANDBOX_ORG_SLUG / _ORG_NAME / _USER_EMAIL only apply when SEED_SANDBOX_CLERK_ORG_ID is set.",
    }
  );

/**
 * Resolves the effective bootstrap identity from the environment. When the
 * Sandbox Clerk org+user ids are supplied, binds to them (the "sandbox" source)
 * with sandbox-specific DB defaults; otherwise returns the synthetic placeholder
 * identity (the "synthetic" source). Blank/whitespace env values are treated as
 * unset.
 */
export function resolveBootstrapIdentity(
  env: NodeJS.ProcessEnv
): ResolvedBootstrapIdentity {
  const parsed = sandboxIdentitySchema.parse({
    orgClerkId: blankToUndefined(env.SEED_SANDBOX_CLERK_ORG_ID),
    userClerkId: blankToUndefined(env.SEED_SANDBOX_CLERK_USER_ID),
    orgSlug: blankToUndefined(env.SEED_SANDBOX_ORG_SLUG),
    orgName: blankToUndefined(env.SEED_SANDBOX_ORG_NAME),
    userEmail: blankToUndefined(env.SEED_SANDBOX_USER_EMAIL),
  });

  const isSandbox = parsed.orgClerkId !== undefined;
  return {
    orgClerkId: parsed.orgClerkId ?? SYNTHETIC_ORG_CLERK_ID,
    userClerkId:
      parsed.userClerkId ??
      (isSandbox ? SANDBOX_DEFAULT_USER_CLERK_ID : SYNTHETIC_USER_CLERK_ID),
    orgSlug:
      parsed.orgSlug ??
      (isSandbox ? SANDBOX_DEFAULT_ORG_SLUG : SYNTHETIC_ORG_SLUG),
    orgName:
      parsed.orgName ??
      (isSandbox ? SANDBOX_DEFAULT_ORG_NAME : SYNTHETIC_ORG_NAME),
    userEmail:
      parsed.userEmail ??
      (isSandbox ? SANDBOX_DEFAULT_USER_EMAIL : SYNTHETIC_USER_EMAIL),
    source: isSandbox
      ? BootstrapIdentitySource.Sandbox
      : BootstrapIdentitySource.Synthetic,
  };
}

function blankToUndefined(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Maps a bootstrap org clerkId to its deterministic row id. The synthetic
 * fallback preserves the historical BOOTSTRAP_ORG_ID exactly (stable across the
 * cut-over and asserted by existing tests); a configured Sandbox identity gets a
 * distinct deterministic id derived from its clerkId so the two never collide on
 * the `id` primary key if they ever share a schema.
 */
function resolveBootstrapOrgId(orgClerkId: string): string {
  return orgClerkId === SYNTHETIC_ORG_CLERK_ID
    ? BOOTSTRAP_ORG_ID
    : deterministicUuid(`preview-bootstrap-organization-v1:${orgClerkId}`);
}

function resolveBootstrapUserId(userClerkId: string): string {
  return userClerkId === SYNTHETIC_USER_CLERK_ID
    ? BOOTSTRAP_USER_ID
    : deterministicUuid(`preview-bootstrap-user-v1:${userClerkId}`);
}
