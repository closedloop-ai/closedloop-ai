/** Shared state builders for the onboarding machine's transition suites. */

import type { OnboardingEventInput } from "@repo/api/src/types/onboarding-events";
import type {
  OnboardingContext,
  OnboardingMachineState,
  OnboardingPhase,
} from "@repo/api/src/types/onboarding-phase";
import { buildOnboardingContext } from "../guided-onboarding-fixtures";
import { transitionOnboarding } from "../onboarding-transitions";

export function context(
  overrides: Partial<OnboardingContext> = {}
): OnboardingContext {
  return buildOnboardingContext(overrides);
}

export function stateAt(
  phase: OnboardingPhase,
  overrides: Partial<OnboardingMachineState> = {}
): OnboardingMachineState {
  return {
    phase,
    history: [],
    accountProvider: null,
    resuming: false,
    organizationEstablished: false,
    ...overrides,
  };
}

export function move(
  state: OnboardingMachineState,
  event: OnboardingEventInput,
  ctx: OnboardingContext
): OnboardingMachineState {
  const result = transitionOnboarding(state, event, ctx);
  if (result.status !== "moved") {
    throw new Error(`expected a move, got rejection: ${result.reason}`);
  }
  return result.state;
}
