/**
 * Canonical install-state vocabulary for the unified Packs / Plugin Catalog UX
 * (FEA-4083).
 *
 * Every surface (single-player desktop, multiplayer desktop, web-admin install
 * matrix) must describe a pack's install state with the SAME words and render it
 * the SAME way. Before this module, install state was inferred ad-hoc from
 * booleans (`installedByMe`, `installedHarnesses.includes(harness)`) and only
 * distinguished "installed" from "not installed"; the honest states a real
 * target can be in — an update is available, an install/conversion is in flight,
 * the pack does not support this harness, the target device is offline, or the
 * last install/update failed — had no shared name and no shared treatment. This
 * is the single source of truth for that vocabulary. The reviewed install-matrix prototype
 * (`apps/prototypes/app/p/install-matrix`, FEA-4074) is the design this is
 * faithful to; the glyph/tone choices here match its `CELL_STATUS`.
 *
 * The pieces:
 *  - `PackInstallState` — the const-object enum (never a TS `enum`, never bare
 *    literals). Members are the honest states a pack can be in on a target.
 *  - `INSTALL_STATE_LABEL` — the ONE label map. No surface hand-rolls a string;
 *    every rendered label reads from here.
 *  - `installStateTreatment` — maps each state to a SINGLE status-icon treatment
 *    (one DS `status-icon` glyph/ring, one tone). The meaning is said once — the
 *    status-icon glyph plus the label from `INSTALL_STATE_LABEL` — never
 *    triplicated as icon + badge + word. The mapper is exhaustive (`never`
 *    guard), so a future member fails typecheck until it is given a treatment.
 */

import type { StatusGlyph } from "@repo/design-system/components/ui/status-icon-primitives";

/**
 * The single display state a packs surface renders for a pack on a given install
 * target (a harness on a device). One canonical vocabulary shared by every packs
 * surface.
 *
 * This is the flattened state a surface *draws*, not the storage model. The
 * underlying axes — last-known install/version state and target reachability
 * (`online`/`lastSeen`) — stay independent upstream; a surface collapses them to
 * exactly one member here at render time. `Offline` in particular is derived
 * from the target being unreachable (mirroring the reviewed install-matrix
 * prototype's per-cell `CellState`, where offline is derived from `target.online`
 * rather than stored on the pack), not a value that replaces the install state in
 * storage.
 */
export const PackInstallState = {
  /** Installed and current — nothing to do. */
  Installed: "installed",
  /** Not installed on this target — the user can install it. */
  NotInstalled: "not-installed",
  /** Installed, but a newer catalog version is available. */
  Updatable: "updatable",
  /** An install / update / conversion is in flight for this target. */
  Converting: "converting",
  /** This pack cannot run on this harness — installing it is not possible. */
  Unsupported: "unsupported",
  /** The target device is offline; its true install state is unknown right now. */
  Offline: "offline",
  /**
   * The last install / update for this target failed. A terminal, retryable
   * state — the surface offers Retry rather than pretending the pack is absent.
   * This is the state a user most needs named (the reviewed install-matrix
   * prototype's `CellState.Failed`).
   */
  Failed: "failed",
} as const;
export type PackInstallState =
  (typeof PackInstallState)[keyof typeof PackInstallState];

/**
 * The ONE label map for install states — the single source of truth for how a
 * state reads on screen. Every surface renders its label from here; none
 * hand-rolls a string.
 */
export const INSTALL_STATE_LABEL: Record<PackInstallState, string> = {
  [PackInstallState.Installed]: "Installed",
  [PackInstallState.NotInstalled]: "Not installed",
  [PackInstallState.Updatable]: "Update available",
  [PackInstallState.Converting]: "Installing",
  [PackInstallState.Unsupported]: "Not supported",
  [PackInstallState.Offline]: "Target offline",
  [PackInstallState.Failed]: "Install failed",
};

/**
 * Last-resort label for a state that isn't in the union — only reachable if a
 * boundary casts an unknown wire string to `PackInstallState`. Pairs with
 * `installStateTreatment`'s neutral fallback so an unknown state renders muted
 * with an honest word, never as an `undefined` label.
 */
export const UNKNOWN_INSTALL_STATE_LABEL = "Unknown";

/**
 * A DS `status-icon` treatment for one install state. It is either a filled
 * glyph circle (`FilledStatusCircle`, terminal states) or a progress ring
 * (`StatusRing`, empty / in-flight states) — the meaning rides on the icon SHAPE
 * plus the label, never on color alone. Rendering reads the label separately
 * from `INSTALL_STATE_LABEL` so the state is said exactly once.
 *
 * `emphatic` lifts the text to full foreground weight for a state that needs
 * attention (update available, installing); the rest stay muted. This mirrors
 * the reviewed install-matrix `CELL_STATUS`.
 */
export type InstallStateTreatment =
  | {
      readonly kind: "glyph";
      /** Filled-circle glyph shape. */
      readonly glyph: StatusGlyph;
      /** CSS-var fill token for the circle. */
      readonly fill: string;
      readonly emphatic: boolean;
    }
  | {
      readonly kind: "ring";
      /** CSS-var arc/track color token. */
      readonly color: string;
      /** Dashed track — the empty "not installed" look. */
      readonly dashed?: boolean;
      /** Spinning arc for the in-flight state. */
      readonly thinking?: boolean;
      /** Ring track/arc stroke width override. */
      readonly ringStrokeWidth?: number;
      /** Track (background circle) color override. */
      readonly trackColor?: string;
      readonly emphatic: boolean;
    };

/**
 * Map an install state to its single status-icon treatment. Exhaustive over the
 * `PackInstallState` union — a newly added member fails typecheck at the `never`
 * guard until it is given a treatment here, so no surface can render an unstyled
 * state. Glyph/tone choices match the reviewed install-matrix prototype.
 */
export function installStateTreatment(
  state: PackInstallState
): InstallStateTreatment {
  switch (state) {
    case PackInstallState.Installed: {
      return {
        kind: "glyph",
        glyph: "check",
        fill: "var(--success)",
        emphatic: false,
      };
    }
    case PackInstallState.Updatable: {
      return {
        kind: "glyph",
        glyph: "swap",
        fill: "var(--progress-foreground)",
        emphatic: true,
      };
    }
    case PackInstallState.Converting: {
      return {
        kind: "ring",
        color: "var(--progress-foreground)",
        thinking: true,
        emphatic: true,
      };
    }
    case PackInstallState.NotInstalled: {
      return {
        kind: "ring",
        color: "var(--progress)",
        dashed: true,
        emphatic: false,
      };
    }
    case PackInstallState.Offline: {
      return {
        kind: "ring",
        color: "var(--muted-foreground)",
        ringStrokeWidth: 1.5,
        trackColor: "var(--muted-foreground)",
        emphatic: false,
      };
    }
    case PackInstallState.Unsupported: {
      return {
        kind: "glyph",
        glyph: "x",
        fill: "var(--muted-foreground)",
        emphatic: false,
      };
    }
    case PackInstallState.Failed: {
      return {
        kind: "glyph",
        glyph: "exclamation",
        fill: "var(--destructive)",
        emphatic: true,
      };
    }
    default: {
      return assertExhaustiveTreatment(state);
    }
  }
}

/**
 * Exhaustiveness guard for `installStateTreatment`. A newly added
 * `PackInstallState` member fails typecheck here (`never`) until it is given a
 * treatment above — that is the compile-time contract. At runtime, this is only
 * reachable if a boundary casts an unknown wire string to `PackInstallState`
 * (bypassing the type); rather than return the raw string mislabeled as a
 * treatment — which would render an undefined glyph and an `undefined` label —
 * it degrades to a neutral, muted fallback so an unknown state can never render
 * broken. Surfaces that can receive unknown wire values should still map them to
 * a known member before display; this is the last-resort safety net.
 */
function assertExhaustiveTreatment(_state: never): InstallStateTreatment {
  return {
    kind: "ring",
    color: "var(--muted-foreground)",
    dashed: true,
    emphatic: false,
  };
}
