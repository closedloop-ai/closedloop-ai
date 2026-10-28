"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  IDLE_INVITE_OUTCOME,
  type OnboardingInviteOutcome,
  OnboardingInviteStatus,
} from "../components/guided-onboarding-data";

/**
 * The send outcome the invite step is shown, and the paced advance after a
 * clean send.
 *
 * Operator ruling 2026-10-05 (ISS-11670): the web-master prototype
 * (`apps/prototypes/app/p/web-master`, `use-web-master-onboarding-controller.ts`
 * `onInviteTeam`) is the spec for this step. There a send shows its
 * confirmation for a beat and then advances on its own — the confirmation's
 * "Continuing setup." — and a return to the step shows the invited addresses
 * rather than the confirmation, because the step remounts without it.
 *
 * So: a `sent` outcome advances after the prototype's beat while the step is
 * active, and a settled outcome the user has since left is no longer presented.
 * Only the presentation is retired; `outcome` itself is untouched for callers
 * that report it.
 *
 * The phase only changes once the server answers, so the step stays on screen
 * after a way off it has been taken. `leave` is every such way — Continue, the
 * paced advance, Skip, and Back (the prototype's `cancelInviteAdvance`): it refuses
 * while another is in flight, so no second transition is posted against the
 * same revision, and it stops the paced advance for the outcome on screen. A
 * newer outcome, such as a fresh send after a failed transition, paces again.
 */
export function useOnboardingInviteStepOutcome({
  active,
  onAdvance,
  outcome,
}: {
  active: boolean;
  onAdvance: (onSettled: () => void) => void;
  outcome: OnboardingInviteOutcome;
}): {
  advance: () => void;
  isLeaving: () => boolean;
  leave: (post: (onSettled: () => void) => void) => void;
  stepOutcome: OnboardingInviteOutcome;
} {
  const [leftOutcome, setLeftOutcome] =
    useState<OnboardingInviteOutcome | null>(null);
  const [pacedOffFor, setPacedOffFor] =
    useState<OnboardingInviteOutcome | null>(null);
  const [leaving, setLeaving] = useState(false);
  const leavingRef = useRef(false);
  const outcomeRef = useRef(outcome);
  const onAdvanceRef = useRef(onAdvance);
  useEffect(() => {
    onAdvanceRef.current = onAdvance;
    outcomeRef.current = outcome;
  });

  useEffect(() => {
    if (active) {
      return;
    }
    leavingRef.current = false;
    setLeaving(false);
    if (RETIRED_ON_LEAVE.has(outcome.status)) {
      setLeftOutcome(outcome);
    }
  }, [active, outcome]);

  const left = leftOutcome === outcome;

  const leave = useCallback((post: (onSettled: () => void) => void) => {
    if (leavingRef.current) {
      return;
    }
    leavingRef.current = true;
    setLeaving(true);
    setPacedOffFor(outcomeRef.current);
    post(() => {
      leavingRef.current = false;
      setLeaving(false);
    });
  }, []);

  const advance = useCallback(
    () => leave((onSettled) => onAdvanceRef.current(onSettled)),
    [leave]
  );

  useEffect(() => {
    if (
      !active ||
      left ||
      leaving ||
      pacedOffFor === outcome ||
      outcome.status !== OnboardingInviteStatus.Sent
    ) {
      return;
    }
    const timer = setTimeout(advance, INVITE_CONFIRMATION_DURATION_MS);
    return () => clearTimeout(timer);
  }, [active, advance, leaving, left, outcome, pacedOffFor]);

  return {
    advance,
    isLeaving: () => leavingRef.current,
    leave,
    stepOutcome: left ? IDLE_INVITE_OUTCOME : outcome,
  };
}

/** The prototype's `INVITE_CONFIRMATION_DURATION_MS` (ISS-11670 ruling). */
export const INVITE_CONFIRMATION_DURATION_MS = 1200;

const RETIRED_ON_LEAVE: ReadonlySet<OnboardingInviteStatus> = new Set([
  OnboardingInviteStatus.Sent,
  OnboardingInviteStatus.Partial,
  OnboardingInviteStatus.AlreadyMember,
]);
