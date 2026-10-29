import { useDocumentsGroupLink } from "@repo/app/documents/hooks/use-documents-group-link";
import { useArtifactHierarchyExpansion } from "@repo/app/shared/hooks/use-artifact-hierarchy-expansion";
import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { HIERARCHY_EXPANDED_PARAM } from "@repo/app/shared/lib/hierarchy-expanded-param";
import { useNavigation } from "@repo/navigation/use-navigation";
import { usePath } from "@repo/navigation/use-path";
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppNavigationProvider, nextNavigationAdapter } from "../next-adapter";

// This suite exercises the REAL port + Next adapter over a router that behaves
// like the production App Router: `replace` lags the search-params snapshot, a
// navigation discards a pending replace, a push to the current URL uses
// replaceState, and every hook gets its own params copy. Opt out of the global
// port shims.
vi.unmock("@repo/navigation/use-navigation");
vi.unmock("@repo/navigation/use-path");
vi.unmock("@repo/navigation/use-route-params");
vi.unmock("@repo/navigation/use-org-path");
vi.unmock("@repo/navigation/use-search-params-value");
vi.unmock("@repo/navigation/link");

const PATH = "/acme/teams/team-1/projects/project-1";
const START_QUERY = "owners=ada&statuses=todo";

const router = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    params: new URLSearchParams(),
    pendingReplace: null as string | null,
    replaced: [] as string[],
  };
  const commit = () => {
    state.params = new URLSearchParams(globalThis.window.location.search);
    for (const listener of listeners) {
      listener();
    }
  };
  globalThis.window.addEventListener("popstate", commit);
  return {
    state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: (href: string) => {
      state.pendingReplace = null;
      const current = `${globalThis.window.location.pathname}${globalThis.window.location.search}`;
      if (href === current) {
        globalThis.window.history.replaceState(null, "", href);
      } else {
        globalThis.window.history.pushState(null, "", href);
      }
      commit();
    },
    replace: (href: string) => {
      state.replaced.push(href);
      state.pendingReplace = href;
    },
    land: () => {
      if (state.pendingReplace === null) {
        return;
      }
      globalThis.window.history.replaceState(null, "", state.pendingReplace);
      state.pendingReplace = null;
      commit();
    },
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: router.push,
    replace: router.replace,
    back: () => globalThis.window.history.back(),
    forward: () => globalThis.window.history.forward(),
    refresh: vi.fn(),
  }),
  usePathname: () => PATH,
  useParams: () => ({ orgSlug: "acme" }),
  // The production App Router memoizes a new object per hook instance.
  useSearchParams: () => {
    const shared = useSyncExternalStore(
      router.subscribe,
      () => router.state.params,
      () => router.state.params
    );
    return useMemo(() => new URLSearchParams(shared.toString()), [shared]);
  },
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    onClick,
  }: {
    children?: ReactNode;
    href: string;
    onClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
        router.push(href);
      }}
    >
      {children}
    </a>
  ),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <AppNavigationProvider>{children}</AppNavigationProvider>
);

function startAt(query: string) {
  globalThis.window.history.replaceState(null, "", `${PATH}?${query}`);
  router.state.params = new URLSearchParams(query);
  router.state.pendingReplace = null;
  router.state.replaced = [];
}

function mountWriter() {
  return renderHook(
    () => {
      const navigation = useNavigation();
      const writer = useLinkedSearchWriter(
        usePath(),
        useSearchParamsValue(),
        navigation.replace
      );
      return { navigation, writer };
    },
    { wrapper }
  );
}

function pushHistory(entries: readonly string[]) {
  for (const query of entries) {
    globalThis.window.history.pushState(null, "", `${PATH}?${query}`);
  }
}

async function settlePopstate(action: () => void) {
  await act(async () => {
    action();
    await new Promise<void>((resolve) => {
      globalThis.window.addEventListener("popstate", () => resolve(), {
        once: true,
      });
    });
  });
}

describe("linked URL writers on the real Next navigation adapter", () => {
  beforeEach(() => {
    localStorage.clear();
    startAt(START_QUERY);
  });

  it("AC-3: A guard test proves two writers in one render cycle never drop each other's params, with the host navigation counter", () => {
    const { result } = renderHook(
      () => ({
        expansion: useArtifactHierarchyExpansion("web:expansion", true),
        group: useDocumentsGroupLink({
          expansionStorageKey: "web:group",
          groupByStorageKey: "web:group-by",
        }),
      }),
      { wrapper }
    );

    act(() => {
      result.current.group.setGroupBy("priority");
      result.current.expansion.setExpandedIds(new Set(["parent-a"]));
    });
    act(() => router.land());

    const params = new URLSearchParams(
      router.state.replaced.at(-1)?.split("?")[1]
    );
    expect(router.state.replaced).toHaveLength(2);
    expect(params.get("owners")).toBe("ada");
    expect(params.get("statuses")).toBe("todo");
    expect(params.get("group")).toBe("priority:custom");
    expect(params.getAll(HIERARCHY_EXPANDED_PARAM)).toEqual(["parent-a"]);
  });

  it("R4: the writers' own replace never reads as a navigation they did not make while the snapshot lags", () => {
    const { result } = mountWriter();

    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2`));
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2&c=3`));

    expect(result.current.writer.readLatest().toString()).toBe(
      `${START_QUERY}&b=2&c=3`
    );
    act(() => router.land());
    expect(result.current.writer.readLatest().toString()).toBe(
      `${START_QUERY}&b=2&c=3`
    );
  });

  it("R4: a push after Back to the current URL, where history.length is unchanged, clears the queue", async () => {
    pushHistory(["owners=ada&statuses=todo&x=1"]);
    const { result } = mountWriter();
    await settlePopstate(() => globalThis.window.history.back());
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2`));
    const lengthBefore = globalThis.window.history.length;

    act(() => result.current.navigation.navigate(`${PATH}?${START_QUERY}`));

    expect(globalThis.window.history.length).toBe(lengthBefore);
    expect(result.current.writer.readLatest().toString()).toBe(START_QUERY);
  });

  it("R4: a Link click to the current URL while a write is pending returns the base query, once history is long", () => {
    pushHistory(["a=1", "a=2", "a=3"]);
    startAt(START_QUERY);
    const { result } = mountWriter();
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2`));
    render(
      <nextNavigationAdapter.Link href={`${PATH}?${START_QUERY}`}>
        same page
      </nextNavigationAdapter.Link>
    );

    fireEvent.click(screen.getByText("same page"));

    expect(result.current.writer.readLatest().toString()).toBe(START_QUERY);
  });

  it("R4: a write that returns to the base query leaves nothing pending, so a later navigation to the abandoned query is read as the URL", () => {
    const { result } = mountWriter();
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2`));
    act(() => result.current.writer.replaceSearch(START_QUERY));
    act(() => router.land());

    act(() => result.current.navigation.navigate(`${PATH}?${START_QUERY}&b=2`));

    expect(result.current.writer.readLatest().toString()).toBe(
      `${START_QUERY}&b=2`
    );
  });

  it("R4: expand, expand, collapse before Next commits leaves only the last write pending, so a later navigation to the superseded query is read as the URL", () => {
    const { result } = mountWriter();
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&x=1`));
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&x=1&y=2`));
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&x=1`));
    act(() => router.land());

    act(() =>
      result.current.navigation.navigate(`${PATH}?${START_QUERY}&x=1&y=2`)
    );

    expect(result.current.writer.readLatest().toString()).toBe(
      `${START_QUERY}&x=1&y=2`
    );
  });

  it("R4: a Back then Forward pair clears the queue", async () => {
    pushHistory(["owners=ada&statuses=todo&x=1"]);
    const { result } = mountWriter();
    await settlePopstate(() => globalThis.window.history.back());
    act(() => result.current.writer.replaceSearch(`${START_QUERY}&b=2`));

    await settlePopstate(() => globalThis.window.history.forward());
    await settlePopstate(() => globalThis.window.history.back());

    expect(result.current.writer.readLatest().toString()).toBe(START_QUERY);
  });
});
