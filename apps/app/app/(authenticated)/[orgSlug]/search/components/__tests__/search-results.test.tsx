import type { GlobalSearchResponse } from "@repo/api/src/types/search";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SearchResults } from "../search-results";

const routerReplaceMock = vi.fn();
const useGlobalSearchMock = vi.fn();

let searchParams = new URLSearchParams("q=alpha");

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => "/acme/search",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: routerReplaceMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

vi.mock("@repo/app/search/hooks/use-search", () => ({
  useGlobalSearch: (...args: unknown[]) => useGlobalSearchMock(...args),
}));

describe("SearchResults", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("q=alpha");
    routerReplaceMock.mockClear();
    useGlobalSearchMock.mockReset();
  });

  test("renders the text search summary", () => {
    useGlobalSearchMock.mockReturnValue({
      data: searchResponse({ query: "alpha" }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(useGlobalSearchMock).toHaveBeenCalledWith({ query: "alpha" });
    expect(screen.getByText('0 results for "alpha"')).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Clear search" })
    ).toBeInTheDocument();
  });

  test("renders the tag search summary without changing hook parameters", () => {
    searchParams = new URLSearchParams("tagId=tag-123");
    useGlobalSearchMock.mockReturnValue({
      data: searchResponse({
        query: "",
        tagId: "tag-123",
        tagName: "Urgent",
      }),
      isLoading: false,
    });

    render(<SearchResults />);

    expect(useGlobalSearchMock).toHaveBeenCalledWith({ tagId: "tag-123" });
    expect(
      screen.getByText('0 results tagged with "Urgent"')
    ).toBeInTheDocument();
  });

  test("clears results back to my tasks", async () => {
    useGlobalSearchMock.mockReturnValue({
      data: searchResponse({ query: "alpha" }),
      isLoading: false,
    });
    const user = userEvent.setup();

    render(<SearchResults />);

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
  });

  test("clears tag results back to my tasks", async () => {
    searchParams = new URLSearchParams("tagId=tag-123");
    useGlobalSearchMock.mockReturnValue({
      data: searchResponse({
        query: "",
        tagId: "tag-123",
        tagName: "Urgent",
      }),
      isLoading: false,
    });
    const user = userEvent.setup();

    render(<SearchResults />);

    expect(useGlobalSearchMock).toHaveBeenCalledWith({ tagId: "tag-123" });

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
  });
});

function searchResponse(
  overrides: Partial<GlobalSearchResponse>
): GlobalSearchResponse {
  return {
    documents: [],
    projects: [],
    query: "",
    ...overrides,
  };
}
