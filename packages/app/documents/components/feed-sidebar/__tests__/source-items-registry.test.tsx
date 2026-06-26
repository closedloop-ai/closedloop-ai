// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { MessageSquare } from "lucide-react";
import { useMemo, useState } from "react";
import { describe, expect, it } from "vitest";

import { FeedItemKind } from "../feed-item";
import type { FeedSource, FeedSourceUseItemsResult } from "../feed-source";
import {
  FeedRuntime,
  type SourceItemsRegistry,
  useAllSourceItems,
  useSourceItems,
} from "../source-items-registry";

type StubItem = {
  id: string;
  kind: typeof FeedItemKind.PrComment;
  sourceId: string;
  createdAt: Date;
  payload: string;
};

function makeStubSource(
  id: string,
  itemsResult: FeedSourceUseItemsResult<StubItem>
): FeedSource<StubItem, { tag: string }> {
  return {
    id,
    kind: FeedItemKind.PrComment,
    label: id,
    Icon: MessageSquare,
    useItems: () => itemsResult,
    defaultFilterState: { tag: "all" },
    applyFilter: (items) => items,
    isFiltered: (state) => state.tag !== "all",
    renderItem: (item) => <div data-testid={`item-${item.id}`}>{item.id}</div>,
  };
}

type Captured<T> = { current: T | null };

function ProbeAll({ capture }: { capture: Captured<SourceItemsRegistry> }) {
  const registry = useAllSourceItems();
  capture.current = registry;
  return null;
}

function ProbeOne({
  sourceId,
  capture,
}: {
  sourceId: string;
  capture: Captured<ReturnType<typeof useSourceItems>>;
}) {
  capture.current = useSourceItems(sourceId);
  return null;
}

describe("FeedRuntime + source registry", () => {
  it("registers a single source's items in the context", () => {
    const items: StubItem[] = [
      {
        id: "a",
        kind: FeedItemKind.PrComment,
        sourceId: "stub",
        createdAt: new Date(0),
        payload: "x",
      },
    ];
    const source = makeStubSource("stub", {
      items,
      isLoading: false,
      isError: false,
    });
    const capture: Captured<SourceItemsRegistry> = { current: null };

    render(
      <FeedRuntime fallback={null} sources={[source]}>
        <ProbeAll capture={capture} />
      </FeedRuntime>
    );

    expect(capture.current).not.toBeNull();
    expect(capture.current?.size).toBe(1);
    const registered = capture.current?.get("stub");
    expect(registered?.source.id).toBe("stub");
    expect(registered?.result.items).toEqual(items);
  });

  it("registers multiple sources keyed by id", () => {
    const sourceA = makeStubSource("a", {
      items: [],
      isLoading: false,
      isError: false,
    });
    const sourceB = makeStubSource("b", {
      items: [],
      isLoading: false,
      isError: false,
    });
    const capture: Captured<SourceItemsRegistry> = { current: null };

    render(
      <FeedRuntime fallback={null} sources={[sourceA, sourceB]}>
        <ProbeAll capture={capture} />
      </FeedRuntime>
    );

    expect(capture.current?.size).toBe(2);
    expect(capture.current?.get("a")?.source.id).toBe("a");
    expect(capture.current?.get("b")?.source.id).toBe("b");
  });

  it("useSourceItems returns the specific source result", () => {
    const items: StubItem[] = [
      {
        id: "x",
        kind: FeedItemKind.PrComment,
        sourceId: "only",
        createdAt: new Date(0),
        payload: "y",
      },
    ];
    const source = makeStubSource("only", {
      items,
      isLoading: false,
      isError: false,
    });
    const capture: Captured<ReturnType<typeof useSourceItems>> = {
      current: null,
    };

    render(
      <FeedRuntime fallback={null} sources={[source]}>
        <ProbeOne capture={capture} sourceId="only" />
      </FeedRuntime>
    );

    expect(capture.current?.result.items).toEqual(items);
  });

  it("useSourceItems returns undefined for an unregistered source id", () => {
    const source = makeStubSource("real", {
      items: [],
      isLoading: false,
      isError: false,
    });
    const capture: Captured<ReturnType<typeof useSourceItems>> = {
      current: null,
    };

    render(
      <FeedRuntime fallback={null} sources={[source]}>
        <ProbeOne capture={capture} sourceId="missing" />
      </FeedRuntime>
    );

    expect(capture.current).toBeUndefined();
  });

  it("does not call useItems on unrelated sources when activeKind changes (hook-rule regression)", () => {
    const callsA = { count: 0 };
    const callsB = { count: 0 };

    function ToggleHost() {
      const [active, setActive] = useState<"a" | "b">("a");
      const sourceA = useMemo<FeedSource<StubItem, { tag: string }>>(
        () => ({
          id: "a",
          kind: FeedItemKind.LiveblocksComment,
          label: "A",
          Icon: MessageSquare,
          useItems: () => {
            callsA.count += 1;
            return { items: [], isLoading: false, isError: false };
          },
          defaultFilterState: { tag: "all" },
          applyFilter: (items) => items,
          isFiltered: () => false,
          renderItem: () => null,
        }),
        []
      );
      const sourceB = useMemo<FeedSource<StubItem, { tag: string }>>(
        () => ({
          id: "b",
          kind: FeedItemKind.PrComment,
          label: "B",
          Icon: MessageSquare,
          useItems: () => {
            callsB.count += 1;
            return { items: [], isLoading: false, isError: false };
          },
          defaultFilterState: { tag: "all" },
          applyFilter: (items) => items,
          isFiltered: () => false,
          renderItem: () => null,
        }),
        []
      );
      const sources = useMemo(() => [sourceA, sourceB], [sourceA, sourceB]);
      return (
        <>
          <button
            data-testid="toggle"
            onClick={() => setActive((p) => (p === "a" ? "b" : "a"))}
            type="button"
          >
            {active}
          </button>
          <FeedRuntime fallback={null} sources={sources}>
            <div data-testid="children" />
          </FeedRuntime>
        </>
      );
    }

    const { getByTestId, rerender } = render(<ToggleHost />);
    expect(callsA.count).toBeGreaterThan(0);
    expect(callsB.count).toBeGreaterThan(0);
    const beforeA = callsA.count;
    const beforeB = callsB.count;

    getByTestId("toggle").click();
    rerender(<ToggleHost />);

    expect(callsA.count).toBeGreaterThan(beforeA);
    expect(callsB.count).toBeGreaterThan(beforeB);
  });
});
