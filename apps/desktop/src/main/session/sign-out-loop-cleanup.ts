import type { ApiKeyStore } from "../settings/api-key-store.js";
import type { SettingsStore } from "../settings/settings-store.js";
import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "./desktop-account-admission.js";
import type { DesktopSessionStore } from "./desktop-session-store.js";

/** Main-process owners required for replay-safe sign-out cleanup. */
export type SignOutLoopCleanupDeps = {
  settingsStore: SettingsStore;
  apiKeyStore: ApiKeyStore;
  desktopSessionStore: DesktopSessionStore;
  /**
   * ISS-11843: mint a new unsaved-profile gateway identity. Saved profiles get
   * theirs from `clearAllConfigManagedMetadata`; this covers installs with none.
   */
  rotateLegacyGatewayIdentity: () => void;
  log: (message: string) => void;
};

/** Restart-safe owner of exhaustive local key deletion at sign-out. */
export class SignOutLoopCleanup {
  private readonly deps: SignOutLoopCleanupDeps;
  private inFlight: Promise<void> | null = null;

  constructor(deps: SignOutLoopCleanupDeps) {
    this.deps = deps;
  }

  /** Starts one singleflight cleanup pass and durably records unfinished work. */
  run(): Promise<void> {
    return this.start(true);
  }

  /** Replays a pending crash journal before auth or cloud work may resume. */
  resumeIfPending(): Promise<void> {
    return this.deps.settingsStore.getSignOutCleanupState().isPending()
      ? this.start(false)
      : Promise.resolve();
  }

  /** Commit fence for a remote managed-key result captured under one account. */
  mayCommitManagedKey(
    captured: DesktopAccountAdmission,
    current: DesktopAccountAdmission | null
  ): boolean {
    return (
      !(
        this.inFlight ||
        this.deps.settingsStore.getSignOutCleanupState().isPending()
      ) && isSameDesktopAccountAdmission(captured, current)
    );
  }

  private start(markPending: boolean): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    // The pass is synchronous; running it inside the executor keeps the
    // pending marker written before `start` returns and turns a throw into a
    // rejection.
    const task = new Promise<void>((resolve) => {
      this.execute(markPending);
      resolve();
    }).finally(() => {
      if (this.inFlight === task) {
        this.inFlight = null;
      }
    });
    this.inFlight = task;
    return task;
  }

  private execute(markPending: boolean): void {
    if (markPending) {
      this.deps.settingsStore.getSignOutCleanupState().markPending();
    }
    let sessionDeletionFailed = false;
    try {
      this.deps.desktopSessionStore.clear();
      sessionDeletionFailed = this.deps.desktopSessionStore.hasSession();
    } catch {
      sessionDeletionFailed = true;
    }
    this.deps.apiKeyStore.clearAllPersistedApiKeyMaterial();
    this.deps.settingsStore.clearAllConfigManagedMetadata();
    this.deps.rotateLegacyGatewayIdentity();
    if (
      sessionDeletionFailed ||
      this.deps.desktopSessionStore.hasSession() ||
      this.deps.apiKeyStore.getApiKey() ||
      this.deps.apiKeyStore.hasPersistedApiKeyMaterial() ||
      this.deps.settingsStore.hasAnyConfigManagedMetadata()
    ) {
      this.deps.log(
        "Sign-out cleanup retained the pending marker: local credential deletion verification failed"
      );
      throw new Error("sign-out local credential deletion verification failed");
    }
    this.deps.settingsStore.getSignOutCleanupState().clear();
  }
}
