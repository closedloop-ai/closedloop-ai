// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { genericArtifacts } from "../../fixtures";
import { GridInteractionArtifactListSurface } from "../grid-interaction-artifact-list-surface";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

describe("GridInteractionArtifactListSurface", () => {
  it("renders the shared artifact grid inside the canonical interaction contract", () => {
    const { container } = render(
      <GridInteractionArtifactListSurface
        artifacts={genericArtifacts.slice(0, 3)}
        onOpenArtifact={vi.fn()}
        showDateRangeControl={false}
        showSummaryCards={false}
      />
    );

    const contract = container.querySelector(
      '[data-grid-interaction-contract="pointer-hover"]'
    );
    expect(contract).not.toBeNull();
    expect(contract?.querySelector("[data-grid-row]")).not.toBeNull();
  });
});
