import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  reconcileOrgRepoSyncStates,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";

export const BOOTSTRAP_ORG_BATCH = 25;
export const BOOTSTRAP_DEADLINE_MS = 240_000;
export const BOOTSTRAP_ORG_WARN_REPOS = 500;

const LOG_PREFIX = "[bootstrap-repo-sync-states]";

export type BootstrapSummary = {
  orgsSelected: number;
  orgsBootstrapped: number;
  orgsFailed: number;
  reposMaterialized: number;
  stoppedOnDeadline: boolean;
};

export const githubRepoSyncStateBootstrapService = {
  async run(options: { now?: Date } = {}): Promise<BootstrapSummary> {
    const now = options.now ?? new Date();
    const startMs = Date.now();
    const orgIds = await selectUnbootstrappedOrgIds(BOOTSTRAP_ORG_BATCH);

    const summary: BootstrapSummary = {
      orgsSelected: orgIds.length,
      orgsBootstrapped: 0,
      orgsFailed: 0,
      reposMaterialized: 0,
      stoppedOnDeadline: false,
    };

    for (const organizationId of orgIds) {
      try {
        const repoCount = await reconcileOrgRepoSyncStates(organizationId, {
          now,
        });
        summary.orgsBootstrapped += 1;
        summary.reposMaterialized += repoCount;

        if (repoCount > BOOTSTRAP_ORG_WARN_REPOS) {
          log.warn(`${LOG_PREFIX} large org bootstrapped`, {
            organizationId,
            repoCount,
          });
        }
      } catch (error) {
        summary.orgsFailed += 1;
        log.error(`${LOG_PREFIX} org bootstrap failed`, {
          organizationId,
          error: parseError(error),
        });
      }

      if (Date.now() - startMs >= BOOTSTRAP_DEADLINE_MS) {
        summary.stoppedOnDeadline = true;
        break;
      }
    }

    return summary;
  },
};
