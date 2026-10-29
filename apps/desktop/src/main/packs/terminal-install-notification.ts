/**
 * @file terminal-install-notification.ts
 * @description ISS-6170 — tell the user ONCE that a required pack can never be
 * installed by this build, with the remedy, instead of burying it in repeated
 * gateway-log errors they never see.
 *
 * The body is read from the installer's own canonical failure text rather than
 * re-worded here: `describeNotStarted` already composes the operator-actionable
 * sentence including "update Closedloop Desktop".
 *
 * `createNotification` is INJECTED. A static
 * `import { Notification } from "electron"` would put the real electron module
 * on the static graph of every importer of `required-plugin-installer-options.ts`,
 * which the `test:node` lane resolves to a stub carrying no `Notification`.
 */

import { gatewayLog } from "../logging/gateway-logger.js";

/** Title of the give-up notification. Wording is operator-owned (ISS-6170). */
const TERMINAL_INSTALL_TITLE = "A required plugin can't be installed";

export type TerminalInstallNotificationOptions = {
  title: string;
  body: string;
};

export type TerminalInstallNotification = {
  show(): void;
};

/**
 * Show the one-shot give-up notification. Best-effort and never throws: this
 * runs inside the distribution reconcile, which must keep processing the
 * remaining distributions whatever the notification layer does.
 */
export function notifyTerminalInstallFailure(
  createNotification: (
    options: TerminalInstallNotificationOptions
  ) => TerminalInstallNotification,
  reason: string
): void {
  try {
    createNotification({
      title: TERMINAL_INSTALL_TITLE,
      body: reason,
    }).show();
  } catch (error) {
    gatewayLog.warn(
      "required-plugin-installer",
      `terminal install notification failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
