/** User-visible error for signed loop launches that cannot satisfy managed-key request signing. */
export const SIGNED_LOOP_LAUNCH_MANAGED_KEY_ERROR =
  "Signed loop launch requires a desktop-managed key with request signing; the active config uses a manually configured key or cannot load its signing key. Re-run managed onboarding.";
