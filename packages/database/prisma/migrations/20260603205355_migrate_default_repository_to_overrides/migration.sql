-- FEA-1057 (PLN-800): migrate legacy projectSettings.defaultRepository -> repositoryOverrides.
--
-- Hand-written DATA migration (no schema change). Prisma cannot express jsonb
-- rewrites or the team-pool correlated subquery, so this SQL is authored by
-- hand per packages/database/CLAUDE.md. Idempotent: a second run matches zero
-- rows. Set-based and deterministic.
--
-- The legacy `defaultRepository.repoId` is a text UUID compared against
-- `team_repositories.installation_repository_id` (the curated-pool id space).
-- Pool membership mirrors teamsService.getRepositoriesByProject: it joins
-- team_repositories -> github_installation_repositories filtered to
-- removed_at IS NULL (tombstoned repos, PLN-634, are excluded).

-- (A) Pool-valid projects with a legacy default and no existing override:
--     write { selectedRepoIds:[repoId], primaryRepoId:repoId } and drop legacy.
UPDATE "projects" p
SET "settings" =
      ("settings" - 'defaultRepository')
      || jsonb_build_object(
           'repositoryOverrides',
           jsonb_build_object(
             'selectedRepoIds', jsonb_build_array("settings" -> 'defaultRepository' ->> 'repoId'),
             'primaryRepoId',   "settings" -> 'defaultRepository' ->> 'repoId'
           )
         )
WHERE "settings" ? 'defaultRepository'
  AND NOT ("settings" ? 'repositoryOverrides')
  AND EXISTS (
        SELECT 1
        FROM "project_teams" pt
        JOIN "team_repositories" tr ON tr."team_id" = pt."team_id"
        JOIN "github_installation_repositories" gir ON gir."id" = tr."installation_repository_id"
        WHERE pt."project_id" = p."id"
          AND gir."removed_at" IS NULL
          AND tr."installation_repository_id"::text = (p."settings" -> 'defaultRepository' ->> 'repoId')
      );

-- (B) Every remaining project that still carries a legacy default: drop the key.
--     Two sub-cases, both intentional:
--       * Override already present -> the override wins; just drop the legacy key.
--       * Not-in-pool / empty-pool -> strip & degrade to "pick repos at job
--         launch". NOTE: this is NOT what the resolver does today. The current
--         resolveProjectRepoDefaults branch 3 is
--         `legacy && (poolIds.size === 0 || poolIds.has(legacy.repoId))`, so an
--         EMPTY-pool project with a legacy default resolves straight to that
--         repo (and push-handler matches its pushes by repoFullName). Dropping
--         the key here is what causes those projects to degrade — it is a
--         deliberate behavior change, not pre-existing resolver behavior.
--         These projects are surfaced as `no_team_repos` by the PLN-800
--         pre-flight (counted in `will_degrade`) and MUST be triaged before
--         deploy (add the repo to a team pool so they convert via (A) instead).
UPDATE "projects" p
SET "settings" = "settings" - 'defaultRepository'
WHERE "settings" ? 'defaultRepository';
