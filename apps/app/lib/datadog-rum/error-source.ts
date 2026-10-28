/**
 * The closed set of `dd_context.source` discriminators the RUM reporter emits.
 *
 * Kept out of `report-error.ts` on purpose: that module pulls in the Datadog
 * browser SDK, and the boundary tests factory-mock it wholesale, so a member
 * imported from there would resolve to `undefined` in exactly the assertions
 * that need it. Constants live here so every producer and every assertion can
 * read the same value without the SDK or a mock in the path.
 */
export const RumErrorSource = {
  /**
   * ISS-11429: Clerk reported `status === "error"` on an auth screen — the
   * `failed_to_load_clerk_js` / `failed_to_load_clerk_ui` condition. Its own
   * discriminator because it is the one error class where the user is left on a
   * signed-out screen with no form and nothing to act on, so it needs a monitor
   * of its own rather than a share of the generic boundary's volume.
   */
  ClerkLoad: "clerk-load",
  GlobalError: "global-error",
  NextjsErrorBoundary: "nextjs-error-boundary",
  RumValidation: "rum-validation",
} as const;

export type RumErrorSource =
  (typeof RumErrorSource)[keyof typeof RumErrorSource];
