import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import {
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import {
  ACME_BASE_SEED,
  ACME_COLLABORATOR_BRANCH,
  ACME_FEATURE_BRANCH,
  ACME_PULL_REQUEST_NUMBER,
} from "../core/base-seed-github";
import {
  VIBE_SEED_SIGNED_IN_PERSON,
  VIBE_SEED_TEAMMATES,
} from "../core/seed-people";
import type { VibeSeedContext } from "../stage";
import { replayAcmeSessionActivity } from "./acme-session-activity";
import { replayBranchEvidence } from "./branch-evidence";
import { assignBranchOwner } from "./branch-owner";
import { replayPullRequestReviews } from "./pr-reviews";
import { replayReviewConversation } from "./review-comments";
import { readSeededBranches, type SeededBranch } from "./seeded-branches";
import { FileChangeStatus, type FileEdit, foldFileEdits } from "./store-edits";
import {
  type BranchWork,
  derivedSha,
  gitHubPerson,
  type WorkCommit,
} from "./store-work";

/**
 * ISS-12135: the base seed writes the Acme repository's two branches, their
 * sessions and their pull request as fixtures on a fixed 2026-01-01 clock, with
 * no push for `saved-project-filters` and no head, commits or changes for
 * either, so neither was recent and only one could be listed. This stage
 * dates the two sessions inside the last few days, records the push each
 * session made, and replays each branch's GitHub side (pushes, commits, file
 * changes, checks, the pull request) through the same producers the golden
 * branches go through, so both are open, recent, listed branches.
 */

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const seededPeople = [VIBE_SEED_SIGNED_IN_PERSON, ...VIBE_SEED_TEAMMATES];
const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;

export type AcmeSessionPlan = {
  readonly sessionName: string;
  /** What the session was asked to do: its opening prompt. */
  readonly prompt: string;
  readonly branchName: string;
  /** How long before the run's `now` the session started. */
  readonly startedHoursAgo: number;
  readonly durationMinutes: number;
  readonly commits: readonly AcmeCommitPlan[];
  readonly pullRequest: {
    readonly number: number;
    readonly title: string;
  } | null;
};

type AcmeCommitPlan = {
  readonly message: string;
  /** Minutes into the session the commit was pushed. */
  readonly pushedAtMinute: number;
  readonly edits: readonly FileEdit[];
};

export async function replayAcmeBranches(
  context: VibeSeedContext
): Promise<void> {
  const branches = await readSeededBranches(context);
  for (const plan of ACME_SESSION_PLANS) {
    const branch = branches.find(
      (seeded) => seeded.branchName === plan.branchName
    );
    if (branch === undefined) {
      throw new Error(`the base seed's ${plan.branchName} branch is missing`);
    }
    const replayedStart = await readReplayedStart(context, branch, plan);
    const startedAt = acmeSessionStart(plan, context.now, replayedStart);
    const work = acmeBranchWork(branch, plan, startedAt);
    const lastPush = work.pushes.at(-1)?.at ?? startedAt;
    await redateSession(context, plan, startedAt);
    await recordSessionPush(context, branch, plan, lastPush);
    if (replayedStart === null) {
      await clearFixturePush(context, branch);
    }
    await replayBranchEvidence(context, branch, work);
    await redateFixtureReviews(context, branch, work);
    await replayPullRequestReviews(context, branch, work);
    await replayReviewConversation(
      context,
      branch,
      work,
      seededPeople.map((person) => gitHubPerson(person.githubUsername))
    );
    await replayAcmeSessionActivity(context, plan, work, startedAt);
    await assignBranchOwner(context, branch, work.author.login);
  }
  context.log(`replayed ${ACME_SESSION_PLANS.length} Acme branch(es)`);
}

export function acmeBranchWork(
  branch: SeededBranch,
  plan: AcmeSessionPlan,
  startedAt: Date
): BranchWork {
  const author = gitHubPerson(VIBE_SEED_SIGNED_IN_PERSON.githubUsername);
  let beforeSha = derivedSha(
    `${branch.repositoryFullName}\0main\0${plan.branchName}`
  );
  const commits: WorkCommit[] = [];
  const pushes: BranchWork["pushes"][number][] = [];
  for (const [index, planned] of plan.commits.entries()) {
    const files = foldFileEdits(planned.edits);
    const at = new Date(
      startedAt.getTime() + planned.pushedAtMinute * MINUTE_MS
    );
    const commit: WorkCommit = {
      sha: derivedSha(
        `${branch.repositoryFullName}\0${plan.branchName}\0${index}\0${planned.message}`
      ),
      message: planned.message,
      committedAt: at,
      linesAdded: files.reduce((sum, file) => sum + file.additions, 0),
      linesRemoved: files.reduce((sum, file) => sum + file.deletions, 0),
      filesChanged: files.length,
    };
    commits.push(commit);
    pushes.push({
      at,
      beforeSha,
      afterSha: commit.sha,
      commits: [commit],
      linesAdded: commit.linesAdded,
      linesRemoved: commit.linesRemoved,
    });
    beforeSha = commit.sha;
  }
  const files = foldFileEdits(plan.commits.flatMap((commit) => commit.edits));
  const lastPush = pushes.at(-1)?.at ?? startedAt;
  return {
    repositoryFullName: branch.repositoryFullName,
    branchName: plan.branchName,
    author,
    baseBranch: "main",
    commits,
    pushes,
    files,
    pullRequests:
      plan.pullRequest === null
        ? []
        : [
            {
              number: plan.pullRequest.number,
              openedAt: new Date(lastPush.getTime() + 5 * MINUTE_MS),
              facts: {
                title: plan.pullRequest.title,
                state: GitHubPRState.Open,
                isDraft: false,
                baseRef: "main",
                additions: files.reduce((sum, file) => sum + file.additions, 0),
                deletions: files.reduce((sum, file) => sum + file.deletions, 0),
                changedFiles: files.length,
              },
            },
          ],
  };
}

async function redateSession(
  context: VibeSeedContext,
  plan: AcmeSessionPlan,
  startedAt: Date
): Promise<void> {
  const endedAt = new Date(
    startedAt.getTime() + plan.durationMinutes * MINUTE_MS
  );
  const sessions = await context.prisma.artifact.findMany({
    where: { organizationId: context.organizationId, name: plan.sessionName },
    select: { id: true },
  });
  for (const session of sessions) {
    await context.prisma.artifact.update({
      where: { id: session.id },
      data: { status: SESSION_STATUS.INACTIVE },
      select: { id: true },
    });
    await context.prisma.sessionDetail.update({
      where: { artifactId: session.id },
      data: {
        sessionStartedAt: startedAt,
        sessionUpdatedAt: endedAt,
        sessionEndedAt: endedAt,
        lastActivityAt: endedAt,
      },
      select: { artifactId: true },
    });
  }
}

/**
 * The session-to-branch link a Desktop sync records for a session that pushed
 * the branch; the base seed records none for `saved-project-filters` and dates
 * the other's push on its fixed clock.
 */
async function recordSessionPush(
  context: VibeSeedContext,
  branch: SeededBranch,
  plan: AcmeSessionPlan,
  pushedAt: Date
): Promise<void> {
  const session = await context.prisma.artifact.findFirst({
    where: { organizationId: context.organizationId, name: plan.sessionName },
    select: { id: true },
  });
  if (session === null) {
    throw new Error(`the base seed's "${plan.sessionName}" session is missing`);
  }
  const participation = {
    branchParticipation: BranchParticipationKind.Wrote,
    branchParticipationMethod: GIT_PUSH_METHOD,
    branchParticipationObservedAt: pushedAt,
  };
  await context.prisma.artifactLink.upsert({
    where: {
      sourceId_targetId_linkType: {
        sourceId: session.id,
        targetId: branch.artifactId,
        linkType: LinkType.RelatesTo,
      },
    },
    create: {
      organizationId: context.organizationId,
      sourceId: session.id,
      targetId: branch.artifactId,
      linkType: LinkType.RelatesTo,
      metadata: {
        linkKind: SessionArtifactLinkKind.SessionBranch,
        branchParticipation: BranchParticipationKind.Wrote,
      },
      ...participation,
    },
    update: participation,
    select: { id: true },
  });
}

/**
 * The base seed stamps push evidence on its fixed clock; the earliest push wins
 * in `upsertBranchArtifact`, so the replayed pushes could not move it.
 */
async function clearFixturePush(
  context: VibeSeedContext,
  branch: SeededBranch
): Promise<void> {
  await context.prisma.branchDetail.update({
    where: { artifactId: branch.artifactId },
    data: { firstPushedAt: null, pushSource: null },
    select: { artifactId: true },
  });
}

/**
 * When the session was dated: by an earlier run of this stage when its pushes
 * are already recorded, so a rerun replays the same commits at the same
 * instants instead of moving them (the activity writer refuses a known
 * delivery with a new time); otherwise relative to the run's `now`.
 */
export function acmeSessionStart(
  plan: Pick<AcmeSessionPlan, "startedHoursAgo">,
  now: Date,
  replayedStart: Date | null
): Date {
  return (
    replayedStart ?? new Date(now.getTime() - plan.startedHoursAgo * HOUR_MS)
  );
}

async function readReplayedStart(
  context: VibeSeedContext,
  branch: SeededBranch,
  plan: AcmeSessionPlan
): Promise<Date | null> {
  const stored = await context.prisma.branchDetail.findUnique({
    where: { artifactId: branch.artifactId },
    select: { pushSource: true },
  });
  if (stored?.pushSource !== BranchPushSource.Webhook) {
    return null;
  }
  const session = await context.prisma.artifact.findFirst({
    where: { organizationId: context.organizationId, name: plan.sessionName },
    select: { session: { select: { sessionStartedAt: true } } },
  });
  return session?.session?.sessionStartedAt ?? null;
}

function edit(
  path: string,
  status: FileChangeStatus,
  removed: readonly string[],
  added: readonly string[]
): FileEdit {
  return { path, status, removed, added, contextBefore: [], contextAfter: [] };
}

export const ACME_SESSION_PLANS: readonly AcmeSessionPlan[] = [
  {
    sessionName: ACME_BASE_SEED.session,
    prompt:
      "Add saved filters to the projects list. Store each person's filters in the projects API, then add a Saved filters menu next to the filter bar that applies one.",
    branchName: ACME_FEATURE_BRANCH,
    startedHoursAgo: 52,
    durationMinutes: 140,
    pullRequest: {
      number: ACME_PULL_REQUEST_NUMBER,
      title: ACME_BASE_SEED.pullRequestTitle,
    },
    commits: [
      {
        message: "Store saved project filters per user",
        pushedAtMinute: 70,
        edits: [
          edit(
            "apps/api/projects/saved-filters.ts",
            FileChangeStatus.Added,
            [],
            [
              "export type SavedFilter = { id: string; name: string; query: ProjectQuery };",
              "",
              "export async function listSavedFilters(userId: string): Promise<SavedFilter[]> {",
              '  return db.savedFilter.findMany({ where: { userId }, orderBy: { name: "asc" } });',
              "}",
              "",
              'export async function saveFilter(userId: string, filter: Omit<SavedFilter, "id">) {',
              "  return db.savedFilter.create({ data: { ...filter, userId } });",
              "}",
            ]
          ),
          edit(
            "apps/api/projects/routes.ts",
            FileChangeStatus.Modified,
            ['router.get("/projects", listProjects);'],
            [
              'router.get("/projects", listProjects);',
              'router.get("/projects/saved-filters", listSavedFiltersRoute);',
              'router.post("/projects/saved-filters", saveFilterRoute);',
            ]
          ),
        ],
      },
      {
        message: "Add the saved filters menu to the projects list",
        pushedAtMinute: 130,
        edits: [
          edit(
            "apps/web/projects/saved-filters-menu.tsx",
            FileChangeStatus.Added,
            [],
            [
              "export function SavedFiltersMenu({ filters, onApply }: SavedFiltersMenuProps) {",
              "  return (",
              '    <Menu label="Saved filters">',
              "      {filters.map((filter) => (",
              "        <MenuItem key={filter.id} onSelect={() => onApply(filter.query)}>",
              "          {filter.name}",
              "        </MenuItem>",
              "      ))}",
              "    </Menu>",
              "  );",
              "}",
            ]
          ),
          edit(
            "apps/web/projects/projects-list.tsx",
            FileChangeStatus.Modified,
            ["      <ProjectFilters value={query} onChange={setQuery} />"],
            [
              "      <ProjectFilters value={query} onChange={setQuery} />",
              "      <SavedFiltersMenu filters={savedFilters} onApply={setQuery} />",
            ]
          ),
        ],
      },
    ],
  },
  {
    sessionName: ACME_BASE_SEED.collaboratorSession,
    prompt:
      "Draft an activity feed for the project page: an API that lists a project's latest events, and a feed component that renders them newest first.",
    branchName: ACME_COLLABORATOR_BRANCH,
    startedHoursAgo: 20,
    durationMinutes: 95,
    pullRequest: null,
    commits: [
      {
        message: "Draft the project activity feed",
        pushedAtMinute: 85,
        edits: [
          edit(
            "apps/web/projects/activity-feed.tsx",
            FileChangeStatus.Added,
            [],
            [
              "export function ActivityFeed({ projectId }: { projectId: string }) {",
              "  const { data: events = [] } = useProjectActivity(projectId);",
              "  return (",
              '    <ol className="activity-feed">',
              "      {events.map((event) => (",
              "        <ActivityRow key={event.id} event={event} />",
              "      ))}",
              "    </ol>",
              "  );",
              "}",
            ]
          ),
          edit(
            "apps/api/projects/activity.ts",
            FileChangeStatus.Added,
            [],
            [
              "export async function listProjectActivity(projectId: string, limit = 50) {",
              "  return db.projectEvent.findMany({",
              "    where: { projectId },",
              '    orderBy: { createdAt: "desc" },',
              "    take: limit,",
              "  });",
              "}",
            ]
          ),
        ],
      },
    ],
  },
];

/**
 * The base seed dates its one review on a fixed 2024 clock; a review lands
 * after its pull request opens.
 */
async function redateFixtureReviews(
  context: VibeSeedContext,
  branch: SeededBranch,
  work: BranchWork
): Promise<void> {
  for (const pullRequest of work.pullRequests) {
    const detailId = branch.pullRequestIdsByNumber.get(pullRequest.number);
    if (detailId === undefined) {
      continue;
    }
    await context.prisma.gitHubPRReview.updateMany({
      where: {
        pullRequestId: detailId,
        submittedAt: { lt: pullRequest.openedAt },
      },
      data: {
        submittedAt: new Date(pullRequest.openedAt.getTime() + 2 * HOUR_MS),
      },
    });
  }
}
