import type { CSSProperties } from "react";
import type { TokenDefinition } from "./style-browser-editor-data";

export function typographyPreviewStyle(token: TokenDefinition): CSSProperties {
  if (token.cssName.startsWith("text-")) {
    return { fontSize: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-weight-bold") {
    return { fontWeight: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-mono") {
    return { fontFamily: `var(--${token.cssName})` };
  }
  if (token.cssName === "font-sans") {
    return { fontFamily: `var(--${token.cssName})` };
  }
  if (token.cssName.startsWith("heading-")) {
    return { font: `var(--${token.cssName})` };
  }
  return {};
}

export function typographySample(token: TokenDefinition): string {
  const samples: Record<string, string> = {
    "font-mono": "branch/style-lab-token-edits",
    "font-sans": "Primary product interface type",
    "font-weight-bold": "Selected navigation item",
    "heading-h1": "Branch review details",
    "heading-h1-desktop": "Engineer workspace",
    "heading-h2": "Document group",
    "heading-h3": "Usage over time",
    "heading-h4": "SUPPORT ARTIFACTS",
    "heading-h5": "Primary token row",
    "text-base": "Default product copy should stay readable in dense surfaces.",
    "text-lg": "Compact panel heading",
    "text-sm": "Session row text with enough detail to scan",
    "text-xs": "Metadata label - updated 2m ago",
  };
  return samples[token.cssName] ?? token.label;
}

export function shapePreviewStyle(token: TokenDefinition): CSSProperties {
  if (token.cssName.includes("shadow")) {
    return { boxShadow: `var(--${token.cssName})` };
  }
  return { borderRadius: `var(--${token.cssName})` };
}

export function logoPreviewStyle(token: TokenDefinition): CSSProperties {
  if (token.cssName.startsWith("icon-")) {
    return {
      background: "var(--primary)",
      height: `var(--${token.cssName})`,
      width: `var(--${token.cssName})`,
    };
  }
  return { background: `var(--${token.cssName})` };
}

export function layoutPreviewSize(token: TokenDefinition): string {
  if (token.cssName.startsWith("density-")) {
    return "0.75rem";
  }
  return `var(--${token.cssName})`;
}

export function layoutPreviewWidth(token: TokenDefinition): string {
  if (token.cssName.startsWith("density-")) {
    return `calc(var(--${token.cssName}) * 16)`;
  }
  return "100%";
}

export const desktopGridColumns = [
  "lg-1",
  "lg-2",
  "lg-3",
  "lg-4",
  "lg-5",
  "lg-6",
  "lg-7",
  "lg-8",
  "lg-9",
  "lg-10",
  "lg-11",
  "lg-12",
] as const;

export const mobileGridColumns = ["sm-1", "sm-2", "sm-3", "sm-4"] as const;
