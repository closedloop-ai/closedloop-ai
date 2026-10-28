/**
 * PRD-730 `batch-fs-detail-context` (ISS-4779 closed-by-default policy): the
 * single cross-surface key gating search's move to complete-surface ownership.
 *
 * ONE key for a batch whose value IS that a reader gets the same rows on web
 * and desktop, so the ownership change flips together rather than per shell —
 * a per-shell key would ship the divergence PRD-730 exists to end. It gates
 * which component a host mounts, not search itself: neither corpus changes on
 * either side of it.
 *
 * "FLIPS TOGETHER" IS A CLAIM ABOUT THE KEY, NOT ABOUT A MOMENT IN TIME
 * (davetho review). The two shells do not ship atomically: `apps/app` deploys
 * on its own cadence while installed Electron builds update on theirs, so for
 * the length of the desktop rollout an account with the key ON gets
 * `SearchSurfaceV2` on web and, on a desktop binary predating this consumer,
 * the legacy `DocsCommandGroup`. One assignment, two shells that reach it at
 * different times.
 *
 * That skew is a GRACEFUL one and is why this is documented rather than gated:
 * an old desktop has no reader for the key, so it keeps rendering exactly what
 * it renders today — the same thing a closed gate gives it. Nothing half-mounts
 * and nothing breaks; what is temporarily untrue is the SAMENESS the batch
 * promises, not the correctness of either shell.
 *
 * ROLLOUT ORDER, therefore: ship the desktop build carrying this consumer
 * first, let that cohort adopt, and open the key after. Opening it ahead of
 * desktop adoption is supported but buys a window in which the two shells
 * disagree about which search they show. Gating the key itself on a desktop
 * capability or version is deliberately NOT done here: it would put release
 * engineering inside a flag whose whole point is that neither shell knows the
 * other exists.
 *
 * Dependency-free so both shells import the SAME literal rather than
 * redeclaring it. ISS-9414 records the rest.
 */
export const PORTABLE_SEARCH_SURFACE_FLAG_KEY =
  "portable-search-surface" as const;
