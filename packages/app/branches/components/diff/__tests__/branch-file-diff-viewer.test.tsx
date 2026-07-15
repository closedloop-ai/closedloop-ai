import type { BranchViewFileDiff } from "@repo/api/src/types/branch-view";
import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchFileDiffViewer } from "../branch-file-diff-viewer";

const { reactDiffViewerMock } = vi.hoisted(() => ({
  reactDiffViewerMock: vi.fn(),
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

vi.mock("react-diff-viewer-continued", () => ({
  default: (props: {
    newValue: string;
    oldValue: string;
    styles?: Record<string, Record<string, string>>;
  }) => {
    reactDiffViewerMock(props);
    return (
      <div data-testid="react-diff-viewer">
        <div data-testid="old-value">{props.oldValue}</div>
        <div data-testid="new-value">{props.newValue}</div>
      </div>
    );
  },
  DiffMethod: { WORDS: "WORDS" },
  LineNumberPrefix: { LEFT: "L", RIGHT: "R" },
}));

const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(
  globalThis.window,
  "matchMedia"
);

afterEach(() => {
  reactDiffViewerMock.mockClear();
  if (originalMatchMediaDescriptor) {
    Object.defineProperty(
      globalThis.window,
      "matchMedia",
      originalMatchMediaDescriptor
    );
    return;
  }
  Reflect.deleteProperty(globalThis.window, "matchMedia");
});

describe("BranchFileDiffViewer", () => {
  it("renders a loading state", () => {
    render(
      <BranchFileDiffViewer
        diffData={undefined}
        diffError={null}
        isDiffLoading={true}
      />
    );

    expect(document.querySelectorAll(".h-28")).toHaveLength(2);
  });

  it("renders an error state", () => {
    render(
      <BranchFileDiffViewer
        diffData={undefined}
        diffError={new Error("failed")}
        isDiffLoading={false}
      />
    );

    expect(
      screen.getByText("Failed to load this file diff.")
    ).toBeInTheDocument();
  });

  it("renders a binary state", () => {
    render(
      <BranchFileDiffViewer
        diffData={makeDiff({ isBinary: true })}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(screen.getByText("Binary file diff not shown.")).toBeInTheDocument();
  });

  it("binds old and new text content without swapping sides", () => {
    render(
      <BranchFileDiffViewer
        diffData={makeDiff({ oldContent: "before", newContent: "after" })}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(screen.getByTestId("old-value")).toHaveTextContent("before");
    expect(screen.getByTestId("new-value")).toHaveTextContent("after");
  });

  it("renders added files with an empty old side", () => {
    render(
      <BranchFileDiffViewer
        diffData={makeDiff({
          isNew: true,
          oldContent: "",
          newContent: "added",
        })}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(screen.getByTestId("old-value")).toHaveTextContent("");
    expect(screen.getByTestId("new-value")).toHaveTextContent("added");
  });

  it("renders deleted files with an empty new side", () => {
    render(
      <BranchFileDiffViewer
        diffData={makeDiff({
          isDeleted: true,
          oldContent: "deleted",
          newContent: "",
        })}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(screen.getByTestId("old-value")).toHaveTextContent("deleted");
    expect(screen.getByTestId("new-value")).toHaveTextContent("");
  });

  it("uses unified diff layout for narrow screens", async () => {
    stubMatchMedia(true);

    render(
      <BranchFileDiffViewer
        diffData={makeDiff()}
        diffError={null}
        isDiffLoading={false}
      />
    );

    await waitFor(() =>
      expect(reactDiffViewerMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ splitView: false })
      )
    );
  });

  it("keeps split diff layout for wider screens", () => {
    stubMatchMedia(false);

    render(
      <BranchFileDiffViewer
        diffData={makeDiff()}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(reactDiffViewerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ splitView: true })
    );
  });

  it("honors an explicit split-view override for narrow web callers", async () => {
    const matchMedia = stubMatchMedia(true);

    render(
      <BranchFileDiffViewer
        diffData={makeDiff()}
        diffError={null}
        isDiffLoading={false}
        viewerProps={{ splitView: true }}
      />
    );

    await waitFor(() => expect(matchMedia).toHaveBeenCalled());
    expect(reactDiffViewerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ splitView: true })
    );
  });

  it("does not read matchMedia during server render initialization", () => {
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => {
        throw new Error("matchMedia should not be read during render");
      }),
    });

    expect(() =>
      renderToString(
        <BranchFileDiffViewer
          diffData={makeDiff()}
          diffError={null}
          isDiffLoading={false}
        />
      )
    ).not.toThrow();
  });

  it("passes wrapping styles for narrow long diff lines", () => {
    render(
      <BranchFileDiffViewer
        diffData={makeDiff({
          newContent:
            "export const after = 'new branch detail value with enough content to wrap';",
          oldContent:
            "export const before = 'old branch detail value with enough content to wrap';",
        })}
        diffError={null}
        isDiffLoading={false}
      />
    );

    expect(reactDiffViewerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        styles: expect.objectContaining({
          contentText: expect.objectContaining({
            overflowWrap: "anywhere",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }),
          content: expect.objectContaining({
            minWidth: 0,
            overflow: "visible",
            width: "100%",
          }),
        }),
      })
    );
  });
});

function makeDiff(
  overrides: Partial<BranchViewFileDiff> = {}
): BranchViewFileDiff {
  return {
    isBinary: false,
    isDeleted: false,
    isNew: false,
    newContent: "new",
    oldContent: "old",
    path: "src/a.ts",
    ...overrides,
  };
}

function stubMatchMedia(matches: boolean) {
  const matchMedia = vi.fn(() => ({
    addEventListener: vi.fn(),
    matches,
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: matchMedia,
  });
  return matchMedia;
}
