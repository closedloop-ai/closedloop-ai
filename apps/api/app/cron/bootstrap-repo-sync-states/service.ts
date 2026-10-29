import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  markOrgRepoSyncBootstrapAttempt,
  reconcileOrgRepoSyncStates,
  selectUnbootstrappedOrgIds,
} from "@/lib/github/github-repo-sync-state";
import {
  type ObservedRepositoryVerificationSummary,
  runObservedRepositoryVerification,
} from "./verify-phase";

export const BOOTSTRAP_ORG_BATCH = 25;
export const BOOTSTRAP_DEADLINE_MS = 240_000;
export const BOOTSTRAP_ORG_WARN_REPOS = 500;

const LOG_PREFIX = "[bootstrap-repo-sync-states]";

export type BootstrapSummary = {
  orgsSelected: number;
  orgsBootstrapped: number;
  /**
   * ISS-6590: passes that ran to the end without settling the org — either ≥1
   * repo went unwritten, or the pass derived no candidate repos at all. These
   * orgs keep no completion marker and are re-selected, so they are neither a
   * success nor a lost org; the distinction is what makes a silent partial
   * bootstrap visible.
   */
  orgsPartial: number;
  orgsFailed: number;
  reposMaterialized: number;
  /** ISS-6590: repos whose row did not land, summed across every org this tick. */
  reposFailed: number;
  stoppedOnDeadline: boolean;
  /**
   * The observed-repository verification pass that runs before the bootstrap
   * loop.
   * Reported as its own object rather than folded into the counters above,
   * because it selects its own orgs on its own recurring predicate — blending
   * them would make `orgsSelected` mean two different populations at once.
   */
  observedRepositoryVerification: ObservedRepositoryVerificationSummary;
};

export const githubRepoSyncStateBootstrapService = {
  async run(options: { now?: Date } = {}): Promise<BootstrapSummary> {
    const now = options.now ?? new Date();
    // Taken before verification so the bootstrap loop's deadline bounds the WHOLE
    // tick. Measuring it from after the verify phase would let the two budgets
    // sum past the route's maxDuration and have the platform kill the tick.
    const startMs = Date.now();
    // Verify FIRST: a repository proven readable on this tick can be queued for
    // targeted session-linked reconciliation on this tick.
    const observedRepositoryVerification =
      await runObservedRepositoryVerification({ now });
    const orgIds = await selectUnbootstrappedOrgIds(BOOTSTRAP_ORG_BATCH);

    const summary: BootstrapSummary = {
      orgsSelected: orgIds.length,
      orgsBootstrapped: 0,
      orgsPartial: 0,
      orgsFailed: 0,
      reposMaterialized: 0,
      reposFailed: 0,
      stoppedOnDeadline: false,
      observedRepositoryVerification,
    };

    for (const organizationId of orgIds) {
      try {
        // Claim before the pass, not after: the route's `maxDuration` can kill
        // this mid-org, and only an already-committed attempt stamp stops the
        // selector from handing back the same org at the head of every batch. A
        // claim that itself fails leaves the org unrotated — unavoidable, since
        // the rotation IS a write — so it is reported as a failed org and the
        // batch moves on rather than retrying into the same unavailable pool.
        await markOrgRepoSyncBootstrapAttempt(organizationId, now);
        const result = await reconcileOrgRepoSyncStates(organizationId, {
          now,
        });
        summary.reposMaterialized += result.repoCount - result.failedRepoCount;
        summary.reposFailed += result.failedRepoCount;
        // Read the reconciler's own verdict rather than re-deriving it from the
        // counts: `orgsBootstrapped` must mean "marker written", and a
        // zero-candidate pass has no failed repos yet is left unsettled.
        if (result.settled) {
          summary.orgsBootstrapped += 1;
          if (result.repoCount > BOOTSTRAP_ORG_WARN_REPOS) {
            log.warn(`${LOG_PREFIX} large org bootstrapped`, {
              organizationId,
              repoCount: result.repoCount,
            });
          }
        } else {
          summary.orgsPartial += 1;
          if (result.repoCount === 0) {
            // A pass with failed repos is already logged by the reconciler with
            // its failure detail; a pass that derived none is not, and it will
            // hold a slot in every batch until whatever made the org match the
            // selector's OR arms resolves.
            log.warn(`${LOG_PREFIX} selected org derived no candidate repos`, {
              organizationId,
            });
          }
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
