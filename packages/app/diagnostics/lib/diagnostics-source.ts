import type { DiagnosticsPayload } from "./diagnostics-payload";
import type { DiagnosticsSectionId } from "./diagnostics-sections";

/**
 * ISS-10004 — what a host's diagnostics PROBE can say, and the commands the
 * surface may fire back. The bridge never crosses this seam, only the result and
 * the invitation to re-run it. Nothing here runs a system check: FEA-976 owns
 * that unification, and `SystemCheckBootstrap` stays the one thing that probes
 * the device.
 */

/** Collapsing these reports a failed read as a healthy machine with nothing to say. */
export const DiagnosticsTransportStatus = {
  Loading: "loading",
  Ready: "ready",
  Unavailable: "unavailable",
} as const;
export type DiagnosticsTransportStatus =
  (typeof DiagnosticsTransportStatus)[keyof typeof DiagnosticsTransportStatus];

/** A command the surface offers and the host performs. */
export type DiagnosticsCommand = {
  /** Disabled while the host says the command cannot be issued right now. */
  readonly busy: boolean;
  readonly run: () => void;
};

export type DiagnosticsSource = {
  readonly status: DiagnosticsTransportStatus;
  /**
   * Alongside `status`, not only under `Ready`: a failed refresh keeps the last
   * good reading beneath the notice rather than blanking the page.
   */
  readonly payload: DiagnosticsPayload | null;
  /** Cleaned of transport detail by the host. Non-null iff `Unavailable`. */
  readonly errorMessage: string | null;
  /** The OPTIONAL sections this device can serve; the rest are the surface's. */
  readonly availableSections: readonly DiagnosticsSectionId[];
  /**
   * ISS-6758: which optional reads the most recently SETTLED probe asked for.
   * Selecting a section is what asks for its read, so for one cycle the payload
   * was fetched without it; reading that absence as "could not measure" would be
   * a false failure claim about a load in progress. A probe that asked and
   * FAILED counts as settled.
   */
  readonly settledSections: readonly DiagnosticsSectionId[];
  /**
   * ISS-10006 — why this HOST can never serve section data, or null when it can.
   *
   * Distinct from `status: Unavailable` with an `errorMessage`, which says a read
   * FAILED and could succeed next time. This says there is no read here at all:
   * the browser host has no probe, because the probe is a local call over the
   * machine that runs the agents. Collapsing the two is what the ruling of
   * 2026-09-22 forbids — a permanent incapacity rendered as a transient failure
   * invites a reader to retry forever.
   *
   * Non-null changes two renders and nothing else. Every section body that would
   * otherwise be EMPTY says this instead, because an empty Repos list asserts
   * "there are no repos" when the truth is "this host cannot serve this" — the
   * confident-zero defect ISS-9931 and ISS-10541/10543 already fixed elsewhere.
   * And `refresh` stops rendering, because a control that looks available and
   * does nothing is the other half of the same lie.
   *
   * `refresh` stays REQUIRED rather than becoming nullable: an omitted optional
   * prop renders no control and looks identical to a surface that never had one
   * (see the props docstring), so the reason a control is gone is stated here
   * rather than inferred from an absence.
   */
  readonly unservableReason: string | null;
  /** Re-run the probe now. */
  readonly refresh: DiagnosticsCommand;
  /** The host's polling loop, or null when this host does not poll. */
  readonly autoRefresh: {
    readonly enabled: boolean;
    readonly toggle: () => void;
  } | null;
  /** Told which section the reader is on, so the host can shape its probe. */
  readonly onSectionChange: (sectionId: DiagnosticsSectionId) => void;
};
