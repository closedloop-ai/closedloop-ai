/**
 * FEA-4005: sandbox validation messages, split out of `sandbox-policy.ts` into a
 * dependency-free module so bundle-sensitive renderer surfaces (the gateway
 * profile sandbox field) can import the shared copy without pulling in
 * `sandbox-policy.ts`'s Node builtins (`node:fs`/`node:os`/`node:path`). Keeping
 * these in one place is the SSOT the onboarding, settings, and per-profile edit
 * points all reject risky/blank sandboxes with.
 */

/** Inline error surfaced when a sandbox base directory is blank/invalid. */
export const SANDBOX_REQUIRED_MESSAGE = "Sandbox base directory is required";

/**
 * FEA-3641 rejection message shown when the selected sandbox is a broad/risky
 * root (~, /Users/<name>, a system dir). Shared by onboarding, settings, and
 * the per-profile gateway sandbox edit point so the copy stays identical.
 */
export const SANDBOX_RISKY_ROOT_MESSAGE =
  "Sandbox base directory cannot be the home directory or a system root. Choose a specific project or workspace folder.";

/**
 * ISS-4577: inline error shown when a typed sandbox path does not exist as a
 * directory on disk (the native picker only ever returns existing folders, so
 * this is reached when the value was hand-typed or the folder was later moved).
 * Kept beside the other sandbox messages so the copy stays in one place.
 */
export const SANDBOX_MISSING_DIRECTORY_MESSAGE =
  "This folder does not exist. Choose an existing project or workspace folder.";
