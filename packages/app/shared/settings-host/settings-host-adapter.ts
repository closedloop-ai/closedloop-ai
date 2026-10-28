import type { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type {
  SettingsHostCapabilities,
  SettingsLocalDeviceProjection,
  SettingsLocalSyncPolicyProjection,
} from "@repo/api/src/types/settings-host-capabilities";
import { WEB_SETTINGS_HOST_CAPABILITIES } from "@repo/api/src/types/settings-host-capabilities";
import type { SettingsPanelHost } from "@repo/api/src/types/settings-panel";

/**
 * ISS-8379 (PRD-691) — the injected port through which Settings learns what
 * host it is on and what that host can say about its own machine.
 *
 * A port rather than a runtime check, per `packages/app/AGENTS.md`: shared code
 * never asks "am I in Electron?", each shell injects its implementation, and the
 * only implementation that can invoke a local operation is the desktop one that
 * lives in `apps/desktop`. The web default below has no local call path at all,
 * which is what makes "web never invokes a local operation" a structural
 * property rather than a convention.
 *
 * One port for both Settings trees, so the rollout does not need two adapters.
 * Neither tree consumes it YET: the panel that reads it — Connected Devices —
 * is ISS-8366, which this ticket blocks. Until that lands the desktop shell
 * mounts the adapter and nothing calls `readLocalDevice`
 * (davetho review, #6388). It carries no feature-flag input — only the program
 * root chooses a tree (PRD-692).
 */
export type SettingsHostAdapter = {
  host: SettingsPanelHost;
  /**
   * Resolves a SETTLED projection on every path. A failed or unavailable read is
   * reported as such and never as an empty or ready one; the adapter must not
   * reject.
   */
  readLocalDevice: () => Promise<SettingsLocalDeviceProjection>;
  /**
   * Read and change THIS machine's own data-sync level (PLN-1915 D6).
   *
   * OPTIONAL, and its absence is the whole reason the control does not exist on
   * web: the web adapter omits it, so there is no branch anywhere that has to
   * remember not to offer a local write off the desktop. A host that implements
   * it delegates to its already-landed local write path rather than opening a
   * second one — no new channel, no second writer.
   *
   * Both members settle rather than reject, on the same contract as
   * {@link readLocalDevice}: an installed build whose preload predates the
   * channels reports `bridge-unavailable`, which renders as "this build cannot
   * do that" instead of an error the user cannot act on.
   */
  localSyncPolicy?: SettingsLocalSyncPolicyCapability;
};

export type SettingsLocalSyncPolicyCapability = {
  read: () => Promise<SettingsLocalSyncPolicyProjection>;
  write: (level: DataSyncLevel) => Promise<SettingsLocalSyncPolicyProjection>;
};

/**
 * The web shell's adapter. It answers from a constant — there is no host to ask
 * — so no amount of misconfiguration can make the web app reach a Desktop
 * gateway or IPC path through Settings.
 *
 * It omits {@link SettingsHostAdapter.localSyncPolicy} entirely, which is what
 * makes "the web app never writes a local sync level" a structural property
 * rather than a hidden branch.
 */
export const webSettingsHostAdapter: SettingsHostAdapter = {
  host: WEB_SETTINGS_HOST_CAPABILITIES.host,
  readLocalDevice: () =>
    Promise.resolve(WEB_SETTINGS_HOST_CAPABILITIES.localDevice),
};

export function toSettingsHostCapabilities(
  host: SettingsPanelHost,
  localDevice: SettingsLocalDeviceProjection
): SettingsHostCapabilities {
  return { host, localDevice };
}
