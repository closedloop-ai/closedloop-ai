/**
 * Tracks the active managed-onboarding continuation so newer user action can
 * cancel stale async work before it writes credentials or settings.
 */
export type ManagedOnboardingRunToken = {
  readonly id: number;
};

/**
 * Small, framework-free run coordinator for Desktop managed onboarding.
 *
 * A token is current only until a newer managed run starts or a manual action
 * cancels automated onboarding. Callers should check the token after awaited
 * work and immediately before durable side effects.
 */
export class ManagedOnboardingRunTracker {
  private currentRunId = 0;

  begin(): ManagedOnboardingRunToken {
    this.currentRunId += 1;
    return { id: this.currentRunId };
  }

  cancel(): void {
    this.currentRunId += 1;
  }

  isCurrent(token: ManagedOnboardingRunToken): boolean {
    return token.id === this.currentRunId;
  }

  isCancelled(
    token: ManagedOnboardingRunToken,
    externallyCancelled = false
  ): boolean {
    return externallyCancelled || !this.isCurrent(token);
  }
}
