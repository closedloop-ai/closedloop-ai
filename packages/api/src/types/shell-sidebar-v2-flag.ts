/**
 * The single cross-surface flag key gating the v2 shell sidebar — the shared
 * `ShellSidebar` composite and the navigation view model behind it — on both the
 * web app and the packaged desktop renderer (ISS-9734, PLN-2016 D11).
 *
 * ## Why a NEW key
 *
 * The v2 shell used to reach users through the `workspace-experience-v2`
 * assignment. ISS-10195 retired that gate and made the v2 workspace experience
 * unconditional, deleting the key, both shell resolvers and the root selector
 * with it. The sidebar MOUNT still has to ship closed, so it gets a key of its
 * own rather than a reader of a vocabulary that no longer gates anything.
 * `packages/api/src/types/workspace-experience.ts` survives as a wire and column
 * vocabulary; nothing may branch on it again.
 *
 * ## Why ONE key, shared, rather than one per surface
 *
 * ISS-4779 requires a UI change reachable on both surfaces to be gated on both,
 * and two parallel string literals are exactly how a feature leaks on one while
 * hidden on the other. `apps/desktop` resolves the signed-in account's PostHog
 * assignment from the same key space `apps/app` reads, and resolves nothing
 * else, so this one constant is the WHOLE gate: there is no desktop Labs toggle
 * to pair with it and no desktop flag-registry entry to add beside it (the
 * ISS-8024 local-registry cutover is retired).
 *
 * ## How it is read
 *
 * ONCE per shell, at that shell's sidebar mount site, which branches between two
 * whole trees. Nothing below that site reads it — not the section builder, not
 * the composite, not either host adapter — so no descendant can disagree with
 * the tree it is rendering inside.
 *
 * Off renders each shell's current sidebar, unchanged. That covers every read
 * until someone creates the flag, every read that has not resolved yet, an
 * errored read, and everyone outside the rollout.
 */
export const SHELL_SIDEBAR_V2_FLAG_KEY = "shell-sidebar-v2" as const;
