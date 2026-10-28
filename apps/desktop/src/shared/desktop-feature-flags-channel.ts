export const DesktopFeatureFlagsIpcChannel = {
  Get: "desktop:get-desktop-feature-flags",
  /**
   * ISS-8753 — the Electron E2E harness's seeded assignment for this launch, or
   * `null`. Answers `null` on every ordinary launch and unconditionally in a
   * packaged build; see `lifecycle/e2e-feature-flag-assignment.ts` for why the
   * seam exists and why a real user cannot reach it.
   */
  GetE2eSeed: "desktop:get-e2e-seeded-feature-flags",
} as const;
export type DesktopFeatureFlagsIpcChannel =
  (typeof DesktopFeatureFlagsIpcChannel)[keyof typeof DesktopFeatureFlagsIpcChannel];
