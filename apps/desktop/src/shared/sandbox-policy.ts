import path from "node:path";
import { expandHomePath } from "./path-utils.js";

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
 * Returns true for broad or sensitive roots that should not complete automated
 * onboarding without an explicit safer sandbox selection.
 */
export function isRiskyAllowedDirectory(
  value: string | null | undefined
): boolean {
  const scopedPath = normalizeScopePath(value);
  const normalized =
    scopedPath === "/" ? scopedPath : scopedPath?.replace(/\/+$/, "");
  if (!normalized) {
    return false;
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
