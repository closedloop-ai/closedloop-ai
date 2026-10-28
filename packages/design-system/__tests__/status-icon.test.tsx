import { StatusIcon } from "@closedloop-ai/design-system/components/ui/status-icon";
import { FilledStatusCircle } from "@closedloop-ai/design-system/components/ui/status-icon-primitives";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

/**
 * ISS-8692, in THIS package's own lane (codex review, PR #6397). The `failed`
 * member's name and mark are `StatusIcon`'s own render behavior, so a
 * regression in either has to redden `pnpm --filter @closedloop-ai/design-system test`.
 * The assertion previously lived only in `apps/app/__tests__/`, which this
 * lane does not collect — the primitive could have lost its accessible name or
 * its distinct geometry with the design-system's required lane still green.
 *
 * Three claims, and none of them is "an icon rendered" — that was true
 * throughout the defect and is what let the wrong mark ship:
 *
 *  - the UN-OVERRIDDEN accessible name. The artifact table supplies its own
 *    `aria-label`, so that surface already announced "Failed" while drawing the
 *    cancellation X; a consumer WITHOUT the override hears the member's own
 *    name, which is the half this pins.
 *  - the mark, against `wont-do`. Both are terminal-and-not-success, so they
 *    must part on what they DRAW and not on hue alone (WCAG 1.4.1), and
 *    `failed` must carry the danger tone rather than the neutral foreground the
 *    document-phase cancellation uses.
 *  - the mark, against the `--warning` exclamation. This is the ISS-6801
 *    decision-maker's 2026-09-01 ruling; see the case for why it is taken
 *    against the primitive rather than against the domain icons.
 */

const FILL_ATTRIBUTE_REGEX = /fill="[^"]*"/g;
const DESTRUCTIVE_FILL = 'fill="var(--destructive)"';

afterEach(cleanup);

describe("StatusIcon — the failed member (ISS-8692)", () => {
  it("names it 'Failed' without a caller-supplied label", () => {
    render(<StatusIcon size={16} status="failed" />);

    // `getByRole` with a name throws when nothing carries it, so resolving at
    // all IS the accessible-name assertion.
    expect(screen.getByRole("img", { name: "Failed" })).toBeInTheDocument();
  });

  it("draws a different mark from wont-do, with fills erased", () => {
    render(<StatusIcon size={16} status="failed" />);
    const failedGeometry = geometryOf(
      screen.getByRole("img", { name: "Failed" })
    );
    cleanup();

    render(<StatusIcon size={16} status="wont-do" />);
    const wontDoGeometry = geometryOf(
      screen.getByRole("img", { name: "Won't do" })
    );

    // Fills erased and the `<svg>`'s own attributes excluded, so neither the
    // differing colour nor the differing label can satisfy this alone.
    expect(failedGeometry).not.toBe(wontDoGeometry);
  });

  /**
   * The ISS-6801 decision-maker's 2026-09-01 ruling ("new glyph"), pinned.
   *
   * `failed` used to BORROW `FilledExclamationCircle` — the exact primitive
   * `IssueStatusIcon` draws for Blocked and `DocumentStatusIcon` for Changes
   * requested, one row away in the same artifact-table column — and parted from
   * them on fill alone. Those domain icons live in `@repo/app`, which this
   * package is gated from importing, so the comparison is taken against the
   * PRIMITIVE they render, which is the thing the geometry actually came from.
   */
  it("draws a different mark from the exclamation Blocked and Changes requested use", () => {
    render(<StatusIcon size={16} status="failed" />);
    const failedGeometry = geometryOf(
      screen.getByRole("img", { name: "Failed" })
    );
    cleanup();

    render(
      <FilledStatusCircle
        fill="var(--warning)"
        glyph="exclamation"
        label="Blocked"
        size={16}
      />
    );
    const blockedGeometry = geometryOf(
      screen.getByRole("img", { name: "Blocked" })
    );

    expect(failedGeometry).not.toBe(blockedGeometry);
  });

  it("fills it with the danger token, where wont-do stays neutral", () => {
    render(<StatusIcon size={16} status="failed" />);
    const failedMark = screen.getByRole("img", { name: "Failed" }).innerHTML;
    cleanup();

    render(<StatusIcon size={16} status="wont-do" />);
    const wontDoMark = screen.getByRole("img", { name: "Won't do" }).innerHTML;

    expect(failedMark).toContain(DESTRUCTIVE_FILL);
    expect(wontDoMark).not.toContain(DESTRUCTIVE_FILL);
  });

  it("keeps caller spread overrides for the filled terminal mark", () => {
    render(<StatusIcon fill="rgb(10, 11, 12)" size={16} status="complete" />);

    expect(
      screen
        .getByRole("img", { name: "Complete" })
        .querySelector("circle")
        ?.getAttribute("fill")
    ).toBe("rgb(10, 11, 12)");
  });
});

/**
 * What an icon DRAWS: its children with every fill erased, and none of the
 * `<svg>`'s own attributes — so a colour change and a label change both drop
 * out of the comparison.
 */
function geometryOf(icon: HTMLElement): string {
  return icon.innerHTML.replace(FILL_ATTRIBUTE_REGEX, 'fill=""');
}

/**
 * ISS-9557. The one arm of `StatusIcon` whose rendered output the appearance
 * reconciliation deliberately changed.
 *
 * Before it, an out-of-union status resolved `STATUS_LABELS[status]` to
 * `undefined`, React dropped the attribute, and the icon shipped as a
 * `role="img"` with NO accessible name — announced as an unlabeled graphic.
 * No typed call site reaches the arm (both `row-type-registry` folds are
 * total), so only a cast or malformed persisted data gets here, which is why
 * the change was kept rather than reverted for byte-parity.
 *
 * Pinned because the only other test on this path asserts that an svg rendered,
 * which was true throughout the defect.
 */
describe("StatusIcon — an out-of-union status (ISS-9557)", () => {
  it("names the fallback mark rather than shipping an unlabeled graphic", () => {
    render(<StatusIcon size={16} status={"NOT_A_STATUS" as "backlog"} />);

    expect(screen.getByRole("img", { name: "Status" })).toBeInTheDocument();
  });

  it("draws it as the muted marker, not as an empty To do ring", () => {
    // The positive sibling: a name alone would pass if the fallback silently
    // became the `todo` circle, which reads as a real, known status.
    render(<StatusIcon size={16} status={"NOT_A_STATUS" as "backlog"} />);

    const track = screen
      .getByRole("img", { name: "Status" })
      .querySelector("circle");

    expect(track?.getAttribute("stroke")).toBe("var(--muted-foreground)");
    expect(track?.getAttribute("stroke-width")).toBe("1.5");
  });

  it.each(["__proto__", "constructor", "toString"])(
    "treats prototype-chain status %s as unknown",
    (status) => {
      render(<StatusIcon size={16} status={status as "backlog"} />);

      expect(screen.getByRole("img", { name: "Status" })).toBeInTheDocument();
      const track = screen
        .getByRole("img", { name: "Status" })
        .querySelector("circle");
      expect(track?.getAttribute("stroke")).toBe("var(--muted-foreground)");
    }
  );
});
