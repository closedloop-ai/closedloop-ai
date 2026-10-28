import { ResizablePanel } from "@closedloop-ai/design-system/components/ui/resizable";
import { render } from "@testing-library/react";
import type { PanelProps } from "react-resizable-panels";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The migration's one silent hazard. react-resizable-panels@3 read a bare
 * number as a PERCENTAGE of the group; @4 reads it as PIXELS and a unitless
 * string as a percentage. Nothing about that fails typecheck — `defaultSize`
 * accepts `number` in both — so `defaultSize={25}` would quietly become a
 * 25-pixel panel on every existing call site.
 *
 * jsdom has no layout, so the library resolves no size at all there and a
 * rendered assertion cannot tell the two apart. The conversion is therefore
 * pinned where it is actually decided: the props this wrapper hands the
 * library.
 */

const panelProps = vi.fn<(props: PanelProps) => void>();

vi.mock("react-resizable-panels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("react-resizable-panels")>();
  return {
    ...actual,
    Panel: (props: PanelProps) => {
      panelProps(props);
      return <div data-panel="true">{props.children}</div>;
    },
  };
});

beforeEach(() => {
  panelProps.mockClear();
});

function lastPanelProps(): PanelProps {
  const call = panelProps.mock.calls.at(-1);
  if (!call) {
    throw new Error("ResizablePanel never rendered the library Panel");
  }
  return call[0];
}

describe("ResizablePanel size units", () => {
  it("sends every numeric size to the library as a percentage", () => {
    render(
      <ResizablePanel
        collapsedSize={5}
        defaultSize={25}
        maxSize={40}
        minSize={15}
      >
        chat
      </ResizablePanel>
    );

    const props = lastPanelProps();
    expect(props.defaultSize).toBe("25%");
    expect(props.minSize).toBe("15%");
    expect(props.maxSize).toBe("40%");
    expect(props.collapsedSize).toBe("5%");
  });

  it("passes an explicitly united string through untouched", () => {
    render(
      <ResizablePanel defaultSize="240px" minSize="20rem">
        body
      </ResizablePanel>
    );

    const props = lastPanelProps();
    expect(props.defaultSize).toBe("240px");
    expect(props.minSize).toBe("20rem");
  });

  it("leaves an omitted size omitted", () => {
    render(<ResizablePanel>body</ResizablePanel>);

    const props = lastPanelProps();
    expect(props.defaultSize).toBeUndefined();
    expect(props.minSize).toBeUndefined();
  });
});
