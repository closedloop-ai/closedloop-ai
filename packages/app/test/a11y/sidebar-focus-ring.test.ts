/**
 * ISS-10104 — the Node half of the browser read: that a ratio is only ever
 * reported about a colour some `box-shadow` layer is actually painted in.
 *
 * The two e2e specs run this module in a real Chromium and are where the token
 * and the cascade are measured. What they cannot cheaply show is the refusal,
 * because producing a browser whose ring colour and painted shadow DISAGREE is
 * the regression itself. `PaintedSidebarRing` crosses a trust boundary — it is
 * returned by `page.evaluate`, so its shape is not constrained at runtime — and
 * these cases drive that boundary directly.
 */

import { describe, expect, it } from "vitest";
import { ContrastThreshold } from "./contrast";
import {
  type PaintedSidebarRing,
  paintedSidebarRingContrast,
} from "./sidebar-focus-ring";

const UNPAINTED_RING_MESSAGE =
  /No box-shadow layer is painted in the resolved --tw-ring-color/;
const NO_OPAQUE_SURFACE_MESSAGE = /opaque surface/;
const OPAQUE_WHITE_PANEL = ["rgba(0, 0, 0, 0)", "rgb(255, 255, 255)"];

function ringRead(overrides: Partial<PaintedSidebarRing>): PaintedSidebarRing {
  return {
    backgroundsClosestFirst: OPAQUE_WHITE_PANEL,
    boxShadow: "none",
    focusVisible: true,
    insideSidebarPanel: true,
    ringColor: "rgb(0, 0, 0)",
    runningRingTransitions: 0,
    ...overrides,
  };
}

describe("paintedSidebarRingContrast", () => {
  it("measures the shadow layer painted in the resolved ring colour, past the commas inside a colour function", () => {
    // The leading layer is a DIFFERENT colour and carries commas of its own, so
    // a naive split on "," finds no layer at all and a first-layer read finds
    // the wrong one. Black on white is 21:1.
    const ratio = paintedSidebarRingContrast(
      ringRead({
        boxShadow:
          "rgba(17, 24, 39, 0.5) 0px 1px 2px 0px, rgb(0, 0, 0) 0px 0px 0px 2px",
      })
    );

    expect(ratio).toBeCloseTo(21, 1);
    expect(ratio).toBeGreaterThanOrEqual(ContrastThreshold.NonText);
  });

  it("refuses when no layer is painted in the ring colour, rather than reporting a ratio about the token alone", () => {
    // davetho on PR #7316: `--tw-ring-color` still resolves to the compliant
    // token while something else is painted. The old read reported 21:1 here.
    expect(() =>
      paintedSidebarRingContrast(
        ringRead({
          boxShadow: "rgb(203, 213, 225) 0px 0px 0px 2px",
          ringColor: "rgb(0, 0, 0)",
        })
      )
    ).toThrow(UNPAINTED_RING_MESSAGE);
  });

  it("refuses when no ancestor painted an opaque surface, rather than compositing onto an imagined white", () => {
    expect(() =>
      paintedSidebarRingContrast(
        ringRead({
          backgroundsClosestFirst: ["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"],
          boxShadow: "rgb(0, 0, 0) 0px 0px 0px 2px",
        })
      )
    ).toThrow(NO_OPAQUE_SURFACE_MESSAGE);
  });
});
