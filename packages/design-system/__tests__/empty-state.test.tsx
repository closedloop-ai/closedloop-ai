import { EmptyState } from "@closedloop-ai/design-system/components/ui/empty-state";
import { render, screen } from "@testing-library/react";
import { InboxIcon } from "lucide-react";
import { describe, expect, it } from "vitest";

const EMPTY_STATE_SLOT = '[data-slot="empty-state"]';

describe("EmptyState slot marker", () => {
  it.each(["default", "compact"] as const)(
    "marks the %s root so a page walk can count empty states",
    (size) => {
      const { container } = render(
        <EmptyState icon={InboxIcon} size={size} title="Nothing here" />
      );

      const roots = container.querySelectorAll(EMPTY_STATE_SLOT);
      expect(roots).toHaveLength(1);
      expect(roots[0]).toContainElement(screen.getByText("Nothing here"));
    }
  );
});
