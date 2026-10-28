import Store from "electron-store";

type SignOutCleanupState = {
  pending?: boolean;
  /**
   * Per-loop progress journal written by builds before ISS-12435. Nothing reads
   * it now; `clear()` still deletes it so an upgraded install drops the entry.
   */
  loops?: unknown;
};

/** Durable non-secret crash journal for incomplete local sign-out cleanup. */
export class SignOutCleanupStateStore {
  private readonly store: Store<SignOutCleanupState>;

  constructor(options?: { cwd?: string; name?: string }) {
    this.store = new Store<SignOutCleanupState>({
      cwd: options?.cwd,
      name: options?.name ?? "desktop-sign-out-cleanup",
    });
  }

  /** Whether cleanup still owns the local credential/account boundary. */
  isPending(): boolean {
    return this.store.get("pending") === true;
  }

  /** Persists the cleanup barrier before any remote await or process signal. */
  markPending(): void {
    this.store.set("pending", true);
  }

  /** Removes the cleanup barrier only after every verification has passed. */
  clear(): void {
    this.store.delete("pending");
    this.store.delete("loops");
  }
}
