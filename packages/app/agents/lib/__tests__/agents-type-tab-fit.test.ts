import { describe, expect, it } from "vitest";
import {
  estimateTypeTabWidthPx,
  fitTypeTabs,
  partitionTypeTabs,
  resolveVisibleTypeTabCount,
} from "../agents-type-tab-fit";

// ISS-4803: the real strip vocabulary — `All` plus the seven SCOPED_CORE_KINDS
// plurals from `kindMeta`, in KIND_ORDER. The fit is only interesting against
// the labels that actually ship.
const STRIP_LABELS = [
  "All",
  "Agents",
  "Commands",
  "Skills",
  "Plugins",
  "MCPs",
  "Tools",
  "Hooks",
] as const;

// The reported viewport (ISS-4803 evidence: `a-web-list-mobile.png` at 390px)
// minus the row's `px-4` padding on both sides, which is the CONTENT width
// `useContainerWidth` reports.
const NARROW_ROW_CONTENT_WIDTH_PX = 390 - 32;

// A desktop window's worth of row: the whole strip has to stay expanded here or
// the fix would hide tabs that fit, which is a regression, not a fix.
const WIDE_ROW_CONTENT_WIDTH_PX = 1200;

type Tab = { value: string; label: string };

function tabs(...labels: readonly string[]): Tab[] {
  return labels.map((label) => ({ value: label.toLowerCase(), label }));
}

describe("resolveVisibleTypeTabCount", () => {
  it("keeps every tab on the strip at a desktop row width", () => {
    expect(
      resolveVisibleTypeTabCount(STRIP_LABELS, WIDE_ROW_CONTENT_WIDTH_PX)
    ).toBe(STRIP_LABELS.length);
  });

  it("drops the tabs that do not fit a 390px phone row", () => {
    const visible = resolveVisibleTypeTabCount(
      STRIP_LABELS,
      NARROW_ROW_CONTENT_WIDTH_PX
    );

    // The exact count depends on the label widths, but the property the ticket
    // is about is that the strip stops SHORT of the full set at this width —
    // and still shows more than the single guaranteed segment.
    expect(visible).toBeLessThan(STRIP_LABELS.length);
    expect(visible).toBeGreaterThan(1);
  });

  it("never collapses the whole strip, even below one segment's width", () => {
    expect(resolveVisibleTypeTabCount(STRIP_LABELS, 1)).toBe(1);
  });

  it("returns every tab when the row has not been measured yet", () => {
    // 0 / NaN / -1 all mean "no measurement": SSR, a detached container, the
    // frame before the observer reports. Collapsing on a guess would hide tabs
    // that fit, so the unmeasured fallback is the full strip.
    for (const unmeasured of [0, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(resolveVisibleTypeTabCount(STRIP_LABELS, unmeasured)).toBe(
        STRIP_LABELS.length
      );
    }
  });

  it("widens the visible set as the row widens", () => {
    const atNarrow = resolveVisibleTypeTabCount(
      STRIP_LABELS,
      NARROW_ROW_CONTENT_WIDTH_PX
    );
    const atMedium = resolveVisibleTypeTabCount(STRIP_LABELS, 640);

    expect(atMedium).toBeGreaterThan(atNarrow);
  });

  it("spends the last segment's reserve on the segment instead of the control", () => {
    // The final tab has no overflow control to reserve room for, so a row that
    // fits every tab but not the control still shows every tab.
    const exactly = STRIP_LABELS.reduce(
      (total, label) => total + estimateTypeTabWidthPx(label),
      6
    );

    expect(resolveVisibleTypeTabCount(STRIP_LABELS, exactly)).toBe(
      STRIP_LABELS.length
    );
  });
});

describe("partitionTypeTabs", () => {
  it("splits at the visible count when the active tab already fits", () => {
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = partitionTypeTabs(
      all,
      3,
      (tab) => tab.value === "agents"
    );

    expect(visible.map((tab) => tab.label)).toEqual([
      "All",
      "Agents",
      "Commands",
    ]);
    expect(overflow.map((tab) => tab.label)).toEqual([
      "Skills",
      "Plugins",
      "MCPs",
      "Tools",
      "Hooks",
    ]);
  });

  it("pulls an overflowed active tab into the last visible slot", () => {
    // The selected segment is the only thing telling the user what the catalog
    // below is filtered to. If it fell into the menu, every visible segment
    // would render unselected, which reads as "All".
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = partitionTypeTabs(
      all,
      3,
      (tab) => tab.value === "hooks"
    );

    expect(visible.map((tab) => tab.label)).toEqual(["All", "Agents", "Hooks"]);
    // The displaced segment goes to the FRONT of the overflow, so the menu
    // still reads in strip order.
    expect(overflow.map((tab) => tab.label)).toEqual([
      "Commands",
      "Skills",
      "Plugins",
      "MCPs",
      "Tools",
    ]);
  });

  it("keeps the leading All segment visible when the active tab is pulled in", () => {
    const all = tabs(...STRIP_LABELS);
    const { visible } = partitionTypeTabs(
      all,
      2,
      (tab) => tab.value === "tools"
    );

    expect(visible.map((tab) => tab.label)).toEqual(["All", "Tools"]);
  });

  it("gives the single remaining slot to the active tab, not to All", () => {
    // The narrowest case the fit can produce. One slot has to say what the
    // catalog is filtered to, so All is the segment that gives way.
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = partitionTypeTabs(
      all,
      1,
      (tab) => tab.value === "mcps"
    );

    expect(visible.map((tab) => tab.label)).toEqual(["MCPs"]);
    expect(overflow[0]?.label).toBe("All");
  });

  it("returns an empty overflow when every tab fits", () => {
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = partitionTypeTabs(
      all,
      all.length,
      (tab) => tab.value === "hooks"
    );

    expect(visible).toHaveLength(all.length);
    expect(overflow).toEqual([]);
  });

  it("clamps a visible count past either end of the list", () => {
    const all = tabs("All", "Agents");

    expect(
      partitionTypeTabs(all, 99, () => false).visible.map((tab) => tab.label)
    ).toEqual(["All", "Agents"]);
    expect(partitionTypeTabs(all, -5, () => false)).toEqual({
      visible: [],
      overflow: all,
    });
  });
});

// The total the strip actually occupies once pinned: group chrome + every
// visible tab + the overflow control when there is anything to disclose.
// Recomputed here from the module's OWN per-tab estimator rather than from
// copied constants, so a change to the tab estimate moves the expectation with
// it instead of silently drifting from what the strip renders.
const GROUP_CHROME_PX = 6;
const OVERFLOW_CONTROL_PX = 68;

function pinnedStripWidthPx(labels: readonly string[], hasOverflow: boolean) {
  return (
    GROUP_CHROME_PX +
    labels.reduce((total, label) => total + estimateTypeTabWidthPx(label), 0) +
    (hasOverflow ? OVERFLOW_CONTROL_PX : 0)
  );
}

describe("fitTypeTabs", () => {
  it("keeps the pinned strip inside the row at every width and selection", () => {
    // The bug this guards (codex, PR #4685): `resolveVisibleTypeTabCount`
    // measures the LEADING run, then `partitionTypeTabs` may swap a wider
    // active tab in for the last of them — so the count and the set it was
    // applied to disagree, and the selected tab is clipped inside the scroll
    // track while ALSO being absent from the overflow menu. Swept rather than
    // spot-checked because the failing band is narrow (~13px at its worst) and
    // depends on which label is selected.
    const all = tabs(...STRIP_LABELS);
    const offenders: string[] = [];

    for (let widthPx = 120; widthPx <= 1500; widthPx += 0.5) {
      for (const active of all) {
        const { visible, overflow } = fitTypeTabs(
          all,
          widthPx,
          (tab) => tab.value === active.value,
          (tab) => tab.label
        );
        const neededPx = pinnedStripWidthPx(
          visible.map((tab) => tab.label),
          overflow.length > 0
        );
        // A single tab is the floor: a row too narrow for even one segment
        // still shows it rather than collapsing the whole control to a button.
        if (visible.length > 1 && neededPx > widthPx) {
          offenders.push(
            `${widthPx}px/${active.label}: needs ${neededPx}px for [${visible
              .map((tab) => tab.label)
              .join(", ")}]`
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("drops to the selected tab alone rather than clipping it", () => {
    // The reviewer's exact case. At 230px the leading-run fit admits
    // All + Agents (228.5px); selecting Commands would replace Agents and need
    // 241.5px. The refit gives the row the one thing it can hold.
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = fitTypeTabs(
      all,
      230,
      (tab) => tab.value === "commands",
      (tab) => tab.label
    );

    expect(visible.map((tab) => tab.label)).toEqual(["Commands"]);
    expect(overflow.map((tab) => tab.label)).toContain("All");
    expect(pinnedStripWidthPx(["Commands"], true)).toBeLessThanOrEqual(230);
  });

  it("never loses, duplicates, or hides the active tab while shrinking", () => {
    const all = tabs(...STRIP_LABELS);

    for (let widthPx = 120; widthPx <= 600; widthPx += 7) {
      for (const active of all) {
        const { visible, overflow } = fitTypeTabs(
          all,
          widthPx,
          (tab) => tab.value === active.value,
          (tab) => tab.label
        );

        expect(visible).toContain(active);
        expect([...visible, ...overflow]).toHaveLength(all.length);
        expect(new Set([...visible, ...overflow]).size).toBe(all.length);
      }
    }
  });

  it("keeps the whole strip expanded on a desktop row", () => {
    // The refit must not shrink a row that already fits — that would be the
    // regression, not the fix.
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = fitTypeTabs(
      all,
      WIDE_ROW_CONTENT_WIDTH_PX,
      (tab) => tab.value === "hooks",
      (tab) => tab.label
    );

    expect(visible).toHaveLength(all.length);
    expect(overflow).toEqual([]);
  });

  it("renders every tab when the row has not been measured", () => {
    // Unmeasured (SSR, detached, first paint) must not collapse on a guess.
    const all = tabs(...STRIP_LABELS);

    for (const widthPx of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const { visible, overflow } = fitTypeTabs(
        all,
        widthPx,
        (tab) => tab.value === "hooks",
        (tab) => tab.label
      );

      expect(visible).toHaveLength(all.length);
      expect(overflow).toEqual([]);
    }
  });

  it("still fits the narrow phone row the ticket reported", () => {
    const all = tabs(...STRIP_LABELS);
    const { visible, overflow } = fitTypeTabs(
      all,
      NARROW_ROW_CONTENT_WIDTH_PX,
      (tab) => tab.value === "all",
      (tab) => tab.label
    );

    expect(overflow.length).toBeGreaterThan(0);
    expect(
      pinnedStripWidthPx(
        visible.map((tab) => tab.label),
        true
      )
    ).toBeLessThanOrEqual(NARROW_ROW_CONTENT_WIDTH_PX);
  });
});
