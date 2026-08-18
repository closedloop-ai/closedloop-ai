import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePath } from "./path-utils.js";
import {
  SANDBOX_REQUIRED_MESSAGE,
  SANDBOX_RISKY_ROOT_MESSAGE,
} from "./sandbox-messages.js";

/**
 * TCC-protected user folders (FEA-3641). On macOS, merely stat'ing or reading
 * these directories triggers a runtime TCC ("Transparency, Consent, Control")
 * permission prompt — the "why is it asking for my music files?" symptom Andrew
 * hit. The app never needs to browse, probe (`.git`), or search inside them, so
 * we treat them as hard-skip everywhere the gateway touches the filesystem.
 *
 * Basenames are matched case-insensitively directly under the user's home dir.
 * `Photos Library.photoslibrary` lives under `~/Pictures`, which is already
 * covered by skipping `Pictures`, but we include the canonical bundle name too
 * for defense-in-depth in case it is relocated.
 */
export const TCC_PROTECTED_HOME_SUBDIRS: readonly string[] = [
  "Music",
  "Pictures",
  "Photos",
  "Movies",
  "Documents",
  "Downloads",
  "Desktop",
] as const;

/**
 * Absolute paths of the TCC-protected folders under the current user's home.
 */
export function tccProtectedDirectories(): string[] {
  const home = os.homedir();
  return TCC_PROTECTED_HOME_SUBDIRS.map((name) => path.join(home, name));
}

/**
 * Case-insensitive path equality. macOS/Windows filesystems are case-insensitive
 * by default, so `${home}/music` and `${home}/Music` resolve to the same folder.
 * Any protected-root/allow-list comparison must fold case, or a differently-cased
 * path silently defeats the check. Sibling helpers (`isTccProtectedBasename`,
 * `isTccProtectedDirectory`) already lowercase; this is the shared primitive.
 */
export function pathsEqualIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * True when `target` is `root` itself or lives under it, compared
 * case-insensitively so a differently-cased path can't bypass the check on a
 * case-insensitive filesystem. Both inputs are expected to be already resolved
 * absolute paths.
 */
export function isPathAtOrUnder(target: string, root: string): boolean {
  const targetLower = target.toLowerCase();
  const rootLower = root.toLowerCase();
  return (
    targetLower === rootLower ||
    targetLower.startsWith(`${rootLower}${path.sep}`)
  );
}

/**
 * Returns true when the given basename is a TCC-protected user folder that
 * should never be stat'd/probed/searched. Case-insensitive so `music` and
 * `Music` both match.
 */
export function isTccProtectedBasename(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".photoslibrary")) {
    return true;
  }
  return TCC_PROTECTED_HOME_SUBDIRS.some((dir) => dir.toLowerCase() === lower);
}

/**
 * Returns true when `targetPath` resolves to a TCC-protected folder directly
 * under the user's home directory (or the Photos library bundle anywhere). Used
 * to skip `.git` probes and directory descent that would otherwise trigger a
 * macOS permission prompt.
 */
export function isTccProtectedDirectory(
  targetPath: string | null | undefined
): boolean {
  if (!targetPath) {
    return false;
  }
  const resolved = path.resolve(expandHomePath(targetPath));
  if (resolved.toLowerCase().endsWith(".photoslibrary")) {
    return true;
  }
  const home = os.homedir();
  const parent = path.dirname(resolved);
  if (parent !== home) {
    return false;
  }
  return isTccProtectedBasename(path.basename(resolved));
}

/**
 * Derive the effective allowed-directories list from the sandbox base directory.
 * Returns a single-entry array when sandbox is set, or [] when blank/null/undefined.
 * An empty array means "deny everything" — prevents path.resolve("") from resolving
 * to cwd and silently widening access.
 */
export function buildAllowedDirectories(
  rawSandbox: string | null | undefined
): string[] {
  const sandbox = normalizeScopePath(rawSandbox);
  return sandbox ? [sandbox] : [];
}

/**
 * Normalize a user-provided scope path: trim whitespace, expand ~ to homedir,
 * and resolve to an absolute path. Returns null for blank/null/undefined input.
 */
export function normalizeScopePath(
  value: string | null | undefined
): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return path.resolve(expandHomePath(trimmed));
}

/**
 * FEA-4005 security fix: resolve the deepest existing prefix of `absolutePath`
 * through `realpathSync.native` so a symlinked scope root is measured by the
 * directory it actually points at, not its lexical name. Without this a symlink
 * like `/tmp/scope -> /` slips past {@link isRiskyAllowedDirectory} (lexically
 * `/tmp/scope` is not a risky root) yet the enforcement path in
 * `security.ts#isPathAllowed` canonicalizes the allowed root to `/` and admits
 * the whole filesystem. Falls back to the lexical absolute path when nothing on
 * the chain can be realpath'd (fail-open only for a truly nonexistent path,
 * which cannot expand scope).
 */
function canonicalizeScopePath(absolutePath: string): string {
  try {
    return fs.realpathSync.native(absolutePath);
  } catch {
    let probe = absolutePath;
    while (true) {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return absolutePath;
      }
      if (fs.existsSync(parent)) {
        try {
          const canonicalParent = fs.realpathSync.native(parent);
          return path.join(
            canonicalParent,
            path.relative(parent, absolutePath)
          );
        } catch {
          return absolutePath;
        }
      }
      probe = parent;
    }
  }
}

/**
 * Returns true for broad or sensitive roots that should not complete automated
 * onboarding without an explicit safer sandbox selection.
 *
 * FEA-4005: the resolved absolute path is canonicalized through the filesystem
 * (realpath) before the risky-root comparison, so a symlink retargeting a
 * benign-looking scope root at `/`, `~`, or a system dir is rejected here rather
 * than silently widening the enforced allowlist.
 */
export function isRiskyAllowedDirectory(
  value: string | null | undefined
): boolean {
  const scopedPath = normalizeScopePath(value);
  const canonicalPath = scopedPath ? canonicalizeScopePath(scopedPath) : null;
  const normalized =
    canonicalPath === "/" ? canonicalPath : canonicalPath?.replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }
  if (
    tccProtectedDirectories().some((directory) =>
      isPathAtOrUnder(normalized, directory)
    )
  ) {
    return true;
  }
  if (normalized === "/" || normalized === expandHomePath("~")) {
    return true;
  }
  if (normalized === "/Users" || /^\/Users\/[^/]+$/.test(normalized)) {
    return true;
  }
  if (normalized === "/home" || /^\/home\/[^/]+$/.test(normalized)) {
    return true;
  }
  return ["/etc", "/private", "/usr", "/bin", "/sbin", "/var", "/System"].some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`)
  );
}

/**
 * FEA-4005: the enforcement-time guard for an *already-canonical* allowed scope
 * root. Narrower than {@link isRiskyAllowedDirectory} on purpose: it rejects only
 * the catastrophic "admits the whole filesystem / a system tree" roots — the
 * filesystem root `/` and *exact* top-level system directories. It deliberately
 * does NOT reject deep children of `/private` or `/var` (legitimate canonical
 * temp paths realpath to `/private/var/folders/...`), nor the home directory /
 * `/Users` (an explicit home-scoped allowlist is a separate persist-time policy
 * governed by {@link isRiskyAllowedDirectory}, not something this enforcement
 * re-check should silently start denying). Callers pass a canonicalized path
 * (the realpath), so a symlinked scope root retargeted at `/` — the concrete
 * escape this guards — is caught here and fails closed.
 */
export function isBroadScopeRoot(value: string | null | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value === "/" ? value : value.replace(/\/+$/, "");
  if (!normalized) {
    return false;
  }
  if (normalized === "/") {
    return true;
  }
  return EXACT_SYSTEM_ROOTS.includes(normalized);
}

const EXACT_SYSTEM_ROOTS = [
  "/etc",
  "/private",
  "/usr",
  "/bin",
  "/sbin",
  "/var",
  "/System",
];

/**
 * Normalize and guard a user-supplied sandbox base directory at any persist
 * point (onboarding, global settings, per-profile edit). Returns the resolved,
 * **canonicalized** absolute path or throws with the shared messages — so
 * blank/invalid paths and FEA-3641 risky roots are rejected identically
 * everywhere the sandbox is set.
 *
 * ISS-4577 security fix (shafty review): the returned value is
 * canonicalized through {@link canonicalizeScopePath} (realpath) so a symlinked
 * scope root is persisted as the REAL directory it pointed at *at save time*,
 * not its mutable lexical alias. Persisting the lexical alias left a
 * retarget window: a link saved while pointing at a safe project could later be
 * repointed at the home directory, and the enforcement path
 * (`security.ts#isPathAllowed`) — which realpaths the allowed root again on every
 * check — would then admit the newly-targeted (wider) tree. The risky-root guard
 * already canonicalizes for its *check*; canonicalizing the *persisted* value too
 * closes the window and fails closed on a retarget-to-risky at save time. A path
 * that does not exist yet realpaths to its own lexical form (fail-open only for a
 * truly nonexistent path, which cannot widen scope).
 */
export function validateSandboxBaseDirectory(
  value: string | null | undefined
): string {
  const normalized = normalizeScopePath(value);
  if (!normalized) {
    throw new Error(SANDBOX_REQUIRED_MESSAGE);
  }
  if (isRiskyAllowedDirectory(normalized)) {
    throw new Error(SANDBOX_RISKY_ROOT_MESSAGE);
  }
  // Persist the real directory (post-symlink-resolution), not the lexical alias,
  // so a later symlink retarget cannot silently widen the enforced scope. The
  // risky-root guard above already canonicalizes for its check, so a link
  // pointing at `/`, `~`, or a system dir is rejected there. On the canonical
  // path we fail closed against only the catastrophic *enforcement-time* roots
  // ({@link isBroadScopeRoot}) — deliberately NOT the broader
  // {@link isRiskyAllowedDirectory}, because a legitimate temp-based project
  // realpaths under `/private/var/folders/...` and must not be rejected here
  // (same asymmetry `security.ts#isPathAllowed` relies on).
  const canonical = canonicalizeScopePath(normalized);
  if (isBroadScopeRoot(canonical)) {
    throw new Error(SANDBOX_RISKY_ROOT_MESSAGE);
  }
  return canonical;
}
