import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ControlVisibilitySection } from "@/app/[locale]/(site)/components/home/control-visibility-section";
import { SystemVisualSection } from "@/app/[locale]/(site)/components/home/system-visual-section";

/**
 * Both sections are static marketing mocks: every conditional is driven by a
 * module-private fixture rather than a prop, so the contract each test pins is
 * "this fixture renders these states", not "this component accepts an input".
 * Asserting counts rather than presence is what makes that load-bearing — a
 * predicate widened to always-true still renders the string, just more often.
 */

// Fragments unique to ONE arm of the `index === 0` ternary, not the whole
// className: the static half (`rounded-xl border p-5 transition-colors`) is
// this component's styling, not its branch, so pinning it would turn a class
// added there — or a class sorter reordering it — into a red test with nothing
// about `index === 0` having changed.
const HIGHLIGHTED_POINT = "bg-accent/40";
const PLAIN_POINT = "hover:bg-accent/20";
const DONE_STEP_MARKER =
  'text-[11px] border-success/30 bg-success/10 text-success">✓<';
const PENDING_STEP_PREFIX =
  'text-[11px] border-border bg-muted/60 text-muted-foreground">';
const STRUCK_TITLE = "text-muted-foreground line-through";

const SIDEBAR_BADGE =
  '<span class="rounded-full bg-primary/15 px-1.5 py-px font-medium text-[10px] text-primary">3</span>';
const ACTIVE_TAB = "border-primary text-foreground";
const INACTIVE_TAB = "border-transparent text-muted-foreground";
const ACTIVE_CHIP =
  "rounded px-2.5 py-1 font-medium text-xs bg-muted text-foreground";
const INACTIVE_CHIP =
  "rounded px-2.5 py-1 font-medium text-xs text-muted-foreground";
const ACTIVE_SIDEBAR_ITEM = "bg-sidebar-accent text-sidebar-accent-foreground";
const GROUP_CHEVRON_OPEN =
  "lucide-chevron-down h-4 w-4 shrink-0 text-muted-foreground";
const GROUP_CHEVRON_CLOSED =
  "lucide-chevron-right h-4 w-4 shrink-0 text-muted-foreground";

describe("ControlVisibilitySection", () => {
  const html = renderToStaticMarkup(<ControlVisibilitySection />);

  test("highlights only the first control point", () => {
    // `index === 0` widened to `index >= 0` renders three highlights, so the
    // count is the assertion — presence alone would survive that mutation.
    expect(occurrences(html, HIGHLIGHTED_POINT)).toBe(1);
    expect(occurrences(html, PLAIN_POINT)).toBe(2);
  });

  test("marks the two completed plan steps done and leaves the rest numbered", () => {
    expect(occurrences(html, DONE_STEP_MARKER)).toBe(2);
    expect(occurrences(html, STRUCK_TITLE)).toBe(2);
  });

  test("numbers a step whose caller omits `done` instead of ticking it", () => {
    // Steps 3 and 4 pass no `done`, so they exercise the `done = false` default
    // parameter. A default flipped to `true` renders "✓" here instead.
    expect(html).toContain(`${PENDING_STEP_PREFIX}3<`);
    expect(html).toContain(`${PENDING_STEP_PREFIX}4<`);
    expect(occurrences(html, PENDING_STEP_PREFIX)).toBe(2);
  });
});

describe("SystemVisualSection", () => {
  const html = renderToStaticMarkup(<SystemVisualSection />);

  test("renders a count badge only for the sidebar item that carries one", () => {
    // One of the two workspace items carries `badge: null`. `=== null` inverted
    // renders its `null` badge as an empty pill instead of nothing at all.
    expect(occurrences(html, SIDEBAR_BADGE)).toBe(1);
    expect(occurrences(html, "bg-primary/15 px-1.5")).toBe(1);
  });

  test("marks exactly one sidebar item, one tab and one filter chip active", () => {
    expect(occurrences(html, ACTIVE_SIDEBAR_ITEM)).toBe(1);
    expect(occurrences(html, ACTIVE_TAB)).toBe(1);
    expect(occurrences(html, INACTIVE_TAB)).toBe(2);
    expect(occurrences(html, ACTIVE_CHIP)).toBe(1);
    expect(occurrences(html, INACTIVE_CHIP)).toBe(4);
  });

  test("points the group chevron down when open and right when collapsed", () => {
    // Three groups are open and one ("Draft") is collapsed.
    expect(occurrences(html, GROUP_CHEVRON_OPEN)).toBe(3);
    expect(occurrences(html, GROUP_CHEVRON_CLOSED)).toBe(1);
  });

  test("lists the rows of an open group", () => {
    // Pins the open half of `group.open && group.artifacts.map(...)`. The
    // closed half is NOT distinguishable from this fixture: the only collapsed
    // group ships `artifacts: []`, so dropping the `group.open &&` guard
    // renders identically. Reachable only by giving a closed group rows, which
    // is a fixture change this test deliberately does not make.
    expect(html).toContain("FEA-241");
    expect(html).toContain("PRD-218");
  });
});

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
