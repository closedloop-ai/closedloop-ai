// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import type * as TiptapReact from "@tiptap/react";
import mermaid from "mermaid";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidComponent } from "./mermaid-extension";

const MERMAID_SVG_DARK =
  '<svg viewBox="0 0 10 10"><text>dark render</text></svg>';
const MERMAID_SVG_LIGHT =
  '<svg viewBox="0 0 10 10"><text>light render</text></svg>';
const MERMAID_SEQUENCE_SVG =
  '<svg viewBox="0 0 120 80"><text>plain svg text label</text></svg>';

const mocks = vi.hoisted(() => ({
  renderControls: [] as Array<{
    code: string;
    reject: (error: Error) => void;
    resolve: (result: { svg: string }) => void;
  }>,
  resolvedTheme: "light",
  viewerCalls: [] as Array<{
    onEdit: () => void;
    svg: string;
  }>,
}));

vi.mock("next-themes", () => ({
  useTheme: vi.fn(() => ({ resolvedTheme: mocks.resolvedTheme })),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn((_id: string, code: string) => {
      return new Promise((resolve, reject) => {
        mocks.renderControls.push({ code, reject, resolve });
      });
    }),
  },
}));

vi.mock("@tiptap/react", async () => {
  const actual = await vi.importActual<typeof TiptapReact>("@tiptap/react");
  return {
    ...actual,
    NodeViewWrapper: ({
      children,
      className,
    }: Readonly<{ children: ReactNode; className?: string }>) =>
      React.createElement("div", { className }, children),
  };
});

vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  DropdownMenuContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: Readonly<{ children: ReactNode; onClick?: () => void }>) => (
    <button onClick={onClick} type="button">
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
}));

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipContent: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
  TooltipTrigger: ({ children }: Readonly<{ children: ReactNode }>) => (
    <div>{children}</div>
  ),
}));

function createMermaidViewerMock() {
  return {
    MermaidViewer: ({
      onEdit,
      svg,
    }: Readonly<{ onEdit: () => void; svg: string }>) => {
      mocks.viewerCalls.push({ onEdit, svg });
      return <div data-testid="mermaid-viewer" />;
    },
  };
}

vi.mock("./mermaid-viewer", createMermaidViewerMock);

vi.mock("./mermaid-viewer.tsx", createMermaidViewerMock);

afterEach(() => {
  mocks.renderControls.length = 0;
  mocks.resolvedTheme = "light";
  mocks.viewerCalls.length = 0;
  vi.clearAllMocks();
});

describe("MermaidComponent render ordering", () => {
  it("ignores an older theme render that resolves after the current one", async () => {
    const { rerender } = render(
      <MermaidComponent {...createNodeViewProps({ content: "graph TD; A;" })} />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    mocks.resolvedTheme = "dark";
    rerender(
      <MermaidComponent {...createNodeViewProps({ content: "graph TD; A;" })} />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    mocks.renderControls[1].resolve({ svg: MERMAID_SVG_DARK });

    expect(await screen.findByTestId("mermaid-viewer")).toBeTruthy();
    expect(latestViewerSvg()).toContain("dark render");
    expect(latestViewerSvg()).toContain('data-cl-mermaid-dark="true"');

    mocks.renderControls[0].resolve({ svg: MERMAID_SVG_LIGHT });

    await waitFor(() => expect(latestViewerSvg()).toContain("dark render"));
    expect(mocks.viewerCalls).toHaveLength(1);
  });

  it("does not let a stale error clear a newer successful render", async () => {
    const { rerender } = render(
      <MermaidComponent {...createNodeViewProps({ content: "graph TD; A;" })} />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    mocks.resolvedTheme = "dark";
    rerender(
      <MermaidComponent {...createNodeViewProps({ content: "graph TD; A;" })} />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2));
    mocks.renderControls[1].resolve({ svg: MERMAID_SVG_DARK });

    expect(await screen.findByTestId("mermaid-viewer")).toBeTruthy();
    expect(latestViewerSvg()).toContain("dark render");
    expect(latestViewerSvg()).toContain('data-cl-mermaid-dark="true"');

    mocks.renderControls[0].reject(new Error("old render failed"));

    await waitFor(() => expect(latestViewerSvg()).toContain("dark render"));
    expect(screen.queryByText("Mermaid Error:")).toBeNull();
  });

  it("passes the latest non-flowchart plain-SVG-text render to the interactive viewer", async () => {
    render(
      <MermaidComponent
        {...createNodeViewProps({
          content: "sequenceDiagram\nAlice->>Bob: plain text label",
        })}
      />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    expect(mocks.renderControls[0].code).toBe(
      "sequenceDiagram\nAlice->>Bob: plain text label"
    );

    mocks.renderControls[0].resolve({ svg: MERMAID_SEQUENCE_SVG });

    expect(await screen.findByTestId("mermaid-viewer")).toBeTruthy();
    expect(mocks.viewerCalls).toHaveLength(1);
    expect(latestViewerSvg()).toBe(MERMAID_SEQUENCE_SVG);
  });

  it("invalidates outstanding work when content becomes empty", async () => {
    const { rerender } = render(
      <MermaidComponent {...createNodeViewProps({ content: "graph TD; A;" })} />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));

    rerender(<MermaidComponent {...createNodeViewProps({ content: "" })} />);

    expect(
      screen.getByRole("button", { name: "Add Mermaid Diagram" })
    ).toBeTruthy();

    mocks.renderControls[0].resolve({ svg: MERMAID_SVG_LIGHT });

    await waitFor(() =>
      expect(screen.queryByTestId("mermaid-viewer")).toBeNull()
    );
  });

  it("keeps the legacy fallback on the sanitized current SVG path", async () => {
    render(
      <MermaidComponent
        {...createNodeViewProps({
          content: "graph TD; A;",
          enhancementsEnabled: false,
        })}
      />
    );

    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    mocks.renderControls[0].resolve({
      svg: '<svg viewBox="0 0 10 10"><script>bad()</script><text>legacy render</text></svg>',
    });

    expect(await screen.findByText("legacy render")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("<script");
    expect(document.body.innerHTML).not.toContain("bad()");
  });
});

function createNodeViewProps({
  content,
  enhancementsEnabled = true,
}: {
  content: string;
  enhancementsEnabled?: boolean;
}) {
  return {
    decorations: [],
    deleteNode: vi.fn(),
    editor: {},
    extension: {
      options: { enhancementsEnabled },
    },
    getPos: vi.fn(() => 0),
    HTMLAttributes: {},
    innerDecorations: {},
    node: {
      attrs: { content },
    },
    selected: false,
    updateAttributes: vi.fn(),
  };
}

function latestViewerSvg() {
  const latestCall = mocks.viewerCalls.at(-1);
  if (!latestCall) {
    throw new Error("MermaidViewer was not rendered");
  }
  return latestCall.svg;
}
