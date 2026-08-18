import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// FEA-4140: the /documents index route now renders the org-level Documents
// index (project-less DOC artifacts) instead of 404ing. notFound() is mocked to
// the sentinel Next throws internally so a regression that reintroduces it would
// surface as a thrown error rather than a silent pass.
//
// `notFound` is declared with vi.hoisted so it is initialized before the hoisted
// vi.mock("next/navigation") factory runs — otherwise the factory closes over an
// uninitialized top-level const (Reference... before initialization). The global
// vitest.setup.ts navigation-port shim (@repo/navigation/use-navigation) resolves
// next/navigation, so this mock must expose the hooks that shim awaits too.
const { notFound } = vi.hoisted(() => ({
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
vi.mock("../components/documents-index-view", () => ({
  DocumentsIndexView: () => <div data-testid="documents-index-view" />,
}));

vi.mock("../../../components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <div data-testid="header">{breadcrumbs.map((b) => b.label).join("/")}</div>
  ),
}));

import DocumentsPage from "../page";

describe("DocumentsPage", () => {
  it("renders the org-level Documents index without 404ing (FEA-4140)", () => {
    render(<DocumentsPage />);

    expect(notFound).not.toHaveBeenCalled();
    expect(screen.getByTestId("documents-index-view")).toBeInTheDocument();
    expect(screen.getByTestId("header")).toHaveTextContent("Documents");
  });
});
