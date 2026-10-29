import type { ContactFormCopy } from "@repo/app/marketing/contact/components/contact-form";
import type { ContactFormDemoProps } from "@repo/app/marketing/contact/components/contact-form-demo";
import type { ContactFormSubmission } from "@repo/app/marketing/contact/lib/contact-form-schema";

/**
 * PLACEHOLDER COPY, NOT A PROPOSAL. Every string here is prefixed so it cannot
 * be mistaken for approved product copy or copy-pasted into production. The
 * field labels are NOT here because they are the operator's own words and live
 * in the surface; these are the strings still awaiting a ruling (root
 * `AGENTS.md` → Human Provenance for Product Behavior).
 */
export const PLACEHOLDER_CONTACT_COPY: ContactFormCopy = {
  submitLabel: "[copy TBD] Send",
  submittingLabel: "[copy TBD] Sending…",
  sentTitle: "[copy TBD] Message sent",
  sentBody: "[copy TBD] Confirmation sentence awaiting a human ruling.",
  errorTitle: "[copy TBD] Message not sent",
  errorBody: "[copy TBD] Failure sentence awaiting a human ruling.",
  invalidTitle: "[copy TBD] Check the highlighted fields",
  invalidBody: "[copy TBD] Validation sentence awaiting a human ruling.",
};

export const SCENARIOS = {
  Succeeds: "succeeds",
  Fails: "fails",
} as const;
export type Scenario = (typeof SCENARIOS)[keyof typeof SCENARIOS];

const SIMULATED_LATENCY_MS = 600;

/**
 * The sandbox has no transport (`apps/prototypes/AGENTS.md`: mock data only, no
 * API). This stands in for the production send so both outcomes of a real
 * Resend call are reachable in review — including the failure, which is the
 * state the screen is being designed for.
 */
export const simulateSend = (
  scenario: Scenario
): ((submission: ContactFormSubmission) => Promise<void>) => {
  return (submission) =>
    new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (scenario === SCENARIOS.Fails) {
          reject(new Error(`send failed for ${submission.email}`));
          return;
        }
        resolve();
      }, SIMULATED_LATENCY_MS);
    });
};

/**
 * The props the sandbox route hands the portable mock host. Both scenario
 * labels and the switcher legend live here rather than in `@repo/app` so no
 * sandbox-only word reaches the production package.
 */
export const mockProps: ContactFormDemoProps = {
  copy: PLACEHOLDER_CONTACT_COPY,
  scenarioLegend: "Scenario",
  scenarios: [
    {
      id: SCENARIOS.Succeeds,
      label: "Send succeeds",
      send: simulateSend(SCENARIOS.Succeeds),
    },
    {
      id: SCENARIOS.Fails,
      label: "Send fails",
      send: simulateSend(SCENARIOS.Fails),
    },
  ],
};
