import { describe, expect, it } from "vitest";
import {
  applyMermaidSvgTheme,
  getMermaidConfig,
  MermaidThemeMode,
} from "./mermaid-theme";

const REQUIRED_THEME_VARIABLE_KEYS = [
  "background",
  "mainBkg",
  "primaryColor",
  "primaryTextColor",
  "primaryBorderColor",
  "secondaryColor",
  "tertiaryColor",
  "lineColor",
  "textColor",
  "edgeLabelBackground",
  "signalColor",
  "signalTextColor",
  "labelBoxBkgColor",
  "labelTextColor",
  "actorTextColor",
  "clusterBkg",
  "clusterBorder",
] as const;

describe("getMermaidConfig", () => {
  it("returns explicit base-theme config for both modes", () => {
    for (const mode of [MermaidThemeMode.Light, MermaidThemeMode.Dark]) {
      const config = getMermaidConfig(mode);

      expect(config.startOnLoad).toBe(false);
      expect(config.securityLevel).toBe("loose");
      expect(config.theme).toBe("base");
      expect(config.themeCSS).toEqual(
        mode === MermaidThemeMode.Dark ? expect.any(String) : ""
      );
      expect(config.themeVariables).toEqual(
        expect.objectContaining(
          Object.fromEntries(
            REQUIRED_THEME_VARIABLE_KEYS.map((key) => [key, expect.any(String)])
          )
        )
      );
    }
  });

  it("keeps dark labels, edges, and borders readable against dark fills", () => {
    const themeVariables = getMermaidConfig(MermaidThemeMode.Dark)
      .themeVariables as Record<string, string>;

    expect(
      contrastRatio(
        themeVariables.primaryTextColor,
        themeVariables.primaryColor
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(themeVariables.textColor, themeVariables.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(themeVariables.lineColor, themeVariables.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        themeVariables.primaryBorderColor,
        themeVariables.primaryColor
      )
    ).toBeGreaterThanOrEqual(3);
    expect(themeVariables.edgeLabelBackground).not.toBe(
      themeVariables.lineColor
    );
    expect(
      contrastRatio(themeVariables.signalTextColor, themeVariables.background)
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(
        themeVariables.labelTextColor,
        themeVariables.labelBoxBkgColor
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(themeVariables.actorTextColor, themeVariables.primaryColor)
    ).toBeGreaterThanOrEqual(4.5);
    expect(getMermaidConfig(MermaidThemeMode.Dark).themeCSS).toContain(
      ".messageText"
    );
    expect(getMermaidConfig(MermaidThemeMode.Dark).themeCSS).toContain(
      ".edgeLabel"
    );
    expect(getMermaidConfig(MermaidThemeMode.Dark).themeCSS).toContain(
      "text.actor"
    );
  });

  it("keeps light mode on dark text over light fills", () => {
    const themeVariables = getMermaidConfig(MermaidThemeMode.Light)
      .themeVariables as Record<string, string>;

    expect(
      contrastRatio(
        themeVariables.primaryTextColor,
        themeVariables.primaryColor
      )
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(themeVariables.lineColor, themeVariables.background)
    ).toBeGreaterThanOrEqual(4.5);
  });

  it("returns fresh config objects so callers cannot mutate shared state", () => {
    const first = getMermaidConfig(MermaidThemeMode.Dark);
    const second = getMermaidConfig(MermaidThemeMode.Dark);

    expect(first).not.toBe(second);
    expect(first.themeVariables).not.toBe(second.themeVariables);
  });
});

describe("applyMermaidSvgTheme", () => {
  it("embeds dark label CSS in rendered SVGs", () => {
    const svg = '<svg viewBox="0 0 10 10"><text>label</text></svg>';
    const themed = applyMermaidSvgTheme(svg, MermaidThemeMode.Dark);

    expect(themed).toContain('data-cl-mermaid-dark="true"');
    expect(themed).toContain(".messageText");
    expect(themed).toContain(".edgeLabel");
    expect(themed).toContain("text.actor");
  });

  it("does not rewrite light SVGs or duplicate dark styles", () => {
    const svg = '<svg viewBox="0 0 10 10"><text>label</text></svg>';
    expect(applyMermaidSvgTheme(svg, MermaidThemeMode.Light)).toBe(svg);

    const themed = applyMermaidSvgTheme(svg, MermaidThemeMode.Dark);
    expect(applyMermaidSvgTheme(themed, MermaidThemeMode.Dark)).toBe(themed);
  });
});

function contrastRatio(foreground: string, background: string) {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background)
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string) {
  const [red, green, blue] = parseHexColor(hex).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.039_28
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function parseHexColor(hex: string) {
  const normalized = hex.replace("#", "");
  return [0, 2, 4].map((index) =>
    Number.parseInt(normalized.slice(index, index + 2), 16)
  );
}
