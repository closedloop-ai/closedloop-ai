import "server-only";

import { ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY } from "@repo/api/src/types/attribution-evidence-policy-flag";
import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { evaluateAttributionEvidenceForOrganization } from "@/lib/attribution-evidence-policy-feature";
import { getAllFeatureFlagsForAnyIdentity } from "@/lib/feature-flag-identity";
import { evaluateServerFeatureFlagForDistinctId } from "@/lib/feature-flags/server-feature-flag-evaluation";
import { DESKTOP_SESSION_REPLAY_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/** Structured-log event emitted when a distinct id's assignment read throws. */
const DESKTOP_FEATURE_FLAG_EVALUATION_FAILED =
  "desktop_feature_flag_evaluation_failed";

type DesktopFeatureFlagsServiceInput = {
  userId: string;
  clerkUserId: string | null;
  /** The account's organization, for flags evaluated per organization. */
  organizationId: string;
};

/**
 * ISS-8024: resolves the signed-in desktop user's PostHog assignment so the
 * desktop shell can gate on the SAME per-user flags the web app resolves,
 * instead of a parallel registry of local Labs toggles kept in sync by hand.
 *
 * Evaluated through {@link getAllFeatureFlagsForAnyIdentity}, the canonical
 * server-side identity resolver, so the distinct ids and their precedence match
 * every other server-side flag check in this app rather than being re-derived
 * here.
 *
 * UNAVAILABLE is reported as `resolved: false` with an empty assignment, never
 * as an assignment of all-`false`. Both render closed on the client — that is
 * the ISS-4779 posture and it is not negotiable — but a flag service outage must
 * not be indistinguishable from "this user is in no rollouts", because the
 * client's no-flash gate reads that difference.
 */
export const desktopFeatureFlagsService = {
  async get(
    input: DesktopFeatureFlagsServiceInput
  ): Promise<DesktopFeatureFlagAssignment> {
    const [flags, attributionEvidence] = await Promise.all([
      getAllFeatureFlagsForAnyIdentity(
        { userId: input.userId, clerkUserId: input.clerkUserId },
        DESKTOP_FEATURE_FLAG_EVALUATION_FAILED
      ),
      evaluateAttributionEvidenceForOrganization(input.organizationId),
    ]);
    if (!flags) {
      return { userId: input.userId, resolved: false, flags: {} };
    }
    return {
      userId: input.userId,
      resolved: true,
      flags: withOrganizationAttributionVerdict(flags, attributionEvidence),
      ...(attributionEvidence === null
        ? {}
        : { organizationEvaluated: [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY] }),
    };
  },

  /**
   * ISS-11945 (ISS-11866 D4): a signed-out install's assignment, evaluated for
   * `distinct_id = node_uuid`. Reads the one allow-listed key by name and never
   * the whole assignment, so no other flag and no payload can reach an
   * unauthenticated caller. Same UNAVAILABLE posture as {@link get}.
   */
  async getAnonymous(nodeUuid: string): Promise<DesktopFeatureFlagAssignment> {
    const enabled = await evaluateServerFeatureFlagForDistinctId(
      DESKTOP_SESSION_REPLAY_SERVER_FLAG,
      nodeUuid
    );
    if (enabled === null) {
      return { userId: nodeUuid, resolved: false, flags: {} };
    }
    return {
      userId: nodeUuid,
      resolved: true,
      flags: { [DESKTOP_SESSION_REPLAY_SERVER_FLAG.key]: enabled },
    };
  },
};

/**
 * ISS-12552 (PRD-800 "Rollout"): attribution-evidence-policy is a company
 * group flag, so the per-person evaluation above reads it as off for every
 * account. The account's organization answers it instead, the same answer the
 * server's own reads use. An organization PostHog could not answer for omits
 * the key, which Desktop reads as no answer and holds its last verdict, rather
 * than as off. Additive: a Desktop that predates the key ignores it.
 */
function withOrganizationAttributionVerdict(
  flags: Record<string, boolean>,
  verdict: boolean | null
): Record<string, boolean> {
  const { [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: _perPerson, ...rest } = flags;
  return verdict === null
    ? rest
    : { ...rest, [ATTRIBUTION_EVIDENCE_POLICY_FLAG_KEY]: verdict };
}
