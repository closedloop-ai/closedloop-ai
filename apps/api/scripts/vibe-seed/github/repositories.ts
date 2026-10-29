import { RepositoryDefaultSource } from "@repo/api/src/types/repository-default-identity";
import { GitHubInstallationStatus, withDb } from "@repo/database";
import { bulkUpsertInstallationRepositories } from "@/app/integrations/github/service/repository-sync";
import { mapGitHubWebhookRepositoryDefaultAuthority } from "@/lib/github/repository-default-authority";
import {
  ensureRepositoryAuthority,
  type SeedRepositoryAuthority,
} from "../../seed-branches-web-db";
import {
  ACME_REPOSITORY,
  ACME_REPOSITORY_GITHUB_ID,
  ACME_REPOSITORY_NAME,
} from "../core/base-seed-github";
import { VIBE_SEED_ORGANIZATION } from "../core/seed-identity";
import type { VibeSeedContext } from "../stage";
import type { SeededRepository } from "./store-links";

/**
 * ISS-12017: the repositories the golden sessions actually worked in, given to
 * the vibe org the way production learns of them. The base seed's only
 * repository is a placeholder no golden session ran in, so without these no
 * session could link to a branch.
 *
 * The vibe store rewrites the corpus's repositories to Acme's (ISS-12135):
 * `acme-co/acme-web`, the base seed's own repository, joins the org's active GitHub App installation
 * through `bulkUpsertInstallationRepositories`, the write
 * `githubService.addRepositories` makes for the `installation_repositories`
 * "added" webhook (the service module itself pulls in Clerk, which this
 * runtime cannot load), with the webhook's default-branch authority. `acme-co/agent-toolkit`
 * is added as a public repository through the branches web seed's own
 * `PublicRepository` writer (production's `addPublicRepository` would look the
 * repository up on GitHub first).
 */

type InstalledRepository = SeededRepository & {
  readonly githubRepoId: number;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranchName: string;
};

export const SYMPHONY_REPOSITORY: InstalledRepository = {
  fullName: ACME_REPOSITORY,
  owner: VIBE_SEED_ORGANIZATION.slug,
  name: ACME_REPOSITORY_NAME,
  githubRepoId: Number(ACME_REPOSITORY_GITHUB_ID),
  defaultBranchName: "main",
  cwdPattern: /(?:^|\/)acme-web(?:\/|$)/,
};

export const CLAUDE_PLUGINS_REPOSITORY: SeedRepositoryAuthority &
  SeededRepository = {
  owner: VIBE_SEED_ORGANIZATION.slug,
  name: "agent-toolkit",
  fullName: `${VIBE_SEED_ORGANIZATION.slug}/agent-toolkit`,
  githubRepoId: "873310592",
  defaultBranchName: "main",
  observationKey: `vibe-seed:${VIBE_SEED_ORGANIZATION.slug}/agent-toolkit`,
  cwdPattern: /(?:^|\/)agent-toolkit(?:\/|$)/,
};

/** Every repository the org holds authority for after this step, for ref inference. */
export const SEEDED_REPOSITORIES: readonly SeededRepository[] = [
  SYMPHONY_REPOSITORY,
  CLAUDE_PLUGINS_REPOSITORY,
];

export async function ensureSeededRepositories(
  context: VibeSeedContext
): Promise<void> {
  const installation = await context.prisma.gitHubInstallation.findFirst({
    where: {
      organizationId: context.organizationId,
      status: GitHubInstallationStatus.ACTIVE,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  if (!installation) {
    throw new Error(
      `organization ${context.organizationId} has no active GitHub installation; the base seed should have created one`
    );
  }
  const repository = {
    id: SYMPHONY_REPOSITORY.githubRepoId,
    full_name: SYMPHONY_REPOSITORY.fullName,
    default_branch: SYMPHONY_REPOSITORY.defaultBranchName,
  };
  const defaultAuthority = mapGitHubWebhookRepositoryDefaultAuthority(
    repository,
    RepositoryDefaultSource.InstallationWebhook,
    {
      deliveryId: `vibe-seed:${SYMPHONY_REPOSITORY.fullName}`,
      observedAt: context.now,
    }
  );
  await withDb.tx((tx) =>
    bulkUpsertInstallationRepositories(tx, installation.id, [
      {
        githubRepoId: String(SYMPHONY_REPOSITORY.githubRepoId),
        fullName: SYMPHONY_REPOSITORY.fullName,
        name: SYMPHONY_REPOSITORY.name,
        owner: SYMPHONY_REPOSITORY.owner,
        private: true,
        ...(defaultAuthority === undefined ? {} : { defaultAuthority }),
      },
    ])
  );
  await ensureRepositoryAuthority(
    context.prisma,
    context.organizationId,
    CLAUDE_PLUGINS_REPOSITORY,
    context.now
  );
}
