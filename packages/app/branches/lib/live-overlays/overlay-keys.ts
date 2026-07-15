/**
 * React Query key factory for the Branches LIVE overlay layer (Epic F / FEA-1952).
 *
 * Rooted at `["branches","overlay"]` — a SIBLING namespace to `branchesKeys`
 * (`["branches"]` → lists/details/usages/analytics from `hooks/use-branches.ts`).
 * Keeping overlays out from under `branchesKeys` is deliberate: the
 * `BranchesLiveBridge` invalidates `branchesKeys.*` on every DB change, and the
 * live overlays (fetched from the GitHub gateway, never persisted) must NOT be
 * swept by those persisted-read invalidations. F5's explicit refresh invalidates
 * `branchesOverlayKeys.all()` separately.
 *
 */

const OVERLAY_ROOT = ["branches", "overlay"] as const;

export const branchesOverlayKeys = {
  /** Prefix matching every live overlay query (used by F5 refresh invalidation). */
  all: () => [...OVERLAY_ROOT] as const,
  /** F1 live files-changed (keyed by owner/repo slug + PR number). */
  files: (
    owner: string | null | undefined,
    repo: string | null | undefined,
    prNumber: number | null | undefined
  ) =>
    [
      ...OVERLAY_ROOT,
      "files",
      owner ?? null,
      repo ?? null,
      prNumber ?? null,
    ] as const,
  /** Live per-file PR diff (keyed by PR identity, current path, and rename path). */
  fileDiff: (
    owner: string | null | undefined,
    repo: string | null | undefined,
    prNumber: number | null | undefined,
    branchId: string | null | undefined,
    path: string | null | undefined,
    previousPath: string | null | undefined
  ) =>
    [
      ...OVERLAY_ROOT,
      "fileDiff",
      owner ?? null,
      repo ?? null,
      prNumber ?? null,
      branchId ?? null,
      path ?? null,
      previousPath ?? null,
    ] as const,
  /** F2 live merge/check status (keyed by owner/repo slug + PR number). */
  status: (
    owner: string | null | undefined,
    repo: string | null | undefined,
    prNumber: number | null | undefined
  ) =>
    [
      ...OVERLAY_ROOT,
      "status",
      owner ?? null,
      repo ?? null,
      prNumber ?? null,
    ] as const,
} as const;
