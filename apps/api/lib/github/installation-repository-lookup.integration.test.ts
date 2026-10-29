import { randomUUID } from "node:crypto";
import {
  GitHubInstallationStatus,
  type TransactionClient,
  withDb,
} from "@repo/database";
import { afterEach, describe, expect, it } from "vitest";
import {
  findCoveringInstallation,
  findInstallationRepositoryId,
} from "@/lib/github/installation-repository-lookup";

/**
 * ISS-6578: the sibling unit suite fakes `Prisma.sql` and can only prove the
 * TEXT of these statements. It cannot prove the statements RUN — a mistyped
 * column, a uuid bind PostgreSQL refuses to coerce, or a mismatched enum cast
 * would ship green there and take out tier-1 credential selection and the
 * reconciler's repository resolution outright. So this tier executes the real
 * exported readers against a real Postgres and asserts the rows they return.
 *
 * That the planner actually picks
 * `github_installation_repositories_inst_lower_full_name_idx` for this
 * predicate is asserted separately, against a fixture sized for a cost-based
 * planner, in
 * `packages/database/__tests__/integration/repository-authority-lower-name-indexes.integration.test.ts`.
 */

const hasDatabase = Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const seededOrganizationIds: string[] = [];

type SeedOptions = {
  status?: GitHubInstallationStatus;
  /** Written verbatim, so a case-insensitive match is a real match. */
  storedFullName?: string;
  removedAt?: Date | null;
};

describeWithDatabase("installation-repository lookups (integration)", () => {
  afterEach(async () => {
    while (seededOrganizationIds.length > 0) {
      const organizationId = seededOrganizationIds.pop();
      if (organizationId) {
        await deleteSeededInstallation(organizationId);
      }
    }
  });

  describe("findCoveringInstallation", () => {
    it("matches a provider-cased full_name from a normalized ask and returns the GitHub installation id", async () => {
      const seeded = await seedInstallation({ storedFullName: "Acme/Widgets" });

      await expect(
        findCoveringInstallation(seeded.organizationId, "acme/widgets")
      ).resolves.toEqual({ installationId: seeded.installationIdValue });
    });

    it("normalizes the ask, so provider casing and a trailing .git still match", async () => {
      const seeded = await seedInstallation({ storedFullName: "Acme/Widgets" });

      await expect(
        findCoveringInstallation(seeded.organizationId, "Acme/Widgets.git")
      ).resolves.toEqual({ installationId: seeded.installationIdValue });
    });

    it("does not cover a tombstoned repository", async () => {
      const seeded = await seedInstallation({
        removedAt: new Date("2026-08-01T00:00:00.000Z"),
        storedFullName: "Acme/Widgets",
      });

      await expect(
        findCoveringInstallation(seeded.organizationId, "acme/widgets")
      ).resolves.toBeNull();
    });

    it("does not cover a repository on an installation that is not ACTIVE", async () => {
      const seeded = await seedInstallation({
        status: GitHubInstallationStatus.SUSPENDED,
        storedFullName: "Acme/Widgets",
      });

      await expect(
        findCoveringInstallation(seeded.organizationId, "acme/widgets")
      ).resolves.toBeNull();
    });

    it("does not cross orgs — another org's installation never covers this org's ask", async () => {
      const owner = await seedInstallation({ storedFullName: "Acme/Widgets" });
      const other = await seedInstallation({ storedFullName: "Other/Repo" });

      await expect(
        findCoveringInstallation(other.organizationId, "acme/widgets")
      ).resolves.toBeNull();
      // The row really is reachable — the null above is the org scope, not a
      // predicate that matches nothing.
      await expect(
        findCoveringInstallation(owner.organizationId, "acme/widgets")
      ).resolves.toEqual({ installationId: owner.installationIdValue });
    });

    it("returns null when the org has no repository by that name", async () => {
      const seeded = await seedInstallation({ storedFullName: "Acme/Widgets" });

      await expect(
        findCoveringInstallation(seeded.organizationId, "acme/gadgets")
      ).resolves.toBeNull();
    });
  });

  describe("findInstallationRepositoryId", () => {
    it("resolves the repository row id from a case-insensitive name", async () => {
      const seeded = await seedInstallation({ storedFullName: "Acme/Widgets" });

      await expect(
        findInstallationRepositoryId(seeded.organizationId, "ACME/WIDGETS")
      ).resolves.toBe(seeded.repositoryId);
    });

    it("still resolves behind an installation that is not ACTIVE", async () => {
      const seeded = await seedInstallation({
        status: GitHubInstallationStatus.SUSPENDED,
        storedFullName: "Acme/Widgets",
      });

      // The documented divergence from findCoveringInstallation: a suspended
      // or uninstalled installation's rows stay FK-resolvable so historical
      // projection detail can still be attached and rendered.
      await expect(
        findInstallationRepositoryId(seeded.organizationId, "acme/widgets")
      ).resolves.toBe(seeded.repositoryId);
    });

    it("does not resolve a tombstoned repository", async () => {
      const seeded = await seedInstallation({
        removedAt: new Date("2026-08-01T00:00:00.000Z"),
        storedFullName: "Acme/Widgets",
      });

      await expect(
        findInstallationRepositoryId(seeded.organizationId, "acme/widgets")
      ).resolves.toBeNull();
    });

    it("does not cross orgs", async () => {
      const owner = await seedInstallation({ storedFullName: "Acme/Widgets" });
      const other = await seedInstallation({ storedFullName: "Other/Repo" });

      await expect(
        findInstallationRepositoryId(other.organizationId, "acme/widgets")
      ).resolves.toBeNull();
      await expect(
        findInstallationRepositoryId(owner.organizationId, "acme/widgets")
      ).resolves.toBe(owner.repositoryId);
    });
  });
});

async function seedInstallation(options: SeedOptions = {}) {
  const suffix = randomUUID();
  const ids = {
    installationIdValue: `install-${suffix}`,
    installationRecordId: randomUUID(),
    organizationId: randomUUID(),
    repositoryId: randomUUID(),
  };
  const storedFullName = options.storedFullName ?? "Acme/Widgets";
  const [owner, name] = storedFullName.split("/");
  seededOrganizationIds.push(ids.organizationId);
  await withDb.tx(async (tx: TransactionClient) => {
    await tx.organization.create({
      data: {
        clerkId: `clerk-${suffix}`,
        id: ids.organizationId,
        name: "ISS-6578 Lookup Org",
        slug: `iss6578-${suffix}`,
      },
      select: { id: true },
    });
    await tx.gitHubInstallation.create({
      data: {
        accountId: `account-${suffix}`,
        accountLogin: owner,
        accountType: "Organization",
        id: ids.installationRecordId,
        installationId: ids.installationIdValue,
        organizationId: ids.organizationId,
        senderId: `sender-${suffix}`,
        senderLogin: "octocat",
        status: options.status ?? GitHubInstallationStatus.ACTIVE,
      },
      select: { id: true },
    });
    await tx.gitHubInstallationRepository.create({
      data: {
        fullName: storedFullName,
        githubRepoId: `gh-${suffix}`,
        id: ids.repositoryId,
        installationId: ids.installationRecordId,
        name,
        owner,
        private: false,
        removedAt: options.removedAt ?? null,
      },
      select: { id: true },
    });
  });
  return ids;
}

async function deleteSeededInstallation(organizationId: string) {
  await withDb.tx(async (tx: TransactionClient) => {
    await tx.gitHubInstallationRepository.deleteMany({
      where: { installation: { organizationId } },
    });
    await tx.gitHubInstallation.deleteMany({ where: { organizationId } });
    await tx.organization.deleteMany({ where: { id: organizationId } });
  });
}
