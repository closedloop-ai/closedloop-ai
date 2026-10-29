import { useLinkedSearchWriter } from "@repo/app/shared/hooks/use-linked-search-writer";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, render, renderHook } from "@testing-library/react";
import { type ReactNode, Suspense, use, useEffect } from "react";
import { describe, expect, it } from "vitest";
import { createLaggingNavigation } from "../../test-fixtures/lagging-navigation";

const PATH = "/teams/team-1/projects/project-1";
const mountWrites = { count: 0 };

function mountWriter(initialQuery: string) {
  const navigation = createLaggingNavigation(`${PATH}?${initialQuery}`);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NavigationProvider adapter={navigation.adapter}>
      {children}
    </NavigationProvider>
  );
  const rendered = renderHook(
    () =>
      useLinkedSearchWriter(
        navigation.adapter.usePathValue(),
        navigation.adapter.useSearchParamsSnapshot(),
        navigation.adapter.useNavigationActions().replace
      ),
    { wrapper }
  );
  return { navigation, rendered };
}

describe("useLinkedSearchWriter queue semantics", () => {
  it("R4: a queued empty query is the newest write, not an empty queue", () => {
    const { rendered } = mountWriter("owners=ada");

    act(() => rendered.result.current.replaceSearch(""));

    rendered.rerender();
    expect(rendered.result.current.readLatest().toString()).toBe("");
    expect(rendered.result.current.search).toBe("");
  });

  it("R4: an empty write after another queued write is the one later writers build on", () => {
    const { rendered } = mountWriter("a=1");

    act(() => rendered.result.current.replaceSearch("a=1&b=2"));
    act(() => rendered.result.current.replaceSearch(""));

    expect(rendered.result.current.readLatest().toString()).toBe("");
  });

  it("R4: a navigation that lands on the starting URL clears the queue", () => {
    const { navigation, rendered } = mountWriter("a=1");
    act(() => rendered.result.current.replaceSearch("a=1&b=2"));

    act(() => navigation.navigate(`${PATH}?a=1`));

    expect(rendered.result.current.readLatest().toString()).toBe("a=1");
  });

  it("R4: a write that lands is dropped and the snapshot is read again", () => {
    const { navigation, rendered } = mountWriter("a=1");
    act(() => rendered.result.current.replaceSearch("a=1&b=2"));

    act(() => navigation.landReplaces());

    expect(rendered.result.current.readLatest().toString()).toBe("a=1&b=2");
    act(() => navigation.navigate(`${PATH}?a=1&b=2&c=3`));
    expect(rendered.result.current.readLatest().toString()).toBe("a=1&b=2&c=3");
  });

  it("R4: a write made while mounting survives a development double mount", async () => {
    mountWrites.count = 0;
    const navigation = createLaggingNavigation(`${PATH}?a=1`);
    let writer: ReturnType<typeof useLinkedSearchWriter> | undefined;
    renderHook(
      () => {
        const current = useLinkedSearchWriter(
          navigation.adapter.usePathValue(),
          navigation.adapter.useSearchParamsSnapshot(),
          navigation.adapter.useNavigationActions().replace
        );
        writer = current;
        const { replaceSearch } = current;
        useEffect(() => {
          if (mountWrites.count > 0) {
            return;
          }
          mountWrites.count += 1;
          replaceSearch("a=1&mounted=1");
        }, [replaceSearch]);
        return current;
      },
      {
        reactStrictMode: true,
        wrapper: ({ children }: { children: ReactNode }) => (
          <NavigationProvider adapter={navigation.adapter}>
            {children}
          </NavigationProvider>
        ),
      }
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(writer?.readLatest().toString()).toBe("a=1&mounted=1");
  });

  it("R4: a render that is discarded before commit does not clear the queue", () => {
    const { rendered } = mountWriter("a=1");
    act(() => rendered.result.current.replaceSearch("a=1&b=2"));
    const stale = createLaggingNavigation(`${PATH}?z=9`);

    function DiscardedRender(): ReactNode {
      useLinkedSearchWriter(
        stale.adapter.usePathValue(),
        stale.adapter.useSearchParamsSnapshot(),
        stale.adapter.useNavigationActions().replace
      );
      return use(NEVER_SETTLES);
    }
    render(
      <Suspense fallback={null}>
        <NavigationProvider adapter={stale.adapter}>
          <DiscardedRender />
        </NavigationProvider>
      </Suspense>
    );

    expect(rendered.result.current.readLatest().toString()).toBe("a=1&b=2");
  });

  it("R3: the search follows the writer's own write without another render trigger, so an effect keyed on it runs for every distinct value", () => {
    const navigation = createLaggingNavigation(`${PATH}?a=1`);
    const seen: string[] = [];
    const { result } = renderHook(
      () => {
        const writer = useLinkedSearchWriter(
          navigation.adapter.usePathValue(),
          navigation.adapter.useSearchParamsSnapshot(),
          navigation.adapter.useNavigationActions().replace
        );
        const { search } = writer;
        useEffect(() => {
          seen.push(search);
        }, [search]);
        return writer;
      },
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <NavigationProvider adapter={navigation.adapter}>
            {children}
          </NavigationProvider>
        ),
      }
    );

    act(() => result.current.replaceSearch("a=1&b=2"));
    act(() => result.current.replaceSearch("a=1&b=2&c=3"));

    expect(seen).toEqual(["a=1", "a=1&b=2", "a=1&b=2&c=3"]);
  });
});

const NEVER_SETTLES = new Promise<never>(() => undefined);
