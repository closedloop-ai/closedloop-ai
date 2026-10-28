/**
 * How long a blocking (no-data-yet) load may run before the UI escalates. A
 * `soft` phase is reached first — the loading affordance stays but gains a
 * retry — and a `hard` phase after that, where the surface should show an
 * actionable "temporarily unavailable" error rather than an endless spinner.
 *
 * ISS-9105: the DETECTOR that advances this (`useLoadingStall`) is desktop-only
 * by placement — it exists because the desktop Sessions read has no query-level
 * timeout — but the phase itself is now a prop on a shared surface, so the type
 * lives where both shells can reach it rather than being re-declared beside the
 * consumer that cannot import the hook.
 */
export type LoadingStallPhase = "none" | "soft" | "hard";
