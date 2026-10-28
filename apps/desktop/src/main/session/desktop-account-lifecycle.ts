import type { DesktopRealtimeHost } from "../realtime/desktop-realtime-host.js";
import type { DesktopAccountAdmission } from "./desktop-account-admission.js";

type AccountChangeDeps = {
  clearOrgDirectory: () => void;
  stopCloud: () => void;
  realtime: Pick<DesktopRealtimeHost, "stop" | "reconcileAccount">;
  forgetSessionSyncIdentity: () => void;
  mayRestartCloud: () => boolean;
  restartCloud: () => void;
};

/** Tear cloud-bound state down on sign-out; reconcile realtime and restart the cloud for an admitted account. */
export function reconcileDesktopAccountChange(
  admission: DesktopAccountAdmission | null,
  deps: AccountChangeDeps
): void {
  if (!admission) {
    deps.clearOrgDirectory();
    deps.stopCloud();
    deps.realtime.stop();
    deps.forgetSessionSyncIdentity();
    return;
  }
  deps.realtime.reconcileAccount();
  if (deps.mayRestartCloud()) {
    deps.restartCloud();
  }
}
