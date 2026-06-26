/**
 * GitHub-derived branch/PR status enums: `ReviewDecision` (PR review rollup)
 * and `ChecksStatus` (CI check rollup).
 *
 * WHY THIS IS A SEPARATE LEAF MODULE (do not merge back into `branch-view.ts`):
 * `branch.ts` needs these two types, and `branch.ts` is imported by the desktop
 * main process, which type-checks `@repo/api` source under `nodenext`. `nodenext`
 * requires explicit `.js` extensions on relative imports — but `branch-view.ts`
 * has a relative VALUE import (`./comment`) that the `apps/app`/`apps/api`
 * Turbopack bundler can only resolve EXTENSIONLESS (no `extensionAlias`/
 * `transpilePackages` is configured). Those two requirements are mutually
 * exclusive for `branch-view.ts`, so it must NOT enter the desktop nodenext
 * program. Keeping these enums here — a module with NO relative imports — lets
 * `branch.ts` reference them without dragging `branch-view.ts` (and its
 * bundler-only-resolvable import) into the desktop compilation. `branch-view.ts`
 * re-exports both names, so its existing consumers are unaffected.
 */

export const ReviewDecision = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Commented: "COMMENTED",
  Dismissed: "DISMISSED",
} as const;
export type ReviewDecision =
  (typeof ReviewDecision)[keyof typeof ReviewDecision];

export const ChecksStatus = {
  Unknown: "UNKNOWN",
  Pending: "PENDING",
  Passing: "PASSING",
  Failing: "FAILING",
} as const;
export type ChecksStatus = (typeof ChecksStatus)[keyof typeof ChecksStatus];
