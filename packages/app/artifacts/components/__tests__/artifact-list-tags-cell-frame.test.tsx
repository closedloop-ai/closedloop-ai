import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArtifactListCell } from "../artifact-list-cells";

// The Tags cell's chip press navigates through the app's ports, which this
// harness does not mount.
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => (path: string) => path,
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
}));

describe("ArtifactListCell tags", () => {
  it("draws no column divider of its own: the grid cell draws it", () => {
    const { container } = render(
      <TooltipProvider>
        <ArtifactListCell
          columnId="tags"
          document={createMockDocument({
            tags: [{ id: "tag-1", name: "Design system", color: "purple" }],
          })}
          editHandlers={{}}
        />
      </TooltipProvider>
    );
    expect(container).toHaveTextContent("Design system");
    expect(container.querySelector(".border-l")).toBeNull();
  });
});
