/**
 * Tests for the TagsCell in DocumentRow:
 * - Renders TagPicker (with a button trigger) for non-project rows
 * - Renders plain TagChips without a TagPicker for project rows
 * - TagPicker's trigger button calls stopPropagation on click
 */

import type { Artifact } from "@repo/api/src/types/artifact";
import { ArtifactType } from "@repo/api/src/types/artifact";
import type { TagSummary } from "@repo/api/src/types/tag";
import { TagColor } from "@repo/api/src/types/tag";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { tooltipMockModule } from "@repo/app/test/mocks/tooltip";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The overflow indicator's tooltip renders through a Radix portal that never
// mounts in jsdom, so the capped tag's NAME is unreadable without this.
vi.mock("@repo/design-system/components/ui/tooltip", () => tooltipMockModule);

const mockUseFeatureFlagEnabled = vi.fn();

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (flag: string) => mockUseFeatureFlagEnabled(flag),
  // ProjectNameCell reads the completion-empty-state gate through the optional
  // hook (ISS-4792). This tags-focused test does not exercise the ring, so keep
  // the gate OFF to match the production default rather than routing it through
  // the tag flag mock.
  useFeatureFlagEnabledOptional: () => false,
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// TagPicker calls useTags when opened. Mock the hooks module so the picker
// renders without a QueryClient provider.
vi.mock("@repo/app/tags/hooks/use-tags", () => ({
  useTags: vi.fn(() => ({ data: [], isLoading: false })),
  useApplyTag: vi.fn(() => ({ mutate: vi.fn() })),
  useRemoveTag: vi.fn(() => ({ mutate: vi.fn() })),
  useCreateTag: vi.fn(() => ({ mutate: vi.fn() })),
  useUpdateTag: vi.fn(() => ({ mutate: vi.fn() })),
  tagKeys: {
    all: ["tags"],
    lists: () => ["tags", "list"],
    list: () => ["tags", "list", {}],
    details: () => ["tags", "detail"],
    detail: (id: string) => ["tags", "detail", id],
  },
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { DocumentColumn as Col } from "@repo/app/shared/hooks/use-column-visibility";
import {
  makeArtifact,
  makeFeatureArtifact,
} from "@repo/app/shared/test-fixtures/documents";
import { makeProject } from "@repo/app/shared/test-fixtures/project";

// Fixtures

const ADD_TAG_PATTERN = /add tag/i;

const TAG_BLUE: TagSummary = {
  id: "t1",
  name: "backend",
  color: TagColor.Blue,
};
const TAG_RED: TagSummary = { id: "t2", name: "urgent", color: TagColor.Red };
const TAG_GREEN: TagSummary = {
  id: "t3",
  name: "platform",
  color: TagColor.Green,
};

function renderTagsColumn(item: DocumentRowItem) {
  return render(<DocumentRow item={item} visibleColumns={[Col.Tags]} />);
}

/**
 * Same mount, but the navigation store is returned so a chip press can be
 * asserted against the href it actually drove.
 */
function renderTagsColumnWithNav(item: DocumentRowItem) {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  rtlRender(
    <NavigationProvider adapter={nav.adapter}>
      <DocumentRow item={item} visibleColumns={[Col.Tags]} />
    </NavigationProvider>
  );
  return nav;
}

// Tests

describe("TagsCell", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockUseFeatureFlagEnabled.mockReturnValue(true);
  });

  describe("non-project rows", () => {
    it("renders a button trigger that opens the TagPicker popover for an artifact row", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [] }),
      };
      const { container } = renderTagsColumn(item);

      // The TagsCell wraps everything in a <button> trigger for the TagPicker.
      // There should be a button element inside the tags cell.
      const buttons = container.querySelectorAll(
        "button[data-slot='popover-trigger']"
      );
      expect(buttons.length).toBeGreaterThanOrEqual(1);
    });

    it("renders applied tag chips inside the trigger for an artifact row", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [TAG_BLUE, TAG_RED] }),
      };
      renderTagsColumn(item);

      expect(screen.getByText("backend")).toBeInTheDocument();
      expect(screen.getByText("urgent")).toBeInTheDocument();
    });

    /**
     * ISS-9215 (davetho review). Documents is the one surface whose chips
     * NAVIGATE, so they cannot nest inside the picker's trigger button — and
     * that layout used to be bought by handing the run to `TagPicker`, which
     * draws every applied tag uncapped. A 3-tag document therefore widened the
     * cell while Sessions and Branches, sharing the same component, capped at
     * two. The cap belongs to the cell on every surface.
     */
    it("caps the chips and names the overflow instead of widening the cell", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [TAG_BLUE, TAG_RED, TAG_GREEN] }),
      };
      renderTagsColumn(item);

      expect(
        screen.getByRole("button", { name: TAG_BLUE.name })
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: TAG_RED.name })
      ).toBeInTheDocument();
      expect(screen.getByText("+1")).toBeInTheDocument();
      // Past the cap the tag is still NAMED — it moves into the overflow
      // indicator's tooltip rather than being dropped — but it is no longer its
      // own chip, which is the whole point of the cap.
      expect(
        screen.queryByRole("button", { name: TAG_GREEN.name })
      ).not.toBeInTheDocument();
      expect(screen.getByText(TAG_GREEN.name)).toBeInTheDocument();
    });

    it("still routes a visible chip to that tag's search", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [TAG_BLUE, TAG_RED, TAG_GREEN] }),
      };
      const nav = renderTagsColumnWithNav(item);

      fireEvent.click(screen.getByRole("button", { name: TAG_BLUE.name }));

      // The cap must not cost the surviving chips their navigation: capping by
      // rendering plain, unpressable chips would satisfy the case above.
      expect(nav.getCurrentHref()).toBe(
        `/test-org/search?tagId=${TAG_BLUE.id}`
      );
    });

    it("renders applied tag chips inside the trigger for a feature row", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeFeatureArtifact({ tags: [TAG_BLUE] }),
      };
      renderTagsColumn(item);

      expect(screen.getByText("backend")).toBeInTheDocument();
    });

    it("stops click propagation from the trigger button", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [] }),
      };
      const parentOnClick = vi.fn();
      const { container } = render(
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: test wrapper
        <div onClick={parentOnClick}>
          <DocumentRow item={item} visibleColumns={[Col.Tags]} />
        </div>
      );

      const trigger = container.querySelector(
        "button[data-slot='popover-trigger']"
      ) as HTMLButtonElement;
      expect(trigger).toBeInTheDocument();

      fireEvent.click(trigger);

      expect(parentOnClick).not.toHaveBeenCalled();
    });
  });

  describe("project rows", () => {
    it("renders tag chips directly without a TagPicker trigger button for a project row", () => {
      const item: DocumentRowItem = {
        kind: "project",
        data: makeProject(),
      };
      const { container } = renderTagsColumn(item);

      // No popover trigger should exist in the tags cell for a project row
      expect(
        container.querySelector("button[data-slot='popover-trigger']")
      ).not.toBeInTheDocument();
    });

    it("renders a plain container (no interactive trigger) when the project has no tags", () => {
      const item: DocumentRowItem = {
        kind: "project",
        data: makeProject(),
      };
      renderTagsColumn(item);

      // Project rows have no tags field on the type — TagsCell reads an empty
      // array and renders TagChips which returns null for empty input.
      // The cell should still render without throwing.
      expect(
        screen.queryByRole("button", { name: ADD_TAG_PATTERN })
      ).not.toBeInTheDocument();
    });
  });

  describe("feature flag gating", () => {
    it("renders TagPicker trigger button when artifact-tags is enabled", () => {
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [] }),
      };
      const { container } = renderTagsColumn(item);

      expect(
        container.querySelector("button[data-slot='popover-trigger']")
      ).toBeInTheDocument();
    });

    it("renders read-only tag chips without a TagPicker trigger when artifact-tags is disabled", () => {
      mockUseFeatureFlagEnabled.mockReturnValue(false);
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [TAG_BLUE] }),
      };
      const { container } = renderTagsColumn(item);

      // Tag chips are still rendered
      expect(screen.getByText("backend")).toBeInTheDocument();
      // No popover trigger
      expect(
        container.querySelector("button[data-slot='popover-trigger']")
      ).not.toBeInTheDocument();
    });

    it("renders an empty non-interactive cell when artifact-tags is disabled and no tags exist", () => {
      mockUseFeatureFlagEnabled.mockReturnValue(false);
      const item: DocumentRowItem = {
        kind: "document",
        data: makeArtifact({ tags: [] }),
      };
      const { container } = renderTagsColumn(item);

      expect(
        container.querySelector("button[data-slot='popover-trigger']")
      ).not.toBeInTheDocument();
    });
  });

  describe("branch rows", () => {
    it("renders tag chips without a TagPicker trigger button for a branch row", () => {
      const data: Artifact = {
        id: "branch-1",
        type: ArtifactType.Branch,
        subtype: null,
        name: "Branch 1",
        slug: null,
        externalUrl: "https://github.com/org/repo/pull/42",
        organizationId: "org-1",
        projectId: "project-1",
        status: "ACTIVE",
        priority: null,
        assigneeId: null,
        assignee: null,
        createdById: "user-1",
        dueDate: null,
        sortOrder: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-02"),
      };
      const item: DocumentRowItem = { kind: "branch", data };
      const { container } = renderTagsColumn(item);

      expect(
        container.querySelector("button[data-slot='popover-trigger']")
      ).not.toBeInTheDocument();
    });
  });
});
