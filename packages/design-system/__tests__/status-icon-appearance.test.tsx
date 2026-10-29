import {
  STATUS_APPEARANCE_NAMES,
  type StatusAppearance,
  StatusAppearanceIcon,
} from "@closedloop-ai/design-system/components/ui/status-icon-primitives";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-9557. The named visual vocabulary the status-icon families all resolve
 * through. One registry now decides what a shared mark draws, so a repointed
 * name silently changes an Issue, a Document AND a generic phase status at
 * once — which is the reconciliation's benefit and its risk.
 *
 * The oracle below is written out by hand and deliberately duplicates the
 * registry. Deriving it from `STATUS_APPEARANCES` would make every one of these
 * assertions a tautology: the mutation that matters is a name pointed at a
 * different tuple, and a self-derived oracle moves with it. Only the NAME LIST
 * is derived (see the completeness test), because a hand-copied list of a union
 * can be one short without `tsc` — which vitest does not run — objecting.
 *
 * It lives beside `status-icon-primitives-full.test.tsx` rather than inside it
 * on purpose: that suite is read-only characterization ("never change
 * `status-icon-primitives.tsx` to make one of these pass"), and this one is the
 * opposite contract — it is the spec the registry has to meet.
 *
 * Every field here was chosen because a real mutation survived without it: the
 * arc offset (a ring's percentage moved with all four ring records identical),
 * and the glyph ink (a check drawn in its own disc's colour, and a deleted
 * exclamation dot, both passed 1,521 tests).
 */

/** One element of a glyph's ink — everything inside the disc. */
type InkElement =
  | {
      readonly el: "path";
      readonly d: string;
      readonly stroke: string | null;
      readonly fill: string | null;
    }
  | { readonly el: "circle"; readonly r: string; readonly fill: string | null };

type MarkOracle =
  | {
      readonly kind: "ring";
      /** Stroke on the r=9 track circle. */
      readonly trackStroke: string;
      readonly trackStrokeWidth: string;
      /** `null` when the track is solid. */
      readonly trackDashArray: string | null;
      /** Stroke on the r=9 progress arc. `null` when no arc is drawn at all. */
      readonly arcStroke: string | null;
      /**
       * The arc's `stroke-dashoffset` — how much of the ring is left undrawn,
       * so it SHRINKS as the ring fills. Frozen literals: this is the only
       * field that separates the four measurable rings from each other.
       */
      readonly arcDashOffset: number | null;
    }
  | {
      readonly kind: "glyph";
      /** Fill on the r=10 disc. */
      readonly discFill: string;
      /** Everything drawn on top of the disc, in document order. */
      readonly ink: readonly InkElement[];
    };

const PROGRESS = "var(--progress)";
const PROGRESS_FOREGROUND = "var(--progress-foreground)";
const MUTED = "var(--muted-foreground)";
const BACKGROUND = "var(--background)";
const LOW_EMPHASIS_TRACK =
  "color-mix(in oklch, var(--muted-foreground) 40%, transparent)";

/** A glyph stroked in the disc's own colour is invisible; these are the ink. */
const STROKED = (d: string): InkElement => ({
  el: "path",
  d,
  stroke: BACKGROUND,
  fill: "none",
});

const MARKS: Record<StatusAppearance, MarkOracle> = {
  "dashed-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: "3 3",
    arcStroke: null,
    arcDashOffset: null,
  },
  "blank-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: null,
    arcDashOffset: null,
  },
  "empty-ring": {
    kind: "ring",
    trackStroke: LOW_EMPHASIS_TRACK,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: null,
    arcDashOffset: null,
  },
  "quarter-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: PROGRESS_FOREGROUND,
    arcDashOffset: 42.411_500_823_462_205,
  },
  "half-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: PROGRESS_FOREGROUND,
    arcDashOffset: 29.122_563_898_777_383,
  },
  "three-quarter-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: PROGRESS_FOREGROUND,
    arcDashOffset: 14.985_396_957_623_314,
  },
  "full-ring": {
    kind: "ring",
    trackStroke: PROGRESS,
    trackStrokeWidth: "2",
    trackDashArray: null,
    arcStroke: PROGRESS_FOREGROUND,
    arcDashOffset: 0,
  },
  "muted-half-ring": {
    kind: "ring",
    trackStroke: MUTED,
    trackStrokeWidth: "1.5",
    trackDashArray: null,
    arcStroke: MUTED,
    // The same stop `half-ring` draws — the name says so, and the tone and
    // stroke width are the whole difference.
    arcDashOffset: 29.122_563_898_777_383,
  },
  "success-check": {
    kind: "glyph",
    discFill: "var(--success)",
    ink: [STROKED("M6.5 10.5L9.5 13.5L14 7.5")],
  },
  "warning-exclamation": {
    kind: "glyph",
    discFill: "var(--warning)",
    ink: [
      STROKED("M10 5.5V11"),
      // The dot. Deleting it left a bare bar and every suite green.
      { el: "circle", r: "0.9", fill: BACKGROUND },
    ],
  },
  "foreground-x": {
    kind: "glyph",
    discFill: "var(--foreground)",
    ink: [STROKED("M7 7L13 13M13 7L7 13")],
  },
  "ai-swap": {
    kind: "glyph",
    discFill: "var(--ai)",
    ink: [STROKED("M5 10H15M7.5 7.5L5 10L7.5 12.5M12.5 7.5L15 10L12.5 12.5")],
  },
  "destructive-bolt": {
    kind: "glyph",
    discFill: "var(--destructive)",
    // Filled, not stroked — the only glyph in the family that is.
    ink: [
      {
        el: "path",
        d: "M11.6 5.2L6.8 10.8H9.4L8.4 14.8L13.2 9.2H10.6Z",
        stroke: null,
        fill: BACKGROUND,
      },
    ],
  },
};

const APPEARANCES = STATUS_APPEARANCE_NAMES;

afterEach(cleanup);

function draw(appearance: StatusAppearance, thinking = false) {
  const { container } = render(
    <StatusAppearanceIcon
      appearance={appearance}
      label={appearance}
      size={16}
      thinking={thinking}
    />
  );
  return container;
}

/**
 * What an icon DRAWS: the `<svg>`'s children, with none of its own attributes.
 * Comparing the container's `innerHTML` would include `aria-label`, and every
 * caller below passes a different one — which made an earlier revision of the
 * distinctness test pass while two names drew the identical mark.
 */
function markOf(container: HTMLElement): string {
  const svg = container.querySelector("svg");
  if (!svg) {
    throw new Error("expected an svg to render");
  }
  return svg.innerHTML;
}

function childrenOf(container: HTMLElement): Element[] {
  const svg = container.querySelector("svg");
  if (!svg) {
    throw new Error("expected an svg to render");
  }
  return Array.from(svg.children);
}

function circlesOfRadius(container: HTMLElement, radius: string) {
  return Array.from(container.querySelectorAll("circle")).filter(
    (circle) => circle.getAttribute("r") === radius
  );
}

/** The r=9 circle with no transition class — the track sits under the arc. */
function trackOf(container: HTMLElement) {
  const track = circlesOfRadius(container, "9").find(
    (circle) => !(circle.getAttribute("class") ?? "").includes("transition-all")
  );
  if (!track) {
    throw new Error("expected a track circle");
  }
  return track;
}

function arcOf(container: HTMLElement) {
  return (
    circlesOfRadius(container, "9").find((circle) =>
      (circle.getAttribute("class") ?? "").includes("transition-all")
    ) ?? null
  );
}

/** The ink an appearance actually drew, in the oracle's own shape. */
function inkOf(container: HTMLElement): InkElement[] {
  // Element 0 is the disc; everything after it is drawn on top of it.
  return childrenOf(container)
    .slice(1)
    .map((element): InkElement => {
      if (element.tagName.toLowerCase() === "circle") {
        return {
          el: "circle",
          r: element.getAttribute("r") ?? "",
          fill: element.getAttribute("fill"),
        };
      }
      return {
        el: "path",
        d: element.getAttribute("d") ?? "",
        stroke: element.getAttribute("stroke"),
        fill: element.getAttribute("fill"),
      };
    });
}

describe("StatusAppearanceIcon — the vocabulary is complete", () => {
  it("has a recorded mark for every name the registry ships", () => {
    // `Record<StatusAppearance, MarkOracle>` is checked by tsc, which a vitest
    // run does not invoke — so a 14th appearance would otherwise ship with the
    // oracle silently one short and every test below still green.
    expect(new Set(Object.keys(MARKS))).toEqual(new Set(APPEARANCES));
  });
});

describe("StatusAppearanceIcon — what each name draws", () => {
  it.each(APPEARANCES)("draws %s as its recorded mark", (appearance) => {
    const oracle = MARKS[appearance];
    const container = draw(appearance);

    if (oracle.kind === "glyph") {
      const disc = circlesOfRadius(container, "10");
      expect(disc).toHaveLength(1);
      expect(disc[0].getAttribute("fill")).toBe(oracle.discFill);
      // The whole ink list, so a glyph drawn in its own disc's colour, a lost
      // element, or a gained one all redden.
      expect(inkOf(container)).toEqual(oracle.ink);
      // A glyph appearance is a filled disc, never a ring: no track, no arc.
      expect(circlesOfRadius(container, "9")).toHaveLength(0);
      return;
    }

    const track = trackOf(container);
    expect(track.getAttribute("stroke")).toBe(oracle.trackStroke);
    expect(track.getAttribute("stroke-width")).toBe(oracle.trackStrokeWidth);
    expect(track.getAttribute("stroke-dasharray")).toBe(oracle.trackDashArray);

    const arc = arcOf(container);
    expect(arc?.getAttribute("stroke") ?? null).toBe(oracle.arcStroke);
    const offset = arc?.getAttribute("stroke-dashoffset");
    if (oracle.arcDashOffset === null) {
      expect(offset).toBeUndefined();
    } else {
      expect(Number(offset)).toBeCloseTo(oracle.arcDashOffset, 6);
    }
    // A ring appearance never draws a glyph path.
    expect(container.querySelector("path")).toBeNull();
  });

  it("draws a different mark for every name", () => {
    // A weaker claim than it looks, and deliberately stated as such: this pins
    // that no two names resolve to the SAME tuple. It is not a claim that every
    // pair is separable to the eye — `blank-ring` and `empty-ring` differ only
    // in track tone, which the per-name records above pin exactly.
    const marks = APPEARANCES.map((appearance) => {
      const mark = markOf(draw(appearance));
      cleanup();
      return mark;
    });

    expect(new Set(marks).size).toBe(APPEARANCES.length);
  });

  it("falls back for prototype-chain appearance names", () => {
    const { container } = render(
      <StatusAppearanceIcon
        appearance={"__proto__" as StatusAppearance}
        label="Unknown"
        size={16}
      />
    );

    const track = trackOf(container);
    expect(track.getAttribute("stroke")).toBe(PROGRESS);
    expect(track.getAttribute("stroke-dasharray")).toBeNull();
  });

  it("names the mark with the caller's own word, not one of its own", () => {
    // The appearance vocabulary is visual; the sentence a screen reader hears
    // belongs to whichever domain mapped onto it.
    render(
      <StatusAppearanceIcon appearance="success-check" label="Done" size={16} />
    );
    expect(screen.getByRole("img", { name: "Done" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "success-check" })).toBeNull();
  });

  it("lets a caller override the accessible name it was given", () => {
    // The artifact table supplies its own `aria-label` for a derived status;
    // the primitive's spread has to land after the label this component sets.
    render(
      <StatusAppearanceIcon
        appearance="foreground-x"
        aria-label="Closed"
        label="Won't do"
        size={16}
      />
    );
    expect(screen.getByRole("img", { name: "Closed" })).toBeInTheDocument();
  });

  it("lets a caller override the registry defaults through a spread", () => {
    // `Omit<…, "color" | "fill">` only rejects the literal form; a spread of a
    // wider object slips past excess-property checking. The wrapper API has
    // historically let that deliberate override win, so this pins the order.
    const hostileOverrides = { color: "rgb(1, 2, 3)", percentage: 90 };
    const hostile = {
      appearance: "half-ring" as const,
      label: "In progress",
      size: 16 as const,
      ...hostileOverrides,
    };

    const { container } = render(<StatusAppearanceIcon {...hostile} />);

    expect(arcOf(container)?.getAttribute("stroke")).toBe("rgb(1, 2, 3)");
    expect(
      Number(arcOf(container)?.getAttribute("stroke-dashoffset"))
    ).toBeCloseTo(5.654_866_776_461_628, 6);
  });
});

describe("StatusAppearanceIcon — thinking", () => {
  it("replaces a ring's progress arc with the spinner", () => {
    const spinning = draw("half-ring", true);
    expect(arcOf(spinning)).toBeNull();
    const spinner = circlesOfRadius(spinning, "9").find((circle) =>
      (circle.getAttribute("class") ?? "").includes("animate-spin")
    );
    expect(spinner?.getAttribute("stroke")).toBe("var(--thinking)");
  });

  it("leaves the same ring's arc in place when it is not thinking", () => {
    // The positive sibling: without this, a component that stopped drawing an
    // arc at all would satisfy the assertion above.
    const still = draw("half-ring");
    expect(arcOf(still)?.getAttribute("stroke")).toBe(PROGRESS_FOREGROUND);
    expect(
      circlesOfRadius(still, "9").some((circle) =>
        (circle.getAttribute("class") ?? "").includes("animate-spin")
      )
    ).toBe(false);
  });

  it("ignores thinking on a glyph appearance, which has no arc to replace", () => {
    const container = draw("success-check", true);
    expect(container.querySelectorAll("circle")).toHaveLength(1);
    expect(markOf(container)).not.toContain("animate-spin");
  });
});
