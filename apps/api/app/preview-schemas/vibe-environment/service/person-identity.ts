import "server-only";

import { isOrgAdminRole } from "@repo/api/src/types/org-admin-role";
import { parseError } from "@repo/observability/error";
import { log } from "@repo/observability/log";
import { clerkService } from "@/lib/auth/clerk-service";
import {
  VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
  VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
  VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
  VibeEnvironmentOrgChoice,
} from "../constants";

/**
 * ISS-12056: the stage Clerk identity a seeded vibe environment is bound to.
 * The skill knows the person's email, not their Clerk ids, so this resolves
 * them here with the stage Clerk secret the API already holds. Read-only: it
 * never changes anything in Clerk.
 */

export type PersonClerkIdentity = {
  clerkUserId: string;
  clerkOrgId: string;
  /** ISS-12135 bug 47: that org's name, for the finalize result. */
  clerkOrgName: string;
  /** Their Clerk role in that org is an admin role. */
  isOrgAdmin: boolean;
  /** ISS-12135: why this org, for the run's log. */
  chosenBy: VibeEnvironmentOrgChoice;
};

/** A stage Clerk org the person belongs to, as a refusal reports it. */
export type PersonClerkOrg = {
  id: string;
  name: string;
  /** ISS-12135 bug 42: whether their role there is an admin role. */
  isAdmin: boolean;
};

export type PersonIdentityRefusal = {
  refused: string;
  /** The failure `code` the route answers with, when the skill can act on it. */
  code?: string;
  /**
   * The orgs that code is about, by name and id, so the skill can ask the
   * person which one by name (or tell them they admin none).
   */
  clerkOrgs?: PersonClerkOrg[];
};

export type ClerkMembership = {
  clerkOrgId: string;
  name: string;
  role: string;
};

export type ClerkLookup = {
  findUserIdsByEmail: (email: string) => Promise<string[]>;
  listMemberships: (userId: string) => Promise<ClerkMembership[]>;
  /** ISS-12135: `undefined` when no session had an org active; may throw. */
  lastActiveOrgId: (userId: string) => Promise<string | undefined>;
};

/**
 * The person's one stage Clerk user, and the org to bind: `requestedOrgId`
 * when given and they belong to it, otherwise their only org, otherwise (Daveth
 * Oakhurst's rule, ISS-12135) their only admin org, otherwise the org their Clerk
 * session last had active when they administer it. `boundOrgIds` (the Clerk
 * orgs an existing environment already holds) settles it first, so a later
 * request lands in the org finalize bound. Anything else is refused
 * with the reason, never guessed. With `requireAdmin` (a seeded environment is
 * bound to an org the person administers), an org where they are not an admin
 * is refused, and only their admin orgs are offered as choices (ISS-12135 bug
 * 42).
 */
export async function resolvePersonClerkIdentity(
  email: string,
  requestedOrgId: string | undefined,
  lookup: ClerkLookup = clerkLookup,
  options: { requireAdmin?: boolean; boundOrgIds?: readonly string[] } = {}
): Promise<PersonClerkIdentity | PersonIdentityRefusal> {
  const userIds = await lookup.findUserIdsByEmail(email);
  if (userIds.length !== 1) {
    return {
      refused:
        userIds.length === 0
          ? "No stage Clerk user has that email; sign in to the stage app once first"
          : "More than one stage Clerk user has that email",
    };
  }
  const [clerkUserId] = userIds;
  const memberships = await lookup.listMemberships(clerkUserId);
  const requireAdmin = options.requireAdmin === true;
  const chosen =
    requestedOrgId === undefined
      ? await chooseUnrequestedMembership(
          memberships,
          requireAdmin,
          () => readLastActiveOrgId(lookup, clerkUserId),
          options.boundOrgIds
        )
      : chooseRequestedMembership(memberships, requestedOrgId, requireAdmin);
  if ("refused" in chosen) {
    return chosen;
  }
  const { membership, chosenBy } = chosen;
  return {
    clerkUserId,
    clerkOrgId: membership.clerkOrgId,
    clerkOrgName: membership.name,
    isOrgAdmin: isOrgAdminRole(membership.role),
    chosenBy,
  };
}

type ChosenMembership = {
  membership: ClerkMembership;
  chosenBy: VibeEnvironmentOrgChoice;
};

/** Why the last active org could not settle the choice, for the refusal. */
type LastActiveRead = { orgId: string } | { missing: string };

function chooseRequestedMembership(
  memberships: ClerkMembership[],
  requestedOrgId: string,
  requireAdmin: boolean
): ChosenMembership | PersonIdentityRefusal {
  const match = memberships.find((m) => m.clerkOrgId === requestedOrgId);
  if (!match) {
    return {
      refused: "The person is not a member of the requested Clerk org",
    };
  }
  if (requireAdmin && !isOrgAdminRole(match.role)) {
    return {
      refused: `The person is not an admin of Clerk org ${match.name} (${match.clerkOrgId})`,
      code: VIBE_ENVIRONMENT_CLERK_ORG_NOT_ADMIN,
      clerkOrgs: memberships.map(toPersonClerkOrg),
    };
  }
  return { membership: match, chosenBy: VibeEnvironmentOrgChoice.Requested };
}

/**
 * The last active org is read only when it is needed (two or more admin
 * orgs), and counts only when it is one of those admin orgs.
 */
async function chooseUnrequestedMembership(
  memberships: ClerkMembership[],
  requireAdmin: boolean,
  readLastActive: () => Promise<LastActiveRead>,
  boundOrgIds: readonly string[] | undefined
): Promise<ChosenMembership | PersonIdentityRefusal> {
  if (memberships.length === 0) {
    return {
      refused:
        "The person belongs to no stage Clerk org; create one in the stage app first",
    };
  }
  const admins = memberships.filter((m) => isOrgAdminRole(m.role));
  if (requireAdmin && admins.length === 0) {
    return {
      refused: `The person is not an admin of any of their ${memberships.length} stage Clerk orgs: ${memberships.map((m) => `${m.name} (${m.clerkOrgId})`).join(", ")}`,
      code: VIBE_ENVIRONMENT_CLERK_ORG_NO_ADMIN,
      clerkOrgs: memberships.map(toPersonClerkOrg),
    };
  }
  const settled = settleWithoutLastActive(memberships, admins, boundOrgIds);
  if (settled) {
    return settled;
  }
  let lastActiveNote = "";
  if (admins.length > 1) {
    const lastActive = await chooseLastActive(admins, readLastActive);
    if ("membership" in lastActive) {
      return lastActive;
    }
    lastActiveNote = `, and ${lastActive.note}`;
  }
  const candidates = requireAdmin ? admins : memberships;
  const adminOf = requireAdmin
    ? ` and is an admin of ${candidates.length} of them`
    : "";
  return {
    refused: `The person belongs to ${memberships.length} stage Clerk orgs${adminOf}${lastActiveNote}; pass clerk_org_id to choose one`,
    code: VIBE_ENVIRONMENT_CLERK_ORG_AMBIGUOUS,
    clerkOrgs: candidates.map(toPersonClerkOrg),
  };
}

const clerkLookup: ClerkLookup = {
  findUserIdsByEmail: (email) => clerkService.findUserIdsByEmail(email),
  async listMemberships(userId) {
    const memberships =
      await clerkService.listUserOrganizationMemberships(userId);
    return memberships.map((membership) => ({
      clerkOrgId: membership.organizationId,
      name: membership.organizationName,
      role: membership.role,
    }));
  },
  lastActiveOrgId: (userId) => clerkService.getLastActiveOrganizationId(userId),
};

function toPersonClerkOrg(membership: ClerkMembership): PersonClerkOrg {
  return {
    id: membership.clerkOrgId,
    name: membership.name,
    isAdmin: isOrgAdminRole(membership.role),
  };
}

/** A Clerk failure here falls back to asking, so it never fails the request. */
async function readLastActiveOrgId(
  lookup: ClerkLookup,
  clerkUserId: string
): Promise<LastActiveRead> {
  try {
    const orgId = await lookup.lastActiveOrgId(clerkUserId);
    return orgId === undefined
      ? { missing: "their Clerk sessions have no last active org" }
      : { orgId };
  } catch (error) {
    log.warn("[vibe-environment] Could not read the last active Clerk org", {
      clerkUserId,
      error: parseError(error),
    });
    return { missing: "their last active Clerk org could not be read" };
  }
}

/** The choices that need no Clerk read beyond the memberships. */
function settleWithoutLastActive(
  memberships: ClerkMembership[],
  admins: ClerkMembership[],
  boundOrgIds: readonly string[] | undefined
): ChosenMembership | undefined {
  const bound = memberships.filter((m) => boundOrgIds?.includes(m.clerkOrgId));
  if (bound.length === 1) {
    return {
      membership: bound[0],
      chosenBy: VibeEnvironmentOrgChoice.AlreadyBound,
    };
  }
  if (memberships.length === 1) {
    return {
      membership: memberships[0],
      chosenBy: VibeEnvironmentOrgChoice.OnlyOrg,
    };
  }
  if (admins.length === 1) {
    return {
      membership: admins[0],
      chosenBy: VibeEnvironmentOrgChoice.OnlyAdminOrg,
    };
  }
  return undefined;
}

async function chooseLastActive(
  admins: ClerkMembership[],
  readLastActive: () => Promise<LastActiveRead>
): Promise<ChosenMembership | { note: string }> {
  const lastActive = await readLastActive();
  if ("missing" in lastActive) {
    return { note: lastActive.missing };
  }
  const match = admins.find((m) => m.clerkOrgId === lastActive.orgId);
  if (match) {
    return { membership: match, chosenBy: VibeEnvironmentOrgChoice.LastActive };
  }
  return {
    note: `their last active Clerk org ${lastActive.orgId} is not one they administer`,
  };
}
