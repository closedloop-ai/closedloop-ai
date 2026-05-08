// Stub for @mdxeditor/editor - prevents bundler from resolving the real module
// (which pulls in sandpack/stitches, crashing in jsdom).
// Test files provide per-test behavior via vi.mock().
import { createElement } from "react";

export const IS_BOLD = 1;
export const IS_ITALIC = 2;
export const IS_UNDERLINE = 4;

export const currentFormat$ = "currentFormat$";
export const currentBlockType$ = "currentBlockType$";
export const currentListType$ = "currentListType$";
export const rootEditor$ = "rootEditor$";
export const applyFormat$ = "applyFormat$";
export const applyListType$ = "applyListType$";
export const convertSelectionToNode$ = "convertSelectionToNode$";

export const useCellValues = () => [0, "paragraph", "", null];
export const usePublisher = () => () => null;

export const headingsPlugin = () => ({});
export const listsPlugin = () => ({});
export const thematicBreakPlugin = () => ({});
export const markdownShortcutPlugin = () => ({});
export const quotePlugin = () => ({});
export const toolbarPlugin = () => ({});

export function MDXEditor({ markdown, placeholder, className }: any) {
  return createElement(
    "div",
    { "data-testid": "mdx-editor", className, "data-placeholder": placeholder },
    markdown
  );
}
