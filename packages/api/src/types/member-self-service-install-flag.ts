/**
 * ISS-5125 (ISS-4779 closed-by-default policy): the single cross-surface flag
 * key gating the MEMBER self-service install AFFORDANCE on the packs
 * per-machine block.
 *
 * ## What it gates
 *
 * The member per-machine block (`MemberTargetsBlock`, FEA-4077) has always been
 * a READ: it says where a pack stands on each of a member's machines, per
 * harness, and says nothing about how to change that. The ACT half — a per
 * (machine x harness) install affordance dispatching the member's own install —
 * is what this key turns on. Off, the block renders exactly the read-only rows
 * it shipped with; on, an actionable cell also carries its install control.
 *
 * The capability itself is NOT new and is NOT widened here: the org role model
 * already grants every member `PackAdminCapability.InstallToOwnMachines`
 * (`packages/app/packs/lib/pack-admin-capability.ts`), and the API already
 * enforces owner-only, org-scoped access to the target node
 * (`dispatchMemberPackInstall` -> `computeTargetsService.findOwnedById`). This
 * flag gates a UI affordance for an authorization that already exists on both
 * sides; flipping it grants no member any permission they did not already hold.
 *
 * ## Why the key lives here
 *
 * Lightweight, dependency-free `@repo/api` module (no Zod, no heavy transitive
 * graph) precisely so BOTH surfaces import the SAME literal instead of
 * redeclaring it:
 *  - web (`apps/app`) reads it as a PostHog flag via
 *    `MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`).
 *  - the desktop renderer resolves the byte-for-byte-equal key from its Labs
 *    registry via `DESKTOP_MEMBER_SELF_SERVICE_INSTALL_FEATURE_FLAG_KEY`
 *    (`apps/desktop/src/shared/feature-flags.ts`), since the packaged renderer
 *    has no PostHog wiring.
 *
 * Both shells mount the block, so both are gated — one literal, one rename.
 */
export const MEMBER_SELF_SERVICE_INSTALL_FLAG_KEY =
  "member-self-service-install" as const;
