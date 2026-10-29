import { useHeldMenuOptions } from "@closedloop-ai/design-system/hooks/use-held-menu-options";
import { renderHook } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

type Option = { id: string; label: string };

function option(id: string, label: string): Option {
  return { id, label };
}

describe("useHeldMenuOptions", () => {
  it("returns the initial options in their given order", () => {
    const options = [option("a", "A"), option("b", "B"), option("c", "C")];
    const { result } = renderHook(() => useHeldMenuOptions(options));

    expect(result.current).toEqual(options);
  });

  it("keeps a removed option's row, showing its last-seen values", () => {
    const first = [option("a", "A"), option("b", "B"), option("c", "C")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    const second = [option("a", "A"), option("c", "C")];
    rerender({ options: second });

    expect(result.current.map((o) => o.id)).toEqual(["a", "b", "c"]);
    expect(result.current.find((o) => o.id === "b")).toEqual(option("b", "B"));
  });

  it("shows the live value for an option that is still present", () => {
    const first = [option("a", "A"), option("b", "B")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    const second = [option("a", "A updated"), option("b", "B")];
    rerender({ options: second });

    expect(result.current.find((o) => o.id === "a")).toEqual(
      option("a", "A updated")
    );
  });

  it("appends a newly arrived option at the end", () => {
    const first = [option("a", "A"), option("b", "B")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    // The new option is inserted at the FRONT of the live list, but must not
    // displace anything the pointer might already be over.
    const second = [option("c", "C"), option("a", "A"), option("b", "B")];
    rerender({ options: second });

    expect(result.current.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps a re-added option at its originally-seen position rather than moving it to the end", () => {
    const first = [option("a", "A"), option("b", "B"), option("c", "C")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    rerender({ options: [option("a", "A"), option("c", "C")] }); // b removed
    rerender({
      options: [option("a", "A"), option("b", "B"), option("c", "C")],
    }); // b returns

    expect(result.current.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("reports every seen row rather than emptiness when the live list empties out", () => {
    const first = [option("a", "A"), option("b", "B")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    rerender({ options: [] });

    expect(result.current.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("returns the same held set when the live list is rebuilt with the same ids", () => {
    const first = [option("a", "A"), option("b", "B")];
    const { result, rerender } = renderHook(
      ({ options }) => useHeldMenuOptions(options),
      { initialProps: { options: first } }
    );

    // A fresh array reference with the exact same ids — the common case for a
    // caller whose `options` prop is rebuilt every render (`tagOptions ?? []`).
    rerender({ options: [...first] });

    // The RESULT is unchanged: same ids in the same order.
    expect(result.current.map((o) => o.id)).toEqual(["a", "b"]);
  });

  it("re-renders when the live list brings an unseen id", () => {
    function useProbe(options: readonly Option[]) {
      const renderCount = useRef(0);
      renderCount.current += 1;
      const held = useHeldMenuOptions(options);
      return { held, renderCount: renderCount.current };
    }

    const first = [option("a", "A")];
    const { result, rerender } = renderHook(
      ({ options }) => useProbe(options),
      { initialProps: { options: first } }
    );
    const renderCountAfterMount = result.current.renderCount;

    rerender({ options: [option("a", "A"), option("b", "B")] });

    expect(result.current.renderCount).toBeGreaterThan(renderCountAfterMount);
    expect(result.current.held.map((o) => o.id)).toEqual(["a", "b"]);

    // The assertion above alone does NOT prove `b` entered `seenIds`: it is
    // still live on that render, so `holdSeenOptions` appends it from the live
    // list even with the `setSeenIds` update gone. Taking it back out is what
    // separates "held" from "merely live" — a `b` that was never recorded
    // disappears here.
    rerender({ options: [option("a", "A")] });

    expect(result.current.held.map((o) => o.id)).toEqual(["a", "b"]);
    expect(result.current.held.find((o) => o.id === "b")).toEqual(
      option("b", "B")
    );
  });
});
