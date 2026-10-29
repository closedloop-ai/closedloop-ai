import { isAttributionEvidenceEnabledForOrganization } from "../lib/attribution-evidence-policy-feature";

/**
 * ISS-12552 (PRD-800 "Rollout"): the attribution backfill and the
 * comparison report run for named organizations whose ring has
 * `attribution-evidence-policy` on. Throws before the script reads anything
 * else when no organization is named, and when the flag is off for any of
 * them.
 */
export async function assertAttributionEvidenceOnForOrganizations(
  organizationIds: readonly string[]
): Promise<void> {
  if (organizationIds.length === 0) {
    throw new Error(
      "--org <organization id> is required: attribution-evidence-policy is rolled out by organization"
    );
  }
  for (const organizationId of organizationIds) {
    if (!(await isAttributionEvidenceEnabledForOrganization(organizationId))) {
      throw new Error(
        `attribution-evidence-policy is off for organization ${organizationId}; turn its ring on first`
      );
    }
  }
}
