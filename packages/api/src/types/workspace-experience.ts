/**
 * ISS-10195 (was ISS-8372 / PRD-692) — which complete component tree a root
 * composes.
 *
 * ONE MEMBER IS LIVE. The `workspace-experience-v2` rollout gate was removed
 * when v2 became unconditional on both shells, so nothing resolves a variant any
 * more and no surface branches on one. What survives is the STAMP: an onboarding
 * attempt records the experience it was created under in
 * `OnboardingAttempt.experienceVariant` (`apps/api/app/onboarding/guided/
 * attempt-store.ts`), persisted on create and never rewritten, so rows written
 * while the gate was live still carry {@link WorkspaceExperience.Legacy} and
 * must keep parsing.
 *
 * So this is a WIRE AND COLUMN vocabulary now, not a runtime switch. Do not
 * reintroduce a reader that branches on it to choose a tree; there is one tree.
 */
export const WorkspaceExperience = {
  /** Stamped on runs created before the gate was removed. Never produced now. */
  Legacy: "legacy",
  /** The only experience any surface composes. */
  V2: "v2",
} as const;
export type WorkspaceExperience =
  (typeof WorkspaceExperience)[keyof typeof WorkspaceExperience];
