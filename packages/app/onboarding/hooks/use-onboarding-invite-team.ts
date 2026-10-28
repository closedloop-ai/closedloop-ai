"use client";

import {
  InviteMemberStatus,
  OrgInviteRole,
} from "@repo/api/src/types/onboarding";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
// Cross-slice by design: the invitation mutation is owned by the organizations
// slice and already mints real Clerk invitations; onboarding drives it rather
// than opening a second write path.
import { useInviteMembers } from "../../organizations/hooks/use-organizations";
import {
  IDLE_INVITE_OUTCOME,
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
} from "../components/guided-onboarding-data";
import {
  failedInviteOutcome,
  foldInviteOutcome,
} from "../lib/onboarding-invite-outcome";

/**
 * Drive the onboarding invite phase against the real invitation route and
 * report what it actually did (ISS-8348).
 *
 * The step it feeds used to claim "N emails sent" the instant the request left,
 * with N being the number of addresses TYPED. Both halves could be wrong: the
 * request can fail, and a 200 can report that several of those addresses were
 * already members. The outcome returned here carries the server's own counts so
 * the confirmation states what happened rather than what was asked for.
 *
 * `invitedEmails` is every address a send from this hook actually invited —
 * the rows the server reported `invited`, never the addresses typed — so a
 * send made elsewhere (settings, an earlier run) can never stand in for one
 * made here (ISS-11670). Both it and `outcome` belong to `identity`: Desktop
 * keeps the host mounted across sign-out and organization switches, so a
 * change of identity drops them, and a send that answers after the identity
 * changed is discarded rather than credited to the next account.
 */
export function useOnboardingInviteTeam(identity: string | null): {
  invite: (emails: readonly string[]) => Promise<void>;
  invitedEmails: readonly string[];
  outcome: OnboardingInviteOutcome;
} {
  const inviteMembers = useInviteMembers();
  const [evidence, setEvidence] = useState<InviteEvidence>(() =>
    emptyInviteEvidence(identity)
  );
  const identityRef = useRef(identity);
  useLayoutEffect(() => {
    identityRef.current = identity;
    setEvidence((current) =>
      current.identity === identity ? current : emptyInviteEvidence(identity)
    );
  }, [identity]);

  const invite = useCallback(
    async (emails: readonly string[]) => {
      const sentFor = identity;
      const record = (
        update: (current: InviteEvidence) => InviteEvidence
      ): void => {
        if (identityRef.current !== sentFor) {
          return;
        }
        setEvidence((current) =>
          update(
            current.identity === sentFor
              ? current
              : emptyInviteEvidence(sentFor)
          )
        );
      };
      record((current) => ({ ...current, outcome: PENDING_INVITE_OUTCOME }));
      try {
        const response = await inviteMembers.mutateAsync({
          emailAddresses: [...emails],
          role: OrgInviteRole.Member,
        });
        const outcomeOfSend = foldInviteOutcome(response);
        const invitedNow =
          outcomeOfSend.status === OnboardingInviteStatus.Sent ||
          outcomeOfSend.status === OnboardingInviteStatus.Partial
            ? (response.results ?? [])
                .filter(
                  (result) => result.status === InviteMemberStatus.Invited
                )
                .map((result) => result.email)
            : [];
        record((current) => ({
          ...current,
          invitedEmails: [
            ...new Set([...current.invitedEmails, ...invitedNow]),
          ],
          outcome: outcomeOfSend,
        }));
      } catch (error) {
        // Caught to classify, not to swallow: `useInviteMembers` opts out of the
        // global mutation error toast precisely so its callers own this.
        record((current) => ({
          ...current,
          outcome: failedInviteOutcome(
            error instanceof Error ? error.message : undefined
          ),
        }));
      }
    },
    [identity, inviteMembers]
  );

  const current =
    evidence.identity === identity ? evidence : NO_INVITE_EVIDENCE;
  return {
    invite,
    invitedEmails: current.invitedEmails,
    outcome: current.outcome,
  };
}

const PENDING_INVITE_OUTCOME: OnboardingInviteOutcome = {
  status: OnboardingInviteStatus.Pending,
};

type InviteEvidence = {
  identity: string | null;
  invitedEmails: readonly string[];
  outcome: OnboardingInviteOutcome;
};

const NO_INVITE_EVIDENCE: InviteEvidence = {
  identity: null,
  invitedEmails: [],
  outcome: IDLE_INVITE_OUTCOME,
};

function emptyInviteEvidence(identity: string | null): InviteEvidence {
  return { ...NO_INVITE_EVIDENCE, identity };
}
