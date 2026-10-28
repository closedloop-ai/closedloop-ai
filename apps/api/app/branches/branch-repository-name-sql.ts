import { Prisma } from "@repo/database";

/**
 * SQL counterpart of `normalizeRepoFullName`
 * (`@repo/api/src/types/branch-repository`): trim, strip surrounding slashes,
 * drop a trailing `.git`, lowercase. Branch candidate ordering, verified
 * publication, and associated-PR ownership all compare repository identity and
 * must normalize byte-identically, so the expression has exactly one owner.
 *
 * The dot before `git` MUST be escaped with a doubled backslash. `Prisma.sql`
 * is a tagged template that reads the COOKED strings, so a single backslash
 * written here never reaches Postgres: `'\.git$'` arrives as `.git$`, whose `.`
 * matches any character, and `acme/digit` and `acme/dogit` both normalize to
 * `acme/d` and compare equal.
 *
 * ISS-10298: the SECOND trailing-slash strip is load-bearing and was missing.
 * The JavaScript strips slashes again AFTER removing `.git`, so `acme/repo/.git`
 * normalizes to `acme/repo` there and used to normalize to `acme/repo/` here —
 * a third segment that the associated-PR identity test now rejects outright.
 */
export function normalizedRepositoryFullNameSql(
  fullName: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`lower(regexp_replace(regexp_replace(regexp_replace(btrim(${fullName}), '^/+|/+$', '', 'g'), '\\.git$', '', 'i'), '/+$', ''))`;
}

/**
 * `github_installation_repositories` carries no `organization_id`, and both
 * `branch_detail.repository_id` and `pull_request_detail.repository_id` are
 * single-column FKs to it, so no database constraint ties the row they select
 * to the artifact's tenant. Joining one by id alone lets a corrupt cross-tenant
 * pointer hand a foreign `full_name` to pull-request selection, search, the
 * status derivation and the Branch list's Repository facet (davetho review on
 * #7545). Ownership is only reachable one hop further out, through the owning
 * installation, so it is asserted there.
 *
 * Belongs in the `ON` clause of a LEFT JOIN, never in `WHERE`: an unowned
 * repository must fall to a NULL row so the identity COALESCE degrades to the
 * denormalized `repository_full_name` the artifact stores itself — moving it to
 * `WHERE` would drop the whole evidence row and silently change the answer.
 * `github_installations.organization_id` is nullable, so an unclaimed
 * installation never establishes ownership and degrades the same way.
 *
 * The surrounding query must bind `a` (the BRANCH `artifacts` row).
 */
export function repositoryOwnedByArtifactOrganizationSql(
  repositoryAlias: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM github_installations repository_installation
    WHERE repository_installation.id = ${repositoryAlias}.installation_id
      AND repository_installation.organization_id = a.organization_id
  )`;
}
