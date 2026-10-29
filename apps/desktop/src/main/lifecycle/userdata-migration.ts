import {
  existsSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import {
  DesktopProfileKind,
  resolveDesktopProfileKind,
} from "../logging/main-log-location.js";

/**
 * Pre-rename Electron app name. Before the brand rename (FEA-2101) the desktop
 * app set its name to the PascalCase "ClosedLoop", so Electron resolved
 * `userData` to `<appData>/ClosedLoop`. After the rename `app.setName` uses
 * "Closedloop", moving `userData` to `<appData>/Closedloop` and orphaning every
 * existing install's persisted data (stores, logs, caches).
 */
export const LEGACY_DESKTOP_USER_DATA_DIR_NAME = "ClosedLoop" as const;

export type UserDataMigrationResult =
  | "migrated"
  | "migrated-replaced-empty-target"
  | "skipped-no-legacy-dir"
  | "skipped-target-exists"
  | "skipped-target-has-data"
  | "skipped-same-path"
  | "skipped-user-data-redirected";

type UserDataMigrationDeps = {
  /** Electron `app.getPath("appData")` — the parent of the userData directory. */
  appDataPath: string;
  /** Electron `app.getPath("userData")` — the NEW "Closedloop" directory. */
  userDataPath: string;
  /**
   * Electron `app.getName()` — the directory Electron appends to `appData` for
   * the DEFAULT `userData` path. Read from Electron rather than restated as a
   * constant here so it cannot drift from the `app.setName` that decides it.
   * Named to match {@link MainLogLocationInput}, whose shape this satisfies.
   */
  appName: string;
  legacyDirName?: string;
  exists?: (targetPath: string) => boolean;
  sameFile?: (a: string, b: string) => boolean;
  /** True when `targetPath` is a directory with no entries. */
  isEmptyDir?: (targetPath: string) => boolean;
  /** Removes an EMPTY directory (caller guarantees emptiness). */
  removeEmptyDir?: (targetPath: string) => void;
  rename?: (from: string, to: string) => void;
  log?: (message: string) => void;
};

/**
 * Best-effort, idempotent migration of the legacy `<appData>/ClosedLoop`
 * userData directory to the post-rename `<appData>/Closedloop` location
 * (FEA-2101). Safe on every filesystem:
 *
 * - Case-INSENSITIVE volumes (default macOS APFS, Windows, most installs): the
 *   legacy and new paths resolve to the SAME directory, so `app.getPath`
 *   already returns the existing data. The target "exists" (it is the legacy
 *   dir) and we skip — data is preserved untouched.
 * - Case-SENSITIVE volumes (some dev machines, Linux `~/.config`): the paths are
 *   distinct. We migrate when the legacy dir exists and the new path is either
 *   absent OR present-but-empty — the latter covers a fresh/partial post-rename
 *   shell (e.g. a prior failed launch that created an empty dir), which would
 *   otherwise orphan the legacy data and boot the app with fresh state.
 *
 * The migration never overwrites real data: when a distinct new directory holds
 * any entries we leave both in place and warn, rather than clobber a genuine
 * fresh install's state.
 *
 * ISS-8955: and it never runs at all against an explicitly-chosen profile. See
 * the redirect guard below for what that cost before it existed.
 */
export function migrateLegacyUserDataDirectory(
  deps: UserDataMigrationDeps
): UserDataMigrationResult {
  const exists = deps.exists ?? existsSync;
  const sameFile = deps.sameFile ?? defaultSameFile;
  const isEmptyDir = deps.isEmptyDir ?? defaultIsEmptyDir;
  const removeEmptyDir = deps.removeEmptyDir ?? rmdirSync;
  const rename = deps.rename ?? renameSync;
  const log = deps.log ?? (() => undefined);

  const legacyPath = path.join(
    deps.appDataPath,
    deps.legacyDirName ?? LEGACY_DESKTOP_USER_DATA_DIR_NAME
  );
  const newPath = deps.userDataPath;

  // ISS-8955. `--user-data-dir=<path>` (and `app.setPath("userData", …)`)
  // redirect `userData` but NOT `appData`, so a launch against a chosen profile
  // still reports the INSTALLED app's directory as the legacy one here. The
  // target is then absent or empty by construction, which is exactly the
  // `migrated` / `migrated-replaced-empty-target` branch — and that branch
  // renames the operator's live profile out from under the running install. A
  // profile path someone chose is never a migration target.
  //
  // `resolveDesktopProfileKind` is the canonical answer to "is this profile the
  // default one?" — the same predicate that decides where the main log goes, so
  // a launch cannot be `redirected` for the logger and `default` here. It
  // compares resolved paths and never stats, which is what makes this hold on a
  // case-sensitive volume and across devices: the case-insensitive-volume and
  // same-device coincidences are precisely what let the rename SUCCEED rather
  // than fail, so a guard leaning on either would be weakest exactly where the
  // damage is possible.
  if (resolveDesktopProfileKind(deps) === DesktopProfileKind.Redirected) {
    log(
      `userData migration: userData is redirected to ${newPath}; skipping legacy migration`
    );
    return "skipped-user-data-redirected";
  }

  if (legacyPath === newPath) {
    // Defensive: only possible if the legacy and new names ever coincide.
    return "skipped-same-path";
  }
  if (!exists(legacyPath)) {
    return "skipped-no-legacy-dir";
  }
  if (exists(newPath)) {
    // On case-insensitive volumes the legacy and new paths resolve to the SAME
    // directory — `app.getPath` already returns the existing data, so there is
    // nothing to move.
    if (sameFile(legacyPath, newPath)) {
      log(
        `userData migration: legacy and new paths are the same directory (case-insensitive volume); leaving data in place at ${newPath}`
      );
      return "skipped-target-exists";
    }

    // Distinct new directory. If it holds no entries it is a fresh/partial shell
    // (e.g. a prior failed launch created it) — remove it and migrate the legacy
    // data so the user keeps their state instead of booting fresh.
    if (isEmptyDir(newPath)) {
      removeEmptyDir(newPath);
      rename(legacyPath, newPath);
      log(
        `userData migration: replaced empty userData directory ${newPath} with legacy data from ${legacyPath}`
      );
      return "migrated-replaced-empty-target";
    }

    // The new directory holds real data: never clobber it. Leave both and warn
    // so the orphaned legacy directory is diagnosable.
    log(
      `userData migration: WARNING new userData directory ${newPath} already holds data while a legacy directory exists at ${legacyPath}; leaving both untouched (legacy data not migrated)`
    );
    return "skipped-target-has-data";
  }

  rename(legacyPath, newPath);
  log(
    `userData migration: moved legacy userData directory ${legacyPath} -> ${newPath}`
  );
  return "migrated";
}

function defaultSameFile(a: string, b: string): boolean {
  try {
    const statA = statSync(a);
    const statB = statSync(b);
    return statA.dev === statB.dev && statA.ino === statB.ino;
  } catch {
    return false;
  }
}

function defaultIsEmptyDir(targetPath: string): boolean {
  try {
    // Fail safe toward NOT-empty: an unreadable directory must never be treated
    // as empty (that would authorize a destructive remove + migrate).
    return readdirSync(targetPath).length === 0;
  } catch {
    return false;
  }
}
