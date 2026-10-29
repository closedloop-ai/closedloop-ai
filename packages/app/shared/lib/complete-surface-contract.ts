/**
 * ISS-9395 — what "complete surface" MEANS, so the registry beside it can say
 * which routes have one.
 *
 * A complete surface is the final feature body below global shell chrome. It
 * owns the visible hierarchy, the controls, the metric treatment, the
 * responsive treatment, and the whole truth-state machine. A host owns the
 * boundary mechanics that a browser and an Electron renderer genuinely differ
 * on, and nothing else.
 *
 * The two halves are declared as disjoint sets on purpose. "Which side owns
 * this?" was previously answered per prop, per host, in whichever ledger noticed
 * it first — and ISS-9218 showed what that costs: `pageSizeOptions` was supplied
 * on web, `notSupported` on desktop, and the reason string was `"See
 * onPageSizeChange."`. Naming the seams once, here, is what lets a later reader
 * grade a claim against a rule instead of against a sentence.
 */

/**
 * The truth states a complete surface owns. Seven, and deliberately not fewer:
 * every collapse between two of them is a defect this repo has actually shipped.
 *
 * The distinction that keeps getting lost is "we did not compute this" versus
 * "there is nothing to compute". They are different claims about the world and a
 * reader acts on them differently — one means wait or retry, the other means the
 * work does not exist. A surface that renders both as the same blank has lied
 * about one of them.
 */
export const CompleteSurfaceState = {
  /** A read is in flight. Nothing is known yet. Never a zero, never a blank. */
  Loading: "loading",
  /**
   * The read succeeded, the population is non-empty, and the ACTIVE FILTERS
   * exclude all of it. The remedy is the user's: widen or clear. Distinct from
   * {@link GenuineEmpty}, whose remedy is to create something.
   */
  FilteredEmpty: "filtered-empty",
  /**
   * The read succeeded and the underlying population is genuinely empty. There
   * is nothing to show because nothing exists — not because a filter hid it and
   * not because a read failed.
   */
  GenuineEmpty: "genuine-empty",
  /**
   * The read succeeded for SOME of the requested data and not the rest — a
   * capped page, a partially-failed fan-out, a source still hydrating. What
   * renders is true; what is missing must be said. Collapsing this into
   * {@link Ready} is how a capped count ships as a confident total.
   *
   * ONE surface is carved out of that, by ruling rather than by drift: ISS-10010
   * decided the Inbox keeps its cap unannounced, so
   * `packages/app/inbox/lib/inbox-notification-source.ts` offers no arm to map
   * this onto and reports a capped read as its own `Ready`. It is a product
   * ruling about an affordance that has never rendered — there is no way past
   * the first page to offer — and not a precedent: the next capped read is held
   * to the rule above unless it gets a ruling of its own.
   */
  Partial: "partial",
  /**
   * This host cannot serve the datum or command at all — no transport, no
   * capability, no local runtime for it. Not an error (nothing went wrong) and
   * not empty (the population is unknown, not zero).
   */
  Unavailable: "unavailable",
  /** The read failed. The failure is shown, with whatever recovery exists. */
  Error: "error",
  /** The read succeeded in full and the surface renders the whole population. */
  Ready: "ready",
} as const;
export type CompleteSurfaceState =
  (typeof CompleteSurfaceState)[keyof typeof CompleteSurfaceState];

/**
 * The ONLY seams a host may own. Each is something a browser and an Electron
 * renderer genuinely differ on, so a host that fills one is stating a real
 * platform fact rather than making a presentation choice.
 */
export const HostBoundarySeam = {
  /** How bytes are fetched: `apps/api` over HTTP, or preload/IPC/gateway. */
  Transport: "transport",
  /** Who the caller is and how that is proven. */
  Auth: "auth",
  /** How a semantic destination becomes a navigation on this host. */
  Routing: "routing",
  /** Which host assignment decides this surface is on. */
  FeatureAssignment: "feature-assignment",
  /**
   * An OS or local-runtime affordance with no browser analogue — a native menu,
   * a filesystem path, a spawned local process. Host runtime availability or
   * recovery chrome may stay outside a mastered surface only when it does not
   * duplicate presentation the surface owns.
   */
  LocalRuntimeCapability: "local-runtime-capability",
} as const;
export type HostBoundarySeam =
  (typeof HostBoundarySeam)[keyof typeof HostBoundarySeam];

/**
 * Concerns the SURFACE owns outright. A host that supplies one of these is
 * composing feature presentation beside the surface, which is the defect the
 * registry and its source guard exist to catch.
 *
 * Listed explicitly rather than defined as "everything not a
 * {@link HostBoundarySeam}", because the negative form is unreadable in a
 * failure message and this list is what a guard can name back to its reader.
 */
export const SurfaceOwnedConcern = {
  /** Feature heading, content hierarchy, and the anchors a tour targets. */
  Hierarchy: "hierarchy",
  /** The toolbar and every control in it. */
  Toolbar: "toolbar",
  /**
   * Summary cards, metric strips, hydration/retry/cohort notices, and strip
   * layout values that make list measurements readable.
   */
  Metrics: "metrics",
  /** Filter affordances and their applied state. */
  Filters: "filters",
  /** Sort affordances, defaults, and rule limits. */
  Sorting: "sorting",
  /** Grouping affordances and defaults. */
  Grouping: "grouping",
  /** Page size ladder, range readout, and page controls (ISS-9216). */
  Pagination: "pagination",
  /** Table/card breakpoint treatment and column folding. */
  ResponsivePresentation: "responsive-presentation",
  /** Which of the seven {@link CompleteSurfaceState}s renders, and as what. */
  StateSelection: "state-selection",
} as const;
export type SurfaceOwnedConcern =
  (typeof SurfaceOwnedConcern)[keyof typeof SurfaceOwnedConcern];

/** Ordered, for tests and for any reader that needs the whole set. */
export const COMPLETE_SURFACE_STATES: readonly CompleteSurfaceState[] =
  Object.values(CompleteSurfaceState);

export const HOST_BOUNDARY_SEAMS: readonly HostBoundarySeam[] =
  Object.values(HostBoundarySeam);

export const SURFACE_OWNED_CONCERNS: readonly SurfaceOwnedConcern[] =
  Object.values(SurfaceOwnedConcern);

/**
 * The two "we have no rows" states, kept adjacent so a reader adding a third
 * empty-ish state has to look at both. A renderer that maps these to the same
 * output has reproduced the defect the state set exists to prevent.
 */
export const DISTINCT_EMPTY_STATES: readonly CompleteSurfaceState[] = [
  CompleteSurfaceState.FilteredEmpty,
  CompleteSurfaceState.GenuineEmpty,
] as const;

/**
 * The states that are NOT a claim about the population — "we did not compute
 * this", in its three forms. None of them may render as a zero, a blank, or as
 * either {@link DISTINCT_EMPTY_STATES} member.
 */
export const NON_POPULATION_STATES: readonly CompleteSurfaceState[] = [
  CompleteSurfaceState.Loading,
  CompleteSurfaceState.Unavailable,
  CompleteSurfaceState.Error,
] as const;

/** Whether a concern is a host's to fill. Every other concern is the surface's. */
export function isHostBoundarySeam(value: string): value is HostBoundarySeam {
  return KNOWN_HOST_BOUNDARY_SEAMS.has(value);
}

/** Whether a concern belongs to the surface and may never be host-supplied. */
export function isSurfaceOwnedConcern(
  value: string
): value is SurfaceOwnedConcern {
  return KNOWN_SURFACE_OWNED_CONCERNS.has(value);
}

const KNOWN_HOST_BOUNDARY_SEAMS = new Set<string>(HOST_BOUNDARY_SEAMS);
const KNOWN_SURFACE_OWNED_CONCERNS = new Set<string>(SURFACE_OWNED_CONCERNS);
