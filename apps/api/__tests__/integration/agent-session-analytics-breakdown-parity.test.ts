/**
 * ISS-6823 — the analytics Repository/Project breakdowns, against a real planner.
 *
 * `/agent-sessions/analytics` used to page EVERY session matching the filter
 * into Node and fold `byRepository` / `byProject` out of the hydrated rows. The
 * Repository fold is now a `GROUP BY repository_full_name` and the Project scan
 * is scoped to project-PARENTED sessions. Moving a reduction from Node into SQL
 * is exactly where a count drifts, so the acceptance here is EXACTNESS, not
 * speed: the seeded corpus carries every case where the two disagree if the
 * translation is careless, and the assertions are on the RETURNED ROWS.
 *
 * The corpus is deliberately adversarial:
 *
 *  - **NULL repository, and EMPTY repository** — one session with no captured
 *    `repositoryFullName` and one with `""` (what `normalizeRepoFullName`
 *    persists for a branch ref naming the repository `.git`). `GROUP BY` gives
 *    each its own group where the Node reduction `continue`d on both; either one
 *    surviving grows the breakdown an option nothing can filter to.
 *  - **NULL project** — an UNPARENTED session artifact, which is what the
 *    Sessions lane actually writes. It must contribute to `byRepository` (it has
 *    a repository) and to NOTHING in `byProject`, which is the whole reason the
 *    project scan can be narrowed.
 *  - **Two sessions in one project, and two projects** — so a per-project total
 *    is a real sum over more than one row and the two projects cannot be
 *    conflated.
 *  - **Repeated repository across projects** — one repository's group spans
 *    sessions belonging to different projects, so the two dimensions are proven
 *    to be independent folds rather than one join being read twice.
 *  - **A session-count tie** — two repositories with the same session count, to
 *    pin the tie order the aggregate now produces (name asc) rather than
 *    leaving it to whatever order the planner returns groups in.
 *  - **Both date-window boundaries** — a session one second BEFORE `startDate`
 *    and one exactly ON it, and a session exactly ON `endDate` (which is `lte`,
 *    so it counts) and one a second after. Analytics windows on
 *    `sessionStartedAt`, and both breakdowns must describe the same windowed
 *    population, so an `lt`/`lte` flip at EITHER end shows up as a changed count.
 *  - **A SECOND organization** holding an in-window session on the same
 *    repository name. Both reads are org-scoped only through the `where` the
 *    route builds, and the project read now ANDs a second `artifact` clause onto
 *    it — a merge that assigned rather than ANDed would drop the org filter, and
 *    a single-org corpus could not notice.
 *  - **An empty population** — a filter that matches nothing returns `[]` for
 *    both breakdowns rather than inventing a zero row.
 *
 * There is no join-fan-out case because there is no fan-out to have: the
 * Repository aggregate groups `session_detail` itself and sums only its own
 * columns, and `SessionDetail`→`Artifact` is 1:1. Seeding a "duplicate-producing
 * join" here would be theatre.
 *
 * Self-skips when DATABASE_URL is unset, like every sibling suite in this
 * directory. Mocked `withDb` suites cannot observe any of this — they never
 * plan a statement, so a `GROUP BY` that returns the wrong groups still passes.
 */

import { randomUUID } from "node:crypto";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { agentSessionsService } from "@/app/agent-sessions/service";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestProject,
  createTestUser,
} from "../utils/db-helpers";

const env = keys();
const hasDatabase = !!env.DATABASE_URL;

/**
 * Seeding eight sessions is ~20 round trips, which clears Prisma's 5s
 * interactive-transaction default under CI/parallel load. Explicit rather than
 * left to the default, so a slow run fails on an assertion and not on a
 * transaction that expired mid-seed.
 */
const ROLLBACK_OPTIONS = { maxWait: 5000, timeout: 20_000 };

const REPO_ALPHA = "closedloop-ai/closedloop-ai";
const REPO_ELECTRON = "closedloop-ai/closedloop-electron";
/** Sorts before both of the above, so the tie order it takes part in is visible. */
const REPO_ARCADE = "closedloop-ai/arcade";

/** The requested window's lower bound, and the rows placed either side of it. */
const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T23:59:59.000Z");
const ON_WINDOW_START = WINDOW_START;
const ON_WINDOW_END = WINDOW_END;
const JUST_BEFORE_WINDOW = new Date("2026-05-31T23:59:59.000Z");
const JUST_AFTER_WINDOW = new Date("2026-07-01T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-10T09:00:00.000Z");

type SeedSessionInput = {
  organizationId: string;
  userId: string;
  computeTargetId: string;
  /** Null seeds the UNPARENTED artifact the Sessions sync lane actually writes. */
  projectId: string | null;
  repositoryFullName: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: string;
  errorCount: number;
  startedAt: Date;
};

async function seedSession(input: SeedSessionInput): Promise<string> {
  const externalSessionId = `iss6823-${randomUUID()}`;
  const artifact = await withDb((db) =>
    db.artifact.create({
      data: {
        createdById: input.userId,
        name: "ISS-6823 breakdown session",
        organizationId: input.organizationId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        // The LIFECYCLE axis, which is the only thing a session artifact's
        // `status` may store; `completed` was retired to `inactive` (ISS-4654).
        // ISS-7019 deleted the second axis that used to carry the retired word,
        // so there is nowhere left for it to survive and nothing reads it.
        status: SESSION_STATUS.INACTIVE,
        type: ArtifactType.SESSION,
        session: {
          create: {
            computeTarget: { connect: { id: input.computeTargetId } },
            errorCount: input.errorCount,
            estimatedCost: input.estimatedCost,
            externalSessionId,
            harness: "claude",
            inputTokens: input.inputTokens,
            lastActivityAt: input.startedAt,
            model: "claude-opus-4",
            outputTokens: input.outputTokens,
            repositoryFullName: input.repositoryFullName,
            sessionStartedAt: input.startedAt,
            sessionUpdatedAt: input.startedAt,
          },
        },
      },
      select: { id: true },
    })
  );
  return artifact.id;
}

async function seedCorpus() {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  const platformProjectId = await createTestProject(organizationId, user.id, {
    name: "Agent Platform",
  });
  const desktopProjectId = await createTestProject(organizationId, user.id, {
    name: "Desktop",
  });
  const computeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "iss6823-breakdown-machine",
        organizationId,
        platform: "darwin",
        userId: user.id,
      },
      select: { id: true },
    })
  );
  const base = {
    computeTargetId: computeTarget.id,
    organizationId,
    userId: user.id,
  };

  // Two in-window sessions in the Agent Platform project, on ONE repository —
  // so the project total is a sum over more than one row.
  await seedSession({
    ...base,
    projectId: platformProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: "1.100000",
    errorCount: 1,
    startedAt: IN_WINDOW,
  });
  await seedSession({
    ...base,
    projectId: platformProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 200,
    outputTokens: 60,
    estimatedCost: "2.200000",
    errorCount: 0,
    startedAt: ON_WINDOW_START,
  });
  // The SAME repository under a DIFFERENT project: the two folds are
  // independent, so this row joins the alpha repository group and the Desktop
  // project group at once.
  await seedSession({
    ...base,
    projectId: desktopProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 10,
    outputTokens: 5,
    estimatedCost: "0.300000",
    errorCount: 0,
    startedAt: IN_WINDOW,
  });
  // Unparented (the production shape) but WITH a repository: counts toward
  // `byRepository` and toward nothing in `byProject`.
  await seedSession({
    ...base,
    projectId: null,
    repositoryFullName: REPO_ELECTRON,
    inputTokens: 7,
    outputTokens: 3,
    estimatedCost: "0.070000",
    errorCount: 4,
    startedAt: IN_WINDOW,
  });
  // The session-count tie partner for `closedloop-electron` (both land on 1).
  await seedSession({
    ...base,
    projectId: null,
    repositoryFullName: REPO_ARCADE,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCost: "0.010000",
    errorCount: 0,
    startedAt: IN_WINDOW,
  });
  // No repository at all: the NULL group the aggregate emits and the fold drops.
  // Parented to Agent Platform, so dropping the NULL repository group is proven
  // NOT to drop the session from the project dimension.
  await seedSession({
    ...base,
    projectId: platformProjectId,
    repositoryFullName: null,
    inputTokens: 500,
    outputTokens: 400,
    // 1.1 + 2.2 + 0.1 is 3.4000000000000004 when accumulated as JS floats and
    // 3.4 when summed as NUMERIC — the divergence the project assertion pins.
    estimatedCost: "0.100000",
    errorCount: 2,
    startedAt: IN_WINDOW,
  });
  // One second before the window opens: in NEITHER breakdown. Its repository
  // and project are ones the window DOES reach, so an off-by-one bound shows up
  // as a changed total rather than as a new row.
  await seedSession({
    ...base,
    projectId: platformProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 999_999,
    outputTokens: 999_999,
    estimatedCost: "99.000000",
    errorCount: 9,
    startedAt: JUST_BEFORE_WINDOW,
  });
  // An EMPTY repository name, which `normalizeRepoFullName` persists for a
  // branch ref naming the repository `.git`. Unparented, so it lands in neither
  // breakdown: the falsy drop keeps it out of `byRepository`, and having no
  // project keeps it out of `byProject`. It is in the population and contributes
  // to nothing — which is exactly what the reduction did with it.
  await seedSession({
    ...base,
    projectId: null,
    repositoryFullName: "",
    inputTokens: 444_444,
    outputTokens: 444_444,
    estimatedCost: "44.000000",
    errorCount: 4,
    startedAt: IN_WINDOW,
  });
  // Exactly ON the closing bound, which is `lte` — so this one IS counted. Paired
  // with the row below, the two pin the closing bound the way the two rows around
  // `WINDOW_START` pin the opening one; without both, an `lt`/`lte` flip is
  // invisible at one end of the window.
  await seedSession({
    ...base,
    projectId: null,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 2,
    outputTokens: 1,
    estimatedCost: "0.020000",
    errorCount: 0,
    startedAt: ON_WINDOW_END,
  });
  // One second after the window closes: in NEITHER breakdown.
  await seedSession({
    ...base,
    projectId: platformProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 888_888,
    outputTokens: 888_888,
    estimatedCost: "88.000000",
    errorCount: 8,
    startedAt: JUST_AFTER_WINDOW,
  });

  // A SECOND organization holding a session that is in-window, on the SAME
  // repository name, and in its own project. Both breakdowns are org-scoped
  // through the `where` the route builds, and neither the new `GROUP BY` nor the
  // ANDed project-parented clause may relax that: an `artifact` key assigned
  // instead of ANDed would REPLACE the org filter, and with a single-org corpus
  // nothing would notice. This row is the witness.
  const otherOrganizationId = await createTestOrganization();
  const otherUser = await createTestUser(otherOrganizationId);
  const otherProjectId = await createTestProject(
    otherOrganizationId,
    otherUser.id,
    { name: "Other Org Project" }
  );
  const otherComputeTarget = await withDb((db) =>
    db.computeTarget.create({
      data: {
        machineName: "iss6823-other-org-machine",
        organizationId: otherOrganizationId,
        platform: "darwin",
        userId: otherUser.id,
      },
      select: { id: true },
    })
  );
  await seedSession({
    computeTargetId: otherComputeTarget.id,
    organizationId: otherOrganizationId,
    userId: otherUser.id,
    projectId: otherProjectId,
    repositoryFullName: REPO_ALPHA,
    inputTokens: 777_777,
    outputTokens: 777_777,
    estimatedCost: "77.000000",
    errorCount: 7,
    startedAt: IN_WINDOW,
  });

  return {
    organizationId,
    platformProjectId,
    desktopProjectId,
    otherProjectId,
  };
}

function analyticsInput(organizationId: string) {
  return {
    organizationId,
    filters: {
      startDate: WINDOW_START.toISOString(),
      endDate: WINDOW_END.toISOString(),
    },
  };
}

describe.skipIf(!hasDatabase)(
  "ISS-6823 analytics breakdowns against a real planner",
  () => {
    it("returns the exact repository groups, dropping the NULL group and honoring the window bound", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId } = await seedCorpus();

        const analytics = await agentSessionsService.getAnalytics(
          analyticsInput(organizationId)
        );

        expect(analytics.byRepository).toEqual([
          {
            // 4 in-window sessions, including the one exactly ON the closing
            // bound. Excluded: the pre-window row, the post-window row, and the
            // OTHER ORGANIZATION's row — each seeded on this same repository
            // with six-figure token counts, so any one of them leaking in is a
            // number nobody could mistake for a rounding difference.
            repositoryFullName: REPO_ALPHA,
            sessionCount: 4,
            inputTokens: 312,
            outputTokens: 116,
            estimatedCost: 3.62,
            errorCount: 1,
          },
          // Tie on sessionCount (1 each): name ascending, deterministically.
          {
            repositoryFullName: REPO_ARCADE,
            sessionCount: 1,
            inputTokens: 1,
            outputTokens: 1,
            estimatedCost: 0.01,
            errorCount: 0,
          },
          {
            repositoryFullName: REPO_ELECTRON,
            sessionCount: 1,
            inputTokens: 7,
            outputTokens: 3,
            estimatedCost: 0.07,
            errorCount: 4,
          },
        ]);
      }, ROLLBACK_OPTIONS);
    });

    it("returns the exact project groups, counting only project-parented sessions", async () => {
      await autoRollbackTransaction(async () => {
        const {
          organizationId,
          platformProjectId,
          desktopProjectId,
          otherProjectId,
        } = await seedCorpus();

        const analytics = await agentSessionsService.getAnalytics(
          analyticsInput(organizationId)
        );

        expect(analytics.byProject).toEqual([
          {
            projectId: platformProjectId,
            projectName: "Agent Platform",
            projectSlug: null,
            // The pre- and post-window Agent Platform sessions are excluded
            // here too, by the same bounds the repository groups honored. The
            // no-repository session IS counted: dropping the NULL repository
            // group must not drop that session from the other dimension.
            sessionCount: 3,
            inputTokens: 800,
            outputTokens: 510,
            // 1.1 + 2.2 + 0.1, and NOT 3.4: `aggregateByProject` still
            // accumulates JS floats, where the repository breakdown above now
            // sums NUMERIC in Postgres and lands on 3.6 exactly for its own
            // three rows. Pinned as observed rather than rounded — this IS the
            // difference between a Node reduction and a SQL aggregate on the
            // same population, and the day the project fold follows it into SQL
            // this number has to be revisited deliberately rather than silently.
            estimatedCost: 3.400_000_000_000_000_4,
          },
          {
            projectId: desktopProjectId,
            projectName: "Desktop",
            projectSlug: null,
            sessionCount: 1,
            inputTokens: 10,
            outputTokens: 5,
            estimatedCost: 0.3,
          },
        ]);
        // The other organization's project never appears — the ANDed
        // project-parented clause did not displace the org filter the caller's
        // `where` carries. Named explicitly rather than left to the deep-equal,
        // so a reader can see WHICH absence is the org-scope claim.
        expect(analytics.byProject.map((row) => row.projectId)).not.toContain(
          otherProjectId
        );
        // The unparented sessions are in `byRepository` and in no project
        // group — the invariant that lets the project read skip them entirely.
        // The no-repository session is the mirror image: in a project group and
        // in no repository group.
        const projectSessions = analytics.byProject.reduce(
          (total, row) => total + row.sessionCount,
          0
        );
        const repositorySessions = analytics.byRepository.reduce(
          (total, row) => total + row.sessionCount,
          0
        );
        expect(projectSessions).toBe(4);
        expect(repositorySessions).toBe(6);
      }, ROLLBACK_OPTIONS);
    });

    it("returns empty breakdowns for a population that matches nothing, inventing no zero rows", async () => {
      await autoRollbackTransaction(async () => {
        const { organizationId } = await seedCorpus();

        const analytics = await agentSessionsService.getAnalytics({
          organizationId,
          filters: {
            startDate: "2030-01-01T00:00:00.000Z",
            endDate: "2030-01-31T00:00:00.000Z",
          },
        });

        expect(analytics.byRepository).toEqual([]);
        expect(analytics.byProject).toEqual([]);
      }, ROLLBACK_OPTIONS);
    });
  }
);
