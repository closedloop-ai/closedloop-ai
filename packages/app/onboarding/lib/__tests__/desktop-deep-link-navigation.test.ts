import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDesktopApp } from "../desktop-deep-link-navigation";

/**
 * ISS-11429. The deep link must stay PAYLOAD-FREE.
 *
 * `apps/desktop/src/main/lifecycle/deep-link.ts` denies any host, path, query,
 * fragment or credentials by default, so a link carrying walkthrough or session
 * state is refused outright rather than acted on — the desktop's own held state
 * is what decides where its run resumes. A caller that "helpfully" appended a
 * resume hint would silently stop the hand-back working at all, with no error
 * anywhere, which is exactly the shape this case exists to kill.
 */

// `vi.stubGlobal` rather than a descriptor swap: jsdom's `location` and its
// methods are non-configurable, so `Object.defineProperty` throws outright.
// `unstubAllGlobals` restores it unconditionally.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openDesktopApp", () => {
  it("navigates to the bare scheme and nothing more", () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...globalThis.location, assign });

    openDesktopApp();

    expect(assign).toHaveBeenCalledWith(DESKTOP_DEEP_LINK_URL);
    const [target] = assign.mock.calls[0] as [string];
    // Asserted against the URL's own shape, not just equality with the constant:
    // the constant could not change without this, but a call site appending to it
    // could, and that is the reachable mistake.
    expect(target).toBe("closedloop://");
    expect(target.replace("closedloop://", "")).toBe("");
  });
});
