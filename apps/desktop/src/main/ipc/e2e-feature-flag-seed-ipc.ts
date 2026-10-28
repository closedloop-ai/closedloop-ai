import type { DesktopFeatureFlagAssignment } from "@repo/api/src/types/desktop-feature-flags";
import { DesktopFeatureFlagsIpcChannel } from "../../shared/desktop-feature-flags-channel.js";
import { readE2eFeatureFlagAssignment } from "../lifecycle/e2e-feature-flag-assignment.js";
import { isTrustedIpcSender } from "./ipc-trusted-sender.js";

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown
  ) => void;
};

type E2eFeatureFlagSeedIpcDeps = {
  /** Reject IPC events whose sender is not the trusted renderer window. */
  isTrustedSender: (sender: unknown) => boolean;
  isPackaged: () => boolean;
  getArgv: () => readonly string[];
  getUserDataPath: () => string;
};

/**
 * ISS-8753 — serve the Electron E2E harness's seeded flag assignment.
 *
 * Registered on every launch and answering `null` on all but a harness one:
 * {@link readE2eFeatureFlagAssignment} refuses a packaged build outright and
 * refuses an unpackaged one that was not started with the harness launch
 * argument, so the shipped app's answer here is a constant `null` and the
 * renderer falls through to the real PostHog assignment path.
 *
 * The packaged refusal is repeated HERE, ahead of the call, because an argument
 * list is fully evaluated before the callee runs: passing `deps.getArgv()` and
 * `deps.getUserDataPath()` positionally means a packaged launch would collect
 * argv and resolve the profile path before the helper's own refusal ever
 * executed. Neither getter reads the seed file, so nothing was disclosed — but
 * "a packaged build answers before it inspects launch or profile state" is the
 * property ISS-8753 is claiming, and a guard that holds only because today's
 * getters happen to be side-effect-free is not that property. The helper still
 * receives the real verdict rather than a hardcoded `false`, so its own refusal
 * stays live rather than becoming a branch this caller can no longer reach.
 *
 * Re-read on every call rather than captured at registration: a spec seeds the
 * file before launch, but reading it lazily is what keeps this handler free of
 * boot-order coupling to `app.setPath("userData", …)`.
 */
export function registerE2eFeatureFlagSeedIpcHandler(
  ipcMainLike: IpcMainLike,
  deps: E2eFeatureFlagSeedIpcDeps
): void {
  ipcMainLike.handle(
    DesktopFeatureFlagsIpcChannel.GetE2eSeed,
    (event): DesktopFeatureFlagAssignment | null => {
      if (!isTrustedIpcSender(deps.isTrustedSender, event)) {
        return null;
      }
      const isPackaged = deps.isPackaged();
      if (isPackaged) {
        return null;
      }
      return readE2eFeatureFlagAssignment(deps.getArgv(), {
        isPackaged,
        userDataPath: deps.getUserDataPath(),
      });
    }
  );
}
