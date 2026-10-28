import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { AppNavigationProvider } from "@/lib/navigation/next-adapter";
import { Search } from "../search";

// Search builds its own targets through the org-path port, so this suite
// exercises the REAL builder (`useOrgPathBuilder`) rather than the route-param
// shim vitest.setup.ts installs. The ISS-7344 window below — active org not yet
// resolved while the URL slug already reads `craft-five` — is a state a
// route-param builder cannot express, so the shim would hide the regression.
vi.unmock("@repo/navigation/use-org-path");

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

// ISS-6567: deliberately DIFFERENT slugs. Search builds its targets from the
// ACTIVE org, so the existing "/acme/..." expectations below fail the moment
// the call site reverts to the URL-slug hook. Mutable so a test can also drive
// the ISS-7344 window where the active org has not resolved at all.
let navOrgSlug = "acme";

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "craft-five",
  useNavOrgSlug: () => navOrgSlug,
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
    navOrgSlug = "acme";
    pathname = "/acme/my-tasks";
    searchParams = new URLSearchParams();
    routerPushMock.mockClear();
    routerReplaceMock.mockClear();
  });

  test("hydrates the sidebar input from the active search query", () => {
    pathname = "/acme/search";
    searchParams = new URLSearchParams("q=alpha");

    render(<Search />, { wrapper: AppNavigationProvider });

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

    render(<Search />, { wrapper: AppNavigationProvider });

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

    render(<Search />, { wrapper: AppNavigationProvider });

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

    render(<Search />, { wrapper: AppNavigationProvider });

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument();
  });

  test("clears a draft search without leaving the current page", async () => {
    const user = userEvent.setup();

    render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "draft search");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    expect(input).toHaveValue("");
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("submitting whitespace resets without creating an empty query URL", async () => {
    const user = userEvent.setup();

    render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "   ");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(input).toHaveValue("");
    expect(routerReplaceMock).not.toHaveBeenCalled();
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("submitting text navigates to encoded search results", async () => {
    const user = userEvent.setup();

    render(<Search />, { wrapper: AppNavigationProvider });

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

    render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "alpha beta");
    await user.keyboard("{Enter}");

    expect(routerPushMock).toHaveBeenCalledWith("/acme/search?q=alpha+beta");
    expect(routerReplaceMock).not.toHaveBeenCalled();
  });

  test("renders native search form target for pre-hydration submissions", () => {
    render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    const form = input.closest("form");

    expect(form).not.toBeNull();
    expect(form).toHaveAttribute("action", "/acme/search");
    expect(form).toHaveAttribute("method", "get");
    expect(input).toHaveAttribute("name", "q");
  });

  test("holds a submit made before the active org resolves, then sends it", async () => {
    // ISS-7344 regression. The authenticated shell paints before Clerk resolves
    // the active org, so an early Enter lands while the slug is still empty. A
    // keypress is one-shot, so dropping it there drops it for good and the box
    // reads as broken. The query is held and then sent to the org-scoped
    // destination in ONE navigation — no redirect hop for the query to survive.
    navOrgSlug = "";
    const user = userEvent.setup();

    const { rerender } = render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "alpha beta");
    await user.keyboard("{Enter}");

    // Nothing org-scoped may be named while the org is unknown — and nothing
    // may be sent to a path that omits it either.
    expect(routerPushMock).not.toHaveBeenCalled();

    navOrgSlug = "acme";
    rerender(<Search />);

    await waitFor(() =>
      expect(routerPushMock).toHaveBeenCalledWith("/acme/search?q=alpha+beta")
    );
    expect(routerPushMock).toHaveBeenCalledTimes(1);
  });

  test("drops a held query when the search box is cleared before the org resolves", async () => {
    // A held submit must not fire behind the user's back after they abandoned
    // it — clearing the box is that abandonment.
    navOrgSlug = "";
    const user = userEvent.setup();

    const { rerender } = render(<Search />, { wrapper: AppNavigationProvider });

    const input = screen.getByRole("combobox", { name: "Search" });
    await user.type(input, "alpha beta");
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Clear search" }));

    navOrgSlug = "acme";
    rerender(<Search />);

    await waitFor(() => expect(input).toHaveValue(""));
    expect(routerPushMock).not.toHaveBeenCalled();
  });

  test("keeps a submittable native form target while the org is unresolved", () => {
    navOrgSlug = "";

    render(<Search />, { wrapper: AppNavigationProvider });

    const form = screen
      .getByRole("combobox", { name: "Search" })
      .closest("form");

    // Absent `action` submits to the CURRENT url, which silently drops the
    // search; "//search" would leave the origin entirely.
    expect(form).toHaveAttribute("action", "/search");
  });

  test('leaves a document slugged "search" out of the search route', () => {
    // The route match is slug-independent, so it has to stay anchored to one
    // optional leading segment — a nested `.../search` is a document, not the
    // search page, and must not drive the sidebar box.
    pathname = "/acme/issues/search";
    searchParams = new URLSearchParams("q=alpha");

    render(<Search />, { wrapper: AppNavigationProvider });

    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue("");
    expect(
      screen.queryByRole("button", { name: "Clear search" })
    ).not.toBeInTheDocument();
  });

  test("recognizes the search route before the active org resolves", () => {
    navOrgSlug = "";
    pathname = "/craft-five/search";
    searchParams = new URLSearchParams("q=alpha");

    render(<Search />, { wrapper: AppNavigationProvider });

    // Deriving "am I on /search" from the slug blanks the user's own query in
    // this window, because the hydration effect treats it as a non-search route.
    expect(screen.getByRole("combobox", { name: "Search" })).toHaveValue(
      "alpha"
    );
  });
});
