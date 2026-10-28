/**
 * ISS-12048: IPC between the renderer's Dev Tools overlay and main's own flag
 * reads (`isDesktopMainFeatureFlagEnabled`).
 */
export const DesktopDevModeIpcChannel = {
  /**
   * Renderer to main: this device's flag overrides, or an empty record when
   * Dev Mode is off or nobody is signed in. Main applies them only when its own
   * eligibility check passes; it never takes the renderer's word for Dev Mode.
   */
  SetFeatureFlagOverrides: "desktop:set-feature-flag-overrides",
  /** Renderer to main: the flag keys main checked, for the overlay. */
  GetCheckedFeatureFlags: "desktop:get-main-checked-feature-flags",
  /** Main to renderer: main checked a key it had not reported yet. */
  CheckedFeatureFlagsChanged: "desktop:main-checked-feature-flags-changed",
} as const;
export type DesktopDevModeIpcChannel =
  (typeof DesktopDevModeIpcChannel)[keyof typeof DesktopDevModeIpcChannel];
