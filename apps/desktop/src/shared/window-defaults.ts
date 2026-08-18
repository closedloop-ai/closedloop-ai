/**
 * The desktop window's default (fresh-window) size.
 *
 * FEA-4001 put these on `src/main/window.ts`, which statically imports
 * `electron`, so nothing outside the Electron main process could read them, and
 * the tests and E2E specs that need to measure the app AT its launch width all
 * re-declared `1380` as a local literal instead. ISS-5068 moved them here, into a
 * leaf module with no imports at all, so those callers can import the real
 * constant and track the shipped width instead of drifting from it. `window.ts`
 * still owns the `BrowserWindow` call that applies them.
 *
 * FEA-4001: width was widened from 1280 → 1380 so the first-launch dashboard
 * summary-card titles (notably "Active Branches") render on a single line out of
 * the box. This is only the default/initial width, the app does not persist
 * window bounds, so there is nothing to override; if bounds restore is ever
 * added, keep it applied AFTER these defaults.
 *
 * Widened again, 1380 → 1400, with the height deliberately left where FEA-4001
 * put it. Both bounds are set by the SMALLEST supported display, a 13" MacBook
 * Air at 1440 × 900 logical:
 *
 *  - WIDTH 1400, not 1440. 1440 is that display's full logical width, so a
 *    default of 1440 opens flush to both screen edges — which reads as a stuck
 *    maximize rather than as a window someone is meant to arrange, and gives up
 *    the inset FEA-4001 stayed under the ceiling to keep (#4445 review). 1400
 *    leaves 40px of desktop showing around a centred fresh window and is still
 *    20px wider than before. Treat 1440 as a hard ceiling and do not park the
 *    default at it; if we ever actually want to fill the display, that is a
 *    maximize-on-first-launch call, not a default-size call.
 *  - HEIGHT 800, unchanged, and this is the constraint it satisfies: macOS takes
 *    TWO bites out of 900, not one — the menu bar (~25px) and the Dock in its
 *    default visible bottom position (~70px with its padding). The usable work
 *    area is therefore ~800, and 800 is the tallest fresh window whose bottom
 *    edge stays grabbable. An earlier revision of this change proposed 861 on
 *    "900 − 861 = 39px for the menu bar"; that arithmetic counted only one of the
 *    two pieces of chrome and would have opened the window with the bottom of the
 *    Sessions list behind the Dock (#4445 review).
 *  - There is deliberately NO clamp against the actual display size. Electron
 *    already places a window that exceeds the work area, and a clamp would add a
 *    branch nothing has asked to exercise.
 *
 * It does NOT make the five Sessions summary cards fit one rank at comfortable
 * density: five comfortable cards need `5 × 260 + 4 × 16 = 1364` of track and
 * {@link SESSIONS_STRIP_TRACK_WIDTH} is nowhere near it, so the COMPACT strip
 * density (ISS-5068, now unconditional) stays load-bearing — it is what buys the
 * single rank at this width. See the note on {@link SESSIONS_STRIP_TRACK_WIDTH}
 * for the arithmetic and for why no width that is actually wider avoids the
 * comfortable-density orphan.
 */
export const DEFAULT_WINDOW_WIDTH = 1400;
export const DEFAULT_WINDOW_HEIGHT = 800;

/**
 * The 16rem (`w-64`) nav rail every desktop page sits beside.
 *
 * The widths below are ONE chain off {@link DEFAULT_WINDOW_WIDTH} rather than
 * four independent literals, because the repo used to carry two of them as
 * unrelated constants — 1079 and 1092 for the SAME strip at the SAME window —
 * and a reader could not tell which was the real track (#4445 review). They
 * differ by exactly the scrollbar; naming each step is what makes that checkable
 * instead of leaving a 13px gap nobody can attribute.
 */
export const NAV_RAIL_WIDTH = 256;

/** The page's own inset gutter between the rail and the content column. */
export const CONTENT_INSET_GUTTER = 16;

/**
 * The vertical scrollbar the real renderer reserves out of the content column.
 * jsdom runs no layout engine and reserves nothing, which is the entire source
 * of the gap between the COMPUTED and MEASURED track widths below.
 */
export const CONTENT_SCROLLBAR_WIDTH = 13;

/**
 * The Sessions content area — the width the table grid lays its columns out in.
 * COMPUTED, no scrollbar: this is the number the jsdom column-fold suites pin.
 */
export const SESSIONS_CONTENT_WIDTH =
  DEFAULT_WINDOW_WIDTH - NAV_RAIL_WIDTH - CONTENT_INSET_GUTTER;

/**
 * The summary strip's track inside that content area, once the host's `px-4`
 * gutter is shed. COMPUTED, no scrollbar — the number `packages/app`'s jsdom
 * fixtures pin, because jsdom is where they run.
 */
export const SESSIONS_STRIP_COMPUTED_TRACK_WIDTH =
  SESSIONS_CONTENT_WIDTH - CONTENT_INSET_GUTTER;

/**
 * The same strip track as the real renderer MEASURES it, scrollbar included.
 * This is the number an E2E run sees, and the one `summary-card-row.tsx` sizes
 * the dense floor against.
 *
 * Both this and {@link SESSIONS_STRIP_COMPUTED_TRACK_WIDTH} sit above the
 * `4 × 260 + 3 × 16 = 1088` a fourth `auto-fit` column needs and below the 1364
 * a fifth needs, so the shipped (gate-OFF) strip lays five cards in four columns
 * and strands the last one against three dead cells.
 *
 * State the cost plainly rather than pricing it off whichever model flatters the
 * change (#4445 review). MEASURED — the number the renderer actually lays out on
 * — this widening IS what moves the break: 1079 at the old 1380 default was under
 * 1088 and closed 3 + 2; 1099 is over it and closes 4 + 1, which is the worse of
 * the two ranks. COMPUTED, the jsdom model, was already 1092 at 1380 and so
 * already answered four, which is why
 * `packages/app/shared/hooks/use-summary-card-columns.ts` describes the
 * quarter-width FEA-2935 orphan as what the DEFAULT window renders and why the
 * repo carried both answers for the old launch rank at once. The widening puts
 * the two models on the same side of 1088, so they now agree; it does not make
 * the rank they agree on a good one.
 *
 * Keeping 3 + 2 and widening are mutually exclusive here: the measured track
 * crosses 1088 at a ~1389px window, so any default that still closes 3 + 2 is
 * ≤1388 — i.e. no wider than the 1380 this replaces — and a fifth column needs a
 * ~1665px window, past the 1440 ceiling. Closing the orphan is therefore not a
 * default-size lever at all; it is `resolveSummaryCardColumns` (ISS-4966, now
 * unconditional), which caps trailing empty cells at one at whatever width the
 * window opens.
 */
export const SESSIONS_STRIP_TRACK_WIDTH =
  SESSIONS_STRIP_COMPUTED_TRACK_WIDTH - CONTENT_SCROLLBAR_WIDTH;
