import { ArtifactType } from "@repo/api/src/types/artifact";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The grid/card seam. `DocumentRow` measures its own container, so the layout
// is chosen here the way `document-row-card-fallback.test.tsx` chooses it:
// < 768 renders the card, >= 768 the grid. Both render the SAME `NameCell`
// cluster, which is why one status mapping has to be pinned on both.
const mockWidth = vi.fn<() => number>(() => 1024);

vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: mockWidth() }),
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// Radix portals tooltip content only while open, which a hover-less jsdom
// render never reaches. Rendering it inline is what makes the row's visible
// status caption assertable at all.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { StatusIcon } from "@repo/design-system/components/ui/status-icon";

const FAILED_CAPTION = SESSION_STATUS_LABELS[SESSION_STATUS.ERROR];

const FAILED_SESSION_ROW: DocumentRowItem = {
  kind: "session",
  data: makeRawArtifact(ArtifactType.Session, {
    id: "ses-failed",
    name: "Nightly refactor run",
    status: SESSION_STATUS.ERROR,
  }),
};

/** Layout name, the container width that selects it, whether it is the card. */
const LAYOUTS = [
  ["grid", 1024, false],
  ["card", 360, true],
] as const;

/** The card fallback's own root — `GridTableCard` builds on the DS `Card`. */
const CARD_SELECTOR = '[data-slot="card"]';

afterEach(() => {
  cleanup();
  mockWidth.mockReturnValue(1024);
});

/**
 * ISS-8692. A failed session used to render the DOCUMENT-phase `wont-do` mark:
 * a neutral X whose own accessible name is "Won't do", under a row already
 * captioned "Failed". Two things have to hold now, and neither is "an icon
 * rendered" — that assertion was always true and is what let the wrong mark
 * ship: the icon has to DRAW what `failed` draws (not the cancellation mark in
 * a different colour), and the caption beside it has to be the same word.
 *
 * Both layouts are asserted because the card and the grid share one `NameCell`
 * cluster: the mapping has one answer, and a fix that reached only the wide
 * layout would leave a phone-width reader with the old mark.
 */
describe("DocumentRow — a failed session's status icon (flag on)", () => {
  it.each(LAYOUTS)(
    "draws the failed mark in the %s layout and captions it Failed",
    (_layout, width, isCard) => {
      mockWidth.mockReturnValue(width);
      const expected = primitiveMarkOf(
        <StatusIcon size={16} status="failed" />,
        "Failed"
      );

      const { container } = renderRow(true);

      // The layout is asserted before the mark, so neither case can pass on the
      // other's copy of the shared cluster and leave one reader uncovered.
      expect(Boolean(container.querySelector(CARD_SELECTOR))).toBe(isCard);
      expect(markOf(FAILED_CAPTION)).toBe(expected);
      expect(captions()).toContain(FAILED_CAPTION);
    }
  );

  it("does not draw the wont-do mark for a failed session", () => {
    // The teeth of the case above: `getByRole` finds the icon by the caption
    // the row already supplied, so an unchanged `wont-do` glyph wearing that
    // caption would still be found. This pins the glyph it must NOT be.
    const wontDo = primitiveMarkOf(
      <StatusIcon size={16} status="wont-do" />,
      "Won't do"
    );

    renderRow(true);

    expect(markOf(FAILED_CAPTION)).not.toBe(wontDo);
  });
});

/**
 * The closed-by-default half (ISS-4779). With the gate off the row must draw
 * exactly the mark it drew before this change — a rollout that is off has to be
 * indistinguishable from not having shipped.
 */
describe("DocumentRow — a failed session's status icon (flag off)", () => {
  it.each(LAYOUTS)(
    "keeps the pre-rollout mark in the %s layout",
    (_layout, width, isCard) => {
      mockWidth.mockReturnValue(width);
      const wontDo = primitiveMarkOf(
        <StatusIcon size={16} status="wont-do" />,
        "Won't do"
      );

      const { container } = renderRow(false);

      expect(Boolean(container.querySelector(CARD_SELECTOR))).toBe(isCard);
      expect(markOf(FAILED_CAPTION)).toBe(wontDo);
    }
  );
});

function renderRow(failedStatusIconEnabled: boolean) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: failedStatusIconEnabled
          ? [FAILED_SESSION_STATUS_ICON_FEATURE_FLAG_KEY]
          : [],
      })}
    >
      <DocumentRow item={FAILED_SESSION_ROW} visibleColumns={[]} />
    </FeatureFlagAdapterProvider>
  );
}

/**
 * The mark the row drew, taken from the icon carrying `caption` — its children
 * only, so the accessible name the row supplies is not part of the comparison
 * and cannot make two different glyphs look equal.
 */
function markOf(caption: string): string {
  return screen.getByRole("img", { name: caption }).innerHTML;
}

/** The mark one `StatusIcon` status draws on its own, for attribution. */
function primitiveMarkOf(icon: ReactElement, caption: string): string {
  const view = render(icon);
  const markup = markOf(caption);
  view.unmount();
  return markup;
}

function captions(): string[] {
  return screen
    .getAllByTestId("tooltip-content")
    .map((node) => node.textContent ?? "");
}
