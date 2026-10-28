import { SESSION_FIXTURE_NOW_MS } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Shared test helper for suites that mount a CLIENT-side Sessions surface on the
 * shared row fixtures (ISS-8217).
 *
 * `createSessionTableRowFixture` pins every row's instants to
 * {@link SESSION_FIXTURE_NOW_MS}, a FIXED point in time, so that its relative
 * labels ("2h ago") state something true. Once the client resolver began
 * applying the selected date window, those rows aged past the default range
 * against the wall clock and every such mount rendered an empty table — a
 * columns/cells/seams test failing on the calendar, and failing later and later
 * as the fixture instant recedes.
 *
 * Pinning `Date` to the fixture's own present makes the rows as recent as their
 * labels claim, so the window admits them and each suite goes on testing what it
 * is named for. This does NOT opt out of the window: the filter still runs, it
 * is simply measured from the instant the fixtures were written against.
 *
 * ONLY `Date` is faked. React's scheduler, `@testing-library`'s async helpers
 * and the surface's own window-refresh interval keep real timers, so pinning the
 * clock cannot change how a render is scheduled.
 *
 * A suite that needs a DIFFERENT instant (one testing the window itself) should
 * pin its own clock rather than call this.
 */
export function pinSessionFixtureClock(): void {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SESSION_FIXTURE_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}
