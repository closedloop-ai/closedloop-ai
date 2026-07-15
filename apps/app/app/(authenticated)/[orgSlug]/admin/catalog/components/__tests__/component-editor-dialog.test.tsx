import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentEditorDialog } from "../component-editor-dialog";

const mocks = vi.hoisted(() => ({
  createCatalogItem: vi.fn(),
  updateCatalogItem: vi.fn(),
}));

vi.mock("@repo/app/agents/hooks/use-catalog", () => ({
  useCreateCatalogItem: () => ({
    isPending: false,
    mutateAsync: mocks.createCatalogItem,
  }),
  useUpdateCatalogItem: () => ({
    isPending: false,
    mutateAsync: mocks.updateCatalogItem,
  }),
}));

const RE_NAME = /Name/;

describe("ComponentEditorDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createCatalogItem.mockResolvedValue({});
    mocks.updateCatalogItem.mockResolvedValue({});
  });

  it("omits content when editing a metadata-only pack", async () => {
    render(
      <ComponentEditorDialog
        existing={makeCatalogItem({
          targetKind: "pack",
          name: "Original Pack",
          description: "Original description",
          content: "stored content should not be resent",
        })}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
      />
    );

    expect(screen.getByRole("heading", { name: "Edit item" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit raw" })).toBeNull();

    fireEvent.change(screen.getByLabelText(RE_NAME), {
      target: { value: "Updated Pack" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save item" }));

    await waitFor(() => expect(mocks.updateCatalogItem).toHaveBeenCalled());
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith({
      id: "item-1",
      name: "Updated Pack",
      description: "",
    });
  });

  it("sends content when editing a content-bearing component", async () => {
    render(
      <ComponentEditorDialog
        existing={makeCatalogItem({
          targetKind: "agent",
          name: "Original Agent",
          description: "Original description",
          content:
            "---\nname: Original Agent\ndescription: Original description\n---\n\nOriginal prompt\n",
        })}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        open
        parentPackId="pack-1"
      />
    );

    fireEvent.change(screen.getByLabelText("System prompt (.md)"), {
      target: { value: "Updated prompt" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save component" }));

    await waitFor(() => expect(mocks.updateCatalogItem).toHaveBeenCalled());
    expect(mocks.updateCatalogItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "item-1",
        name: "Original Agent",
        description: "Original description",
        content: expect.stringContaining("Updated prompt"),
      })
    );
  });
});

function makeCatalogItem(
  overrides: Partial<CatalogItemDto> = {}
): CatalogItemDto {
  return {
    id: "item-1",
    organizationId: "org-1",
    targetKind: "pack",
    source: CatalogItemSource.OrgCustom,
    scope: CatalogItemScope.Org,
    name: "Catalog Item",
    description: null,
    version: "1.0.0",
    sortOrder: 0,
    enabled: true,
    archived: false,
    coaching: false,
    coachingConfig: null,
    parentPackId: null,
    componentUuid: null,
    content: null,
    components: [],
    agentSlug: null,
    logoUrl: null,
    createdById: "owner-1",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}
