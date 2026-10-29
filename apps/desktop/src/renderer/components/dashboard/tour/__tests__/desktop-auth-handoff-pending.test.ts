/**
 * ISS-11315 Defect 4: which auth statuses hold the first-launch tour's one shot.
 *
 * THE MAPPING HAD NO COVERAGE AT ALL, and the modal-exclusion suite beside this
 * one cannot supply it: that suite drives `useTourArming` with `handoffPending`
 * as a direct boolean, so it pins what the HOOK does with the answer and nothing
 * about which statuses produce it. Measured by counterfactual — reverting
 * `Exchanging` to `false` left every case in that file green.
 *
 * It is the half that was actually wrong. The first fix released the hold at
 * `Exchanging`, on the reasoning that the browser had already come back; but the
 * takeover has not answered by then, so the falling edge was spent, the
 * permanent `dashboardOnboardedStorageKey` latch was written, the tour opened,
 * and Choose organization opened on top of it (tamsinb + codex review, and the
 * operator's 2026-09-27 recording).
 *
 * The expectation is a `Record` over the status union rather than a list of the
 * interesting members, so adding a status fails `tsc` here and has to declare
 * which side of the hold it is on — the same correction
 * `HANDOFF_PENDING_BY_STATUS` itself carries.
 */

import { describe, expect, it } from "vitest";
import { DesktopAuthStatus } from "../../../../../shared/contracts";
import { isDesktopAuthHandoffPending } from "../use-tour-arming";

/** Whether the account run is out at the system browser and coming back. */
const EXPECTED_PENDING: Record<DesktopAuthStatus, boolean> = {
  [DesktopAuthStatus.Loading]: false,
  [DesktopAuthStatus.SignedOut]: false,
  [DesktopAuthStatus.OpeningBrowser]: true,
  [DesktopAuthStatus.AwaitingRedirect]: true,
  // The status this ticket's review moved. The redeem is in flight, so no run
  // source is offering a snapshot and the tour standing folds to `Owed` off a
  // read that never happened.
  [DesktopAuthStatus.Exchanging]: true,
  // Needs no hold of its own: the snapshot query is enabled by here, so the
  // standing reads `Unread` until the host answers and the arm declines on that.
  [DesktopAuthStatus.Authenticated]: false,
  [DesktopAuthStatus.RefreshFailed]: false,
};

describe("isDesktopAuthHandoffPending", () => {
  for (const [status, pending] of Object.entries(EXPECTED_PENDING)) {
    it(`${pending ? "holds" : "releases"} on ${status}`, () => {
      expect(isDesktopAuthHandoffPending(status as DesktopAuthStatus)).toBe(
        pending
      );
    });
  }
});
