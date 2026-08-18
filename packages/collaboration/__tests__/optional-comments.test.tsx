// @vitest-environment jsdom

import { DocumentThreadAnchorStatus } from "@repo/api/src/types/comment";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OptionalComments } from "../client/optional-comments";

const {
  mockAnchoredThreads,
  mockFloatingComposer,
  mockFloatingThreads,
  mockFloatingToolbar,
  mockUseConstrainFloatingWithinEditor,
  mockUseThreads,
} = vi.hoisted(() => ({
  mockAnchoredThreads: vi.fn(),
  mockFloatingComposer: vi.fn(),
  mockFloatingThreads: vi.fn(),
  mockFloatingToolbar: vi.fn(),
  mockUseConstrainFloatingWithinEditor: vi.fn(),
  mockUseThreads: vi.fn(),
}));

vi.mock("@liveblocks/react/suspense", () => ({
  useThreads: mockUseThreads,
}));

vi.mock("@liveblocks/react-tiptap", () => ({
  AnchoredThreads: (props: Record<string, unknown>) => {
    mockAnchoredThreads(props);
    return <div data-testid="anchored-threads" />;
  },
  FloatingComposer: (props: Record<string, unknown>) => {
    mockFloatingComposer(props);
    return <div data-testid="floating-composer" />;
  },
  FloatingThreads: (props: Record<string, unknown>) => {
    mockFloatingThreads(props);
    return <div data-testid="floating-threads" />;
  },
  FloatingToolbar: (props: Record<string, unknown>) => {
    mockFloatingToolbar(props);
    return <div data-testid="floating-toolbar" />;
  },
}));

vi.mock("../client/use-constrain-floating-within-editor", () => ({
  useConstrainFloatingWithinEditor: mockUseConstrainFloatingWithinEditor,
}));

describe("OptionalComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseThreads.mockReturnValue({ threads: [] });
  });

  it.each([
    null,
    undefined,
    "",
  ])("renders nothing without a room id (%s)", (roomId) => {
    const { container } = render(
      <OptionalComments editor={createEditor() as never} roomId={roomId} />
    );

    expect(container).toBeEmptyDOMElement();
    expect(mockUseConstrainFloatingWithinEditor).not.toHaveBeenCalled();
  });

  it("renders the floating controls with default anchored metadata", () => {
    const editor = createEditor();

    render(
      <OptionalComments editor={editor as never} roomId="org:artifact:ISS-1" />
    );

    expect(screen.getByTestId("floating-threads")).toBeInTheDocument();
    expect(screen.getByTestId("floating-composer")).toBeInTheDocument();
    expect(screen.getByTestId("floating-toolbar")).toBeInTheDocument();
    expect(mockUseConstrainFloatingWithinEditor).toHaveBeenCalledWith(editor);
    expect(lastProps(mockFloatingComposer).metadata).toEqual({
      anchorPreview: "",
      anchorStatus: DocumentThreadAnchorStatus.Anchored,
    });
    expect(lastProps(mockFloatingThreads).threads).toEqual([]);
  });

  it("tracks a trimmed, bounded selection preview and unregisters the listener", () => {
    const editor = createEditor();
    const longSelection = `  ${"a".repeat(175)}  `;
    editor.state.doc.textBetween.mockReturnValue(longSelection);
    const { unmount } = render(
      <OptionalComments
        currentVersion={0}
        editor={editor as never}
        renderGutterThreads={false}
        roomId="org:artifact:ISS-1"
      />
    );

    expect(screen.queryByTestId("floating-threads")).not.toBeInTheDocument();
    expect(mockUseThreads).not.toHaveBeenCalled();
    expect(lastProps(mockFloatingComposer).metadata).toEqual({
      anchorPreview: "",
      anchorStatus: DocumentThreadAnchorStatus.Anchored,
      version: 0,
    });

    editor.state.selection.from = 2;
    editor.state.selection.to = 180;
    act(() => editor.selectionListener?.());

    expect(lastProps(mockFloatingComposer).metadata).toEqual({
      anchorPreview: "a".repeat(150),
      anchorStatus: DocumentThreadAnchorStatus.Anchored,
      version: 0,
    });

    unmount();
    expect(editor.off).toHaveBeenCalledWith(
      "selectionUpdate",
      editor.selectionListener
    );
  });

  it("keeps the prior preview for collapsed and whitespace-only selections", () => {
    const editor = createEditor();
    render(
      <OptionalComments editor={editor as never} roomId="org:artifact:ISS-1" />
    );

    act(() => editor.selectionListener?.());
    expect(editor.state.doc.textBetween).not.toHaveBeenCalled();

    editor.state.selection.to = 4;
    editor.state.doc.textBetween.mockReturnValue("   ");
    act(() => editor.selectionListener?.());

    expect(lastProps(mockFloatingComposer).metadata).toMatchObject({
      anchorPreview: "",
    });
  });

  it("renders unresolved anchored threads and hides the gutter after resolution", () => {
    const editor = createEditor();
    const unresolved = { id: "thread-open", resolved: false };
    const resolved = { id: "thread-done", resolved: true };
    mockUseThreads.mockReturnValue({ threads: [resolved, unresolved] });
    const { rerender } = render(
      <OptionalComments
        editor={editor as never}
        mode="anchored"
        roomId="org:artifact:ISS-1"
      />
    );

    expect(screen.getByTestId("anchored-threads")).toBeInTheDocument();
    expect(lastProps(mockAnchoredThreads).threads).toEqual([
      resolved,
      unresolved,
    ]);

    mockUseThreads.mockReturnValue({ threads: [resolved] });
    rerender(
      <OptionalComments
        editor={editor as never}
        mode="anchored"
        roomId="org:artifact:ISS-1"
      />
    );

    expect(screen.queryByTestId("anchored-threads")).not.toBeInTheDocument();
    expect(screen.getByTestId("floating-composer")).toBeInTheDocument();
  });

  it("does not subscribe to selection changes until an editor exists", () => {
    const editor = createEditor();
    const { rerender } = render(
      <OptionalComments
        editor={null as never}
        renderGutterThreads={false}
        roomId="org:artifact:ISS-1"
      />
    );

    expect(editor.on).not.toHaveBeenCalled();

    rerender(
      <OptionalComments
        editor={editor as never}
        renderGutterThreads={false}
        roomId="org:artifact:ISS-1"
      />
    );
    expect(editor.on).toHaveBeenCalledWith(
      "selectionUpdate",
      editor.selectionListener
    );
  });
});

function createEditor() {
  const editor = {
    off: vi.fn(),
    on: vi.fn(),
    selectionListener: undefined as (() => void) | undefined,
    state: {
      doc: { textBetween: vi.fn() },
      selection: { from: 1, to: 1 },
    },
  };
  editor.on.mockImplementation((_event: string, listener: () => void) => {
    editor.selectionListener = listener;
  });
  return editor;
}

function lastProps(mockComponent: ReturnType<typeof vi.fn>) {
  return mockComponent.mock.lastCall?.[0] as Record<string, unknown>;
}
