"use client";

import { DesktopAvailabilityNotifyForm } from "@repo/app/onboarding/components/desktop-availability-notify-form"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { GuidedOnboardingDialogProps } from "@repo/app/onboarding/components/guided-onboarding-types"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import {
  DesktopOs,
  type DesktopOs as DesktopOsValue,
} from "@repo/app/onboarding/lib/desktop-platform-availability"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import { DESKTOP_AVAILABILITY_NOTIFY_PROPOSED_COPY } from "./desktop-availability-notify-copy";
import { PrototypePlatform } from "./prototype-developer-menu";

/** How long the mock request stays in flight, so the busy state is visible. */
const MOCK_REQUEST_MS = 1200;

/**
 * ISS-12364: the download step's "notify me" email capture, wired to a mock
 * request because no waitlist endpoint exists. The developer menu's Platform
 * row picks what platform the step shows, so a designer on a Mac can see the
 * Windows variant, and whether the mock request succeeds or fails.
 *
 * `Detected` passes no override, so the step reads the browser's own,
 * exactly as production does.
 *
 * The shell holds the recorded address (`submittedEmail`, set through
 * `onSubmitted` when the mock request resolves), so a reader who goes Back and
 * returns to the step sees the confirmation, not the form again.
 */
export function desktopAvailabilityNotifyPreview({
  email,
  onSubmitted,
  platform,
  submittedEmail,
}: {
  email: string | undefined;
  onSubmitted: (email: string) => void;
  platform: PrototypePlatform;
  submittedEmail: string | undefined;
}): Pick<
  GuidedOnboardingDialogProps,
  "installerGapFollowUp" | "platformOverride"
> {
  const fails = platform === PrototypePlatform.WindowsRequestFails;
  return {
    platformOverride:
      platform === PrototypePlatform.Detected ? undefined : DesktopOs.Windows,
    installerGapFollowUp: (os: DesktopOsValue) => (
      <DesktopAvailabilityNotifyForm
        copy={DESKTOP_AVAILABILITY_NOTIFY_PROPOSED_COPY[os]}
        defaultEmail={email}
        // Remounted per variant so switching platforms starts from the
        // initial state rather than a previous success.
        key={platform}
        onSubmit={(address) =>
          new Promise<void>((resolve, reject) => {
            globalThis.window.setTimeout(() => {
              if (fails) {
                reject(new Error("Prototype: mock request failed"));
                return;
              }
              onSubmitted(address);
              resolve();
            }, MOCK_REQUEST_MS);
          })
        }
        submittedEmail={submittedEmail}
      />
    ),
  };
}
