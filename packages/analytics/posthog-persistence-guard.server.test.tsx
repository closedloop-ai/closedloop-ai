// @vitest-environment node
/**
 * ISS-8660: the guard's server half.
 *
 * `AnalyticsProvider` mounts at a root layout, so this component is rendered on
 * the server on every request. Every other suite here runs under jsdom, where
 * `globalThis.window` is always defined — so nothing else would notice a module-
 * or render-scope browser read, which throws a request rather than degrading.
 *
 * This carries more weight since the sweep moved into the render phase. While it
 * was a layout effect, React discarded it during `renderToString` on its own and
 * the module's `globalThis.window` branch could not be observed either way. A
 * render-phase sweep has no such backstop: it runs wherever the component
 * renders, so the browser check is now the only thing keeping it off the server.
 */
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LIVE client, deliberately. Standing `usePostHog` down to `null` here would
 * make every case below pass on the null check alone, never reaching the browser
 * check it claims to cover — so the client is present and the only reason
 * nothing happens is that there is no browser.
 */
const serverClient = vi.hoisted(() => ({
  get_property: vi.fn(),
  register: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@posthog/next", () => ({ usePostHog: () => serverClient }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PostHogPersistenceGuard on the server", () => {
  it("imports and renders to nothing where there is no browser", async () => {
    const { PostHogPersistenceGuard } = await import(
      "./posthog-persistence-guard"
    );

    const html = renderToString(<PostHogPersistenceGuard />);

    expect(html).toBe("");
  });

  it("never touches the client it was handed", async () => {
    const { PostHogPersistenceGuard } = await import(
      "./posthog-persistence-guard"
    );

    renderToString(<PostHogPersistenceGuard />);

    // Reading is as wrong as writing: there is no persistence behind a server
    // client, so a sweep here can only ever report a repair that did not happen.
    expect(serverClient.get_property).not.toHaveBeenCalled();
    expect(serverClient.register).not.toHaveBeenCalled();
    expect(serverClient.capture).not.toHaveBeenCalled();
  });

  it("has no browser global to read at import time", () => {
    // Pins the premise rather than assuming it: under jsdom the case above
    // would pass having exercised the browser branch instead.
    expect(globalThis.window).toBeUndefined();
  });
});
