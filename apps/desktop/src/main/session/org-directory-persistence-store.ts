import type { BasicUser } from "@repo/api/src/types/user";
import Store from "electron-store";
import {
  basicUserSchema,
  type OrgDirectoryPersistence,
} from "./org-directory-cache.js";

/**
 * @file org-directory-persistence-store.ts — electron-store-backed durable
 * store for the org-directory snapshot (FEA-3457).
 *
 * Rehydrating the last-known `GET /users` directory on cold start makes the
 * Branches/Sessions "Owner" column resolve immediately at boot (and survive an
 * offline session) instead of reading blank until a live fetch lands. The
 * snapshot is written under the signed-in identity key; the cache layer only
 * ever rehydrates a record whose identity matches the current account, so a
 * prior account's directory can never leak.
 *
 * This holds ONLY the BasicUser identity fields (id/email/name/avatar), which
 * are already returned by `GET /users` and rendered on-screen, plus a one-way
 * `identityKey` FINGERPRINT — it carries NO credential/token material. The
 * cache layer hashes `apiOrigin + token` (SHA-256) before it ever reaches this
 * store (see `persistenceIdentityKeyOf` in org-directory-cache.ts), so the raw
 * `sk_live` key is never written to this unencrypted electron-store file; the
 * fingerprint still scope-checks identity by equality.
 */

type PersistedOrgDirectory = {
  /**
   * One-way SHA-256 fingerprint of `${apiOrigin} ${token}` — the identity that
   * produced `users`. NOT the raw credential (never persist the live key).
   */
  identityKey: string;
  users: BasicUser[];
};

type OrgDirectorySchema = {
  snapshot?: PersistedOrgDirectory;
  [key: string]: PersistedOrgDirectory | undefined;
};

const SNAPSHOT_KEY = "snapshot";

export type OrgDirectoryPersistenceStoreOptions = {
  /** electron-store cwd override (the app passes `userData`). */
  cwd?: string;
  /** Store file name override (tests). */
  name?: string;
  /**
   * Observability seam (FEA-3517). Invoked from {@link OrgDirectoryPersistence.load}
   * when one or more persisted `users` elements are dropped as malformed, with
   * the count kept vs. dropped, so a corrupt on-disk snapshot degrading owner
   * attribution at boot is diagnosable (main-process log, per server-only logging
   * discipline) rather than a silent swallow. Defaults to a no-op; the app wires
   * a main-process logger. MUST NOT throw — it is invoked on the best-effort read
   * path and any throw is swallowed so observability can never crash rehydrate.
   */
  onCorruptEntriesDropped?: (info: { kept: number; dropped: number }) => void;
};

/**
 * Build an {@link OrgDirectoryPersistence} backed by electron-store. All reads
 * and writes are best-effort; the cache layer already swallows thrown errors,
 * but we defend here too so a corrupt on-disk value degrades to "no persisted
 * snapshot" rather than crashing the read path.
 */
export function createOrgDirectoryPersistenceStore(
  options?: OrgDirectoryPersistenceStoreOptions
): OrgDirectoryPersistence {
  const store = new Store<OrgDirectorySchema>({
    name: options?.name ?? "org-directory-cache",
    cwd: options?.cwd,
  });
  return {
    load() {
      const record = store.get(SNAPSHOT_KEY);
      if (
        !record ||
        typeof record.identityKey !== "string" ||
        !Array.isArray(record.users)
      ) {
        return null;
      }
      // Drop any element that is not a well-formed BasicUser (null, non-object,
      // missing/typed-wrong id, etc.) so a corrupt on-disk array degrades to
      // "no persisted snapshot" instead of crashing the cache rehydrate on read
      // (FEA-3517). If none survive, treat the whole record as absent. The filter
      // is per-element, so valid siblings survive alongside a corrupt entry — a
      // single bad row never discards the whole batch.
      const users = record.users.filter(
        (user) => basicUserSchema.safeParse(user).success
      );
      const dropped = record.users.length - users.length;
      if (dropped > 0) {
        // Surface the skip so a corrupt persisted directory shrinking boot-time
        // owner attribution is diagnosable, not a silent swallow (FEA-3517).
        // Best-effort: observability MUST NOT crash the read path.
        try {
          options?.onCorruptEntriesDropped?.({ kept: users.length, dropped });
        } catch {
          // Swallow: a faulty observer cannot be allowed to break rehydrate.
        }
      }
      if (users.length === 0) {
        return null;
      }
      return { identityKey: record.identityKey, users };
    },
    save(record) {
      store.set(SNAPSHOT_KEY, record);
    },
    clear() {
      store.delete(SNAPSHOT_KEY);
    },
  };
}
