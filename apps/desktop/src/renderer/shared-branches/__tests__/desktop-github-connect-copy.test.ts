import { describe, expect, it } from "vitest";
import { DesktopGitHubConnectState } from "../../components/branches/use-desktop-github-connect";
import {
  DesktopGitHubConnectSurface,
  desktopGitHubConnectFailureMessage,
  desktopGitHubConnectMessage,
} from "../desktop-github-connect-copy";
import { listSurfacePageNounsNamedIn } from "./connect-status-page-noun-fixture";

const SURFACES = Object.values(DesktopGitHubConnectSurface);
/**
 * The list-shaped surfaces, which each render on more than one page. Derived by
 * excluding the one that does not: a hand-listed pair would not visit a third
 * list variant, which is how `list` itself came to serve four pages unnoticed.
 */
const LIST_SURFACES = SURFACES.filter(
  (surface) => surface !== DesktopGitHubConnectSurface.Panel
);
/**
 * Every state, derived — not the three that speak today. A hand-copied triple
 * would not visit a fourth state added to `STATE_MESSAGE`, and the page-noun
 * guard below is exactly the check a new state must not skip. The states that
 * render nothing resolve to `null` and the guard skips them by name.
 */
const ALL_STATES = Object.values(DesktopGitHubConnectState);
const PRODUCT_NAME_RE = /closedloop/i;
const SIGN_IN_REQUIRED_OPENING = "GitHub sign-up was not completed.";
const SIGN_IN_REQUIRED_OPENING_RE = /^GitHub sign-up was not completed\./;

describe("desktopGitHubConnectMessage", () => {
  it.each([DesktopGitHubConnectState.Idle, DesktopGitHubConnectState.Pending])(
    "says nothing for the non-terminal %s state",
    (state) => {
      expect(
        desktopGitHubConnectMessage(state, DesktopGitHubConnectSurface.List)
      ).toBeNull();
    }
  );

  it.each(SURFACES)(
    "gives every surface ONE spelling of sign-in-required (%s)",
    (surface) => {
      const content = desktopGitHubConnectMessage(
        DesktopGitHubConnectState.SignInRequired,
        surface
      );

      expect(content?.tone).toBe("warning");
      // One spelling of WHAT HAPPENED, everywhere — then at most one
      // surface-specific continuation, which is the shape this map declares.
      expect(content?.message).toMatch(SIGN_IN_REQUIRED_OPENING_RE);
      // …and every surface must add one: a bare "it did not complete" leaves the
      // reader with no next step and nothing about what still works.
      expect(content?.message.length).toBeGreaterThan(
        SIGN_IN_REQUIRED_OPENING.length
      );
    }
  );

  it("keeps a retained-data continuation on a failed open, named for no one page", () => {
    expect(
      desktopGitHubConnectMessage(
        DesktopGitHubConnectState.Failed,
        DesktopGitHubConnectSurface.List
      )
    ).toEqual({
      tone: "error",
      message:
        "GitHub connect could not be opened. Local data remains available.",
    });
  });

  it("reports the opened handoff as success, pointing at the page in hand", () => {
    expect(
      desktopGitHubConnectMessage(
        DesktopGitHubConnectState.Opened,
        DesktopGitHubConnectSurface.List
      )
    ).toEqual({
      tone: "success",
      message:
        "Continue in the browser to connect GitHub. This page updates when the connection is available.",
    });
  });

  /**
   * ISS-11326 (found by whitlockk on #7990). The `list` surface renders on four
   * pages, so a continuation that names ONE of them is wrong on the other three.
   * This runs over every state rather than the two that were wrong, so a FOURTH
   * caller cannot inherit a sentence naming somebody else's page.
   */
  it.each(LIST_SURFACES)(
    "never names one page in any %s continuation",
    (surface) => {
      const spoken = ALL_STATES.map((state) => ({
        state,
        message: desktopGitHubConnectMessage(state, surface)?.message,
      })).filter((entry) => entry.message !== undefined);

      // Positive half first, and it is what stops this passing vacuously: a
      // surface that stopped speaking entirely names no page either.
      expect(spoken.map((entry) => entry.state)).toEqual([
        DesktopGitHubConnectState.Opened,
        DesktopGitHubConnectState.SignInRequired,
        DesktopGitHubConnectState.Failed,
      ]);
      for (const entry of spoken) {
        expect(listSurfacePageNounsNamedIn(entry.message)).toEqual([]);
      }
    }
  );

  /**
   * ISS-11326: the stalled Branches slot renders only at `isLoading && !hasData`
   * under a "Loading branches…" spinner, so it must NOT tell the reader their
   * local data is available — there is none on screen to be available. The
   * populated list surfaces keep that line, which the case below pins, so this
   * pair is what stops either half being "fixed" into the other.
   */
  it("withholds the retained-data line from the stalled list, and keeps it on the populated one", () => {
    expect(
      desktopGitHubConnectMessage(
        DesktopGitHubConnectState.Failed,
        DesktopGitHubConnectSurface.StalledList
      )?.message
    ).toBe("GitHub connect could not be opened. Try again.");
    expect(
      desktopGitHubConnectMessage(
        DesktopGitHubConnectState.Failed,
        DesktopGitHubConnectSurface.List
      )?.message
    ).toBe("GitHub connect could not be opened. Local data remains available.");
  });

  /**
   * The user-facing half of the ISS-11326 hoist: `list` and `panel` say the SAME
   * thing about where to watch for the handoff. It pins the WORDS agreeing, not
   * that one literal produces both — two spellings that happen to match still
   * pass here, and are what let `list` drift onto a page name while the `panel`
   * sentence beside it stayed correct.
   */
  it("gives both surfaces the same pending-connection continuation", () => {
    const list = desktopGitHubConnectMessage(
      DesktopGitHubConnectState.Opened,
      DesktopGitHubConnectSurface.List
    )?.message;
    const panel = desktopGitHubConnectMessage(
      DesktopGitHubConnectState.Opened,
      DesktopGitHubConnectSurface.Panel
    )?.message;

    expect((list ?? "").trim().length).toBeGreaterThan(0);
    expect(panel).toBe(list);
  });

  // ISS-5958 M4 retired the one entry that named the product (the sign-in-
  // required line, which now reports the declared sign-up action instead), so
  // no message in this map spells it today. The guard therefore runs over EVERY
  // state rather than that one: the miscasing it caught arrived with copy
  // landing here, and the next entry to name the product must not bring it back.
  it.each(SURFACES)("never miscases the product name on %s", (surface) => {
    for (const state of Object.values(DesktopGitHubConnectState)) {
      const message =
        desktopGitHubConnectMessage(state, surface)?.message ?? "";
      const mention = message.match(PRODUCT_NAME_RE);
      expect(message).not.toContain("ClosedLoop");
      expect(mention === null || mention[0] === "Closedloop").toBe(true);
    }
  });
});

describe("desktopGitHubConnectFailureMessage", () => {
  it("stays silent on the successful handoff", () => {
    expect(
      desktopGitHubConnectFailureMessage(
        DesktopGitHubConnectState.Opened,
        DesktopGitHubConnectSurface.Panel
      )
    ).toBeNull();
  });

  it.each([
    [
      DesktopGitHubConnectState.Failed,
      "GitHub connect could not be opened. Try again.",
    ],
    [
      DesktopGitHubConnectState.SignInRequired,
      "GitHub sign-up was not completed. Try again.",
    ],
  ] as const)("reports %s on a panel surface", (state, expected) => {
    expect(
      desktopGitHubConnectFailureMessage(
        state,
        DesktopGitHubConnectSurface.Panel
      )
    ).toBe(expected);
  });
});
