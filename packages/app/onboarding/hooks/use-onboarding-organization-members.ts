"use client";

import type { User } from "@repo/api/src/types/user";
// Cross-slice by design: the organization roster is owned by the users slice,
// and onboarding consumes its query rather than opening a second read of the
// same endpoint.
import {
  useCurrentUser,
  useOrganizationUsers,
} from "../../users/hooks/use-users";
import type { OnboardingOrganizationMembers } from "../components/guided-onboarding-data";
import {
  foldOnboardingOrganizationMembers,
  type OnboardingRosterRead,
} from "../lib/onboarding-organization-members";

/**
 * The invite step's existing-teammate claim, sourced from the real organization
 * roster (`GET /users`) instead of a fixture (ISS-8348).
 *
 * `enabled` defaults to `false`. The wizard mounts at `welcome` and this data is
 * needed at `invite-team`, so an always-on fetch would pull the whole roster on
 * every first-run mount for a screen most sessions reach much later — the
 * on-mount fetching `packages/app/AGENTS.md` asks callers to gate.
 *
 * Only a RESOLVED roster read plus a RESOLVED signer can produce a `known`
 * value; everything else is `unknown`. See
 * {@link foldOnboardingOrganizationMembers} for why an empty roster is
 * `unknown` rather than a count of zero.
 */
export function useOnboardingOrganizationMembers(options?: {
  enabled?: boolean;
}): OnboardingOrganizationMembers {
  const enabled = options?.enabled ?? false;
  const roster = useOrganizationUsers({ enabled });
  const currentUser = useCurrentUser({ enabled });

  return foldOnboardingOrganizationMembers(
    toRosterRead(roster.data, roster.isError, enabled),
    currentUser.data?.id ?? null
  );
}

/**
 * Adapt the query onto the fold's settled/unsettled shape.
 *
 * `isPending` is deliberately not the gate. React Query reports a DISABLED
 * query as pending indefinitely, and it keeps serving cached rows while a
 * background refetch runs — so branching on it would call a gated query
 * "loading" and a refetching one "unresolved". Presence of `data` is what
 * distinguishes a settled read.
 *
 * `classifyDirectory` (documents/.../activity-directory.ts) reaches the same
 * ready-vs-not-ready answer for this endpoint, but it is NOT the same
 * predicate: it reads `fetchStatus` to keep Pending separate from Unavailable,
 * which it needs and this consumer does not — both collapse to `unknown` here.
 */
function toRosterRead(
  users: User[] | undefined,
  isError: boolean,
  enabled: boolean
): OnboardingRosterRead {
  if (!enabled || isError || users === undefined) {
    return { status: "unresolved" };
  }
  return { status: "resolved", users };
}
