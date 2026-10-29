import { BRANCH_PUSH_METHOD_VALUES } from "@repo/api/src/types/session-artifact-link";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import {
  PullRequestCommentProofFixture,
  pullRequestCommentProofIdentity,
} from "@repo/database/scripts/seed/pull-request-comment-proof-identity";
import { seedBranchOwners } from "@/app/branches/branch-owner-seed/branch-owner-seed";
import { generateSlug } from "@/lib/slug-generator";
import type { VibeSeedContext } from "../stage";
import { VIBE_SEED_ORGANIZATION } from "./seed-identity";
import { VIBE_SEED_SIGNED_IN_PERSON, VIBE_SEED_TEAMMATES } from "./seed-people";

/**
 * ISS-12056 (Seed quality): the base seed's GitHub account, repository, pull
 * request, branches, deployment and sessions, renamed for the vibe org, and
 * the base-seed branches the Branches Owner column could not attribute
 * given an owner. Keyed on the base seed's own values, so a rerun is a no-op.
 */

const BASE = {
  account: "seed-org",
  repository: "seed-org/seed-repo",
  login: "seed-user",
  reviewer: "seed-reviewer",
  pullRequestTitle: "Seed pull request: add feature branch",
  featureBranch: "seed/feature-branch",
  collaboratorBranch: "seed/collaborators-branch",
  deployment: "Preview Deployment (seed)",
  session: "Seed Agent Session",
  collaboratorSession: "Seed Collaborator Evidence Session",
  machine: "seed-machine",
  cwd: "/workspace/seed-worktree",
} as const;

export const ACME_REPOSITORY_NAME = "acme-web";
export const ACME_REPOSITORY = `${VIBE_SEED_ORGANIZATION.slug}/${ACME_REPOSITORY_NAME}`;
/**
 * ISS-12135: the signed-in person's branches carry a topic prefix, not their
 * handle. A seeded Vercel environment hands the signed-in person's row to
 * whoever signs in, so a `jordanavery/` prefix would name someone other than
 * the branch's owner.
 */
export const ACME_FEATURE_BRANCH = "feat/saved-project-filters";
export const ACME_COLLABORATOR_BRANCH = "feat/project-activity-feed";
/**
 * The names a database seeded before that rename holds, relabeled too so a
 * rerun over it (`--skip-base`) finds the branches the replay expects. They
 * carry the handle the signed-in person had then. Only these branch names are
 * relabeled: the pull requests, reviews, installation and machines such a
 * database holds keep that handle, so a rerun over it does not give the
 * signed-in person one identity. Seed it fresh instead.
 */
const PREVIOUS_SIGNED_IN_LOGIN = "jordanavery";
const PREVIOUS_FEATURE_BRANCH = `${PREVIOUS_SIGNED_IN_LOGIN}/saved-project-filters`;
const PREVIOUS_COLLABORATOR_BRANCH = `${PREVIOUS_SIGNED_IN_LOGIN}/project-activity-feed`;
export const ACME_REPOSITORY_GITHUB_ID = "731264058";
/**
 * ISS-12135: the base seed numbers its pull request 1, but the corpus's work
 * now shares this repository and already holds a #1. No pull request the
 * corpus records or the seed settles carries this number.
 */
export const ACME_PULL_REQUEST_NUMBER = 5601;
const PULL_REQUEST_URL = `https://github.com/${ACME_REPOSITORY}/pull/${ACME_PULL_REQUEST_NUMBER}`;
const [GIT_PUSH_METHOD] = BRANCH_PUSH_METHOD_VALUES;

export const ACME_BASE_SEED = {
  pullRequestTitle: "Add saved filters to the projects list",
  pullRequestBody:
    "Adds saved filters to the projects list so people can keep their usual view. Filters are stored per user; the API change is additive.",
  reviewBody: "Looks good to me. Nice cleanup of the filter state.",
  deployment: `Preview: ${ACME_FEATURE_BRANCH}`,
  session: "Wire saved filters into the projects API",
  collaboratorSession: "Draft the project activity feed",
  machine: "acme-mac-studio",
  cwd: `/workspace/${ACME_REPOSITORY_NAME}`,
} as const;

export async function relabelBaseSeedGitHub(
  context: VibeSeedContext
): Promise<void> {
  await relabelAccountAndRepository(context);
  await relabelPullRequest(context);
  await relabelBranches(context);
  await relabelSessions(context);
  await attributeBaseSeedBranch(context, ACME_COLLABORATOR_BRANCH);
  await relabelProofBranches(context);
}

async function relabelAccountAndRepository(
  context: VibeSeedContext
): Promise<void> {
  const { prisma, organizationId } = context;
  await prisma.gitHubInstallation.updateMany({
    where: { organizationId, accountLogin: BASE.account },
    data: {
      accountLogin: VIBE_SEED_ORGANIZATION.slug,
      senderLogin: VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
    },
  });
  await prisma.gitHubInstallationRepository.updateMany({
    where: { installation: { organizationId }, fullName: BASE.repository },
    data: {
      fullName: ACME_REPOSITORY,
      name: ACME_REPOSITORY_NAME,
      owner: VIBE_SEED_ORGANIZATION.slug,
      // The base seed's placeholder id is not a number, and the GitHub
      // replay only projects pull requests of a repository with a GitHub id.
      githubRepoId: ACME_REPOSITORY_GITHUB_ID,
    },
  });
  await prisma.branchDetail.updateMany({
    where: { organizationId, repositoryFullName: BASE.repository },
    data: { repositoryFullName: ACME_REPOSITORY },
  });
  await prisma.sessionDetail.updateMany({
    where: {
      artifact: { organizationId },
      repositoryFullName: BASE.repository,
    },
    data: { repositoryFullName: ACME_REPOSITORY },
  });
  const login = VIBE_SEED_SIGNED_IN_PERSON.githubUsername;
  await prisma.gitHubUserConnection.updateMany({
    where: { organizationId, login: BASE.login },
    data: {
      login,
      normalizedLogin: login.toLowerCase(),
      profileUrl: `https://github.com/${login}`,
    },
  });
  await prisma.computeTarget.updateMany({
    where: { organizationId, machineName: BASE.machine },
    data: { machineName: ACME_BASE_SEED.machine },
  });
}

/**
 * The PR's author login is what attributes `seed/feature-branch` to its owner
 * (the PR-creator rung the branch assignee is seeded from, ISS-12463); the
 * owner created the branch.
 */
async function relabelPullRequest(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  const pullRequests = await prisma.pullRequestDetail.findMany({
    where: { organizationId, title: BASE.pullRequestTitle },
    select: { id: true },
  });
  const reviewer = VIBE_SEED_TEAMMATES[0];
  for (const pullRequest of pullRequests) {
    await prisma.pullRequestDetail.update({
      where: { id: pullRequest.id },
      data: {
        number: ACME_PULL_REQUEST_NUMBER,
        // The base seed's placeholder id is not the id GitHub's payload
        // carries; the replay records the real one.
        githubId: null,
        title: ACME_BASE_SEED.pullRequestTitle,
        body: ACME_BASE_SEED.pullRequestBody,
        htmlUrl: PULL_REQUEST_URL,
        headRefName: ACME_FEATURE_BRANCH,
        authorLogin: VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
      },
      select: { id: true },
    });
    await prisma.gitHubPRReview.updateMany({
      where: { pullRequestId: pullRequest.id, authorLogin: BASE.reviewer },
      data: {
        authorLogin:
          reviewer?.githubUsername ?? VIBE_SEED_SIGNED_IN_PERSON.githubUsername,
        body: ACME_BASE_SEED.reviewBody,
        htmlUrl: `${PULL_REQUEST_URL}#pullrequestreview-33221100`,
      },
    });
  }
}

async function relabelBranches(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  for (const [from, to] of [
    [BASE.featureBranch, ACME_FEATURE_BRANCH],
    [BASE.collaboratorBranch, ACME_COLLABORATOR_BRANCH],
    [PREVIOUS_FEATURE_BRANCH, ACME_FEATURE_BRANCH],
    [PREVIOUS_COLLABORATOR_BRANCH, ACME_COLLABORATOR_BRANCH],
  ] as const) {
    await prisma.branchDetail.updateMany({
      where: { organizationId, branchName: from },
      data: { branchName: to },
    });
    // Branches the product writes carry no slug; only the base seed mints one.
    await prisma.artifact.updateMany({
      where: { organizationId, name: from },
      data: { name: to, slug: null },
    });
  }
  await prisma.pullRequestDetail.updateMany({
    where: { organizationId, headRefName: PREVIOUS_FEATURE_BRANCH },
    data: { headRefName: ACME_FEATURE_BRANCH },
  });
  await prisma.deploymentDetail.updateMany({
    where: {
      artifact: { organizationId },
      ref: { in: [BASE.featureBranch, PREVIOUS_FEATURE_BRANCH] },
    },
    data: { ref: ACME_FEATURE_BRANCH },
  });
  await prisma.artifact.updateMany({
    where: {
      organizationId,
      name: { in: [BASE.deployment, `Preview: ${PREVIOUS_FEATURE_BRANCH}`] },
    },
    data: { name: ACME_BASE_SEED.deployment, slug: null },
  });
}

async function relabelSessions(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  for (const [from, to] of [
    [BASE.session, ACME_BASE_SEED.session],
    [BASE.collaboratorSession, ACME_BASE_SEED.collaboratorSession],
  ] as const) {
    const sessions = await prisma.artifact.findMany({
      where: { organizationId, name: from },
      select: { id: true },
    });
    for (const session of sessions) {
      await prisma.artifact.update({
        where: { id: session.id },
        data: {
          name: to,
          slug: await generateSlug(organizationId, SlugPrefix.Session),
        },
        select: { id: true },
      });
    }
  }
  await prisma.sessionDetail.updateMany({
    where: { artifact: { organizationId }, cwd: BASE.cwd },
    data: { cwd: ACME_BASE_SEED.cwd },
  });
}

/**
 * The base seed leaves the collaborator session without a creator and its
 * branch link without a push method (an e2e fixture for native-comment
 * collaborators), so that branch had no owner. Here the session's creator is
 * its machine's owner, the person the Owner seed's push rung names (ISS-12251,
 * ISS-12463), and the link records the push the branch's `firstPushedAt`
 * already claims. The base seed writes these branches directly, so no product
 * write path runs the Owner seed on them; it runs here once the push evidence
 * exists, since Owner is the assignee it stamps (ISS-12463).
 */
async function attributeBaseSeedBranch(
  context: VibeSeedContext,
  branchName: string
): Promise<void> {
  const { prisma, organizationId } = context;
  const branch = await prisma.branchDetail.findFirst({
    where: { organizationId, branchName },
    select: { artifactId: true, firstPushedAt: true },
  });
  if (!branch) {
    return;
  }
  const links = await prisma.artifactLink.findMany({
    where: {
      organizationId,
      targetId: branch.artifactId,
      source: { session: { isNot: null } },
    },
    select: {
      id: true,
      sourceId: true,
      source: {
        select: {
          createdById: true,
          session: {
            select: { computeTarget: { select: { userId: true } } },
          },
        },
      },
    },
  });
  for (const link of links) {
    const ownerId =
      link.source.createdById ?? link.source.session?.computeTarget.userId;
    if (!ownerId) {
      continue;
    }
    await prisma.artifact.updateMany({
      where: { id: link.sourceId, createdById: null },
      data: { createdById: ownerId },
    });
    await prisma.artifactLink.updateMany({
      where: { id: link.id, branchParticipationMethod: null },
      data: {
        branchParticipationMethod: GIT_PUSH_METHOD,
        branchParticipationObservedAt: branch.firstPushedAt ?? context.now,
      },
    });
  }
  await seedBranchOwners(prisma, organizationId, [branch.artifactId]);
}

/** Vibe identity preparation for the base seed's additive PR-comment proof rows. */
async function relabelProofBranches(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  for (const fixture of Object.values(PullRequestCommentProofFixture)) {
    const identity = pullRequestCommentProofIdentity(organizationId, fixture);
    const branch = await prisma.branchDetail.findFirst({
      where: { organizationId, artifactId: identity.branchArtifactId },
      select: { branchName: true },
    });
    if (!branch) {
      continue;
    }
    const branchName = branch.branchName.replace(BASE_BRANCH_PREFIX, "");
    await prisma.branchDetail.updateMany({
      where: { organizationId, artifactId: identity.branchArtifactId },
      data: { branchName },
    });
    await prisma.artifact.updateMany({
      where: { organizationId, id: identity.branchArtifactId },
      data: { name: branchName, slug: null },
    });
    const session = await prisma.artifact.findFirst({
      where: { organizationId, id: identity.sessionArtifactId },
      select: { name: true, slug: true },
    });
    if (session && session.slug === identity.sessionSlug) {
      await prisma.artifact.updateMany({
        where: { organizationId, id: identity.sessionArtifactId },
        data: {
          name: session.name?.replace(BASE_SESSION_PREFIX, "") ?? session.name,
          slug: await generateSlug(organizationId, SlugPrefix.Session),
        },
      });
    }
    const pullRequests = await prisma.pullRequestDetail.findMany({
      where: { organizationId, branchArtifactId: identity.branchArtifactId },
      select: { id: true, title: true },
    });
    for (const pullRequest of pullRequests) {
      await prisma.pullRequestDetail.updateMany({
        where: { organizationId, id: pullRequest.id },
        data: {
          title: pullRequest.title
            ?.replace(BASE_SESSION_PREFIX, "")
            .replace(BASE_SEED_BRANCH_REFERENCE, ""),
          repositoryFullName: ACME_REPOSITORY,
          headRefName: branchName,
        },
      });
    }
    await attributeBaseSeedBranch(context, branchName);
  }
}

const BASE_BRANCH_PREFIX = /^seed\//;
const BASE_SESSION_PREFIX = /^Seed /;

const BASE_SEED_BRANCH_REFERENCE = /\bseed\//g;
