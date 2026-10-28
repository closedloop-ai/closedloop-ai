import { withDb } from "@repo/database";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import {
  memoizeAttributionEvidenceGate,
  settledAttributionEvidenceGate,
} from "@/lib/attribution-evidence-gate-scope";
import { currentFeatureFlagRequestScope } from "@/lib/feature-flags/feature-flag-request-scope";
import {
  evaluateServerFeatureFlagForOrganization,
  resolveUnmemoizedFeatureFlagValue,
} from "@/lib/feature-flags/server-feature-flag-evaluation";
import { ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";
import { createMemoizedOrganizationFeatureFlagGate } from "@/lib/memoized-feature-flag-gate";

/**
 * Intentionally NOT `import "server-only"`: sync ingest reads this gate, and
 * the desktop gateway socket server loads that graph under `tsx` outside
 * Next, where `server-only` throws (`pnpm --filter api server:import-smoke`).
 *
 * ISS-12552 (PRD-800 "Rollout"): the one gate for everything PRD-800 adds
 * on the server, capture and use alike. It is a company group flag rolled out
 * by organization ring, so every read is for an organization and every member
 * of an organization gets the same answer. With it off, capture and use match
 * the server before PRD-800. The Documents and Issues cost and count cards
 * never read it (PRD-800 "Scope of this project's metric changes").
 */
export const ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY =
  ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG.key;

/** Structured-log event emitted only when flag evaluation throws. */
export const ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY =
  "attribution_evidence_policy_flag_unavailable" as const;

/**
 * Fail-closed: an unavailable PostHog answer reads as off, so an outage can
 * never switch capture or a reader onto evidence. Call it before any
 * transaction opens: it reads the organization row and asks PostHog.
 */
export async function isAttributionEvidenceEnabledForOrganization(
  organizationId: string
): Promise<boolean> {
  return (
    (await evaluateAttributionEvidenceForOrganization(organizationId)) === true
  );
}

/**
 * The organization's answer, with an unavailable PostHog answer reported as
 * `null` rather than off, for a writer that must retry instead of recording an
 * answer it never got (the session evidence link sync). An organization that
 * does not exist is off.
 *
 * Inside `runWithAttributionEvidenceGate` an organization is evaluated once
 * and every read site of the request shares that answer. A caller in Dev Mode
 * gets their own override for this key, so a developer can see both states
 * without moving their organization's ring; a preview's pinned snapshot also
 * applies.
 */
export function evaluateAttributionEvidenceForOrganization(
  organizationId: string
): Promise<boolean | null> {
  return memoizeAttributionEvidenceGate(organizationId, () =>
    evaluateForOrganization(organizationId)
  );
}

/**
 * For a writer that runs inside a transaction (a branch write's source link):
 * whether this request already read the organization's answer as on, before
 * its transaction opened, with {@link readAttributionEvidenceForRequest}. It
 * never evaluates, so it never waits on PostHog inside the transaction. A
 * request that did not read it is off.
 */
export function isAttributionEvidenceReadOnForOrganization(
  organizationId: string
): boolean {
  return settledAttributionEvidenceGate(organizationId) === true;
}

/**
 * The other half of {@link isAttributionEvidenceReadOnForOrganization}: whether
 * this request already read the answer as off (or unavailable, which reads as
 * off), so a writer can skip work that only the on answer needs without
 * evaluating anything. A request that did not read it is neither.
 */
export function isAttributionEvidenceReadOffForOrganization(
  organizationId: string
): boolean {
  const settled = settledAttributionEvidenceGate(organizationId);
  return settled === false || settled === null;
}

/**
 * Reads the organization's answer into the request scope, outside any
 * transaction, for {@link isAttributionEvidenceReadOnForOrganization} to branch
 * on inside one. Call it inside `runWithAttributionEvidenceGate`.
 */
export async function readAttributionEvidenceForRequest(
  organizationId: string
): Promise<void> {
  await evaluateAttributionEvidenceForOrganization(organizationId);
}

/** How long one organization's evaluated answer is reused across requests. */
export const ATTRIBUTION_EVIDENCE_DECISION_TTL_MS = 30_000;

/** How long an unanswered evaluation waits before PostHog is asked again. */
export const ATTRIBUTION_EVIDENCE_UNAVAILABLE_BACKOFF_MS = 5000;

const ATTRIBUTION_EVIDENCE_GATE_MAX_ENTRIES = 5000;

/**
 * ISS-12552: every read site shares this per-organization memo, so an API-key
 * write pays the organization read and the PostHog group decide once per
 * organization per TTL instead of once per request. The per-request scope in
 * `attribution-evidence-gate-scope.ts` still sits on top, so one request
 * never sees two answers even across a TTL boundary.
 */
const organizationGate = createMemoizedOrganizationFeatureFlagGate({
  flag: ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
  unavailableLogKey: ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY,
  ttlMs: ATTRIBUTION_EVIDENCE_DECISION_TTL_MS,
  unavailableBackoffMs: ATTRIBUTION_EVIDENCE_UNAVAILABLE_BACKOFF_MS,
  maxEntries: ATTRIBUTION_EVIDENCE_GATE_MAX_ENTRIES,
  evaluate: evaluateOrganizationGroup,
});

/** Test seam: forget every memoized organization answer. */
export function clearAttributionEvidenceGateMemo(): void {
  organizationGate.clear();
}

async function evaluateForOrganization(
  organizationId: string
): Promise<boolean | null> {
  const callerDistinctId = currentFeatureFlagRequestScope()?.distinctId;
  const unmemoized = await resolveUnmemoizedFeatureFlagValue(
    ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
    callerDistinctId ? [callerDistinctId] : []
  );
  if (unmemoized !== undefined) {
    return unmemoized;
  }
  return await organizationGate.resolve(organizationId);
}

async function evaluateOrganizationGroup(
  organizationId: string
): Promise<boolean | null> {
  try {
    const organization = await withDb((db) =>
      db.organization.findUnique({
        where: { id: organizationId },
        select: { clerkId: true },
      })
    );
    if (!organization) {
      return false;
    }
    return await evaluateServerFeatureFlagForOrganization(
      ATTRIBUTION_EVIDENCE_POLICY_SERVER_FLAG,
      organization.clerkId
    );
  } catch (error) {
    log.warn(ATTRIBUTION_EVIDENCE_POLICY_FLAG_UNAVAILABLE_LOG_KEY, {
      level: "warn",
      status: "warn",
      featureFlagKey: ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY,
      organizationId,
      error: parseError(error),
    });
    return null;
  }
}
