import type mermaid from "mermaid";

export const MermaidThemeMode = {
  Dark: "dark",
  Light: "light",
} as const;

export type MermaidThemeMode =
  (typeof MermaidThemeMode)[keyof typeof MermaidThemeMode];

export type MermaidInitializeConfig = Parameters<typeof mermaid.initialize>[0];

const RE_SVG_OPEN_TAG = /<svg\b([^>]*)>/;

/**
 * Build a fresh Mermaid initialization config for the requested editor theme.
 * Hard-coded colors keep exported SVG readable outside the app CSS runtime.
 */
export function getMermaidConfig(
  mode: MermaidThemeMode
): MermaidInitializeConfig {
  return {
    startOnLoad: false,
    securityLevel: "loose",
    theme: "base",
    themeCSS: mode === MermaidThemeMode.Dark ? DARK_THEME_CSS : "",
    themeVariables:
      mode === MermaidThemeMode.Dark
        ? getDarkThemeVariables()
        : getLightThemeVariables(),
  };
}

/**
 * Embed theme CSS in Mermaid's generated SVG so labels remain readable after
 * sanitization, export, and standalone browser rendering.
 */
export function applyMermaidSvgTheme(
  svg: string,
  mode: MermaidThemeMode
): string {
  if (mode !== MermaidThemeMode.Dark || svg.includes("data-cl-mermaid-dark")) {
    return svg;
  }
  return svg.replace(
    RE_SVG_OPEN_TAG,
    `<svg$1><style data-cl-mermaid-dark="true">${DARK_THEME_CSS}</style>`
  );
}

const DARK_THEME_CSS = `
.edgeLabel {
  background-color: #111827 !important;
  color: #f8fafc !important;
}
.edgeLabel rect,
.labelBkg {
  fill: #111827 !important;
  fill-opacity: 0.96 !important;
}
  .edgeLabel text,
  .edgeLabel span,
  .edgeLabel p,
  text.actor,
  .actor text,
  .actor tspan,
  .actorText,
  .actorText tspan,
  .messageText,
  .messageText tspan,
  .loopText,
  .loopText tspan {
  color: #f8fafc !important;
  fill: #f8fafc !important;
  stroke: none !important;
}
.messageLine0,
.messageLine1,
.flowchart-link {
  stroke: #cbd5e1 !important;
}
`;

function getLightThemeVariables() {
  return {
    background: "#ffffff",
    mainBkg: "#ffffff",
    primaryColor: "#f8fafc",
    primaryTextColor: "#0f172a",
    primaryBorderColor: "#334155",
    secondaryColor: "#e0f2fe",
    tertiaryColor: "#f1f5f9",
    lineColor: "#334155",
    textColor: "#0f172a",
    edgeLabelBackground: "#ffffff",
    signalColor: "#334155",
    signalTextColor: "#0f172a",
    labelBoxBkgColor: "#ffffff",
    labelTextColor: "#0f172a",
    actorTextColor: "#0f172a",
    clusterBkg: "#f8fafc",
    clusterBorder: "#64748b",
  };
}

function getDarkThemeVariables() {
  return {
    background: "#0f172a",
    mainBkg: "#1e293b",
    primaryColor: "#1e293b",
    primaryTextColor: "#f8fafc",
    primaryBorderColor: "#94a3b8",
    secondaryColor: "#164e63",
    tertiaryColor: "#312e81",
    lineColor: "#cbd5e1",
    textColor: "#f8fafc",
    edgeLabelBackground: "#111827",
    signalColor: "#cbd5e1",
    signalTextColor: "#f8fafc",
    labelBoxBkgColor: "#111827",
    labelTextColor: "#f8fafc",
    actorTextColor: "#f8fafc",
    clusterBkg: "#111827",
    clusterBorder: "#94a3b8",
  };
}
