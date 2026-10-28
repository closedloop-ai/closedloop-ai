import type { ManagedOnboardingController } from "../onboarding/managed-onboarding-controller.js";
import type { DesktopSessionManager } from "./desktop-session-manager.js";
import type { SignOutLoopCleanup } from "./sign-out-loop-cleanup.js";

/** Invalidates auth and starts the one app-owned durable cleanup transaction. */
export function coordinateDesktopSignOut(
  manager: DesktopSessionManager,
  onboarding: ManagedOnboardingController,
  cleanup: SignOutLoopCleanup
): Promise<void> {
  onboarding.cancelManagedOnboardingForUserChange("desktop sign-out started");
  const signOut = manager.signOut();
  const localCleanup = cleanup.run();
  return Promise.all([signOut, localCleanup]).then(() => undefined);
}
