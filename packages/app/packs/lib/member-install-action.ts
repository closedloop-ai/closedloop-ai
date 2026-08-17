/**
 * Member self-service install ACTION model (ISS-5125).
 *
 * The member per-machine block (FEA-4077) has always answered "where does this
 * pack stand on each of my machines?" and stopped there — its own docblock said
 * the ACT/dispatch path was a separate slice. This module is the decision half
 * of that slice: given the canonical {@link PackInstallState} a cell already
 * renders, what — if anything — may the member DO to that cell?
 *
 * It is deliberately a pure, node-testable rule table with no React and no
 * transport, mirroring the reviewed install-matrix prototype's `actionForState`
 * (`apps/prototypes/app/p/install-matrix/mock.ts`, FEA-4074) so the shipped
 * affordance follows the agreed design rather than a second, ad-hoc rule set.
 *
 * ## Where this narrows the prototype, and why
 *
 * The prototype offers four actions per cell: Install, Update, Remove, Retry.
 * Production ships only the two the member API can actually honor. The one
 * member-scoped write that exists is
 * `POST /compute-targets/{id}/member-installs`, whose gateway operation is
 * `member_pack_install` — "install this pack, for this harness, on this node".
 * There is no member-scoped update or uninstall route: the desktop's own
 * Update/Uninstall run through a DIFFERENT local mutation
 * (`plugins-panel`'s `runMutation(..., "update" | "uninstall")`), which the web
 * has no equivalent of. Rendering an Update or Remove control here would offer
 * the member a button with nothing behind it, so those two states stay read-only
 * until their routes exist. That deferral is deliberate and recorded, not an
 * oversight.
 *
 * Retry IS offered, because a retry of a failed install is the same install
 * call — no new contract is implied.
 */

import { PackInstallState } from "./install-state";

/**
 * A member-initiated action on one (machine x harness) cell. A const object
 * (never a TS `enum`) so call sites compare against the member, not a bare
 * string. Both members resolve to the SAME dispatch — an install of this pack
 * for this harness on this node — and differ only in how the control reads, so
 * the member is never told "Install" for something that already failed once.
 */
export const MemberInstallAction = {
  /** The pack is absent on this cell; installing it is the forward step. */
  Install: "install",
  /** The last install for this cell failed; the same call is offered again. */
  Retry: "retry",
} as const;
export type MemberInstallAction =
  (typeof MemberInstallAction)[keyof typeof MemberInstallAction];

/**
 * The ONE label map for member install actions. Every surface renders its
 * control label from here; none hand-rolls a string.
 */
export const MEMBER_INSTALL_ACTION_LABEL: Record<MemberInstallAction, string> =
  {
    [MemberInstallAction.Install]: "Install",
    [MemberInstallAction.Retry]: "Retry",
  };

/**
 * The action a member may take on a cell in the given install state, or `null`
 * when the cell offers none.
 *
 * `null` is returned for five distinct reasons, and they are NOT
 * interchangeable — the block renders a different explanation for each:
 *  - `Installed`   — nothing to do (uninstall has no member route; see above).
 *  - `Updatable`   — installed already; update has no member route (see above).
 *  - `Converting`  — an install is in flight; a second dispatch would duplicate it.
 *  - `Offline`     — the node is unreachable, so an install could not land.
 *  - `Unsupported` — the pack cannot run on this harness at all.
 *
 * Exhaustive over the `PackInstallState` union: a newly added member fails
 * typecheck at the `never` guard until it is intentionally given (or denied) an
 * action, so a future state can never silently inherit an install button.
 */
export function memberInstallActionFor(
  state: PackInstallState
): MemberInstallAction | null {
  switch (state) {
    case PackInstallState.NotInstalled: {
      return MemberInstallAction.Install;
    }
    case PackInstallState.Failed: {
      return MemberInstallAction.Retry;
    }
    case PackInstallState.Installed:
    case PackInstallState.Updatable:
    case PackInstallState.Converting:
    case PackInstallState.Offline:
    case PackInstallState.Unsupported: {
      return null;
    }
    default: {
      return assertExhaustiveAction(state);
    }
  }
}

/**
 * Why a cell offers no action, in words the member can act on — or `null` when
 * the cell either HAS an action or is in a settled state that needs no excuse.
 *
 * Only the three BLOCKED states earn a sentence. `Installed` and `Updatable`
 * are settled outcomes the status line already states honestly; adding "you
 * cannot uninstall from here" beneath every installed row would be noise about
 * a thing the member did not ask for. Offline / unsupported / in-flight, by
 * contrast, are cases where a member reasonably expects a button and must be
 * told why there isn't one — never a silently missing control.
 */
export function memberInstallBlockedReason(
  state: PackInstallState,
  computeTargetName: string
): string | null {
  if (state === PackInstallState.Offline) {
    return `${computeTargetName} is offline. Install state will sync when it reconnects.`;
  }
  if (state === PackInstallState.Unsupported) {
    return "This pack can't run on this harness.";
  }
  if (state === PackInstallState.Converting) {
    return "An install is already running here.";
  }
  return null;
}

/**
 * The full accessible name for a cell's install control.
 *
 * The visible label is one short word ("Install"), because the control sits in
 * a dense per-machine list where a long label would wrap. The row and harness
 * coordinate therefore has to reach a screen-reader user some other way, and
 * the accessible name is that way — "Install release-captain on parkers-mbp for
 * Codex" rather than a bare "Install" the user must reconstruct from the row
 * they think they are on. This mirrors the reviewed prototype's
 * `actionAriaLabel`.
 */
export function memberInstallActionAriaLabel(input: {
  action: MemberInstallAction;
  packName: string;
  computeTargetName: string;
  harnessLabel: string;
}): string {
  const verb = MEMBER_INSTALL_ACTION_LABEL[input.action];
  return `${verb} ${input.packName} on ${input.computeTargetName} for ${input.harnessLabel}`;
}

/**
 * Exhaustiveness guard for {@link memberInstallActionFor}. A newly added
 * `PackInstallState` fails typecheck here (`never`) until it is handled above —
 * that is the compile-time contract. At runtime this is only reachable if a
 * boundary casts an unknown wire string to `PackInstallState`; it fails CLOSED
 * (no action) so an unrecognised state can never render an install button whose
 * effect nobody designed.
 */
function assertExhaustiveAction(_state: never): null {
  return null;
}
