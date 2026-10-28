import { normalizeRepoFullName } from "@repo/api/src/types/branch-repository";
import { GitHubInstallationStatus, Prisma, withDb } from "@repo/database";

/**
 * ISS-6578: the GitHub sync ladder's repository lookups by full name.
 *
 * `github_installation_repositories.full_name` keeps the provider's casing, so
 * a lookup by name has to be case-insensitive. Prisma's `mode: "insensitive"`
 * compiles to `ILIKE`, and PostgreSQL cannot match `ILIKE` to the partial
 * expression index migration 20260815120000 built for exactly this predicate —
 * `(installation_id, lower(full_name)) WHERE removed_at IS NULL` (ISS-6452).
 * Every such lookup therefore read the installation's whole repo set and ran
 * `ILIKE` against every row, on every credential draw, every tier
 * classification, and every reconciler repo-id resolution.
 *
 * These read `LOWER(full_name) = <normalized>` instead — the shape the index
 * serves — matching the session-ingest authority read in
 * `apps/api/app/agent-sessions/service/artifact-links/shared.ts`, which is what
 * the index was built for. `installation_id` leads the index and is bound from
 * the joined installation row rather than filtered directly, exactly as in that
 * read; the join is one row per org because `organization_id` is unique on
 * `github_installations`.
 *
 * The comparison value goes through {@link normalizeRepoFullName}, the same
 * canonical normalizer the callers and the ISS-6452 read already use, so both
 * sides of the equality are lowercased.
 */

type CoveringInstallationRow = { installationId: string };

type InstallationRepositoryIdRow = { id: string };

/**
 * The org's ACTIVE installation when its non-tombstoned repo set covers
 * `repositoryFullName`, else null — i.e. no installation, an installation that
 * is not ACTIVE, or a repo that is not on it (or is tombstoned).
 *
 * Returns the GitHub installation id (not the row's uuid), which is what the
 * installation-token acquisition path takes.
 */
export async function findCoveringInstallation(
  organizationId: string,
  repositoryFullName: string
): Promise<CoveringInstallationRow | null> {
  const normalized = normalizeRepoFullName(repositoryFullName);
  const rows = await withDb((db) =>
    db.$queryRaw<CoveringInstallationRow[]>(Prisma.sql`
      SELECT installation.installation_id AS "installationId"
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE installation.organization_id = ${organizationId}
        AND installation.status = ${GitHubInstallationStatus.ACTIVE}::"GitHubInstallationStatus"
        AND repository.removed_at IS NULL
        AND LOWER(repository.full_name) = ${normalized}
      LIMIT 1
    `)
  );
  return rows[0] ?? null;
}

/**
 * The id of the org installation's non-tombstoned repository row for
 * `repositoryFullName`, else null.
 *
 * Deliberately NOT filtered on installation status: the reconciler resolves a
 * repository id to attach a projection row to, and a suspended or uninstalled
 * installation's rows stay FK-resolvable so historical detail still renders.
 */
export async function findInstallationRepositoryId(
  organizationId: string,
  repositoryFullName: string
): Promise<string | null> {
  const normalized = normalizeRepoFullName(repositoryFullName);
  const rows = await withDb((db) =>
    db.$queryRaw<InstallationRepositoryIdRow[]>(Prisma.sql`
      SELECT repository.id
      FROM github_installation_repositories repository
      INNER JOIN github_installations installation
        ON installation.id = repository.installation_id
      WHERE installation.organization_id = ${organizationId}
        AND repository.removed_at IS NULL
        AND LOWER(repository.full_name) = ${normalized}
      LIMIT 1
    `)
  );
  return rows[0]?.id ?? null;
}
