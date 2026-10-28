import {
  sortableSubtreeAnnouncementData,
  sortableSubtreeAnnouncementLabel,
} from "@closedloop-ai/design-system/components/ui/sortable-subtree";
import type { Active } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

function activeWith(data: Record<string, unknown>): Active {
  return {
    data: { current: data },
    id: "internal-row-id",
    rect: { current: { initial: null, translated: null } },
  };
}

describe("sortableSubtreeAnnouncementData (ISS-12905)", () => {
  it("round-trips a label to the announcement reader", () => {
    expect(
      sortableSubtreeAnnouncementLabel(
        activeWith(sortableSubtreeAnnouncementData("Delivery plan"))
      )
    ).toBe("Delivery plan");
  });

  it.each([undefined, "", "   "])(
    "reads %j as no label, never the internal id",
    (label) => {
      expect(
        sortableSubtreeAnnouncementLabel(
          activeWith(sortableSubtreeAnnouncementData(label))
        )
      ).toBeUndefined();
    }
  );
});
