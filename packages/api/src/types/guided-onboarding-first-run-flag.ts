/**
 * ISS-11143 (ISS-4779 closed-by-default): the single cross-surface flag key
 * gating the FIRST-RUN onboarding screen's corrections. One key for that screen,
 * not one per defect found on it, so a rollout moves the screen as a whole
 * instead of letting its halves diverge.
 *
 * WHAT READS IT. One reader today — `WebGuidedOnboardingDialogHost`
 * (`apps/app/app/(authenticated)/components/guided-onboarding-dialog-host.tsx`):
 * whether the guided run's Choose-organization step resolves its
 * joinable-organization status from real Clerk membership and invitation state,
 * which is what makes that step's `none` empty state reachable at all. Off, that
 * host keeps exactly its pre-flag behaviour and requests no lists.
 *
 * ISS-11143's tree arbitration is intended to gate on this same key rather than
 * introduce a second one, but nothing reads it for that yet — no reader is
 * claimed here until that change lands and adds its own line.
 *
 * NOT a tree SELECTOR. PRD-689's `workspace-experience-v2` was retired
 * (`e41982fcca`, #7291) and must not come back; see
 * `@repo/api/src/types/workspace-experience`. This key does not choose which tree
 * exists or which one a rollout ships. Whether the v2 tree should be gated at all
 * is ISS-11144's question, awaiting a human, and this key deliberately does not
 * answer it: legacy stays live, stays routable, and still owns the frame for a
 * reader with no blocking guided run.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no heavy
 * transitive graph) so every consumer on BOTH shells imports this SAME literal
 * rather than redeclaring it or aliasing it per surface — the desktop renderer
 * resolves it from the signed-in account's PostHog assignment, the same key space
 * `apps/app` reads, so one PostHog flag gates both. There is no second desktop
 * key, no Labs toggle, and no desktop registry entry paired with it.
 */
export const GUIDED_ONBOARDING_FIRST_RUN_FLAG_KEY =
  "guided-onboarding-first-run" as const;
