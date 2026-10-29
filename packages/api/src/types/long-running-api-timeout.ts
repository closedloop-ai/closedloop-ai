/**
 * Deadline for the few endpoints that do genuinely long synchronous work before
 * they respond (pack import from a repo or zip, GitHub backfill in Apply mode,
 * Google Drive folder import).
 *
 * 5 minutes is not an arbitrary "big number": it is the serverless
 * `maxDuration` each of those routes explicitly declares (`export const
 * maxDuration = 300`), so a request that outlives it cannot still be doing
 * useful work on the server — at that point waiting longer only withholds the
 * failure from the user.
 *
 * That premise only holds while the routes actually declare it. Before PR
 * #4321 they did not, so the platform default terminated the function first and
 * the client surfaced a 504 long before this deadline could fire. The
 * declarations are pinned by `apps/api/app/long-running-route-max-duration.test.ts`
 * — if a new call site raises its deadline to this constant, give its route the
 * matching `maxDuration` and add it there.
 *
 * It lives here rather than beside the client in
 * `packages/app/shared/api/api-timeout.ts` because `apps/api` reads it too, and
 * `apps/api` does not declare `@repo/app` (ISS-12224).
 */
export const LONG_RUNNING_API_TIMEOUT_MS = 5 * 60_000;
