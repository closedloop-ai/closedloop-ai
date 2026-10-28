import { ArtifactSectionOrdering } from "@repo/api/src/types/artifact-group-by-mode";
import {
  evaluateFeatureFlagForAnyIdentity,
  type FeatureFlagIdentity,
} from "@/lib/feature-flag-identity";
import {
  ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
  UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG,
} from "@/lib/feature-flags/server-feature-flags";

const FLAG_LOG_KEY = "assigned_tree.section_ordering.flag_evaluation_failed";

/**
 * ISS-10472 — which section ordering a grouped assigned-tree read is built with.
 *
 * The ONE place `apps/api` decides this. The response NAMES the result rather
 * than the client requesting it: ISS-9437 declined letting a list honor an
 * ordering the client states over the one the server evaluated
 * (`app/branches/branch-status-ordering.ts`), and the same reasoning applies
 * here — a client-stated ordering would slice a page in one order and render it
 * in another.
 *
 * PRECEDENCE MATCHES THE BROWSER's. `useTableViewOrdering` checks root-order
 * first, then universal-status, then falls through to today's order; the two
 * keys are independent in PostHog and both can be on, so the order of these
 * checks is the behavior, not a detail.
 *
 * MUST BE CALLED ABOVE any read snapshot: it awaits a PostHog round trip, and
 * spending a transaction's budget on a flag lookup risks aborting the read it
 * was meant to configure. The section-page service therefore takes a RESOLVED
 * ordering and never an identity.
 *
 * `evaluateFeatureFlagForAnyIdentity` rather than the raw evaluator, because the
 * raw call re-throws a rejected read and would turn a PostHog outage into a 500
 * on the board. An unevaluable flag is simply OFF here, which is the
 * closed-by-default policy's own answer and today's sectioning.
 */
export async function resolveAssignedTreeSectionOrdering(
  identity: FeatureFlagIdentity
): Promise<ArtifactSectionOrdering> {
  const rootOrder = await evaluateFeatureFlagForAnyIdentity(
    ARTIFACT_STATUS_ROOT_ORDER_SERVER_FLAG,
    identity,
    FLAG_LOG_KEY
  );
  if (rootOrder === true) {
    return ArtifactSectionOrdering.RootFirst;
  }
  const universalStatus = await evaluateFeatureFlagForAnyIdentity(
    UNIVERSAL_ARTIFACT_STATUS_SERVER_FLAG,
    identity,
    FLAG_LOG_KEY
  );
  if (universalStatus === true) {
    return ArtifactSectionOrdering.Retained;
  }
  return ArtifactSectionOrdering.Vocabulary;
}
