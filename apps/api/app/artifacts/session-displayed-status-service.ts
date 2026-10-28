import type { SessionStatus } from "@repo/api/src/types/session-status";

/**
 * ISS-8694: batch-project the DISPLAY status of SESSION artifacts for the
 * artifact trees behind Projects and My Tasks.
 *
 * The trees serve the raw `artifacts.status`, and this service existed because
 * the Sessions list folded that column through `projectDisplayedSessionStatus`
 * while the trees did not — one session, two stories. Computing it HERE rather
 * than in each table was the point: three surfaces deriving their own answer is
 * how they diverged.
 *
 * **INERT since ISS-10364** (operator ruling, 2026-09-23/24): the two
 * DISPLAY-ONLY words it carried, `stale` and `unknown`, are retired from the
 * vocabulary, and a lifecycle word is not safe in this field (see the field's
 * own doc). There is no value left to project, so `findByIds` resolves an empty
 * map without reading the database. It previously still issued its `findMany`
 * and discarded the rows, which cost every project-tree and assigned-tree read
 * a round trip nothing could consume.
 *
 * ISS-11131 is the ticket that deletes the service, the `displayedSessionStatus`
 * field and their callers outright; this step only stops the work.
 */
export const sessionDisplayedStatusService = {
  findByIds(
    _organizationId: string,
    _sessionArtifactIds: readonly string[],
    // ISS-10364 left both of these on the signature so the two tree callers keep
    // compiling unchanged. ISS-11131 removes them with the rest of the service.
    _now: Date = new Date()
  ): Promise<ReadonlyMap<string, SessionStatus>> {
    return Promise.resolve(new Map());
  },
};
