import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetWebAppOriginCacheForTests,
  useWebAppOrigin,
} from "../use-web-app-origin";

/**
 * ISS-4898: a desktop can be pointed at production, a stage host, or a local dev
 * server through its gateway profile, and the org slug it links with comes from
 * whichever cloud that profile names. Pairing a stage slug with a production
 * origin would link the user at a same-named production org — someone else's
 * data — so the configured origin is read rather than assumed.
 *
 * wongk + codex review: the hook must also fail UNRESOLVED. Seeding state with
 * the production default meant the pending window and every settings-IPC failure
 * produced an allowlisted PRODUCTION href for a non-production org slug, which
 * is the same cross-tenant link the ticket is about — only harder to see,
 * because it looks like a working pill.
 */
function installSettings(settings: unknown) {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getSettings: vi.fn(() => Promise.resolve(settings)) },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
  // ISS-5366: the hook now caches its settled origin process-wide so a mount
  // after any earlier resolution seeds SYNCHRONOUSLY (that cache is the fix for
  // the flash — the pending window it removes is the one the pills were
  // rendering their "not reachable" state into). Module state outlives a test
  // file, so it is dropped here or the next case starts already-resolved with
  // the previous case's origin and every pending-window assertion goes vacuous.
  resetWebAppOriginCacheForTests();
});

describe("useWebAppOrigin (ISS-4898)", () => {
  it("resolves the configured origin", async () => {
    installSettings({ webAppOrigin: "https://app.closedloop-stage.ai" });

    const { result } = renderHook(() => useWebAppOrigin());

    await waitFor(() =>
      expect(result.current.origin).toBe("https://app.closedloop-stage.ai")
    );
  });

  it("normalizes a configured value that carries a path", async () => {
    installSettings({
      webAppOrigin: "https://app.closedloop-stage.ai/some/path",
    });

    const { result } = renderHook(() => useWebAppOrigin());

    await waitFor(() =>
      expect(result.current.origin).toBe("https://app.closedloop-stage.ai")
    );
  });

  it("is unresolved on the first render, before the settings read settles", () => {
    // The pending window is the one the review flagged: identity can resolve
    // first, so a production default here would mint a live prod link for a
    // stage org between mount and this promise settling.
    installSettings({ webAppOrigin: "https://app.closedloop-stage.ai" });

    const { result } = renderHook(() => useWebAppOrigin());

    expect(result.current.origin).toBeNull();
    // ISS-5366: and it says WHY it is null. `origin: null` alone could not tell
    // "the read has not landed" from "there is no usable origin", so a caller
    // gating a link on it rendered its unavailable state over a pending read.
    expect(result.current.isResolved).toBe(false);
  });

  it.each([
    ["an unset origin", {}],
    ["a blank origin", { webAppOrigin: "   " }],
    ["a malformed origin", { webAppOrigin: "not a url" }],
    ["a non-http scheme", { webAppOrigin: "file:///etc/passwd" }],
    ["a non-object settings payload", "nope"],
  ])("stays unresolved for %s", async (_label, settings) => {
    installSettings(settings);

    const { result } = renderHook(() => useWebAppOrigin());

    // An unusable configured value is not evidence that production is the right
    // destination, so it settles on null and the caller keeps the pill inert.
    await waitFor(() =>
      expect(window.desktopApi?.getSettings).toHaveBeenCalled()
    );
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.origin).toBeNull();
  });

  it("stays unresolved when the settings bridge is absent", async () => {
    Reflect.deleteProperty(window, "desktopApi");

    const { result } = renderHook(() => useWebAppOrigin());

    expect(result.current.origin).toBeNull();
    // ISS-5366: SETTLED, not pending. A bridge that will never exist must not
    // leave a caller holding a loading state for the life of the view — the
    // pills degrade to their honest inert label instead.
    await waitFor(() => expect(result.current.isResolved).toBe(true));
  });

  it("stays unresolved when the settings read rejects", async () => {
    const getSettings = vi.fn(() => Promise.reject(new Error("boom")));
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: { getSettings },
    });

    const { result } = renderHook(() => useWebAppOrigin());

    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    // A failed read is a settled absence too, for the same reason.
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.origin).toBeNull();
  });
});
