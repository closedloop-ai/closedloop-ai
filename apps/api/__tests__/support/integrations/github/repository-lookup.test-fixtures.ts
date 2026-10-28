/**
 * The `GitHubInstallationRepository` lookup the three repository reads perform,
 * simulated closely enough to test the FILTER rather than the fixture.
 *
 * `findFirst` resolves the row against the `where` the production query builds,
 * so a repository that is tombstoned, suspended, or owned by another
 * organization comes back null exactly as Postgres would. A mock that returned
 * its fixture regardless of `where` is what let those predicates move from
 * post-load checks into the query without a single test noticing.
 *
 * Lives here rather than in `service.test.ts` because that file is on the
 * `noExcessiveLinesPerFile` grandfather list (shrink-only).
 */

import { GitHubInstallationStatus } from "@repo/database";
import { vi } from "vitest";
import { mockWithDbCall } from "@/__tests__/utils/db-helpers";

export const ORG_ID = "org-1";
export const GITHUB_INSTALLATION_ID = "gh-install-100";

export function makeRepoWithInstallation(overrides?: {
  orgId?: string;
  fullName?: string;
  removedAt?: Date | null;
  status?: string;
}) {
  return {
    id: "repo-1",
    fullName: overrides?.fullName ?? "org/repo",
    removedAt: overrides?.removedAt ?? null,
    installation: {
      organizationId: overrides?.orgId ?? ORG_ID,
      installationId: GITHUB_INSTALLATION_ID,
      status: overrides?.status ?? GitHubInstallationStatus.ACTIVE,
    },
  };
}

type RepoLookupWhere = {
  id?: string;
  removedAt?: Date | null;
  installation?: { organizationId?: string; status?: string };
};

/**
 * Resolves the fixture against the `where` the production query builds, so a
 * row that is tombstoned, suspended, or owned by another organization comes
 * back null exactly as Postgres would.
 *
 * The previous shape returned its fixture regardless of `where`, which is why
 * these tests stayed green when the org, status, and removedAt predicates moved
 * from post-load checks into the query itself — the assertions were describing
 * code that no longer ran. Simulating the filter keeps them behavioral instead
 * of turning them into argument-shape assertions.
 */
export function mockRepoLookup(
  repo: ReturnType<typeof makeRepoWithInstallation> | null
) {
  const mockDb = {
    gitHubInstallationRepository: {
      findFirst: vi.fn((args?: { where?: RepoLookupWhere }) =>
        Promise.resolve(repoMatchesWhere(repo, args?.where) ? repo : null)
      ),
    },
  };
  mockWithDbCall(mockDb);
  return mockDb;
}

function repoMatchesWhere(
  repo: ReturnType<typeof makeRepoWithInstallation> | null,
  where: RepoLookupWhere | undefined
): boolean {
  if (!repo) {
    return false;
  }
  if (!where) {
    return true;
  }
  if (where.id !== undefined && where.id !== repo.id) {
    return false;
  }
  if (where.removedAt === null && repo.removedAt !== null) {
    return false;
  }
  const installation = where.installation;
  if (!installation) {
    return true;
  }
  if (
    installation.organizationId !== undefined &&
    installation.organizationId !== repo.installation.organizationId
  ) {
    return false;
  }
  return (
    installation.status === undefined ||
    installation.status === repo.installation.status
  );
}
