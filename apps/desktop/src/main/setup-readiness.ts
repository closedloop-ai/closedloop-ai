import type { DesktopSettings } from "../shared/contracts.js";
import { normalizeScopePath } from "../shared/sandbox-policy.js";

export type DesktopSetupReadinessInput = Pick<
  DesktopSettings,
  "onboardingCompleted" | "sandboxBaseDirectory"
> & {
  hasApiKey: boolean;
};

/**
 * Returns true when Desktop can accept commands without first-run setup.
 *
 * Existing users may predate the persisted onboarding flag. Treat those
 * profiles as ready when they already have both required runtime inputs:
 * an API key and a scoped workspace directory.
 */
export function isDesktopSetupCompleteFromState(
  input: DesktopSetupReadinessInput
): boolean {
  const sandboxBaseDirectory = normalizeScopePath(input.sandboxBaseDirectory);
  return (
    Boolean(input.onboardingCompleted) ||
    (sandboxBaseDirectory !== null && input.hasApiKey)
  );
}
