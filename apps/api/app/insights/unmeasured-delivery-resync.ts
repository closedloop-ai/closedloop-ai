import "server-only";

import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { waitUntil } from "@vercel/functions";
import { runPostConnectObservedSync } from "@/app/integrations/github/post-connect-sync-service";
import {
  claimOrganizationRun,
  type OrganizationRunGateDefinition,
  releaseOrganizationRun,
} from "@/lib/organization-run-gate";

const LOG_PREFIX = "[insights/unmeasured-delivery-resync]";

/**
 * ISS-8424: how long the read-triggered arm refuses a fresh claim.
 *
 * An hour, not the connect lane's minute. This trigger fires from a Dashboard
 * READ, which an org loads continuously, and its precondition (nothing in the
 * session-linked merged population verified) is self-clearing only when the
 * sync succeeds — an org whose repositories are permanently unreadable would
 * otherwise re-sweep on every cooldown expiry forever. That is the shape
 * ISS-8423's unbounded rescue arm took, and the fix there was to bound the arm
 * rather than to trust its precondition to go away.
 */
export const UNMEASURED_DELIVERY_RESYNC_COOLDOWN_MS = 60 * 60 * 1000;

/**
 * Short next to the cooldown: the lease only has to outlive the chain it
 * guards, and `runPostConnectObservedSync` holds its own 5-minute lease over
 * the actual work.
 */
export const UNMEASURED_DELIVERY_RESYNC_LEASE_MS = 5 * 60 * 1000;

const UNMEASURED_DELIVERY_RESYNC_GATE: OrganizationRunGateDefinition = {
  settingsKey: "insightsUnmeasuredDeliveryResyncGate",
  // Its OWN lock, because it wraps rather than replaces the connect lane: the
  // chain inside claims `github-post-connect-sync` itself, so a connect running
  // concurrently is refused there — where the work is — not here.
  lockName: "insights-unmeasured-delivery-resync",
  leaseMs: UNMEASURED_DELIVERY_RESYNC_LEASE_MS,
  cooldownMs: UNMEASURED_DELIVERY_RESYNC_COOLDOWN_MS,
  writeSubject: "Insights unmeasured-delivery resync gate write",
};

/**
 * Give an org whose Delivery population has never been verified the automatic
 * trigger it otherwise lacks.
 *
 * An OAuth-only org has no webhook lane, so `lastVerifiedAt` is written only by
 * the tier-2 targeted sync. The crons reach it (`bootstrap-repo-sync-states`
 * verifies observed repositories, then `reconcile-pull-requests` sweeps them),
 * and connecting GitHub reaches it immediately — but an org that connected
 * before its sessions produced any session-linked PR has no event left to fire,
 * and until a cron tick lands its dashboard is entirely unmeasured. This makes
 * the unmeasured READ itself the event.
 *
 * It reuses `runPostConnectObservedSync` whole rather than assembling a second
 * verify/reconcile/sweep chain: that chain is already bounded (five repos, its
 * own org lease and lock) and already documented as the installation-free
 * analogue of the App lane's installation claim. What is added here is only the
 * outer frequency bound.
 *
 * Fire-and-forget and never throws: it runs beside a response the reader is
 * waiting on, and a resync that cannot start must not cost them their
 * dashboard.
 */
export function scheduleUnmeasuredDeliveryResync(organizationId: string): void {
  waitUntil(
    resyncUnmeasuredDelivery(organizationId).catch((error) => {
      log.warn(`${LOG_PREFIX} resync failed`, {
        organizationId,
        error: parseError(error),
      });
    })
  );
}

async function resyncUnmeasuredDelivery(organizationId: string): Promise<void> {
  const claim = await claimOrganizationRun(
    organizationId,
    UNMEASURED_DELIVERY_RESYNC_GATE
  );
  if (!claim.claimed) {
    return;
  }
  try {
    const summary = await runPostConnectObservedSync({ organizationId });
    log.info(`${LOG_PREFIX} resync completed`, { organizationId, ...summary });
  } finally {
    // In a `finally`, so a failing org restarts the cooldown exactly like a
    // succeeding one. Releasing only on success would leave a permanently
    // unverifiable org re-admitted as soon as the five-minute lease expired,
    // which is the unbounded retry this gate exists to prevent. (The claim
    // itself already wrote the cooldown, so a killed process is bounded too;
    // the release is what clears the lease early.)
    await releaseBestEffort(organizationId);
  }
}

async function releaseBestEffort(organizationId: string): Promise<void> {
  try {
    await releaseOrganizationRun(
      organizationId,
      UNMEASURED_DELIVERY_RESYNC_GATE
    );
  } catch (error) {
    log.warn(`${LOG_PREFIX} failed to release the resync gate`, {
      organizationId,
      error: parseError(error),
    });
  }
}
