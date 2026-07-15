import type { ReactDiffViewerStylesOverride } from "react-diff-viewer-continued";

/**
 * Shared react-diff-viewer-continued theme for branch file diffs.
 *
 * The values are expressed with design-system CSS variables so the same
 * presentational viewer works in the web app and the desktop renderer.
 */

type DiffViewerVars = {
  diffViewerBackground: string;
  diffViewerColor: string;
  addedBackground: string;
  addedColor: string;
  removedBackground: string;
  removedColor: string;
  wordAddedBackground: string;
  wordRemovedBackground: string;
  addedGutterBackground: string;
  removedGutterBackground: string;
  gutterBackground: string;
  gutterBackgroundDark: string;
  highlightBackground: string;
  highlightGutterBackground: string;
  codeFoldGutterBackground: string;
  codeFoldBackground: string;
  emptyLineBackground: string;
  codeFoldContentColor: string;
};

const sharedLineStyles = {
  line: {
    padding: "4px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
  },
  content: {
    minWidth: 0,
    overflow: "visible",
    width: "100%",
  },
  gutter: {
    padding: "4px 8px",
    fontSize: "11px",
    minWidth: "40px",
  },
  contentText: {
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
    overflowWrap: "anywhere",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
} as const;

/** Diff viewer styles used by branch review and desktop branch-file previews. */
export const branchDiffViewerStyles = {
  variables: {
    light: makeDiffVars(),
    dark: makeDiffVars(),
  },
  ...sharedLineStyles,
} satisfies ReactDiffViewerStylesOverride;

function makeDiffVars(overrides?: {
  addedBg?: number;
  removedBg?: number;
  wordAddedBg?: number;
  wordRemovedBg?: number;
  addedGutterBg?: number;
  removedGutterBg?: number;
  highlightBg?: number;
}): DiffViewerVars {
  const opacity = {
    addedBg: 14,
    removedBg: 14,
    wordAddedBg: 35,
    wordRemovedBg: 35,
    addedGutterBg: 22,
    removedGutterBg: 22,
    highlightBg: 8,
    ...overrides,
  };
  return {
    diffViewerBackground: "var(--background)",
    diffViewerColor: "var(--foreground)",
    addedBackground: `color-mix(in oklch, var(--success) ${opacity.addedBg}%, transparent)`,
    addedColor: "var(--foreground)",
    removedBackground: `color-mix(in oklch, var(--destructive) ${opacity.removedBg}%, transparent)`,
    removedColor: "var(--foreground)",
    wordAddedBackground: `color-mix(in oklch, var(--success) ${opacity.wordAddedBg}%, transparent)`,
    wordRemovedBackground: `color-mix(in oklch, var(--destructive) ${opacity.wordRemovedBg}%, transparent)`,
    addedGutterBackground: `color-mix(in oklch, var(--success) ${opacity.addedGutterBg}%, transparent)`,
    removedGutterBackground: `color-mix(in oklch, var(--destructive) ${opacity.removedGutterBg}%, transparent)`,
    gutterBackground: "var(--muted)",
    gutterBackgroundDark: "var(--muted)",
    highlightBackground: `color-mix(in oklch, var(--foreground) ${opacity.highlightBg}%, transparent)`,
    highlightGutterBackground: `color-mix(in oklch, var(--foreground) ${opacity.highlightBg}%, transparent)`,
    codeFoldGutterBackground: "var(--muted)",
    codeFoldBackground: "var(--muted)",
    emptyLineBackground: "var(--muted)",
    codeFoldContentColor: "var(--muted-foreground)",
  };
}
