import { withDb } from "@repo/database";
import {
  emitSessionIngestionPolicyDenied,
  emitSessionIngestionPolicyDeniedAggregate,
  SessionIngestionDenialReason,
} from "@/lib/observability/session-ingestion-metrics";
import { sessionIngestionPolicyDeniedThrottle } from "@/lib/observability/session-ingestion-policy-denied-throttle";

/**
 * FEA-4169 — server-side enforcement of the ORG POLICY
 * (`Organization.sessionSyncPolicyEnabled`) that governs whether ANY local
 * desktop session data (metadata batches or transcripts) may be ingested into
 * the cloud for an organization.
 *
 * The policy is server-owned: the column is `NOT NULL DEFAULT false`, so every
 * org row has an explicit boolean and only an explicitly-enabled org (e.g. the
 * seeded internal Closedloop org) returns `true`. The desktop client honors this
 * value locally (`OrgSyncPolicyStore` / `orgPolicyAllowsSessionSync`), but that
 * is a UX-first gate: an older Desktop that predates the field, ignores it, or a
 * compromised client can still hit the ingest routes directly. Because the
 * server owns the policy it must enforce the SAME denial at every ingest
 * boundary — session-batch persist, transcript upload planning, and the
 * trace-comment agent-session sync — rather than trusting the client to
 * suppress egress.
 *
 * Fail-closed: an org that cannot be resolved (deleted, wrong id) degrades to
 * `false` (deny) rather than throwing, so a lookup miss never crashes the ingest
 * route and never accidentally allows egress. This depends on no client-sent
 * field, so a version-skewed old Desktop is enforced identically to a new one.
 *
 * ISS-4543: every denial emits `session.ingestion.policy_denied`. This function
 * is the SINGLE choke point ANDed in front of all three ingest boundaries, so
 * instrumenting it here — rather than at each boundary — covers them all and
 * cannot drift as boundaries are added. The metric is what makes a fail-closed
 * org loud: ISS-4537 left an org dark for ~2 days precisely because a denial
 * produced no signal at all. Emission is best-effort telemetry (a `log.info`
 * under the hood) and never changes the allow/deny answer.
 *
 * ISS-4707: because some callers reach this choke point with no limiter (the
 * trace-comment routes) or before their own limiter (transcript authorization),
 * an authenticated member of a policy-off org could replay them to emit an
 * UNBOUNDED stream of `policy_denied` events. The emission is throttled per
 * `(orgId, reason)` through a bounded process-local window: the first denial in
 * a window emits, the rest are counted and flushed as one aggregate rollup so
 * the denial volume is preserved. The throttle NEVER touches the allow/deny
 * answer, and its emission is best-effort — a throttling fault can never block
 * ingest.
 */
export async function isOrgSessionSyncPolicyEnabled(
  organizationId: string
): Promise<boolean> {
  const org = await withDb((db) =>
    db.organization.findUnique({
      where: { id: organizationId },
      select: { sessionSyncPolicyEnabled: true },
    })
  );

  if (org?.sessionSyncPolicyEnabled === true) {
    return true;
  }

  const reason = org
    ? SessionIngestionDenialReason.PolicyDisabled
    : SessionIngestionDenialReason.OrgNotFound;
  emitThrottledPolicyDenied(organizationId, reason);
  return false;
}

/**
 * Emit the policy-denied metric under the ISS-4707 per-(org, reason) throttle.
 * The first denial in a window emits `count: 1`; a window that closes with
 * suppressed denials flushes them as one aggregate rollup on the next window's
 * first denial. Best-effort telemetry only — the caller has already decided to
 * deny before this runs.
 */
function emitThrottledPolicyDenied(
  organizationId: string,
  reason: SessionIngestionDenialReason
): void {
  const decision = sessionIngestionPolicyDeniedThrottle.record(
    organizationId,
    reason,
    Date.now()
  );

  if (decision.flushedSuppressedCount > 0) {
    emitSessionIngestionPolicyDeniedAggregate(
      organizationId,
      reason,
      decision.flushedSuppressedCount
    );
  }

  if (decision.emit) {
    emitSessionIngestionPolicyDenied(organizationId, reason);
  }
}
