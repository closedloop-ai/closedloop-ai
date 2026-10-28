import type { DesktopAvailabilityNotifyCopy } from "@repo/app/onboarding/components/desktop-availability-notify-form"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).
import type { DesktopOs } from "@repo/app/onboarding/lib/desktop-platform-availability"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).

/**
 * ISS-12364's copy slots, pending Kaito/Ottilie. It lives in the prototype, not
 * the shared component, which takes every word as a required prop, so
 * production cannot pick any of it up until someone approves it.
 *
 * The call to action is the ticket's own suggested message (ISS-12364
 * description, "Design scope"). Every other string is a neutral placeholder
 * named after its slot, allowed by operator ruling (Nerys, 2026-10-15),
 * ISS-12526 thread th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the
 * wording.
 *
 * Keyed by platform because the form only renders for a platform with no
 * published installer, and its call to action names that platform. Only
 * Windows can reach it today; the macOS and Linux entries are unreachable
 * while both installers are published, and are placeholders so the record
 * stays exhaustive.
 */
const SHARED_SLOTS = {
  emailLabel: "Placeholder: email field label",
  explanation: "Placeholder: what submitting does (no release date)",
  failure: "Placeholder: request failed, try again",
  invalidEmail: "Placeholder: not a valid email address",
  retryLabel: "Placeholder: retry button",
  submittingLabel: "Placeholder: submitting button",
  successDetail: "Placeholder: what happens next",
  successTitle: "Placeholder: request received",
} as const;

export const DESKTOP_AVAILABILITY_NOTIFY_PROPOSED_COPY = {
  linux: {
    ...SHARED_SLOTS,
    submitLabel: "Placeholder: notify me for Linux",
  },
  mac: {
    ...SHARED_SLOTS,
    submitLabel: "Placeholder: notify me for macOS",
  },
  windows: {
    ...SHARED_SLOTS,
    submitLabel: "Notify me when the Windows app is available",
  },
} as const satisfies Record<DesktopOs, DesktopAvailabilityNotifyCopy>;
