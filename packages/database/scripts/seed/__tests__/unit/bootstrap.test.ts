import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../../generated/client";
import {
  applyBootstrapTarget,
  BOOTSTRAP_ORG_ID,
  BOOTSTRAP_USER_ID,
  ensureBootstrapUser,
  resolveBootstrapIdentity,
} from "../../bootstrap";
import { SeedSetupFailureMarker } from "../../setup-failure";

const SANDBOX_ENV_KEYS = [
  "SEED_SANDBOX_CLERK_ORG_ID",
  "SEED_SANDBOX_CLERK_USER_ID",
  "SEED_SANDBOX_ORG_SLUG",
  "SEED_SANDBOX_ORG_NAME",
  "SEED_SANDBOX_USER_EMAIL",
] as const;

const USER_REQUIRES_ORG_PATTERN = /requires SEED_SANDBOX_CLERK_ORG_ID/i;
const SANDBOX_OVERRIDE_REQUIRES_ORG_PATTERN = /only apply when/i;

function makePrisma() {
  const orgUpsert = vi.fn().mockResolvedValue({ id: BOOTSTRAP_ORG_ID });
  const userUpsert = vi.fn().mockResolvedValue({ id: BOOTSTRAP_USER_ID });
  const prisma = {
    organization: { upsert: orgUpsert },
    user: { upsert: userUpsert },
  } as unknown as PrismaClient;
  return { prisma, orgUpsert, userUpsert };
}

// Snapshot and clear the Sandbox identity env so each test starts on the
// synthetic fallback and nothing leaks between tests (ensureBootstrapUser reads
// process.env at call time).
const savedSandboxEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of SANDBOX_ENV_KEYS) {
    savedSandboxEnv[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SANDBOX_ENV_KEYS) {
    if (savedSandboxEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedSandboxEnv[key];
    }
  }
});

describe("ensureBootstrapUser", () => {
  it("upserts a synthetic org + user and returns the resulting ids", async () => {
    const { prisma, orgUpsert, userUpsert } = makePrisma();

    const result = await ensureBootstrapUser(prisma);

    expect(result).toEqual({
      organizationId: BOOTSTRAP_ORG_ID,
      userId: BOOTSTRAP_USER_ID,
    });
    // Org upsert keys on the unique clerkId (not the id), and the create branch
    // pins the deterministic id.
    expect(orgUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clerkId: expect.any(String) }),
        create: expect.objectContaining({ id: BOOTSTRAP_ORG_ID }),
      })
    );
    // User upsert keys on the (clerkId, organizationId) compound unique and is
    // scoped to the org returned by the org upsert.
    expect(userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clerkId_organizationId: expect.objectContaining({
            organizationId: BOOTSTRAP_ORG_ID,
          }),
        }),
        create: expect.objectContaining({ organizationId: BOOTSTRAP_ORG_ID }),
      })
    );
  });

  it("is idempotent — upserts with an empty update so reruns converge", async () => {
    const { prisma, orgUpsert, userUpsert } = makePrisma();

    await ensureBootstrapUser(prisma);
    await ensureBootstrapUser(prisma);

    expect(orgUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
    expect(userUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} })
    );
  });

  it("wraps an underlying failure with the bootstrap setup-failure marker", async () => {
    const prisma = {
      organization: {
        upsert: vi.fn().mockRejectedValue(new Error("unique violation")),
      },
      user: { upsert: vi.fn() },
    } as unknown as PrismaClient;

    await expect(ensureBootstrapUser(prisma)).rejects.toThrow(
      SeedSetupFailureMarker.Bootstrap
    );
  });
});

describe("applyBootstrapTarget", () => {
  const bootstrap = {
    organizationId: BOOTSTRAP_ORG_ID,
    userId: BOOTSTRAP_USER_ID,
  };

  it("returns both undefined (legacy lookup) when there is no CLI target and no bootstrap", () => {
    expect(applyBootstrapTarget({}, undefined)).toEqual({
      organizationId: undefined,
      userId: undefined,
    });
  });

  it("targets the bootstrap identity when --bootstrap-user ran and no explicit CLI target", () => {
    expect(applyBootstrapTarget({}, bootstrap)).toEqual({
      organizationId: BOOTSTRAP_ORG_ID,
      userId: BOOTSTRAP_USER_ID,
    });
  });

  it("lets an explicit CLI target win over the bootstrap identity", () => {
    expect(
      applyBootstrapTarget(
        { organizationId: "cli-org", userId: "cli-user" },
        bootstrap
      )
    ).toEqual({ organizationId: "cli-org", userId: "cli-user" });
  });

  it("merges per-field — CLI org with bootstrap user", () => {
    expect(
      applyBootstrapTarget({ organizationId: "cli-org" }, bootstrap)
    ).toEqual({ organizationId: "cli-org", userId: BOOTSTRAP_USER_ID });
  });
});

describe("resolveBootstrapIdentity", () => {
  it("returns the synthetic identity when no Sandbox config is set", () => {
    const identity = resolveBootstrapIdentity({});

    expect(identity).toEqual({
      orgClerkId: "seed_preview_org_synthetic",
      userClerkId: "seed_preview_user_synthetic",
      orgSlug: "preview-seed-org",
      orgName: "Preview Seed Organization",
      userEmail: "seed-preview-bootstrap@example.com",
      source: "synthetic",
    });
  });

  it("binds to the configured Sandbox clerkIds when both are set", () => {
    const identity = resolveBootstrapIdentity({
      SEED_SANDBOX_CLERK_ORG_ID: "org_sandbox123",
      SEED_SANDBOX_CLERK_USER_ID: "user_sandbox456",
    });

    expect(identity.source).toBe("sandbox");
    expect(identity.orgClerkId).toBe("org_sandbox123");
    expect(identity.userClerkId).toBe("user_sandbox456");
    // Sandbox source uses sandbox-distinct DB defaults (NOT the synthetic ones)
    // so the two identities never collide on the slug/email unique constraints.
    expect(identity.orgSlug).toBe("seed-sandbox");
    expect(identity.orgName).toBe("Seed Sandbox");
    expect(identity.userEmail).toBe("seed-sandbox@example.com");
  });

  it("honors optional slug/name/email overrides", () => {
    // Use values DISTINCT from the SANDBOX_DEFAULT_* fallbacks so the assertions
    // actually exercise the override branch (not the default).
    const identity = resolveBootstrapIdentity({
      SEED_SANDBOX_CLERK_ORG_ID: "org_sandbox123",
      SEED_SANDBOX_CLERK_USER_ID: "user_sandbox456",
      SEED_SANDBOX_ORG_SLUG: "custom-override-slug",
      SEED_SANDBOX_ORG_NAME: "Custom Override Org",
      SEED_SANDBOX_USER_EMAIL: "custom-override@example.com",
    });

    expect(identity.orgSlug).toBe("custom-override-slug");
    expect(identity.orgName).toBe("Custom Override Org");
    expect(identity.userEmail).toBe("custom-override@example.com");
  });

  it("treats blank/whitespace values as unset (synthetic fallback)", () => {
    const identity = resolveBootstrapIdentity({
      SEED_SANDBOX_CLERK_ORG_ID: "   ",
      SEED_SANDBOX_CLERK_USER_ID: "",
    });

    expect(identity.source).toBe("synthetic");
    expect(identity.orgClerkId).toBe("seed_preview_org_synthetic");
  });

  it("defaults the user clerkId to a synthetic anchor when only the org id is set", () => {
    // The user is optional — nobody authenticates as it (visibility is scoped by
    // the org). Setting just the org is the common case (e.g. reusing an existing
    // Clerk org); the bootstrap user falls back to the synthetic anchor.
    const identity = resolveBootstrapIdentity({
      SEED_SANDBOX_CLERK_ORG_ID: "org_only",
    });

    expect(identity.source).toBe("sandbox");
    expect(identity.orgClerkId).toBe("org_only");
    expect(identity.userClerkId).toBe("seed_sandbox_user_synthetic");
    // Still distinct from the synthetic-fallback user clerkId.
    expect(identity.userClerkId).not.toBe("seed_preview_user_synthetic");
  });

  it("rejects a user id without an org id (user can't define the sandbox)", () => {
    expect(() =>
      resolveBootstrapIdentity({ SEED_SANDBOX_CLERK_USER_ID: "user_only" })
    ).toThrow(USER_REQUIRES_ORG_PATTERN);
  });

  it("rejects slug/name/email overrides when the org id is unset", () => {
    // Guards against a synthetic org silently grabbing the sandbox slug (which
    // would collide once sandbox is enabled). The overrides are sandbox-only.
    expect(() =>
      resolveBootstrapIdentity({ SEED_SANDBOX_ORG_SLUG: "seed-sandbox" })
    ).toThrow(SANDBOX_OVERRIDE_REQUIRES_ORG_PATTERN);
    expect(() =>
      resolveBootstrapIdentity({ SEED_SANDBOX_USER_EMAIL: "x@example.com" })
    ).toThrow(SANDBOX_OVERRIDE_REQUIRES_ORG_PATTERN);
  });
});

describe("ensureBootstrapUser — Sandbox identity binding", () => {
  it("binds the upsert to the configured Sandbox clerkIds and a distinct row id", async () => {
    process.env.SEED_SANDBOX_CLERK_ORG_ID = "org_sandbox123";
    process.env.SEED_SANDBOX_CLERK_USER_ID = "user_sandbox456";
    const sandboxOrgId = "019eb3c3-0000-7000-8000-000000000001";
    const orgUpsert = vi.fn().mockResolvedValue({ id: sandboxOrgId });
    const userUpsert = vi.fn().mockResolvedValue({ id: "sandbox-user-row" });
    const prisma = {
      organization: { upsert: orgUpsert },
      user: { upsert: userUpsert },
    } as unknown as PrismaClient;

    await ensureBootstrapUser(prisma);

    const orgArgs = orgUpsert.mock.calls[0][0];
    expect(orgArgs.where.clerkId).toBe("org_sandbox123");
    expect(orgArgs.create.clerkId).toBe("org_sandbox123");
    // Sandbox row id is derived from the clerkId, distinct from the synthetic
    // BOOTSTRAP_ORG_ID so the two never collide on the primary key.
    expect(orgArgs.create.id).not.toBe(BOOTSTRAP_ORG_ID);

    const userArgs = userUpsert.mock.calls[0][0];
    expect(userArgs.where.clerkId_organizationId.clerkId).toBe(
      "user_sandbox456"
    );
    expect(userArgs.create.id).not.toBe(BOOTSTRAP_USER_ID);
  });
});
