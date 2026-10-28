import type {
  SetupGateStepListCopy,
  SyncPolicyGateNoticeCopy,
} from "@repo/app/onboarding/components/setup-gate-steps"; // Cross-slice: preview shell runs the real onboarding flow (ISS-12938).

/**
 * ISS-12363's PROPOSED wording, pending Kaito/Ottilie review. It lives in the
 * prototype, not in the shared components, because none of it has a product
 * ruling yet: the components take it as a required prop, so production cannot
 * pick these words up until someone approves them.
 */
export const SETUP_GATE_PROPOSED_COPY = {
  downloaded: "Desktop downloaded. One more step: choose what syncs.",
  explanation:
    "Sessions on your computer can show up in Desktop before they appear here. The web app only shows what you choose to sync. Choose here or in Desktop; either one finishes setup, and Off counts as a choice.",
  listLabel: "Setup steps",
  stepComplete: "Done",
  stepIncomplete: "Not done yet",
} as const satisfies SetupGateStepListCopy & SyncPolicyGateNoticeCopy;
