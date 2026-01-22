import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock overrides the resolve.alias mock at runtime to provide per-test
// controllable fns. The resolve.alias in vitest.config.mts is still needed to
// prevent the bundler from pulling in sandpack/stitches transitive deps.
const mockDispatchCommand = vi.fn();
const mockUseCellValues = vi.fn();
const mockUsePublisher = vi.fn();

vi.mock("@mdxeditor/editor", () => ({
  MDXEditor: ({ placeholder, markdown, className }: any) => (
    <div
      className={className}
      data-placeholder={placeholder}
      data-testid="mdx-editor"
    >
      {markdown}
    </div>
  ),
  headingsPlugin: vi.fn(() => ({})),
  listsPlugin: vi.fn(() => ({})),
  thematicBreakPlugin: vi.fn(() => ({})),
  markdownShortcutPlugin: vi.fn(() => ({})),
  quotePlugin: vi.fn(() => ({})),
  toolbarPlugin: vi.fn(() => ({})),
  useCellValues: (...args: any[]) => mockUseCellValues(...args),
  usePublisher: (...args: any[]) => mockUsePublisher(...args),
  currentFormat$: "currentFormat$",
  currentBlockType$: "currentBlockType$",
  currentListType$: "currentListType$",
  rootEditor$: "rootEditor$",
  applyFormat$: "applyFormat$",
  applyListType$: "applyListType$",
  convertSelectionToNode$: "convertSelectionToNode$",
  IS_BOLD: 1,
  IS_ITALIC: 2,
  IS_UNDERLINE: 4,
}));

import { RichTextToolbar } from "@repo/design-system/components/ui/rich-text-editor/rich-text-toolbar";

afterEach(cleanup);

describe("RichTextToolbar", () => {
  const mockPublishFormat = vi.fn();
  const mockPublishListType = vi.fn();
  const mockConvertSelectionToNode = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: no formatting, paragraph block, no list, editor available
    mockUseCellValues.mockReturnValue([
      0, // format
      "paragraph", // blockType
      "", // listType
      { dispatchCommand: mockDispatchCommand }, // editor
    ]);

    mockUsePublisher.mockImplementation((cell: string) => {
      if (cell === "applyFormat$") {
        return mockPublishFormat;
      }
      if (cell === "applyListType$") {
        return mockPublishListType;
      }
      if (cell === "convertSelectionToNode$") {
        return mockConvertSelectionToNode;
      }
      return vi.fn();
    });
  });

  test("renders all toolbar controls", () => {
    render(<RichTextToolbar />);
    expect(screen.getByText("Body")).toBeDefined();
    expect(screen.getByLabelText("Bold")).toBeDefined();
    expect(screen.getByLabelText("Italic")).toBeDefined();
    expect(screen.getByLabelText("Underline")).toBeDefined();
    expect(screen.getByLabelText("Bullet List")).toBeDefined();
    expect(screen.getByLabelText("Numbered List")).toBeDefined();
    expect(screen.getByLabelText("Undo")).toBeDefined();
    expect(screen.getByLabelText("Redo")).toBeDefined();
  });

  describe("heading dropdown", () => {
    test.each([
      ["paragraph", "Body"],
      ["h1", "Heading 1"],
      ["h2", "Heading 2"],
      ["h3", "Heading 3"],
    ])("shows '%s' block type as '%s'", (blockType, expectedLabel) => {
      mockUseCellValues.mockReturnValue([
        0,
        blockType,
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByText(expectedLabel)).toBeDefined();
    });

    test.each([
      ["h4", "Body"],
      ["h0", "Body"],
      ["quote", "Body"],
      ["", "Body"],
    ])("treats unrecognized block type '%s' as 'Body'", (blockType, expectedLabel) => {
      mockUseCellValues.mockReturnValue([
        0,
        blockType,
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByText(expectedLabel)).toBeDefined();
    });
  });

  describe("format toggles", () => {
    test.each([
      ["Bold", 1, "bold"],
      ["Italic", 2, "italic"],
      ["Underline", 4, "underline"],
    ] as const)("%s shows active state and dispatches on click", (label, flag, formatName) => {
      // Verify active state
      mockUseCellValues.mockReturnValue([
        flag,
        "paragraph",
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      const { unmount } = render(<RichTextToolbar />);
      expect(screen.getByLabelText(label).getAttribute("aria-pressed")).toBe(
        "true"
      );
      unmount();

      // Verify inactive state
      mockUseCellValues.mockReturnValue([
        0,
        "paragraph",
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByLabelText(label).getAttribute("aria-pressed")).toBe(
        "false"
      );

      // Verify click dispatches format
      fireEvent.click(screen.getByLabelText(label));
      expect(mockPublishFormat).toHaveBeenCalledWith(formatName);
    });

    test("shows multiple formats active simultaneously (bold + italic)", () => {
      mockUseCellValues.mockReturnValue([
        3,
        "paragraph",
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByLabelText("Bold").getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(screen.getByLabelText("Italic").getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(
        screen.getByLabelText("Underline").getAttribute("aria-pressed")
      ).toBe("false");
    });

    test("shows all formats active (bold + italic + underline)", () => {
      mockUseCellValues.mockReturnValue([
        7,
        "paragraph",
        "",
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByLabelText("Bold").getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(screen.getByLabelText("Italic").getAttribute("aria-pressed")).toBe(
        "true"
      );
      expect(
        screen.getByLabelText("Underline").getAttribute("aria-pressed")
      ).toBe("true");
    });
  });

  describe("list toggles", () => {
    test.each([
      ["Bullet List", "bullet"],
      ["Numbered List", "number"],
    ] as const)("%s toggles on when inactive and off when active", (label, listType) => {
      // Click when inactive → activates
      render(<RichTextToolbar />);
      fireEvent.click(screen.getByLabelText(label));
      expect(mockPublishListType).toHaveBeenCalledWith(listType);
      cleanup();

      // Click when active → deactivates
      mockPublishListType.mockClear();
      mockUseCellValues.mockReturnValue([
        0,
        "paragraph",
        listType,
        { dispatchCommand: mockDispatchCommand },
      ]);
      render(<RichTextToolbar />);
      expect(screen.getByLabelText(label).getAttribute("aria-pressed")).toBe(
        "true"
      );
      fireEvent.click(screen.getByLabelText(label));
      expect(mockPublishListType).toHaveBeenCalledWith("");
    });
  });

  describe("undo/redo", () => {
    test.each([
      ["Undo", "UNDO_COMMAND"],
      ["Redo", "REDO_COMMAND"],
    ] as const)("%s dispatches %s to editor", (label, command) => {
      render(<RichTextToolbar />);
      fireEvent.click(screen.getByLabelText(label));
      expect(mockDispatchCommand).toHaveBeenCalledWith(command, undefined);
    });
  });

  test("disables all interactive controls when editor is null", () => {
    mockUseCellValues.mockReturnValue([0, "paragraph", "", null]);
    render(<RichTextToolbar />);

    for (const label of [
      "Bold",
      "Italic",
      "Underline",
      "Bullet List",
      "Numbered List",
      "Undo",
      "Redo",
    ]) {
      expect(screen.getByLabelText(label).hasAttribute("disabled")).toBe(true);
    }
  });
});
