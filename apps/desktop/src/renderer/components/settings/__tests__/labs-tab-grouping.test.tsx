/**
 * ISS-5310 — the Labs flag list: grouped by category, with dependent flags
 * nested under the parent they are inert without.
 *
 * Two review findings, one surface (stage cid 3726701542 and cid 3726701547):
 *   - a dependency stated in the last sentence of a description is not a
 *     dependency the UI enforces — both Agents display flags stayed fully
 *     flippable while `agentsNav` was off, so you toggled one, nothing happened,
 *     and the reason was in prose you had already skimmed;
 *   - forty-one identical bordered rows in one card, thirty-six wearing a "Labs"
 *     badge inside a card titled Labs, gave the eye no path down a list this PR
 *     had just made load-bearing.
 *
 * Every case drives the real `LabsTab` and asserts on the rendered switches, not
 * on the registry — a regression that only reverted the UI would keep a
 * registry-shaped assertion green.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY,
  FEATURE_FLAGS,
} from "../../../../shared/feature-flags";
import { LabsTab } from "../labs-tab";

const AGENTS_NAV_LABEL = "Agents workspace";
// Derived from the registry rather than listed by hand (ISS-5366): the set of
// Agents-workspace dependents changes whenever a flag graduates or retires, and
// a hardcoded list turns every such change into a red test about nothing. What
// this suite actually owns is that a dependent — whichever ones exist — nests,
// disables, and carries the parent's name.
const DEPENDENT_KEYS = FEATURE_FLAGS.filter(
  (flag) =>
    !flag.hiddenFromLabs &&
    flag.dependsOn === DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY
).map((flag) => flag.key);

afterEach(cleanup);

function renderLabsTab(settings: Record<string, unknown>): void {
  render(<LabsTab onSettingsChange={vi.fn()} settings={settings} />);
}

function switchFor(flagKey: string): HTMLElement {
  const label = FEATURE_FLAGS.find((flag) => flag.key === flagKey)?.label;
  if (!label) {
    throw new Error(`No registry flag for key ${flagKey}`);
  }
  return screen.getByRole("switch", { name: `Toggle ${label}` });
}

describe("ISS-5310 Labs tab — dependent flags", () => {
  it("registers at least one Agents-workspace dependent to assert against", () => {
    // The precondition every case below rests on. Without it, a registry that
    // lost its last dependent would make each `for` loop iterate zero times and
    // pass vacuously.
    expect(DEPENDENT_KEYS.length).toBeGreaterThan(0);
  });

  it("disables every Agents display dependent while the Agents workspace is off", () => {
    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: false });

    for (const key of DEPENDENT_KEYS) {
      expect(switchFor(key).hasAttribute("disabled")).toBe(true);
    }
    // The parent itself stays flippable — the gate must nest, not freeze the
    // whole group.
    expect(
      switchFor(DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY).hasAttribute("disabled")
    ).toBe(false);
  });

  it("enables them once the Agents workspace is on", () => {
    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true });

    for (const key of DEPENDENT_KEYS) {
      expect(switchFor(key).hasAttribute("disabled")).toBe(false);
    }
  });

  it("names the parent to turn on, from the parent's own registry label", () => {
    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: false });

    // One hint per dependent — and the text is the parent's registry label,
    // which is what stops the hint drifting when the parent is renamed.
    expect(
      screen.getAllByText(`Turn on ${AGENTS_NAV_LABEL} first.`)
    ).toHaveLength(DEPENDENT_KEYS.length);
  });

  it("drops the hint once the parent is on", () => {
    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true });

    expect(screen.queryByText(`Turn on ${AGENTS_NAV_LABEL} first.`)).toBeNull();
  });

  it("leaves an unrelated flag alone whatever the Agents workspace is set to", () => {
    // Without this, a regression that disabled every row would satisfy the
    // disabled-case assertions above.
    const unrelated = FEATURE_FLAGS.find(
      (flag) =>
        !(flag.hiddenFromLabs || flag.dependsOn) &&
        flag.key !== DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY
    );
    expect(unrelated).toBeDefined();

    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: false });

    expect(switchFor(unrelated?.key ?? "").hasAttribute("disabled")).toBe(
      false
    );
  });
});

describe("ISS-5310 Labs tab — grouping", () => {
  it("renders one section per category present in the registry", () => {
    renderLabsTab({});

    const categories = new Set(
      FEATURE_FLAGS.filter((flag) => !flag.hiddenFromLabs).map(
        (flag) => flag.category
      )
    );
    expect(categories.size).toBeGreaterThan(1);
    for (const category of categories) {
      expect(screen.getByText(category)).toBeDefined();
    }
  });

  it("stops repeating the category on every row now that the header carries it", () => {
    renderLabsTab({});

    // "Labs" is the category the great majority of rows carried as a badge
    // inside a card already titled Labs. It must now appear exactly once — as
    // that group's section heading — rather than once per row.
    expect(screen.getAllByText("Labs")).toHaveLength(1);
  });

  it("puts each dependent row directly after its parent", () => {
    renderLabsTab({ [DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY]: true });

    const switches = screen.getAllByRole("switch");
    const positionOf = (key: string) => switches.indexOf(switchFor(key));
    const parentPosition = positionOf(DESKTOP_AGENTS_NAV_FEATURE_FLAG_KEY);

    expect(parentPosition).toBeGreaterThanOrEqual(0);
    // Contiguous, in registry order, immediately below the parent — an indent
    // that floats away from what it is indented under explains nothing.
    for (const [offset, key] of DEPENDENT_KEYS.entries()) {
      expect(positionOf(key)).toBe(parentPosition + offset + 1);
    }
  });
});
