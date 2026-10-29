// @vitest-environment jsdom

import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataSyncLevelCard } from "../data-sync-level-card";
import { DataSyncLevelPicker } from "../data-sync-level-picker";
import { DataSyncLevelVisual } from "../data-sync-level-visual";

// Written out by hand rather than derived from DATA_SYNC_LEVEL_COPY: the visual
// is built from that module, so a fixture read from it would pass whatever the
// visual drew. These are the shipped per-level egress rows as they stand, in
// the order the card prints them: session shape, tool-call activity, tool
// inputs & file contents, prompts & completions. `true` = uploaded.
const EXPECTED_UPLOADED_SLOTS: Record<
  | typeof DataSyncLevel.Off
  | typeof DataSyncLevel.Metadata
  | typeof DataSyncLevel.Full,
  readonly boolean[]
> = {
  [DataSyncLevel.Off]: [false, false, false, false],
  [DataSyncLevel.Metadata]: [true, true, false, false],
  [DataSyncLevel.Full]: [true, true, true, true],
};

function visual(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    '[data-slot="data-sync-level-visual"]'
  );
  if (!element) {
    throw new Error("no data-sync level visual rendered");
  }
  return element;
}

describe("DataSyncLevelVisual (ISS-12522)", () => {
  it.each([
    DataSyncLevel.Off,
    DataSyncLevel.Metadata,
    DataSyncLevel.Full,
  ] as const)(
    "draws every category as collected locally and %s's uploads in the slots of the rows that upload",
    (level) => {
      const { container } = render(<DataSyncLevelVisual level={level} />);
      const image = visual(container);
      expect(image.querySelectorAll("[data-collected]")).toHaveLength(4);
      // Per slot, not a count: the picture has to line up with the rows the
      // card prints beneath it, so slot N is uploaded exactly when row N is.
      const cloudSlots = Array.from(
        image.querySelectorAll<HTMLElement>("[data-cloud-slot]")
      ).map((slot) => slot.hasAttribute("data-uploaded"));
      expect(cloudSlots).toEqual(EXPECTED_UPLOADED_SLOTS[level]);
    }
  );
});

describe("DataSyncLevelCard visual slot (ISS-12522)", () => {
  it("renders the visual inside the card, with the rows as its text equivalent (WCAG 1.4.1)", () => {
    const { container } = render(
      <DataSyncLevelCard
        control={<input aria-label="Metadata only" type="radio" />}
        level={DataSyncLevel.Metadata}
        selected={false}
        visual={<DataSyncLevelVisual level={DataSyncLevel.Metadata} />}
      />
    );
    const card = container.querySelector("label") as HTMLElement;
    const image = visual(card);
    // The marks are decorative; the same breakdown is carried in words by the
    // card's rows, in the same card, so nothing is conveyed by the marks alone.
    expect(image).toHaveAttribute("aria-hidden", "true");
    expect(card).toHaveTextContent(
      "Session shape, timing & cost — syncs to cloud"
    );
    expect(card).toHaveTextContent(
      "Prompts & completions — stays on this device"
    );
  });

  it("renders no visual when the host supplies none", () => {
    render(
      <DataSyncLevelCard
        control={<input aria-label="Metadata only" type="radio" />}
        level={DataSyncLevel.Metadata}
        selected
      />
    );
    expect(screen.getByRole("radio")).toBeInTheDocument();
    expect(
      document.querySelector('[data-slot="data-sync-level-visual"]')
    ).toBeNull();
  });

  it("leaves the shipped picker without visuals", () => {
    // Every production surface renders the card through the picker; the
    // policy-choice screen's new visual treatment is deferred, so this must
    // stay byte-identical until a host opts in.
    render(
      <DataSyncLevelPicker
        label="Sync level"
        levels={[DataSyncLevel.Off, DataSyncLevel.Metadata, DataSyncLevel.Full]}
        onSelect={vi.fn()}
        selected={DataSyncLevel.Full}
      />
    );
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(
      document.querySelector('[data-slot="data-sync-level-visual"]')
    ).toBeNull();
  });
});
