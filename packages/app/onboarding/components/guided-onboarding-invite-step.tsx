"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { CheckIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { MultiEmailInviteField } from "../../organizations/components/multi-email-invite-field";
import { formatNumber } from "../../shared/lib/format-utils";
import {
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
  type OnboardingMemberPreview,
  type OnboardingOrganizationMembers,
} from "./guided-onboarding-data";
import {
  GuidedOnboardingBackButton,
  GuidedOnboardingPrimaryPlaceholder,
  GuidedOnboardingStepLayout,
} from "./guided-onboarding-step-layout";
import type { GuidedOnboardingPhaseSource } from "./guided-onboarding-types";

export function GuidedOnboardingInviteStep({
  annotation,
  brand,
  inviteOutcome,
  invitedEmails,
  members,
  onBack,
  onContinue,
  onInvite,
  onSkip,
}: {
  annotation?: ReactNode;
  brand: ReactNode;
  /**
   * What the host's send actually did. When supplied it is AUTHORITATIVE — the
   * local optimistic state below is bypassed entirely rather than merged, so
   * the two can never both drive the confirmation.
   *
   * Omitted, the step keeps its previous behaviour: it announces the send in the
   * same tick it is requested. That path is retained for hosts that do not
   * report an outcome, and is what `guided-onboarding-dialog.test.tsx` pins.
   */
  inviteOutcome?: OnboardingInviteOutcome;
  invitedEmails: readonly string[];
  members: OnboardingOrganizationMembers;
  onBack?: () => void;
  onContinue: () => void;
  onInvite: (emails: readonly string[]) => void;
  onSkip: () => void;
}) {
  // Only a completed lookup may claim existing teammates. An unknown membership
  // shows no roster and makes no count claim (ISS-8678).
  const knownMembers = members.status === "known" ? members : null;
  // The sent state is earned only by this run's send, which names the
  // addresses it invited; nothing to list makes no claim (ISS-11670).
  const invitationsSent = invitedEmails.length > 0;
  const showRoster = Boolean(
    knownMembers && knownMembers.count > 0 && !invitationsSent
  );
  const [sentEmails, setSentEmails] = useState<readonly string[] | null>(null);
  const {
    canContinue,
    composerHidden,
    confirmation,
    pending,
    submissionError,
  } = resolveInviteState(inviteOutcome, sentEmails, invitationsSent);

  return (
    <GuidedOnboardingStepLayout
      annotation={annotation}
      body={
        <>
          {showRoster && knownMembers ? (
            <InviteStepRoster
              count={knownMembers.count}
              preview={knownMembers.preview}
            />
          ) : null}
          {confirmation ? (
            <Alert
              className="mt-7 min-h-48 content-center"
              variant={confirmation.variant}
            >
              {confirmation.variant === "success" ? <CheckIcon /> : null}
              <AlertTitle>{confirmation.title}</AlertTitle>
              <AlertDescription>{confirmation.description}</AlertDescription>
            </Alert>
          ) : null}
          {!confirmation && invitationsSent ? (
            <div className="mt-8 space-y-3 border-y py-5">
              {invitedEmails.map((email) => (
                <div className="flex items-center gap-2 text-sm" key={email}>
                  <CheckIcon className="size-4 text-success" />
                  <span>{email}</span>
                </div>
              ))}
            </div>
          ) : null}
          {composerHidden ? null : (
            <div className="mt-7">
              <MultiEmailInviteField
                onSubmit={(emails) => {
                  // Emit the invite request in the same tick the confirmation
                  // is shown. Deferring it behind a presentation timer let an
                  // unmount cancel the request while "N emails sent" stayed on
                  // screen. Any pacing belongs to the host's `onInvite`.
                  setSentEmails(emails);
                  onInvite(emails);
                }}
                pending={pending}
                submissionError={submissionError}
              />
              <div className="mt-3 flex justify-center">
                <Button
                  className="h-auto px-2 py-1 text-muted-foreground text-xs hover:text-foreground"
                  disabled={pending}
                  onClick={onSkip}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Skip for now
                </Button>
              </div>
            </div>
          )}
        </>
      }
      brand={brand}
      description={getInviteDescription(members, invitationsSent)}
      eyebrow={getInviteEyebrow(members, showRoster, invitationsSent)}
      footer={
        <>
          <GuidedOnboardingBackButton
            className="w-full sm:w-40"
            onBack={onBack}
          />
          {canContinue ? (
            <Button
              className="w-full sm:w-40"
              onClick={onContinue}
              size="lg"
              type="button"
            >
              Continue
            </Button>
          ) : (
            <GuidedOnboardingPrimaryPlaceholder className="w-full sm:w-40" />
          )}
        </>
      }
      title={
        invitationsSent ? "Invitations sent" : "Invite people you build with"
      }
    />
  );
}

/**
 * The invite pitch. Every sentence below states only what the lookup reported:
 * the count sentence needs a completed lookup that found people, and "you're the
 * first" is equally a claim, so it needs a completed lookup that found nobody. A
 * membership that has not reported can support neither and gets the claim-free
 * pitch.
 */
function getInviteDescription(
  members: OnboardingOrganizationMembers,
  invitationsSent: boolean
): string {
  if (invitationsSent) {
    return "Your teammates have been invited. You can invite more people later.";
  }
  if (members.status === "unknown") {
    return INVITE_PITCH_WITHOUT_COUNT;
  }
  if (members.count === 0) {
    return FIRST_MEMBER_INVITE_PITCH;
  }
  const people = members.count === 1 ? "person" : "people";
  return `${formatNumber(members.count)} ${people} at your company already ${members.count === 1 ? "uses" : "use"} Closedloop. Invite anyone missing so your team can learn from the same playbook.`;
}

const INVITE_PITCH_WITHOUT_COUNT =
  "Teams learn agentic coding faster together. Invite people you trust to compare workflows and share what works.";

const FIRST_MEMBER_INVITE_PITCH =
  "You're the first in your company to use Closedloop. Invite your team so you can all build and learn from the same playbook.";

/**
 * The eyebrow is the step's other claim about who is already in the
 * organization, so it is held to the same rule as the pitch: a roster line only
 * once the lookup found people, the first-user line only once it found nobody,
 * and the claim-free line while it has not reported. Once invitations are sent
 * the step is reporting the send rather than the org, so neither claim applies.
 */
function getInviteEyebrow(
  members: OnboardingOrganizationMembers,
  showRoster: boolean,
  invitationsSent: boolean
): string {
  if (showRoster) {
    return "Your team is already here";
  }
  if (!invitationsSent && members.status === "known" && members.count === 0) {
    return "Invite your team";
  }
  return "Build together";
}

/**
 * Everything the step renders about the send itself.
 *
 * A supplied `inviteOutcome` is AUTHORITATIVE: the local optimistic latch is
 * bypassed, not merged, so the two can never both drive the confirmation.
 *
 * `canContinue` is the part that is easy to get wrong. Hiding the composer also
 * hides "Skip for now", which lives inside it, and the footer only offered
 * Continue once invitations were sent. A host that reports a settled send
 * without also reporting sent addresses — which is exactly what a batch that
 * invited nobody looks like — was left with no forward control at all.
 *
 * Continue is offered only after an earned send and "Skip for now" otherwise,
 * as the web-master prototype does (operator ruling 2026-10-05, ISS-11670).
 */
function resolveInviteState(
  inviteOutcome: OnboardingInviteOutcome | undefined,
  sentEmails: readonly string[] | null,
  invitationsSent: boolean
): {
  canContinue: boolean;
  composerHidden: boolean;
  confirmation: InviteConfirmation | null;
  pending: boolean;
  submissionError: string | undefined;
} {
  const confirmation = inviteOutcome
    ? describeInviteOutcome(inviteOutcome)
    : describeOptimisticSend(sentEmails);
  return {
    canContinue: invitationsSent || Boolean(confirmation),
    composerHidden: Boolean(confirmation) || invitationsSent,
    confirmation,
    pending: inviteOutcome?.status === OnboardingInviteStatus.Pending,
    submissionError:
      inviteOutcome?.status === OnboardingInviteStatus.Failed
        ? inviteOutcome.message
        : undefined,
  };
}

/**
 * The confirmation an AUTHORITATIVE outcome earns.
 *
 * `pending` returns null on purpose: the composer stays mounted and reports the
 * in-flight send itself, so nothing here announces a result that has not
 * happened. Every count stated below comes from the server's tally, never from
 * the number of addresses the user typed — reporting the submitted length is
 * what let a batch of five that invited two say "5 emails sent".
 */
function describeInviteOutcome(
  outcome: OnboardingInviteOutcome
): InviteConfirmation | null {
  switch (outcome.status) {
    case OnboardingInviteStatus.Idle:
    case OnboardingInviteStatus.Pending:
    case OnboardingInviteStatus.Failed:
      return null;
    case OnboardingInviteStatus.Sent:
      return {
        description: "Invitations are on their way. Continuing setup.",
        title: `${outcome.invited} ${pluralizeInvitation(outcome.invited)} ${INVITE_SENT_WORD}`,
        variant: "success",
      };
    case OnboardingInviteStatus.Partial:
      return {
        description: describePartial(outcome.alreadyMember, outcome.failed),
        title: `${outcome.invited} ${pluralizeInvitation(outcome.invited)} ${INVITE_SENT_WORD}`,
        variant: "warning",
      };
    case OnboardingInviteStatus.AlreadyMember:
      return {
        description:
          "Everyone you listed is already in your organization or has an invitation waiting.",
        title: "No new invitations needed",
        variant: "info",
      };
    default:
      // A status added to the union without a branch here must fail `tsc`
      // rather than fall through to somebody else's sentence.
      return assertNoUnhandledOutcome(outcome);
  }
}

function assertNoUnhandledOutcome(outcome: never): never {
  throw new Error(
    `Unhandled onboarding invite outcome: ${JSON.stringify(outcome)}`
  );
}

/** The uncontrolled path's confirmation, unchanged from before ISS-8348. */
function describeOptimisticSend(
  sentEmails: readonly string[] | null
): InviteConfirmation | null {
  if (!sentEmails) {
    return null;
  }
  return {
    description: "Invitations are on their way. Continuing setup.",
    title: `${sentEmails.length} ${sentEmails.length === 1 ? "email" : "emails"} ${INVITE_SENT_WORD}`,
    variant: "success",
  };
}

function describePartial(alreadyMember: number, failed: number): string {
  const notes: string[] = [];
  if (alreadyMember > 0) {
    notes.push(`${alreadyMember} already in your organization`);
  }
  if (failed > 0) {
    notes.push(`${failed} could not be sent`);
  }
  // Retry guidance only when something actually failed. Telling someone to
  // re-invite a teammate who is already a member is advice that cannot work.
  const guidance = failed > 0 ? " You can try those again later." : "";
  return `${notes.join(", ")}.${guidance}`;
}

function pluralizeInvitation(count: number): string {
  return count === 1 ? "invitation" : "invitations";
}

type InviteConfirmation = {
  description: string;
  title: string;
  variant: "info" | "success" | "warning";
};

/**
 * The "your team is already here" strip. Extracted so the step itself stays
 * under the cognitive-complexity ceiling once the outcome branches landed.
 */
function InviteStepRoster({
  count,
  preview,
}: {
  count: number;
  preview: readonly OnboardingMemberPreview[];
}) {
  const remaining = count - preview.length;
  return (
    <div className="mt-5 flex flex-wrap items-center gap-2 text-sm">
      {preview.map((member) => (
        <div
          className="flex items-center gap-2 rounded-full border bg-muted/20 py-1.5 pr-3 pl-1.5"
          key={member.id}
        >
          <PersonAvatar
            avatarUrl={member.avatarUrl}
            className="size-7"
            decorative
            fallbackClassName="font-semibold text-xs"
            initials={member.initials}
            name={member.name}
          />
          <span className="font-medium">{member.name}</span>
        </div>
      ))}
      {remaining > 0 ? (
        <span className="text-muted-foreground">
          +{formatNumber(remaining)} more from your company
        </span>
      ) : null}
    </div>
  );
}

export function selectInviteStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingInviteStep> {
  const onContinue = source.onContinueFromInvites ?? source.onComplete;
  return {
    annotation: source.annotations[OnboardingPhase.InviteTeam],
    brand: source.brand,
    inviteOutcome: source.inviteOutcome,
    invitedEmails: source.invitedEmails,
    members: source.members,
    onBack: source.onBack,
    onContinue,
    onInvite: source.onInviteTeam ?? onContinue,
    onSkip: source.onSkipInvites ?? onContinue,
  };
}

/** The word a send confirmation's count title ends on. */
export const INVITE_SENT_WORD = "sent";
