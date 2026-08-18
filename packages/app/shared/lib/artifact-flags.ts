/**
 * PostHog feature-flag keys for the Artifacts section. Each artifact is gated
 * individually, so nav items, page routes, and E2E route fixtures can share the
 * same canonical key set without duplicating string literals.
 */
export const ArtifactFlag = {
  /**
   * Removed "Documents" primary nav item (FEA-3964). No nav surface consumes it;
   * retained only as the canonical key the mobile-nav regression test enables to
   * prove the item never resurfaces (and for a future real surface to re-adopt).
   */
  Documents: "documents-nav",
  Issues: "issues-nav",
  /**
   * FEA-4155: no longer consumed by any web nav item or route — the Branches
   * surface (list + detail) is always-on. Retained as the canonical key for the
   * desktop split-gate compatibility contract (see `feature-flags.ts`) and for a
   * future re-adoption; do not remove without approving that cleanup.
   */
  Branches: "branches-nav",
  BranchDetail: "branch-detail-page",
} as const;
export type ArtifactFlagMap = typeof ArtifactFlag;
export type ArtifactFlag = (typeof ArtifactFlag)[keyof typeof ArtifactFlag];
