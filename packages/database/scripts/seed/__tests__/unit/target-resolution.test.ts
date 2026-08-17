import { describe, expect, it, vi } from "vitest";
import { SeedOrgPreflightStatus } from "../../non-empty-org-guard";
import { SeedAuditMode } from "../../profiles";
import { resolveAuditMode, resolveSeedTarget } from "../../target-resolution";

/**
 * Which organization and user a seed run targets.
 *
 * The ambiguity refusals are what these tests are really for. With no explicit
 * `--organization-id` / `--user-id`, the run INFERS its target — and an
 * inference that silently picked the first of several organizations would seed,
 * or with `--reset` WIPE, the wrong one. Both resolvers read `take: 2` and
 * refuse when a second row exists rather than ordering and taking the first, so
 * these cases assert the refusal, not just the happy path.
 *
 * Every function already took `prisma` as a parameter, so a fake client is
 * enough — no database.
 */

const AMBIGUOUS_ORG = /multiple organizations exist/;
const AMBIGUOUS_USER = /multiple users exist/;
const ORG_NOT_FOUND = /target organization was not found/;
const USER_NOT_IN_ORG = /target user was not found/;
const NO_USERS = /No users found/;
const ORG_MISSING_FOR_USER = /Organization not found for resolved user/;

type FakePrismaParts = {
  orgFindUnique?: unknown;
  orgFindMany?: unknown[];
  userFindFirst?: unknown;
  userFindMany?: unknown[];
};

function fakePrisma(parts: FakePrismaParts) {
  return {
    organization: {
      findUnique: vi.fn().mockResolvedValue(parts.orgFindUnique ?? null),
      findMany: vi.fn().mockResolvedValue(parts.orgFindMany ?? []),
    },
    user: {
      findFirst: vi.fn().mockResolvedValue(parts.userFindFirst ?? null),
      findMany: vi.fn().mockResolvedValue(parts.userFindMany ?? []),
    },
  } as unknown as Parameters<typeof resolveSeedTarget>[0];
}

const ORG = { id: "org-1" };
const USER = { id: "user-1", organizationId: "org-1", email: "a@example.com" };

describe("resolveSeedTarget — explicit flags", () => {
  it("uses the organization and user the caller named", async () => {
    const prisma = fakePrisma({ orgFindUnique: ORG, userFindFirst: USER });

    const target = await resolveSeedTarget(prisma, {
      resetRequested: false,
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(target).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      userEmail: "a@example.com",
      source: "explicit-flags",
    });
  });

  it("refuses when the named organization does not exist", async () => {
    const prisma = fakePrisma({ orgFindUnique: null });

    await expect(
      resolveSeedTarget(prisma, {
        resetRequested: false,
        organizationId: "missing",
      })
    ).rejects.toThrow(ORG_NOT_FOUND);
  });

  it("refuses when the named user is not in the target organization", async () => {
    // The user lookup is scoped by organizationId, so a real user in ANOTHER
    // org resolves to null here — and must be refused rather than seeded.
    const prisma = fakePrisma({ orgFindUnique: ORG, userFindFirst: null });

    await expect(
      resolveSeedTarget(prisma, {
        resetRequested: false,
        organizationId: "org-1",
        userId: "user-from-another-org",
      })
    ).rejects.toThrow(USER_NOT_IN_ORG);
  });
});

describe("resolveSeedTarget — inference refuses to guess", () => {
  it("infers a sole organization and user when reset is requested", async () => {
    const prisma = fakePrisma({
      orgFindMany: [ORG],
      userFindMany: [{ id: "user-1", email: "a@example.com" }],
    });

    const target = await resolveSeedTarget(prisma, { resetRequested: true });

    expect(target).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      source: "inferred",
    });
  });

  it("REFUSES when more than one organization exists", async () => {
    // The dangerous case: with --reset this would wipe whichever org happened
    // to sort first.
    const prisma = fakePrisma({ orgFindMany: [ORG, { id: "org-2" }] });

    await expect(
      resolveSeedTarget(prisma, { resetRequested: true })
    ).rejects.toThrow(AMBIGUOUS_ORG);
  });

  it("REFUSES when more than one user exists in the target organization", async () => {
    const prisma = fakePrisma({
      orgFindMany: [ORG],
      userFindMany: [
        { id: "user-1", email: "a@example.com" },
        { id: "user-2", email: "b@example.com" },
      ],
    });

    await expect(
      resolveSeedTarget(prisma, { resetRequested: true })
    ).rejects.toThrow(AMBIGUOUS_USER);
  });

  it("refuses when no organization exists at all", async () => {
    const prisma = fakePrisma({ orgFindMany: [] });

    await expect(
      resolveSeedTarget(prisma, { resetRequested: true })
    ).rejects.toThrow(ORG_NOT_FOUND);
  });

  it("reads only two rows — enough to detect ambiguity, no more", async () => {
    const prisma = fakePrisma({
      orgFindMany: [ORG],
      userFindMany: [{ id: "user-1", email: "a@example.com" }],
    });

    await resolveSeedTarget(prisma, { resetRequested: true });

    const orgFindMany = (
      prisma as unknown as {
        organization: { findMany: ReturnType<typeof vi.fn> };
      }
    ).organization.findMany;
    expect(orgFindMany.mock.calls[0][0]).toMatchObject({ take: 2 });
  });
});

describe("resolveSeedTarget — legacy path", () => {
  it("falls back to the oldest user when neither reset nor flags are given", async () => {
    const prisma = fakePrisma({
      userFindFirst: USER,
      orgFindUnique: ORG,
    });

    const target = await resolveSeedTarget(prisma, { resetRequested: false });

    expect(target).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      source: "legacy-default",
    });
  });

  it("refuses when the database has no users", async () => {
    const prisma = fakePrisma({ userFindFirst: null });

    await expect(
      resolveSeedTarget(prisma, { resetRequested: false })
    ).rejects.toThrow(NO_USERS);
  });

  it("refuses when the resolved user's organization is missing", async () => {
    // A dangling organizationId is corrupt data, not a seedable target.
    const prisma = fakePrisma({ userFindFirst: USER, orgFindUnique: null });

    await expect(
      resolveSeedTarget(prisma, { resetRequested: false })
    ).rejects.toThrow(ORG_MISSING_FOR_USER);
  });

  it("takes the legacy path only when BOTH reset and flags are absent", async () => {
    // An explicit flag alone is enough to leave the legacy path, even without
    // --reset.
    // Only the org is named, so the USER is still inferred — via findMany,
    // not findFirst.
    const prisma = fakePrisma({
      orgFindUnique: ORG,
      userFindMany: [{ id: "user-1", email: "a@example.com" }],
    });

    const target = await resolveSeedTarget(prisma, {
      resetRequested: false,
      organizationId: "org-1",
    });

    expect(target.source).toBe("explicit-flags");
  });
});

describe("resolveAuditMode", () => {
  it("records a forced overwrite when conflicts were overridden", () => {
    expect(
      resolveAuditMode({
        conflicts: ["project"],
        status: SeedOrgPreflightStatus.SeedOwned,
        forceOverwrite: true,
      })
    ).toBe(SeedAuditMode.ForceOverwriteNonEmpty);
  });

  it("records an idempotent reseed of a seed-owned org", () => {
    expect(
      resolveAuditMode({
        conflicts: [],
        status: SeedOrgPreflightStatus.SeedOwned,
        forceOverwrite: false,
      })
    ).toBe(SeedAuditMode.IdempotentSeedOrg);
  });

  it("records a clean org when there is nothing to overwrite", () => {
    expect(
      resolveAuditMode({
        conflicts: [],
        status: SeedOrgPreflightStatus.Clean,
        forceOverwrite: false,
      })
    ).toBe(SeedAuditMode.CleanOrg);
  });

  it("does not record a forced overwrite when there were no conflicts", () => {
    // forceOverwrite is an operator intent; without conflicts nothing was
    // actually overwritten, and the audit must not claim otherwise.
    expect(
      resolveAuditMode({
        conflicts: [],
        status: SeedOrgPreflightStatus.Clean,
        forceOverwrite: true,
      })
    ).toBe(SeedAuditMode.CleanOrg);
  });

  it("does not record a forced overwrite when conflicts were NOT overridden", () => {
    expect(
      resolveAuditMode({
        conflicts: ["project"],
        status: SeedOrgPreflightStatus.Clean,
        forceOverwrite: false,
      })
    ).toBe(SeedAuditMode.CleanOrg);
  });
});
