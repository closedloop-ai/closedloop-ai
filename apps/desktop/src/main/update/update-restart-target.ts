/**
 * @file update-restart-target.ts
 * @description ISS-7247: which version, if any, this quit comes back on. Pure,
 * because getting it wrong is silent both ways — too narrow and most upgrades
 * go unreported, too broad and an ordinary quit arms an expectation the next
 * boot calls a failed upgrade.
 */
import type { PackagedUpdateState } from "./packaged-update-state.js";

export type UpdateRestartTargetInput = {
  /** An explicit "restart to update" is in flight (renderer or gateway apply). */
  applyingUpdate: boolean;
  /**
   * Read live: the translocation and fake-feed guards turn it off, and on those
   * installs an ordinary quit stages nothing.
   */
  autoInstallOnAppQuit: boolean;
  currentVersion: string;
  state: PackagedUpdateState;
};

/**
 * `autoInstallOnAppQuit` is the case worth stating: on by default, so a
 * downloaded update installs on an ORDINARY quit with no user action. Keying
 * only off the explicit apply limited upgrade-outcome records to users who
 * clicked "Restart to update".
 *
 * A downloaded artifact equal to the running version is not an upgrade, so a
 * re-quit after one landed cannot arm a second expectation.
 */
export function resolveUpdateRestartTargetVersion(
  input: UpdateRestartTargetInput
): string | undefined {
  const { version, downloaded } = input.state;
  if (!(downloaded && version) || version === input.currentVersion) {
    return undefined;
  }
  if (input.applyingUpdate || input.autoInstallOnAppQuit) {
    return version;
  }
  return undefined;
}
