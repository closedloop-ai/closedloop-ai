import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SearchPage, { generateMetadata } from "../page";

const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/acme/search",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("../../../components/header", () => ({
  Header: ({ breadcrumbs }: { breadcrumbs: { label: string }[] }) => (
    <div data-testid="page-header">
      {breadcrumbs.map((crumb) => (
        <span key={crumb.label}>{crumb.label}</span>
      ))}
    </div>
  ),
}));

vi.mock("../components/search-results", () => ({
  SearchResults: () => <div data-testid="search-results" />,
}));

describe("generateMetadata", () => {
  it("titles the page for a tag-filtered search", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({ tagId: "tag-1" }),
    });

    expect(metadata.title).toBe("Tagged documents - Search results");
    expect(metadata.description).toBe("Documents filtered by tag");
  });

  it("titles the page with the query string when no tag is present", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({ q: "invoices" }),
    });

    expect(metadata.title).toBe("invoices - Search results");
    expect(metadata.description).toBe("Search results for invoices");
  });

  it("falls back to an empty query in the title when neither q nor tagId is present", async () => {
    const metadata = await generateMetadata({
      params: Promise.resolve({ orgSlug: "acme" }),
      searchParams: Promise.resolve({}),
    });

    expect(metadata.title).toBe(" - Search results");
  });
});

describe("SearchPage", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects to my-tasks when neither q nor tagId is present", async () => {
    await expect(
      SearchPage({
        params: Promise.resolve({ orgSlug: "acme" }),
        searchParams: Promise.resolve({}),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/acme/my-tasks");

    expect(redirectMock).toHaveBeenCalledWith("/acme/my-tasks");
  });

  it("renders the results layout when a search query is present", async () => {
    render(
      await SearchPage({
        params: Promise.resolve({ orgSlug: "acme" }),
        searchParams: Promise.resolve({ q: "invoices" }),
      })
    );

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("page-header")).toHaveTextContent("Search");
    expect(screen.getByTestId("search-results")).toBeInTheDocument();
  });

  it("renders the results layout when only a tagId is present", async () => {
    render(
      await SearchPage({
        params: Promise.resolve({ orgSlug: "acme" }),
        searchParams: Promise.resolve({ tagId: "tag-1" }),
      })
    );

    expect(redirectMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("search-results")).toBeInTheDocument();
  });
});
