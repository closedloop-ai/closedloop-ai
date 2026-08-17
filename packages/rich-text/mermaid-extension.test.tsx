// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as TiptapReact from "@tiptap/react";
import mermaid from "mermaid";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MermaidComponent, MermaidExtension } from "./mermaid-extension";

const MERMAID_SVG_DARK =
  '<svg viewBox="0 0 10 10"><text>dark render</text></svg>';
const MERMAID_SVG_LIGHT =
  '<svg viewBox="0 0 10 10"><text>light render</text></svg>';
const MERMAID_SEQUENCE_SVG =
  '<svg viewBox="0 0 120 80"><text>plain svg text label</text></svg>';

const mocks = vi.hoisted(() => ({
  renderControls: [] as Array<{
    code: string;
    reject: (error: unknown) => void;
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

describe("MermaidComponent public actions", () => {
  it("adds, saves, and deletes a diagram from the empty state", () => {
    const props = createNodeViewProps({ content: "" });
    const { container } = render(<MermaidComponent {...props} selected />);

    expect(container.querySelector(".ring-2")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add Mermaid Diagram" })
    );

    const textarea = screen.getByRole("textbox", {
      name: "Mermaid diagram source",
    });
    fireEvent.change(textarea, { target: { value: "graph TD; A-->B;" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(props.updateAttributes).toHaveBeenCalledWith({
      content: "graph TD; A-->B;",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Add Mermaid Diagram" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(props.deleteNode).toHaveBeenCalledOnce();
  });

  it("cancels edits and restores the node's current content", async () => {
    const props = createNodeViewProps({ content: "graph TD; A;" });
    render(<MermaidComponent {...props} />);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    mocks.renderControls[0].resolve({ svg: MERMAID_SVG_LIGHT });
    await screen.findByTestId("mermaid-viewer");

    mocks.viewerCalls[0].onEdit();
    const textarea = await screen.findByRole("textbox", {
      name: "Mermaid diagram source",
    });
    fireEvent.change(textarea, { target: { value: "temporary" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(props.updateAttributes).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("textbox", { name: "Mermaid diagram source" })
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Add Mermaid Diagram" })
    );
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Mermaid diagram source",
      }).value
    ).toBe("graph TD; A;");
  });

  it("surfaces Error and non-Error render failures and opens the editor", async () => {
    const { rerender } = render(
      <MermaidComponent {...createNodeViewProps({ content: "bad one" })} />
    );
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    mocks.renderControls[0].reject(new Error("parse failed"));

    expect(await screen.findByText("parse failed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Diagram" }));
    expect(
      screen.getByRole("textbox", { name: "Mermaid diagram source" })
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerender(
      <MermaidComponent {...createNodeViewProps({ content: "bad two" })} />
    );
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(3));
    mocks.renderControls[2].reject("not an Error");
    expect(await screen.findByText("Failed to render diagram")).toBeTruthy();
  });

  it("opens the legacy rendered diagram from its public Edit action", async () => {
    render(
      <MermaidComponent
        {...createNodeViewProps({
          content: "graph TD; A;",
          enhancementsEnabled: false,
        })}
      />
    );
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledOnce());
    mocks.renderControls[0].resolve({ svg: MERMAID_SVG_LIGHT });

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("textbox", { name: "Mermaid diagram source" })
    ).toBeTruthy();
  });
});

describe("MermaidExtension public schema", () => {
  it("parses Mermaid pre blocks and rejects other preformatted code", () => {
    const parseRules = MermaidExtension.config.parseHTML?.call(
      MermaidExtension as never
    );
    const preRule = parseRules?.find((rule) => rule.tag === "pre");
    if (!(preRule && "getAttrs" in preRule && preRule.getAttrs)) {
      throw new Error("Mermaid pre parse rule was not registered");
    }
    const mermaidPre = document.createElement("pre");
    mermaidPre.innerHTML = '<code class="language-mermaid"></code>';
    const code = mermaidPre.querySelector("code");
    if (!code) {
      throw new Error("test code element was not created");
    }
    code.textContent = "";

    expect(preRule.getAttrs(mermaidPre)).toEqual({ content: "" });
    expect(preRule.getAttrs(document.createElement("pre"))).toBe(false);
  });

  it("executes its insertion, markdown, node-view, and plugin contracts", () => {
    const extension = MermaidExtension.configure({ enhancementsEnabled: true });
    const insertContent = vi.fn(() => true);
    const addCommands = extension.config.addCommands;
    const addNodeView = extension.config.addNodeView;
    if (!addCommands) {
      throw new Error("Mermaid commands were not registered");
    }
    const commands = addCommands.call(extension as never);
    const setMermaid = commands.setMermaid;
    if (!setMermaid) {
      throw new Error("setMermaid command was not registered");
    }

    expect(
      setMermaid({ content: "graph TD" })({
        commands: { insertContent } as never,
      } as never)
    ).toBe(true);
    expect(insertContent).toHaveBeenCalledWith({
      attrs: { content: "graph TD" },
      type: "mermaid",
    });
    expect(
      extension.config.renderMarkdown?.({}, {} as never, {} as never)
    ).toBe("```mermaid\n\n```\n\n");
    expect(addNodeView?.call(extension as never)).toBeTypeOf("function");
    expect(
      extension.config.addProseMirrorPlugins?.call(extension as never)
    ).toHaveLength(1);
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
