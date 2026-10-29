import { randomUUID } from "node:crypto";
import type {
  OrganizationJSON,
  OrganizationMembershipJSON,
  UserJSON,
} from "@repo/auth/server";
import { withDb } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { usersService } from "@/app/users/service";
import {
  handleOrganizationCreated,
  handleOrganizationUpdated,
  handleUserCreated,
  handleUserUpdated,
} from "@/app/webhooks/auth/auth-hooks";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "../utils/db-helpers";

const hasDatabase = !!process.env.DATABASE_URL;

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    identify: vi.fn(),
    capture: vi.fn(),
    groupIdentify: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
  },
}));

// `@repo/auth/server` re-exports `UserJSON` but not the shape of one of its
// email entries, so it is read off the payload type rather than restated.
type EmailAddressJSON = UserJSON["email_addresses"][number];

// Two Clerk stamps a full day apart, so "older" and "newer" cannot be confused
// with the millisecond jitter of a same-tick `Date.now()`.
const OLDER_CLERK_STAMP = 1_700_000_000_000;
const NEWER_CLERK_STAMP = OLDER_CLERK_STAMP + 86_400_000;

function buildOrganizationPayload(overrides: {
  clerkId: string;
  name: string;
  slug: string;
  updatedAt: number;
}): OrganizationJSON {
  return {
    object: "organization",
    id: overrides.clerkId,
    name: overrides.name,
    slug: overrides.slug,
    image_url: "",
    has_image: false,
    created_at: OLDER_CLERK_STAMP,
    updated_at: overrides.updatedAt,
    public_metadata: {},
    private_metadata: {},
    max_allowed_memberships: 100,
    admin_delete_enabled: false,
    members_count: 1,
    created_by: "user_creator_123",
  };
}

function buildUserPayload(overrides: {
  clerkId: string;
  firstName: string;
  updatedAt: number;
  emailAddresses?: EmailAddressJSON[];
  memberships?: OrganizationMembershipJSON[];
}): UserJSON {
  return {
    object: "user",
    id: overrides.clerkId,
    username: null,
    first_name: overrides.firstName,
    last_name: "Mirror",
    image_url: "",
    has_image: false,
    primary_email_address_id: null,
    primary_phone_number_id: null,
    primary_web3_wallet_id: null,
    password_enabled: false,
    two_factor_enabled: false,
    totp_enabled: false,
    backup_code_enabled: false,
    email_addresses: overrides.emailAddresses ?? [],
    phone_numbers: [],
    web3_wallets: [],
    organization_memberships: overrides.memberships ?? null,
    external_accounts: [],
    enterprise_accounts: [],
    password_last_updated_at: null,
    public_metadata: {},
    private_metadata: {},
    unsafe_metadata: {},
    external_id: null,
    last_sign_in_at: null,
    banned: false,
    locked: false,
    lockout_expires_in_seconds: null,
    verification_attempts_remaining: null,
    created_at: OLDER_CLERK_STAMP,
    updated_at: overrides.updatedAt,
    last_active_at: null,
    create_organization_enabled: true,
    create_organizations_limit: null,
    delete_self_enabled: true,
    legal_accepted_at: null,
    locale: null,
  };
}

function buildEmailAddress(email: string): EmailAddressJSON {
  return {
    object: "email_address",
    id: `idn_${email}`,
    email_address: email,
    verification: null,
    linked_to: [],
  };
}

function buildMembership(
  organization: OrganizationJSON,
  member: { clerkId: string; email: string; firstName: string }
): OrganizationMembershipJSON {
  return {
    object: "organization_membership",
    id: `orgmem_${member.clerkId}`,
    public_metadata: {},
    role: "org:member",
    permissions: [],
    created_at: OLDER_CLERK_STAMP,
    updated_at: OLDER_CLERK_STAMP,
    organization,
    public_user_data: {
      identifier: member.email,
      first_name: member.firstName,
      last_name: "Mirror",
      image_url: "",
      has_image: false,
      user_id: member.clerkId,
    },
  };
}

function readOrganization(clerkId: string) {
  return withDb((db) =>
    db.organization.findUniqueOrThrow({
      where: { clerkId },
      select: { name: true, slug: true, clerkUpdatedAt: true },
    })
  );
}

/**
 * ISS-7132: Svix is at-least-once and unordered, so the same `organization.*` /
 * `user.*` payload can arrive twice, and an older one can arrive after a newer
 * one. Before the guard they all wrote straight through, reverting the mirror
 * — and for `slug`, which is the `[orgSlug]` routing key, that changes every URL
 * the org's users hold.
 *
 * Every case pins the status the handler answered, not just the stored row:
 * `POST` awaits these handlers, so anything but a 2xx — including a throw, which
 * becomes a 500 — makes Svix redeliver a payload the guard has already applied
 * or already rejected (review, whitlockk).
 */
describe.skipIf(!hasDatabase)("Clerk mirror replay/ordering guard", () => {
  describe("handleOrganizationUpdated", () => {
    it("applies a delivery newer than the stored stamp", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        await createTestOrganization({
          clerkId,
          name: "Original",
          slug: `${clerkId}-original`,
        });

        const applied = await handleOrganizationUpdated(
          buildOrganizationPayload({
            clerkId,
            name: "Renamed",
            slug: `${clerkId}-renamed`,
            updatedAt: NEWER_CLERK_STAMP,
          })
        );
        expect(applied.status).toBe(204);

        const stored = await readOrganization(clerkId);
        expect(stored.name).toBe("Renamed");
        expect(stored.slug).toBe(`${clerkId}-renamed`);
        expect(stored.clerkUpdatedAt).toEqual(new Date(NEWER_CLERK_STAMP));
      });
    });

    it("ignores a redelivery of an already-applied payload", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        await createTestOrganization({
          clerkId,
          name: "Original",
          slug: `${clerkId}-original`,
        });

        const payload = buildOrganizationPayload({
          clerkId,
          name: "Renamed",
          slug: `${clerkId}-renamed`,
          updatedAt: NEWER_CLERK_STAMP,
        });

        const firstDelivery = await handleOrganizationUpdated(payload);
        expect(firstDelivery.status).toBe(204);
        // A later local rename through `PUT /organizations/:id`, which writes
        // the mirror without a Clerk stamp. The redelivered payload therefore
        // carries a timestamp EQUAL to the stored one — the case that makes the
        // guard `lt` rather than `lte`.
        await withDb((db) =>
          db.organization.update({
            where: { clerkId },
            data: { name: "Edited after the first delivery" },
          })
        );

        const redelivery = await handleOrganizationUpdated(payload);
        expect(redelivery.status).toBe(204);

        const stored = await readOrganization(clerkId);
        expect(stored.name).toBe("Edited after the first delivery");
      });
    });

    it("ignores a delivery that arrives after a newer one", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        await createTestOrganization({
          clerkId,
          name: "Original",
          slug: `${clerkId}-original`,
        });

        const newestDelivery = await handleOrganizationUpdated(
          buildOrganizationPayload({
            clerkId,
            name: "Newest",
            slug: `${clerkId}-newest`,
            updatedAt: NEWER_CLERK_STAMP,
          })
        );
        expect(newestDelivery.status).toBe(204);

        const staleDelivery = await handleOrganizationUpdated(
          buildOrganizationPayload({
            clerkId,
            name: "Stale",
            slug: `${clerkId}-stale`,
            updatedAt: OLDER_CLERK_STAMP,
          })
        );
        expect(staleDelivery.status).toBe(204);

        const stored = await readOrganization(clerkId);
        expect(stored.name).toBe("Newest");
        expect(stored.slug).toBe(`${clerkId}-newest`);
        expect(stored.clerkUpdatedAt).toEqual(new Date(NEWER_CLERK_STAMP));
      });
    });

    it("accepts the first delivery to a row that was never stamped", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        await createTestOrganization({
          clerkId,
          name: "Original",
          slug: `${clerkId}-original`,
        });

        // Rows predating the column, and rows `findOrCreateByClerkId` made from
        // a membership payload, carry no stamp; a null must not read as "newer
        // than everything" and lock the mirror.
        const applied = await handleOrganizationUpdated(
          buildOrganizationPayload({
            clerkId,
            name: "Renamed",
            slug: `${clerkId}-renamed`,
            updatedAt: OLDER_CLERK_STAMP,
          })
        );
        expect(applied.status).toBe(204);

        const stored = await readOrganization(clerkId);
        expect(stored.name).toBe("Renamed");
        expect(stored.clerkUpdatedAt).toEqual(new Date(OLDER_CLERK_STAMP));
      });
    });
  });

  // `organization.created` writes the same two columns through the same guard,
  // so a replay of it reverts a rename exactly as a stale `organization.updated`
  // would. Covered separately because it is a different handler: without this,
  // reverting that one call site to an unconditional write leaves the suite
  // green.
  describe("handleOrganizationCreated", () => {
    it("does not revert a rename a newer delivery already applied", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        await createTestOrganization({
          clerkId,
          name: "Original",
          slug: `${clerkId}-original`,
        });

        const renameDelivery = await handleOrganizationUpdated(
          buildOrganizationPayload({
            clerkId,
            name: "Newest",
            slug: `${clerkId}-newest`,
            updatedAt: NEWER_CLERK_STAMP,
          })
        );
        expect(renameDelivery.status).toBe(204);

        // A redelivered `organization.created` for the same org, carrying the
        // state it had at creation time.
        const replayedCreation = await handleOrganizationCreated(
          buildOrganizationPayload({
            clerkId,
            name: "AtCreation",
            slug: `${clerkId}-at-creation`,
            updatedAt: OLDER_CLERK_STAMP,
          })
        );
        expect(replayedCreation.status).toBe(201);

        const stored = await readOrganization(clerkId);
        expect(stored.name).toBe("Newest");
        expect(stored.slug).toBe(`${clerkId}-newest`);
        expect(stored.clerkUpdatedAt).toEqual(new Date(NEWER_CLERK_STAMP));
      });
    });
  });

  describe("handleUserUpdated", () => {
    it("ignores a delivery that arrives after a newer one", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        await createTestUser(organizationId, {
          clerkId,
          firstName: "Original",
        });

        const newestDelivery = await handleUserUpdated(
          buildUserPayload({
            clerkId,
            firstName: "Newest",
            updatedAt: NEWER_CLERK_STAMP,
          })
        );
        expect(newestDelivery.status).toBe(204);

        const staleDelivery = await handleUserUpdated(
          buildUserPayload({
            clerkId,
            firstName: "Stale",
            updatedAt: OLDER_CLERK_STAMP,
          })
        );
        expect(staleDelivery.status).toBe(204);

        const stored = await usersService.findByClerkIdAndOrg(
          clerkId,
          organizationId
        );
        expect(stored?.firstName).toBe("Newest");
      });
    });

    it("ignores a redelivery of an already-applied payload", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        const user = await createTestUser(organizationId, {
          clerkId,
          firstName: "Original",
        });

        const payload = buildUserPayload({
          clerkId,
          firstName: "Renamed",
          updatedAt: NEWER_CLERK_STAMP,
        });

        const firstDelivery = await handleUserUpdated(payload);
        expect(firstDelivery.status).toBe(204);
        // A later local edit through `PUT /users/:id`, which leaves
        // `clerkUpdatedAt` untouched. The redelivered payload therefore carries
        // a timestamp EQUAL to the stored one — the case that makes the user
        // guard `lt` rather than `lte` (review, davetho).
        await usersService.update(user.id, organizationId, {
          firstName: "Edited after the first delivery",
        });

        const redelivery = await handleUserUpdated(payload);
        expect(redelivery.status).toBe(204);

        const stored = await usersService.findByClerkIdAndOrg(
          clerkId,
          organizationId
        );
        expect(stored?.firstName).toBe("Edited after the first delivery");
      });
    });

    // The guard is per ROW, not per clerkId: `updateMany` evaluates the `where`
    // against each organization's row on its own. A row already carrying a
    // newer stamp must keep its value while the rest still move forward — a
    // clerkId-wide guard, or no guard at all, gets one of these two wrong.
    it("advances only the organization rows the delivery is newer than", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        const behindOrgId = await createTestOrganization();
        const aheadOrgId = await createTestOrganization();
        await createTestUser(behindOrgId, { clerkId, firstName: "Original" });
        await createTestUser(aheadOrgId, {
          clerkId,
          firstName: "Ahead",
          // Already stamped past the delivery below, as a newer `user.updated`
          // that reached only this row would have left it.
          clerkUpdatedAt: new Date(NEWER_CLERK_STAMP),
        });

        const staleDelivery = await handleUserUpdated(
          buildUserPayload({
            clerkId,
            firstName: "Renamed",
            updatedAt: OLDER_CLERK_STAMP,
          })
        );
        expect(staleDelivery.status).toBe(204);

        const behind = await usersService.findByClerkIdAndOrg(
          clerkId,
          behindOrgId
        );
        const ahead = await usersService.findByClerkIdAndOrg(
          clerkId,
          aheadOrgId
        );
        expect(behind?.firstName).toBe("Renamed");
        expect(ahead?.firstName).toBe("Ahead");
      });
    });

    // The route verifies the Svix signature and nothing about the body shape,
    // so `updated_at` is typed as a number but not known to be one. Feeding an
    // Invalid Date to Prisma throws, which POST turns into a 500 and Svix then
    // redelivers forever a payload that can never succeed.
    it("skips the mirror write when updated_at is not a usable stamp", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        await createTestUser(organizationId, {
          clerkId,
          firstName: "Original",
        });

        const unorderable = await handleUserUpdated(
          buildUserPayload({
            clerkId,
            firstName: "Unorderable",
            updatedAt: Number.NaN,
          })
        );
        expect(unorderable.status).toBe(204);

        const stored = await usersService.findByClerkIdAndOrg(
          clerkId,
          organizationId
        );
        expect(stored?.firstName).toBe("Original");
      });
    });

    // ISS-7132 regression guard. `upsertByClerkIdAndOrg` writes profile columns
    // from payloads carrying no user-level `updated_at` (a membership event, a
    // live Clerk read). If it left a newer stamp in place while writing older
    // columns, the redelivery that used to heal the revert would itself be
    // rejected by the guard and the revert would become permanent.
    it("lets a redelivery heal a profile written by the ungated upsert path", async () => {
      await autoRollbackTransaction(async () => {
        const organizationId = await createTestOrganization();
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        await createTestUser(organizationId, {
          clerkId,
          firstName: "Original",
        });

        const newest = buildUserPayload({
          clerkId,
          firstName: "Newest",
          updatedAt: NEWER_CLERK_STAMP,
        });
        const firstDelivery = await handleUserUpdated(newest);
        expect(firstDelivery.status).toBe(204);

        // A retried membership event reverts the profile with no timestamp to
        // order it by.
        await usersService.upsertByClerkIdAndOrg({
          clerkId,
          organizationId,
          email: "stale@example.com",
          firstName: "Stale",
          lastName: "Mirror",
        });

        const redelivery = await handleUserUpdated(newest);
        expect(redelivery.status).toBe(204);

        const stored = await usersService.findByClerkIdAndOrg(
          clerkId,
          organizationId
        );
        expect(stored?.firstName).toBe("Newest");
      });
    });
  });

  // `user.created` carries its own `updated_at`, so its mirror write is
  // orderable and goes through the same guard. Covered separately because it
  // reaches the DB through `upsertByClerkIdAndOrg` rather than
  // `updateByClerkId`: without this, reverting that call site to the ungated
  // upsert leaves the suite green (review, whitlockk).
  describe("handleUserCreated", () => {
    it("does not revert a profile a newer delivery already applied", async () => {
      await autoRollbackTransaction(async () => {
        const clerkId = `user_guard_${randomUUID().slice(0, 8)}`;
        const orgClerkId = `org_guard_${randomUUID().slice(0, 8)}`;
        const email = `${clerkId}@example.com`;
        // The org stamp is irrelevant here; only the user guard is under test.
        const organization = buildOrganizationPayload({
          clerkId: orgClerkId,
          name: "Guarded Org",
          slug: `${orgClerkId}-guarded`,
          updatedAt: OLDER_CLERK_STAMP,
        });
        const created = buildUserPayload({
          clerkId,
          firstName: "AtCreation",
          updatedAt: OLDER_CLERK_STAMP,
          emailAddresses: [buildEmailAddress(email)],
          memberships: [
            buildMembership(organization, {
              clerkId,
              email,
              firstName: "AtCreation",
            }),
          ],
        });

        const creation = await handleUserCreated(created);
        expect(creation.status).toBe(201);

        const newerUpdate = await handleUserUpdated(
          buildUserPayload({
            clerkId,
            firstName: "Newest",
            updatedAt: NEWER_CLERK_STAMP,
          })
        );
        expect(newerUpdate.status).toBe(204);

        // The redelivered creation carries the profile the user had at signup.
        const replayedCreation = await handleUserCreated(created);
        expect(replayedCreation.status).toBe(201);

        const stored = await withDb((db) =>
          db.user.findFirstOrThrow({
            where: { clerkId },
            select: { firstName: true, clerkUpdatedAt: true },
          })
        );
        expect(stored.firstName).toBe("Newest");
        expect(stored.clerkUpdatedAt).toEqual(new Date(NEWER_CLERK_STAMP));
      });
    });
  });
});
