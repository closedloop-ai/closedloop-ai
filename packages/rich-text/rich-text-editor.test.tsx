// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "./rich-text-editor";
import type { RichTextEditorProps } from "./types";

const coreProps = vi.hoisted(() => ({ calls: [] as unknown[] }));

vi.mock("./tiptap-editor-core", () => ({
  TiptapEditorCore: (props: Readonly<RichTextEditorProps>) => {
    coreProps.calls.push(props);
    return <div data-testid="editor-core" />;
  },
}));

afterEach(() => {
  coreProps.calls.length = 0;
});

describe("RichTextEditor", () => {
  it("server-renders only the skeleton and never reaches the editor core", () => {
    const html = renderToString(<RichTextEditor onChange={vi.fn()} value="" />);

    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain(SUSPENSE_BOUNDARY_MARKER);
    expect(html).not.toContain('data-testid="editor-core"');
    expect(coreProps.calls).toEqual([]);
  });

  it("shows the skeleton until the lazy editor core resolves", async () => {
    const { container } = render(
      <RichTextEditor onChange={vi.fn()} value="" />
    );

    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(screen.queryByTestId("editor-core")).toBeNull();

    await screen.findByTestId("editor-core");
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
  });

  it("mounts the editor core with the default scroll and toolbar modes", async () => {
    render(<RichTextEditor onChange={vi.fn()} value="hello" />);

    expect(await screen.findByTestId("editor-core")).toBeTruthy();
    expect(coreProps.calls.at(-1)).toMatchObject({
      scrollMode: "inner",
      toolbarMode: "always",
      value: "hello",
    });
  });

  it("forwards explicit scroll and toolbar modes", async () => {
    render(
      <RichTextEditor
        onChange={vi.fn()}
        scrollMode="outer"
        toolbarMode="focus"
        value=""
      />
    );

    await screen.findByTestId("editor-core");
    expect(coreProps.calls.at(-1)).toMatchObject({
      scrollMode: "outer",
      toolbarMode: "focus",
    });
  });

  it("forwards the empty-room seed opt-out", async () => {
    render(<RichTextEditor onChange={vi.fn()} skipEmptyRoomSeed value="" />);

    await screen.findByTestId("editor-core");
    expect(coreProps.calls.at(-1)).toMatchObject({ skipEmptyRoomSeed: true });
  });
});

// React's server renderer wraps every Suspense boundary in <!--$...--> comments.
const SUSPENSE_BOUNDARY_MARKER = "<!--$";
