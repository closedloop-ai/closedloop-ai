import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  createOrganization: vi.fn(),
  findOrCreateByClerkId: vi.fn(),
  findOrCreateUser: vi.fn(),
  findUserOrganizationBySlug: vi.fn(),
  getOrganization: vi.fn(),
  issueDesktopSessionCredentials: vi.fn(),
  userHasOrganization: vi.fn(),
  verifyDesktopBootstrapToken: vi.fn(),
  updateOrganizationLogo: vi.fn(),
  readLogo: vi.fn(),
  removeLogo: vi.fn(),
}));

vi.mock("./logo-service", () => ({
  desktopBootstrapLogoService: {
    read: mocks.readLogo,
    remove: mocks.removeLogo,
  },
}));

const db = vi.hoisted(() => ({
  desktopBootstrapCode: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    vi.fn((run: (client: typeof db) => unknown) => run(db)),
    { tx: vi.fn((run: (client: typeof db) => unknown) => run(db)) }
  );
  return { withDb };
});

vi.mock("@repo/auth/desktop-bootstrap-jwt", () => ({
  verifyDesktopBootstrapToken: mocks.verifyDesktopBootstrapToken,
}));

vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: {
    createOrganization: mocks.createOrganization,
    findUserOrganizationBySlug: mocks.findUserOrganizationBySlug,
    getOrganization: mocks.getOrganization,
    userHasOrganization: mocks.userHasOrganization,
    updateOrganizationLogo: mocks.updateOrganizationLogo,
  },
}));

vi.mock("@/app/organizations/service", () => ({
  organizationsService: {
    findOrCreateByClerkId: mocks.findOrCreateByClerkId,
  },
}));

vi.mock("@/lib/auth/find-or-create-user", () => ({
  findOrCreateUser: mocks.findOrCreateUser,
}));

vi.mock("@/app/desktop/session/service", () => ({
  issueDesktopSessionCredentials: mocks.issueDesktopSessionCredentials,
}));

import { desktopBootstrapOrganizationService } from "./service";

const now = new Date("2026-10-05T20:00:00.000Z");
const clerkOrganization = {
  id: "org_clerk",
  name: "Acme",
  slug: "acme",
};
const tokens = {
  accessToken: "access",
  accessTokenExpiresAt: now.toISOString(),
  refreshToken: "refresh",
  refreshTokenExpiresAt: now.toISOString(),
  userId: "user-internal",
  organizationId: "org-internal",
};

describe("desktopBootstrapOrganizationService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyDesktopBootstrapToken.mockResolvedValue({
      bootstrapId: "bootstrap-1",
      clerkUserId: "user_clerk",
      gatewayId: "gateway-1",
    });
    mocks.userHasOrganization.mockResolvedValue(false);
    mocks.findOrCreateByClerkId.mockResolvedValue({ id: "org-internal" });
    mocks.findOrCreateUser.mockResolvedValue({
      id: "user-internal",
      active: true,
    });
    mocks.issueDesktopSessionCredentials.mockResolvedValue(tokens);
    db.desktopBootstrapCode.updateMany.mockResolvedValue({ count: 1 });
    db.desktopBootstrapCode.update.mockResolvedValue({ id: "bootstrap-1" });
    mocks.updateOrganizationLogo.mockResolvedValue(undefined);
    mocks.readLogo.mockResolvedValue(
      new File(["logo"], "logo.png", { type: "image/png" })
    );
    mocks.removeLogo.mockResolvedValue(undefined);
  });

  it("rejects an existing member on a fresh attempt even when the slug matches", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(bootstrapRow({}));
    mocks.userHasOrganization.mockResolvedValue(true);
    mocks.findUserOrganizationBySlug.mockResolvedValue(clerkOrganization);

    expect(await create()).toEqual({ ok: false, error: "organization_exists" });
    expect(mocks.findUserOrganizationBySlug).not.toHaveBeenCalled();
    expect(db.desktopBootstrapCode.updateMany).not.toHaveBeenCalled();
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.issueDesktopSessionCredentials).not.toHaveBeenCalled();
  });

  it("recovers a claimed attempt after Clerk creation but before recording its org", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(
      bootstrapRow({ consumedAt: now })
    );
    mocks.userHasOrganization.mockResolvedValue(true);
    mocks.findUserOrganizationBySlug.mockResolvedValue(clerkOrganization);

    expect(await create()).toEqual({ ok: true, value: tokens });
    expect(mocks.findUserOrganizationBySlug).toHaveBeenCalledWith(
      "user_clerk",
      "acme"
    );
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it("records the Clerk organization before atomically completing session issuance", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(
      bootstrapRow({ consumedAt: null, organizationClerkId: null })
    );
    mocks.findUserOrganizationBySlug.mockResolvedValue(null);
    mocks.createOrganization.mockResolvedValue(clerkOrganization);

    await expect(create()).resolves.toEqual({ ok: true, value: tokens });
    expect(mocks.createOrganization).toHaveBeenCalledTimes(1);
    expect(db.desktopBootstrapCode.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: { organizationClerkId: clerkOrganization.id },
      })
    );
    expect(db.desktopBootstrapCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { completedAt: now } })
    );
  });

  it("resumes after Clerk creation without creating a duplicate organization", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(
      bootstrapRow({ consumedAt: new Date(now.getTime() - 1000) })
    );
    mocks.findUserOrganizationBySlug.mockResolvedValue(clerkOrganization);

    await expect(create()).resolves.toEqual({ ok: true, value: tokens });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.findOrCreateByClerkId).toHaveBeenCalledWith(
      clerkOrganization.id,
      { name: clerkOrganization.name, slug: clerkOrganization.slug }
    );
  });

  it("uploads the staged logo to the created organization before issuing tokens", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(bootstrapRow({}));
    mocks.findUserOrganizationBySlug.mockResolvedValue(null);
    mocks.createOrganization.mockResolvedValue(clerkOrganization);
    await expect(
      desktopBootstrapOrganizationService.create({
        bootstrapToken: "bootstrap-token",
        name: "Acme",
        slug: "acme",
        now,
        logo: {
          name: "logo.png",
          type: "image/png",
          size: 4,
          sha256: "a".repeat(64),
        },
      })
    ).resolves.toEqual({ ok: true, value: tokens });
    const uploaded = mocks.updateOrganizationLogo.mock.calls[0][0];
    expect(uploaded.organizationId).toBe(clerkOrganization.id);
    expect(uploaded.uploaderUserId).toBe("user_clerk");
    expect(await uploaded.file.text()).toBe("logo");
    expect(uploaded.file.type).toBe("image/png");
    expect(mocks.removeLogo).toHaveBeenCalledWith("bootstrap-1");
    expect(
      mocks.updateOrganizationLogo.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.issueDesktopSessionCredentials.mock.invocationCallOrder[0]
    );
  });

  it("retries a failed logo upload against the recorded org without issuing a premature session", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(
      bootstrapRow({
        consumedAt: new Date(now.getTime() - 1000),
        organizationClerkId: clerkOrganization.id,
      })
    );
    mocks.getOrganization.mockResolvedValue(clerkOrganization);
    mocks.updateOrganizationLogo.mockRejectedValueOnce(
      new Error("Clerk unavailable")
    );
    const input = {
      bootstrapToken: "bootstrap-token",
      name: "Acme",
      slug: "acme",
      now,
      logo: {
        name: "logo.png",
        type: "image/png",
        size: 4,
        sha256: "a".repeat(64),
      },
    };
    await expect(
      desktopBootstrapOrganizationService.create(input)
    ).rejects.toThrow("Clerk unavailable");
    expect(mocks.issueDesktopSessionCredentials).not.toHaveBeenCalled();
    expect(mocks.removeLogo).not.toHaveBeenCalled();
    expect(db.desktopBootstrapCode.update).not.toHaveBeenCalled();
    await expect(
      desktopBootstrapOrganizationService.create(input)
    ).resolves.toEqual({ ok: true, value: tokens });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
  });

  it("rejects an invalid staged image without creating an organization or session", async () => {
    db.desktopBootstrapCode.findUnique.mockResolvedValue(bootstrapRow({}));
    mocks.readLogo.mockResolvedValue(null);
    expect(
      await desktopBootstrapOrganizationService.create({
        bootstrapToken: "bootstrap-token",
        name: "Acme",
        slug: "acme",
        now,
        logo: {
          name: "logo.png",
          type: "image/png",
          size: 4,
          sha256: "a".repeat(64),
        },
      })
    ).toEqual({ ok: false, error: "invalid" });
    expect(mocks.createOrganization).not.toHaveBeenCalled();
    expect(mocks.issueDesktopSessionCredentials).not.toHaveBeenCalled();
  });
});

function create() {
  return desktopBootstrapOrganizationService.create({
    bootstrapToken: "bootstrap-token",
    name: "Acme",
    slug: "acme",
    now,
  });
}

function bootstrapRow(
  overrides: Partial<{
    completedAt: Date | null;
    consumedAt: Date | null;
    organizationClerkId: string | null;
  }>
) {
  return {
    id: "bootstrap-1",
    clerkUserId: "user_clerk",
    gatewayId: "gateway-1",
    boundPublicKey: "public-key",
    redeemedAt: new Date(now.getTime() - 2000),
    consumedAt: null,
    organizationClerkId: null,
    completedAt: null,
    ...overrides,
  };
}
