import { DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// FEA-4140: the /documents index route now renders the org-level Documents
// index (DOC artifacts) instead of 404ing. notFound() is mocked to
// the sentinel Next throws internally so a regression that reintroduces it would
// surface as a thrown error rather than a silent pass.
//
// `notFound` is declared with vi.hoisted so it is initialized before the hoisted
// vi.mock("next/navigation") factory runs — otherwise the factory closes over an
// uninitialized top-level const (Reference... before initialization). The global
// vitest.setup.ts navigation-port shim (@repo/navigation/use-navigation) resolves
// next/navigation, so this mock must expose the hooks that shim awaits too.
const { notFound, featureFlagEnabled } = vi.hoisted(() => ({
  featureFlagEnabled: vi.fn(() => false),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  notFound,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/documents",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

// Leaf surfaces → markers so the page test asserts wiring, not the table
// internals (which have their own coverage) and needs no data/query providers.
vi.mock("@repo/app/documents/components/index/documents-index-view", () => ({
  DocumentsIndexView: () => <div data-testid="documents-index-view" />,
}));

vi.mock("../../../components/header", () => ({
  Header: ({
    breadcrumbs,
    children,
  }: {
    breadcrumbs: { label: string }[];
    children?: React.ReactNode;
  }) => (
    <div data-testid="header">
      {breadcrumbs.map((b) => b.label).join("/")}
      {children}
    </div>
  ),
}));

vi.mock(
  "@repo/app/documents/components/index/documents-universal-index-view",
  () => ({
    DocumentsUniversalIndexView: () => (
      <div data-testid="documents-universal-index-view" />
    ),
  })
);
vi.mock("@repo/app/documents/components/index/documents-create-action", () => ({
  DocumentsCreateAction: ({ label = "New Document" }: { label?: string }) => (
    <button type="button">{label}</button>
  ),
  DocumentsCreateProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: featureFlagEnabled,
}));

import DocumentsPage from "../page";

describe("DocumentsPage", () => {
  it("renders the org-level Documents index without 404ing (FEA-4140)", () => {
    render(<DocumentsPage />);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("documents-index-view")).toBeInTheDocument();
    expect(screen.getByTestId("header")).toHaveTextContent("Documents");
  });

  it("mounts the universal host and Add document action only when its flag is enabled", () => {
    featureFlagEnabled.mockReturnValue(true);
    render(<DocumentsPage />);
    expect(featureFlagEnabled).toHaveBeenCalledWith(
      DOCUMENTS_UNIVERSAL_LIST_FEATURE_FLAG_KEY
    );
    expect(
      screen.getByTestId("documents-universal-index-view")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("documents-index-view")
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add document" })
    ).toBeInTheDocument();
    featureFlagEnabled.mockReturnValue(false);
  });
});
