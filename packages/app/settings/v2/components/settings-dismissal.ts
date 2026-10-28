/**
 * @file settings-dismissal.ts
 * @description How a Settings v2 modal mount returns the user to where they
 * were (ISS-8978).
 *
 * ONE close policy — "dismiss returns you to the surface you came from" — with
 * two outcomes, chosen by one fact: is there still a surface behind the modal?
 * This is the reconciliation ISS-8978 asked for between dismiss-to-underlying
 * -surface and ISS-8370's close-to-Dashboard. Close-to-Dashboard is not a
 * competing semantic; it is what "the surface you came from" resolves to when
 * you came from nowhere, and `resolveSettingsCloseRoute` already owns that
 * resolution (a validated `returnTo`, else the dashboard).
 *
 * The mode is stated by the host rather than sniffed, because only the host
 * knows whether it is holding a surface mounted behind the portal. Sniffing it
 * — from history length, a referrer, or a `returnTo` being present — would make
 * the shell claim a restore it cannot perform, which is the "never let the UI
 * lie about state" failure this axis exists to prevent.
 */

export const SettingsDismissMode = {
  /**
   * Settings was opened OVER a live surface that is still mounted behind the
   * dialog — an intercepting or parallel route, the mount shape chosen for this
   * program. Dismissing hides the dialog and performs NO navigation, so the
   * surface's scroll position, filters, and in-flight view state survive
   * because it was never unmounted.
   */
  Overlay: "overlay",
  /**
   * Settings was entered cold: a deep link opened straight into it with no
   * surface mounted behind it. There is nothing to restore, so dismissing
   * navigates to the close route.
   */
  Cold: "cold",
} as const;

export type SettingsDismissMode =
  (typeof SettingsDismissMode)[keyof typeof SettingsDismissMode];

export type SettingsDismissal =
  | {
      mode: typeof SettingsDismissMode.Overlay;
      /**
       * Hides the dialog while leaving the surface behind it mounted. The host
       * must NOT navigate here — a navigation is what loses the state this mode
       * exists to keep.
       */
      onDismiss: () => void;
    }
  | { mode: typeof SettingsDismissMode.Cold };
