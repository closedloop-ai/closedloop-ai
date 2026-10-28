/**
 * `activity-dot-rendering.ts` owns both directions of the dot contract — kind to
 * lane (`getMarkerDotColor`) and persisted token back to kind
 * (`getEventMarkerKind`) — so the two cannot drift apart. Drift is silent: a
 * failure repainted into the human-steering lane still renders, still has an
 * accessible name, and still clicks; only the verdict is wrong.
 *
 * ISS-6672 asks for bucket-count-to-dot-density thresholds. No density function
 * exists in this module — that work lives in the sibling
 * `activity-bucket-rendering.ts`, which has its own suite.
 */

import { describe, expect, it } from "vitest";
import {
  type DotColor,
  getDotButtonLabel,
  getDotColorToken,
  getDotLabel,
  getDotShape,
  getEventMarkerKind,
  getMarkerDotColor,
} from "../activity-dot-rendering";
import type { ActivityMarker } from "../session-timeline-axis";

describe("getMarkerDotColor — lane assignment", () => {
  it.each(Object.entries(LANE_BY_KIND))(
    "plots a %s marker in the %s lane",
    (kind, lane) => {
      expect(getMarkerDotColor(kind as ActivityMarker["kind"])).toBe(lane);
    }
  );

  it("gives every marker kind a lane — none is silently dropped from the strip", () => {
    // The trailing `return null` is the escape hatch for a kind the strip does
    // not plot; today there is none, and one that stopped resolving would leave
    // a real event off the timeline with no other symptom.
    const kinds = Object.keys(LANE_BY_KIND) as ActivityMarker["kind"][];
    expect(kinds.map((kind) => getMarkerDotColor(kind))).not.toContain(null);
  });

  it("keeps the three lanes disjoint — a failure never reads as human steering", () => {
    expect(getMarkerDotColor("fail")).not.toBe(getMarkerDotColor("prompt"));
    expect(getMarkerDotColor("fail")).not.toBe(getMarkerDotColor("commit"));
    expect(getMarkerDotColor("commit")).not.toBe(getMarkerDotColor("prompt"));
  });
});

describe("getEventMarkerKind — the inverse direction", () => {
  it.each(DOT_TOKENS)(
    "round-trips the persisted %s token back to its own lane",
    (token) => {
      // A one-sided retokenizing reprojects every persisted marker into the wrong
      // lane on reload, with no error anywhere.
      expect(getMarkerDotColor(getEventMarkerKind(token))).toBe(token);
    }
  );

  it.each([
    ["absent", undefined],
    ["unrecognized", "x"],
    ["empty", ""],
  ])(
    "degrades an %s dot token to a plotted marker rather than dropping it",
    (_case, token) => {
      // Cross-repo skew: a version-skewed producer's new `dot` token must still
      // land on the strip.
      const kind = getEventMarkerKind(token as string | undefined);
      expect(kind).toBe("prompt");
      expect(getMarkerDotColor(kind)).not.toBeNull();
    }
  );
});

describe("getDotButtonLabel — the accessible name must not promise a jump", () => {
  it.each(DOT_TOKENS)("drops 'Jump to' for a withdrawn %s dot", (color) => {
    const withdrawn = getDotButtonLabel(color, true);
    const jumpable = getDotButtonLabel(color, false);

    expect(withdrawn).toBe(getDotLabel(color));
    expect(withdrawn).not.toMatch(JUMP_PREFIX);
    // Paired: a helper returning the bare label unconditionally satisfies the
    // assertion above but fails here.
    expect(jumpable).toBe(`Jump to ${getDotLabel(color)}`);
  });
});

describe("getDotColorToken — lanes stay visually distinguishable", () => {
  it("paints each lane with the timeline's own marker token, never a shared one", () => {
    // ISS-10676 / ISS-12117: the shared `--primary` / `--success` /
    // `--destructive` collided with the strip's `--chart-*` bars.
    expect(getDotColorToken("g")).toBe("var(--sd3-marker-delivery)");
    expect(getDotColorToken("r")).toBe("var(--sd3-marker-failure)");
    expect(getDotColorToken("b")).toBe("var(--sd3-marker-steering)");
  });

  it("draws every lane in a shape of its own", () => {
    // ISS-12117: hue alone cannot separate the three marks, so each has its
    // own shape.
    expect(getDotShape("r")).toBe("diamond");
    expect(getDotShape("g")).toBe("circle");
    expect(getDotShape("b")).toBe("square");
  });

  it("never paints two lanes the same colour", () => {
    const tokens = DOT_TOKENS.map((color) => getDotColorToken(color));
    expect(new Set(tokens).size).toBe(DOT_TOKENS.length);
  });

  it("gives each lane a distinct human name, so hue is never the only signal", () => {
    // WCAG 1.4.1 — the tooltip and the accessible name carry the lane in words.
    const labels = DOT_TOKENS.map((color) => getDotLabel(color));
    expect(new Set(labels).size).toBe(DOT_TOKENS.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });
});

/**
 * Exhaustive over the union, so a new kind fails `tsc` here rather than falling
 * through `getMarkerDotColor`'s trailing `return null` and vanishing.
 */
const LANE_BY_KIND: Record<ActivityMarker["kind"], DotColor> = {
  commit: "g",
  pr: "g",
  fail: "r",
  limit: "r",
  prompt: "b",
  frust: "b",
};

/** The persisted tokens a synced row can carry, in the order the strip stacks. */
const DOT_TOKENS: readonly DotColor[] = ["b", "g", "r"];

/** The jump promise a withdrawn dot's accessible name must not carry. */
const JUMP_PREFIX = /^Jump to/;
