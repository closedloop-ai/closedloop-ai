// @vitest-environment node
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExpandableWidget } from "../expandable-widget";

/**
 * FEA-3700 — the widget's stable portal host is created synchronously via a
 * lazy `useState` initializer so `children` mount exactly once on the client
 * (no inline-then-portal remount). That initializer runs during render, and a
 * `"use client"` component is STILL server-rendered by Next.js for the initial
 * HTML — where `document` does not exist. This test runs in the Node
 * environment (no jsdom, no `document`) to pin that host creation is guarded:
 * server rendering must not throw `ReferenceError: document is not defined`.
 * React skips portals during SSR regardless, so a null host on the server is
 * correct — the children hydrate into the synchronously-created host on the
 * client's first render.
 */
describe("ExpandableWidget SSR safety (FEA-3700)", () => {
  it("renders on the server without touching document", () => {
    expect(() =>
      renderToString(
        <ExpandableWidget title="Model Usage">
          <div>widget body content</div>
        </ExpandableWidget>
      )
    ).not.toThrow();
  });
});
