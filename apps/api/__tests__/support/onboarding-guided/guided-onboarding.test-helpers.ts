/**
 * @file guided-onboarding.test-helpers.ts
 * @description Narrowers over the guided transition `Result` (ISS-8375), shared
 * by the suites that drive the real service.
 *
 * `Result` is a union, so without these every assertion about a settled
 * transition opens with an `ok` branch that is scaffolding rather than the thing
 * under test. Each narrower THROWS on the wrong branch, so a case that lands on
 * the other one fails loudly instead of asserting nothing.
 */

import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided";
import type {
  GuidedTransitionAcceptance,
  GuidedTransitionRejection,
  GuidedTransitionResult,
} from "@/app/onboarding/guided/transition-service";

/** The acceptance, or a failure naming the status the service refused with. */
export function expectAccepted(
  result: GuidedTransitionResult
): GuidedTransitionAcceptance {
  if (!result.ok) {
    throw new Error(
      `expected an accepted transition, got status ${result.error.status}`
    );
  }
  return result.value;
}

/** The rejection, or a failure naming the outcome the service accepted with. */
export function expectRejected(
  result: GuidedTransitionResult
): GuidedTransitionRejection {
  if (result.ok) {
    throw new Error(
      `expected a rejected transition, got outcome ${result.value.outcome}`
    );
  }
  return result.error;
}

/**
 * The composed snapshot. A `null` is the DELIBERATE "nothing was measured"
 * answer, so a case that wants a snapshot says so here rather than reading
 * fields off an optional chain that quietly evaluates to `undefined`.
 */
export function expectSnapshot(
  settled: GuidedTransitionAcceptance | GuidedTransitionRejection
): GuidedOnboardingSnapshot {
  if (settled.snapshot === null) {
    throw new Error("expected a composed snapshot, got null");
  }
  return settled.snapshot;
}

/**
 * One comparable label per settled command, so a race between two concurrent
 * commands is asserted as a SET without the case caring which call won.
 */
export function settledAs(result: GuidedTransitionResult): string {
  return result.ok ? result.value.outcome : String(result.error.status);
}
