"use client";

import { useState } from "react";
import type {
  OnboardingJoinAuthority,
  OnboardingOrganizationJoin,
} from "../components/guided-onboarding-data";
import { OnboardingJoinAuthority as JoinAuthority } from "../components/guided-onboarding-data";

/**
 * What a failed join says, per authority, because the two fail for different
 * reasons and the remedy differs: an invitation can have been revoked or expired
 * and needs a new one, while a membership that will not activate is the reader's
 * to retry. An exhaustive `Record` so a third authority cannot be added without
 * deciding what its failure tells the reader.
 */
const ORGANIZATION_JOIN_FAILED_MESSAGE: Record<
  OnboardingJoinAuthority,
  string
> = {
  [JoinAuthority.Invitation]:
    "We couldn't accept that invitation. It may have been revoked or expired — ask an admin to send a new one, or create an organization below.",
  [JoinAuthority.Membership]:
    "We couldn't switch you into that organization. Please try again.",
};

const ORGANIZATION_JOIN_UNAVAILABLE_MESSAGE =
  "Joining isn't available here yet. Open the web app to join, then return to onboarding.";

/**
 * Drives the Choose-organization step's Join affordance (ISS-11145).
 *
 * The provider call happens FIRST and `onJoined` runs only once it resolves, so
 * the run never moves past the phase on a join that did not happen — a button
 * labelled "Join" that merely advanced would be a control reporting work it did
 * not do. A failure states itself and leaves the phase where it is; it is never
 * folded back into the lookup's empty or pending arm, which would answer a
 * question about the ACTION with one about the READ.
 *
 * `join` is undefined when the surface cannot honor a join at all, and the step
 * offers no Join button in that case rather than one that does nothing.
 */
export function useOnboardingOrganizationJoin({
  canPost,
  onJoinOrganization,
  onJoined,
}: {
  /** Whether the run has the snapshot a transition would be posted against. */
  canPost: boolean;
  onJoinOrganization?: (
    join: OnboardingOrganizationJoin
  ) => Promise<void> | void;
  onJoined: () => void;
}): {
  error: string | null;
  join?: (target: OnboardingOrganizationJoin) => void;
  joining: boolean;
} {
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!onJoinOrganization) {
    return { error, joining };
  }

  return { error, join: performJoin, joining };

  function performJoin(target: OnboardingOrganizationJoin) {
    if (!(canPost && onJoinOrganization)) {
      setError(ORGANIZATION_JOIN_UNAVAILABLE_MESSAGE);
      return;
    }
    setError(null);
    setJoining(true);
    Promise.resolve(onJoinOrganization(target))
      .then(() => {
        setJoining(false);
        onJoined();
      })
      .catch(() => {
        setJoining(false);
        setError(ORGANIZATION_JOIN_FAILED_MESSAGE[target.authority]);
      });
  }
}
