import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@repo/design-system/components/ui/card";
import {
  CARD_COMFORTABLE_SLOT_UTILITIES,
  CARD_COMPACT_SLOT_UTILITIES,
  CARD_DENSITY_ATTRIBUTE,
  CARD_DENSITY_VARIANT_CLASS,
  CardDensity,
} from "@repo/design-system/components/ui/card-density";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-5070 item 1: the density used to be six descendant overrides written
 * inline on `SummaryCardRow`, with NOTHING linking the values it wrote to the
 * primitive's own. The day `Card` went `px-6` → `px-5`, that string still said
 * `px-4` against a different baseline and no test noticed, because the tests
 * asserted the class string rather than the RELATIONSHIP.
 *
 * This file is that missing link. It asserts the comfortable column of
 * `card-density.ts` against what the REAL `Card` family renders — so moving a
 * padding on the primitive fails here, beside the step-down that has just
 * stopped stepping down from anything, instead of silently desynchronising a
 * string in another package.
 *
 * It lives in `packages/app` rather than beside `card-density.ts` because
 * `packages/design-system` declares no `test` script and is not in the PR CI
 * test filter set — a spec there would never run, which is precisely the kind of
 * silent non-coverage this file exists to prevent. It sits beside
 * `summary-card-row-density.test.tsx`, its only consumer's test.
 */

function slot(container: HTMLElement, name: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  if (!el) {
    throw new Error(`No [data-slot="${name}"] rendered`);
  }
  return el;
}

function renderCardFamily() {
  const { container } = render(
    <Card>
      <CardHeader className="border-b">Header</CardHeader>
      <CardContent>Content</CardContent>
      <CardFooter className="border-t">Footer</CardFooter>
    </Card>
  );
  return container;
}

describe("Card comfortable baseline (ISS-5070)", () => {
  it("still ships every utility the compact variant steps down from", () => {
    const container = renderCardFamily();

    // Card's own box: the gap between slots and its vertical padding.
    const card = slot(container, "card");
    expect(card.className).toContain(CARD_COMFORTABLE_SLOT_UTILITIES.cardGap);
    expect(card.className).toContain(
      CARD_COMFORTABLE_SLOT_UTILITIES.cardPaddingY
    );

    // The three horizontal gutters. Asserted per slot rather than once, because
    // they are three independent declarations in `card.tsx` and only one of them
    // has to drift for a rank to render mismatched gutters.
    expect(slot(container, "card-header").className).toContain(
      CARD_COMFORTABLE_SLOT_UTILITIES.headerPaddingX
    );
    expect(slot(container, "card-content").className).toContain(
      CARD_COMFORTABLE_SLOT_UTILITIES.contentPaddingX
    );
    expect(slot(container, "card-footer").className).toContain(
      CARD_COMFORTABLE_SLOT_UTILITIES.footerPaddingX
    );
  });

  it("declares a compact step-down that is genuinely smaller on every slot", () => {
    // A step-down that accidentally equals its baseline is a no-op variant that
    // would still pass a "the class is present" assertion. Compare the two
    // columns as the numbers they are.
    const pairs: [string, string][] = [
      [
        CARD_COMFORTABLE_SLOT_UTILITIES.cardGap,
        CARD_COMPACT_SLOT_UTILITIES.cardGap,
      ],
      [
        CARD_COMFORTABLE_SLOT_UTILITIES.cardPaddingY,
        CARD_COMPACT_SLOT_UTILITIES.cardPaddingY,
      ],
      [
        CARD_COMFORTABLE_SLOT_UTILITIES.headerPaddingX,
        CARD_COMPACT_SLOT_UTILITIES.headerPaddingX,
      ],
      [
        CARD_COMFORTABLE_SLOT_UTILITIES.contentPaddingX,
        CARD_COMPACT_SLOT_UTILITIES.contentPaddingX,
      ],
      [
        CARD_COMFORTABLE_SLOT_UTILITIES.footerPaddingX,
        CARD_COMPACT_SLOT_UTILITIES.footerPaddingX,
      ],
    ];
    for (const [comfortable, compact] of pairs) {
      const comfortableStep = Number(comfortable.split("-").at(-1));
      const compactStep = Number(compact.split("-").at(-1));
      expect(Number.isFinite(comfortableStep)).toBe(true);
      expect(compactStep).toBeLessThan(comfortableStep);
    }
  });
});

describe("Card density variant (ISS-5070)", () => {
  it("self-gates every rule on the compact attribute value", () => {
    // The property that makes this a VARIANT rather than a patch: a host applies
    // the class unconditionally and switches with one attribute. A rule that
    // forgot its `[data-density=compact]` prefix would apply at comfortable
    // density too, which is the ungated perceivable change ISS-4779 forbids.
    const rules = CARD_DENSITY_VARIANT_CLASS.split(" ").filter(Boolean);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.startsWith(`[&[data-density=${CardDensity.Compact}]_`)).toBe(
        true
      );
    }
  });

  it("covers the footer and bordered-seam slots the inline patch missed (item 1a)", () => {
    // `MetricCard` renders no footer today, so nothing was broken — but a rank
    // accepts arbitrary children, and a card with a footer among compact
    // siblings would have rendered 24px gutters beside 16px ones.
    expect(CARD_DENSITY_VARIANT_CLASS).toContain(
      `[data-slot=card-footer]]:${CARD_COMPACT_SLOT_UTILITIES.footerPaddingX}`
    );
    expect(CARD_DENSITY_VARIANT_CLASS).toContain(
      `.border-b[data-slot=card-header]]:pb-${CARD_COMPACT_SLOT_UTILITIES.borderedSeamPadding}`
    );
    expect(CARD_DENSITY_VARIANT_CLASS).toContain(
      `.border-t[data-slot=card-footer]]:pt-${CARD_COMPACT_SLOT_UTILITIES.borderedSeamPadding}`
    );
  });

  it("names the attribute hosts set, so the two sides cannot drift", () => {
    expect(CARD_DENSITY_ATTRIBUTE).toBe("data-density");
    expect(CARD_DENSITY_VARIANT_CLASS).toContain(
      `[&[${CARD_DENSITY_ATTRIBUTE}=${CardDensity.Compact}]_`
    );
  });
});
