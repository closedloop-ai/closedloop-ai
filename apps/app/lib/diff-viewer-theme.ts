/**
 * Shared react-diff-viewer-continued theme using CSS custom properties.
 * Used by both the engineer ChangedFilesViewer and the branch BranchDiffView.
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

function makeDiffVars(overrides?: {
  addedBg?: number;
  removedBg?: number;
  wordAddedBg?: number;
  wordRemovedBg?: number;
  addedGutterBg?: number;
  removedGutterBg?: number;
  highlightBg?: number;
}): DiffViewerVars {
  const o = {
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
    addedBackground: `color-mix(in oklch, var(--success) ${o.addedBg}%, transparent)`,
    addedColor: "var(--foreground)",
    removedBackground: `color-mix(in oklch, var(--destructive) ${o.removedBg}%, transparent)`,
    removedColor: "var(--foreground)",
    wordAddedBackground: `color-mix(in oklch, var(--success) ${o.wordAddedBg}%, transparent)`,
    wordRemovedBackground: `color-mix(in oklch, var(--destructive) ${o.wordRemovedBg}%, transparent)`,
    addedGutterBackground: `color-mix(in oklch, var(--success) ${o.addedGutterBg}%, transparent)`,
    removedGutterBackground: `color-mix(in oklch, var(--destructive) ${o.removedGutterBg}%, transparent)`,
    gutterBackground: "var(--muted)",
    gutterBackgroundDark: "var(--muted)",
    highlightBackground: `color-mix(in oklch, var(--foreground) ${o.highlightBg}%, transparent)`,
    highlightGutterBackground: `color-mix(in oklch, var(--foreground) ${o.highlightBg}%, transparent)`,
    codeFoldGutterBackground: "var(--muted)",
    codeFoldBackground: "var(--muted)",
    emptyLineBackground: "var(--muted)",
    codeFoldContentColor: "var(--muted-foreground)",
  };
}

const sharedLineStyles = {
  line: {
    padding: "4px 8px",
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
  },
  gutter: {
    padding: "4px 8px",
    fontSize: "11px",
    minWidth: "40px",
  },
  contentText: {
    fontSize: "12px",
    fontFamily: "var(--font-mono), monospace",
  },
};

/**
 * Diff viewer styles for the engineer ChangedFilesViewer.
 * Uses separate light/dark vars with slightly different opacity values.
 */
export const diffViewerStyles = {
  variables: {
    light: makeDiffVars({
      addedBg: 12,
      removedBg: 12,
      wordAddedBg: 30,
      wordRemovedBg: 30,
      addedGutterBg: 25,
      removedGutterBg: 25,
      highlightBg: 5,
    }),
    dark: makeDiffVars({
      addedBg: 15,
      removedBg: 15,
      wordAddedBg: 40,
      wordRemovedBg: 40,
      addedGutterBg: 20,
      removedGutterBg: 20,
      highlightBg: 10,
    }),
  },
  ...sharedLineStyles,
};

/**
 * Diff viewer styles for the branch view BranchDiffView.
 * Uses same vars for light and dark (CSS variables handle theming).
 */
export const branchDiffViewerStyles = {
  variables: {
    light: makeDiffVars(),
    dark: makeDiffVars(),
  },
  ...sharedLineStyles,
};
