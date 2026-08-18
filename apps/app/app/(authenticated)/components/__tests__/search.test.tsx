import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Search } from "../search";

const routerPushMock = vi.fn();
const routerReplaceMock = vi.fn();

let pathname = "/acme/my-tasks";
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "acme" }),
  usePathname: () => pathname,
  useRouter: () => ({
    back: vi.fn(),
    push: routerPushMock,
    refresh: vi.fn(),
    replace: routerReplaceMock,
  }),
  useSearchParams: () => searchParams,
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

// The sidebar mounts the shared prefix-mode typeahead, which calls the unified
// FTS hook. Stub it so these tests stay focused on the sidebar's submit/clear
// navigation behavior and do not require a live API adapter.
vi.mock("@repo/app/search/hooks/use-search", () => ({
  useUnifiedSearch: () => ({ data: undefined, isLoading: false }),
}));

// The typeahead's inline-filter intellisense fetches org members/projects; stub
// the controller closed so these navigation-focused tests need no auth/API
// adapter. Its own behavior is covered in use-search-intellisense.test.tsx.
vi.mock("@repo/app/search/hooks/use-search-intellisense", () => ({
  useSearchIntellisense: () => ({
    isOpen: false,
    mode: "free-text",
    rows: [],
    isLoading: false,
    isError: false,
    commitRow: () => null,
  }),
}));

describe("Search", () => {
  beforeEach(() => {
    pathname = "/acme/my-tasks";
    searchParams = new URLSearchParams();
    routerPushMock.mockClear();
    routerReplaceMock.mockClear();
  });

  test("hydrates the sidebar input from the active search query", () => {
    pathname = "/acme/search";
    searchParams = new URLSearchParams("q=alpha");

    render(<Search />);

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue(
      "alpha"
    );
    expect(
      screen.getByRole("button", { name: "Clear search" })
    ).toBeInTheDocument();
  });

  test("clears active text search back to my tasks", async () => {
    pathname = "/acme/search";
    searchParams = new URLSearchParams("q=alpha");
    const user = userEvent.setup();

    render(<Search />);

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue("");
    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
    expect(routerReplaceMock.mock.calls[0]?.[0]).not.toContain("?");
  });

  test("clears active tag search back to my tasks", async () => {
    pathname = "/acme/search";
    searchParams = new URLSearchParams("tagId=tag-123");
    const user = userEvent.setup();

    render(<Search />);

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(routerReplaceMock).toHaveBeenCalledWith("/acme/my-tasks", {
      scroll: false,
    });
    expect(routerReplaceMock.mock.calls[0]?.[0]).not.toContain("?");
  });

  test("ignores similar query keys when hydrating and deciding active search", () => {
    pathname = "/acme/search";
    searchParams = new URLSearchParams("query=alpha&qish=beta&tag=tag-123");

    render(<Search />);

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument();
  });

  test("clears a draft search without leaving the current page", async () => {
    const user = userEvent.setup();

    render(<Search />);

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "draft search");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(input).toHaveValue("");
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("submitting whitespace resets without creating an empty query URL", async () => {
    const user = userEvent.setup();

    render(<Search />);

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "   ");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(input).toHaveValue("");
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("submitting text navigates to encoded search results", async () => {
    const user = userEvent.setup();

    render(<Search />);

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "alpha beta");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(routerPushMock).toHaveBeenCalledWith("/acme/search?q=alpha+beta");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("pressing Enter with a query submits and navigates to search results", async () => {
    // Guards the typeahead's keydown handler: with a query typed and no
    // suggestion highlighted, Enter must fall through to the native form submit
    // (it must not preventDefault and swallow the submit). The typeahead wraps
    // the input in role="combobox"; regressing this would break Enter→/search.
    const user = userEvent.setup();

    render(<Search />);

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "alpha beta");
    await user.keyboard("{Enter}");

    expect(routerPushMock).toHaveBeenCalledWith("/acme/search?q=alpha+beta");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("renders native search form target for pre-hydration submissions", () => {
    render(<Search />);

    const input = screen.getByRole("combobox", { name: "Search" });
    const form = input.closest("form");

    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("action", "/acme/search");
    expect(form).toHaveAttribute("method", "get");
    expect(input).toHaveAttribute("name", "q");
  });
});
