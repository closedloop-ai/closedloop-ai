import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchProductEligibility } from "@repo/api/src/types/branch-product-eligibility";
import {
  DOCUMENT_ROUTE_PREFIX,
  DocumentType,
} from "@repo/api/src/types/document";
import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

import { NameCell } from "@repo/app/documents/components/table/cells/name-cell";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import {
  makeArtifact,
  makeRawArtifact,
} from "@repo/app/shared/test-fixtures/documents";
// Import after mocks
import { makeProject } from "@repo/app/shared/test-fixtures/project";
import { formatGridCardSelectionLabel } from "@repo/design-system/lib/grid-table-aria";

// Tests

describe("NameCell — Link vs div rendering", () => {
  // ISS-12959 (2026-10-19 operator Asana observation): one line, ellipsis.
  it("keeps status plus a one-line truncated title in the PRD-727 narrow projection", () => {
    const title = "A deliberately long narrow document title";
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        slug: `${SlugPrefix.Prd}-727`,
        title,
      }),
    };

    render(
      <NameCell
        href="/test-org/prds/PRD-727"
        isSelected={false}
        item={item}
        narrow
        showCheckbox={false}
      />
    );

    expect(screen.getByRole("img", { name: "Draft" })).toBeVisible();
    expect(screen.getByText(title)).toHaveClass("truncate");
    expect(screen.getByText(title)).not.toHaveClass("whitespace-normal");
    expect(screen.queryByText(`${SlugPrefix.Prd}-727`)).toBeNull();
  });

  it("keeps the wide title's existing truncation treatment", () => {
    const title = "A deliberately long wide document title";
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ title }),
    };

    render(<NameCell isSelected={false} item={item} showCheckbox={false} />);

    expect(screen.getByText(title)).toHaveClass("truncate");
  });

  it("uses the shared selection label and legacy checkbox reveal outside manual placement", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ title: "Selection title" }),
    };
    const { container } = render(
      <DocumentRow item={item} showCheckbox visibleColumns={[]} />
    );
    const checkbox = screen.getByRole("checkbox", {
      name: formatGridCardSelectionLabel("Selection title", false),
    });
    expect(checkbox.parentElement).not.toHaveClass("focus-within:opacity-100");
    expect(container).toBeInTheDocument();
  });

  it("PRD-718 AC4 hands the checkbox click chord to the selection model", () => {
    const onSelectionChange = vi.fn();
    const data = makeArtifact({ title: "Chord title" });
    render(
      <DocumentRow
        item={{ kind: "document", data }}
        onSelectionChange={onSelectionChange}
        showCheckbox
        visibleColumns={[]}
      />
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: formatGridCardSelectionLabel("Chord title", false),
      }),
      { shiftKey: true }
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(onSelectionChange).toHaveBeenCalledWith(
      data.id,
      true,
      expect.objectContaining({
        ctrlKey: false,
        metaKey: false,
        shiftKey: true,
      })
    );
  });
  it("starts a manual title drag before a descendant pointer handler can claim the event", () => {
    const onDragPointerDown = vi.fn();
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ slug: "PRD-1", type: DocumentType.Prd }),
    };
    const { container } = render(
      <DocumentRow
        item={item}
        placementLayout="manual"
        rowDragTargetProps={{ onPointerDown: onDragPointerDown }}
        visibleColumns={[]}
      />
    );
    const link = container.querySelector("a[draggable='false']");
    if (!link) {
      throw new Error("Expected the manual title link");
    }
    link.addEventListener("pointerdown", (event) => event.stopPropagation());

    fireEvent.pointerDown(link);

    expect(onDragPointerDown).toHaveBeenCalledOnce();
  });

  it("renders artifact NameCell as <a> when href is resolvable", () => {
    // getDocumentRoute returns a path for PRD type with a slug
    const item: DocumentRowItem = { kind: "document", data: makeArtifact() };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor?.tagName).toBe("A");
  });

  it("renders artifact NameCell <a> with the correct href", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ slug: "PRD-1", type: DocumentType.Prd }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toHaveAttribute(
      "href",
      `/test-org/${DOCUMENT_ROUTE_PREFIX}/PRD-1`
    );
  });

  it("renders feature row NameCell as <a> with correct href", () => {
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({
        id: "feat-1",
        slug: "FEAT-1",
        type: DocumentType.Feature,
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute(
      "href",
      `/test-org/${DOCUMENT_ROUTE_PREFIX}/FEAT-1`
    );
  });

  it("keeps the title beside a compact Unknown status for future evidence", () => {
    const title = "Future-status document";
    const item: DocumentRowItem = {
      kind: "document",
      data: {
        ...makeArtifact({ title }),
        rawStatus: "AWAITING_PRODUCT_COUNCIL",
      },
    };
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        <DocumentRow item={item} visibleColumns={[]} />
      </FeatureFlagAdapterProvider>
    );

    expect(screen.getByRole("link", { name: title })).toBeVisible();
    expect(screen.getByRole("img", { name: "Unknown" })).toBeVisible();
    expect(screen.queryByText("AWAITING_PRODUCT_COUNCIL")).toBeNull();
  });

  it("renders project NameCell as <a> when team context is available", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({
        id: "project-1",
        teams: [{ id: "team-1", name: "Team One" }],
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    const anchor = container.querySelector("a");
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute(
      "href",
      "/test-org/teams/team-1/projects/project-1"
    );
  });

  it("renders project NameCell as div when no team is available", () => {
    const item: DocumentRowItem = {
      kind: "project",
      data: makeProject({ id: "project-1", teams: [] }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    // No <a> tag should be rendered in the NameCell when href cannot be resolved
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  it("renders artifact NameCell as div when document type is non-navigable", () => {
    // getDocumentRoute returns null for document types outside the navigable set
    const item: DocumentRowItem = {
      kind: "document",
      data: makeArtifact({ type: DocumentType.Template }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    // Non-navigable type → getDocumentRoute returns null → NameCell renders <div>
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  it("routes an eligible Branch row to canonical Details when rollout is enabled", () => {
    const item: DocumentRowItem = {
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        productEligibility: BranchProductEligibility.Eligible,
      }),
    };
    const { container } = render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [ELIGIBLE_BRANCH_NAVIGATION_FEATURE_FLAG_KEY],
        })}
      >
        <DocumentRow item={item} visibleColumns={[]} />
      </FeatureFlagAdapterProvider>
    );

    expect(container.querySelector("a")).toHaveAttribute(
      "href",
      "/test-org/branches/branch-1"
    );
  });

  it("keeps an eligible Branch row on compatibility while rollout is off", () => {
    const item: DocumentRowItem = {
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        hasCompatibilityProviderFallback: true,
        productEligibility: BranchProductEligibility.Eligible,
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    expect(container.querySelector("a")).toHaveAttribute(
      "href",
      "/test-org/build/branch-1"
    );
  });

  it("renders an ineligible Branch row as a non-link", () => {
    const item: DocumentRowItem = {
      kind: "branch",
      data: makeRawArtifact(ArtifactType.Branch, {
        id: "branch-1",
        productEligibility: BranchProductEligibility.Ineligible,
      }),
    };
    const { container } = render(
      <DocumentRow item={item} visibleColumns={[]} />
    );

    expect(container.querySelector("a")).not.toBeInTheDocument();
  });
});

describe("NameCell slug spacing", () => {
  it.each([
    {
      kind: "document",
      item: {
        kind: "document",
        data: makeArtifact({
          slug: "scaled-seed-document-21",
          title: "Scaled Seed Document",
        }),
      } satisfies DocumentRowItem,
      title: "Scaled Seed Document",
    },
    {
      kind: "project",
      item: {
        kind: "project",
        data: makeProject({ name: "Seed Project", slug: "seed-project" }),
      } satisfies DocumentRowItem,
      title: "Seed Project",
    },
    {
      kind: "branch",
      item: {
        kind: "branch",
        // Branches and sessions normally have untyped slugs; these inputs
        // prove the shared cell still displays any slug the canonical guard accepts.
        data: makeRawArtifact(ArtifactType.Branch, {
          name: "Seed Branch",
          slug: "seed-branch",
        }),
      } satisfies DocumentRowItem,
      title: "Seed Branch",
    },
    {
      kind: "session",
      item: {
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          name: "Seed Session",
          slug: "seed-session",
        }),
      } satisfies DocumentRowItem,
      title: "Seed Session",
    },
  ])(
    "does not reserve slug width for a $kind row with a hidden slug",
    ({ item, title }) => {
      const { container } = render(
        <DocumentRow item={item} visibleColumns={[]} />
      );

      expect(container.querySelector('span[class*="min-w-[7ch]"]')).toBeNull();
      expect(screen.getByText(title)).toBeVisible();
    }
  );

  it.each([
    {
      kind: "document",
      item: {
        kind: "document",
        data: makeArtifact({
          slug: `${SlugPrefix.Prd}-9`,
          title: "Typed document",
        }),
      } satisfies DocumentRowItem,
      slug: `${SlugPrefix.Prd}-9`,
      title: "Typed document",
    },
    {
      kind: "project",
      item: {
        kind: "project",
        data: makeProject({
          name: "Typed project",
          slug: `${SlugPrefix.Project}-9`,
        }),
      } satisfies DocumentRowItem,
      slug: `${SlugPrefix.Project}-9`,
      title: "Typed project",
    },
    {
      kind: "branch",
      item: {
        kind: "branch",
        data: makeRawArtifact(ArtifactType.Branch, {
          name: "Typed branch",
          slug: `${SlugPrefix.Issue}-9`,
        }),
      } satisfies DocumentRowItem,
      slug: `${SlugPrefix.Issue}-9`,
      title: "Typed branch",
    },
    {
      kind: "session",
      item: {
        kind: "session",
        data: makeRawArtifact(ArtifactType.Session, {
          name: "Typed session",
          slug: `${SlugPrefix.Doc}-9`,
        }),
      } satisfies DocumentRowItem,
      slug: `${SlugPrefix.Doc}-9`,
      title: "Typed session",
    },
  ])(
    "keeps the existing slot and text for a $kind row with a displayable slug",
    ({ item, kind, slug, title }) => {
      const { container } = render(
        <DocumentRow item={item} visibleColumns={[]} />
      );

      const slugSlot = container.querySelector('span[class*="min-w-[7ch]"]');
      expect(slugSlot).toHaveTextContent(slug);
      expect(slugSlot?.classList.contains("mr-1.5")).toBe(true);
      expect(slugSlot?.classList.contains("ml-1")).toBe(kind === "project");
      expect(screen.getByText(title)).toBeVisible();
    }
  );
});
