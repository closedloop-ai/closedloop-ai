import {
  deriveNavigationActorStanding,
  NavigationActorStanding,
  type NavigationDestinationProjection,
  NavigationDestinationStatus,
  NavigationProjectionStatus,
  type NavigationViewModel,
} from "@repo/api/src/types/navigation-view-model";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";

export type BuildNavigationViewModelInput = {
  /** Internal organization id; null when the actor has no organization. */
  organizationId: string | null;
  /** Clerk organization id; null when the actor has no organization. */
  clerkOrgId: string | null;
  clerkUserId: string;
  destinationIds: readonly string[];
};

/**
 * The tenant-scoped navigation projection (ISS-8377).
 *
 * Deliberately thin about POLICY. It answers the two questions the server is
 * actually the authority on — what is this actor's standing, and can these
 * destinations be used at all — and invents no per-destination permission rules,
 * because which destinations are admin-only is a product decision nobody has
 * made and this service is not the place to make one.
 *
 * What it is NOT thin about is failure, and it reads the MEMBERSHIP ROLE rather
 * than going through the admin gate to get there. `getOrgAdminStatus` answers
 * "is this actor an admin", so it necessarily folds "not a member of this org"
 * and "a member without the admin role" into one `not_admin`. That is the right
 * shape for a gate and the wrong shape here: navigation needs the two apart,
 * because treating a revoked membership as an ordinary member offers every
 * org-scoped destination to someone who has just lost all of them. Reading the
 * role directly keeps `null` (no membership) distinct, and a thrown provider
 * error distinct from both — with no reason-string inventory to fall out of step
 * as new failure modes are added.
 */
async function buildNavigationViewModel({
  clerkOrgId,
  clerkUserId,
  destinationIds,
  organizationId,
}: BuildNavigationViewModelInput): Promise<NavigationViewModel> {
  if (organizationId === null || clerkOrgId === null) {
    // Every destination the shell offers is org-scoped, so with no organization
    // they are genuinely unusable. That is a settled answer, not a failed read,
    // which is why this is `Forbidden` under a `Ready` projection rather than an
    // error the surface would invite the user to retry.
    return forbidAll(destinationIds, {
      organizationId: null,
      standing: NavigationActorStanding.NoOrganization,
    });
  }

  let role: string | null;
  try {
    role = await clerkService.getOrganizationMembershipRole(
      clerkOrgId,
      clerkUserId
    );
  } catch (error) {
    log.error("Failed to resolve Clerk membership role for navigation", {
      clerkOrgId,
      clerkUserId,
      error,
    });
    return {
      projectionStatus: NavigationProjectionStatus.Error,
      standing: NavigationActorStanding.Unknown,
      organizationId,
      destinations: Object.create(null),
    };
  }

  const standing = deriveNavigationActorStanding({ organizationId, role });
  if (standing === NavigationActorStanding.NotAMember) {
    return forbidAll(destinationIds, { organizationId, standing });
  }

  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing,
    organizationId,
    destinations: projectAll(destinationIds, NavigationDestinationStatus.Ready),
  };
}

/** A settled projection in which nothing is usable. */
function forbidAll(
  destinationIds: readonly string[],
  actor: { organizationId: string | null; standing: NavigationActorStanding }
): NavigationViewModel {
  return {
    projectionStatus: NavigationProjectionStatus.Ready,
    standing: actor.standing,
    organizationId: actor.organizationId,
    destinations: projectAll(
      destinationIds,
      NavigationDestinationStatus.Forbidden
    ),
  };
}

/**
 * One status for every requested id. Null-prototype because the ids arrive from
 * the request: a plain object would let `__proto__` reach the prototype instead
 * of adding an own key.
 */
function projectAll(
  destinationIds: readonly string[],
  status: NavigationDestinationStatus
): Record<string, NavigationDestinationProjection> {
  const destinations: Record<string, NavigationDestinationProjection> =
    Object.create(null);
  for (const id of destinationIds) {
    destinations[id] = { status };
  }
  return destinations;
}

/** The single service object routes consume; see `apps/api/AGENTS.md`. */
export const navigationService = { buildNavigationViewModel };
