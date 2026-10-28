import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import postcss, { type AtRule, type Root, type Rule } from "postcss";
import { describe, expect, it, vi } from "vitest";
import { activateAfterSignIn } from "../src/main/auth/activate-after-sign-in.js";
import { startDesktopLoopbackListener } from "../src/main/auth/desktop-loopback-listener.js";
import { AUTH_HANDOFF_ASSETS } from "../src/shared/auth-handoff-assets.generated.js";
import { readWoff2VariationAxes } from "./support/woff2-variation-axes.js";

const PICTURE_RE = /<picture>[\s\S]*?<\/picture>/;
const MAIN_BODY_RE = /<main>([\s\S]*?)<\/main>/;
const H1_RE = /<h1>([^<]*)<\/h1>/g;
const PARAGRAPH_RE = /<p>([\s\S]*?)<\/p>/g;
const ANCHOR_RE = /<a href="([^"]*)">([^<]*)<\/a>/g;
const LINE_BREAK_RE = /<br\s*\/?>/;
const MAIN_TAG_COUNT_RE = /<main[\s>]/g;
const BODY_RE = /<body>([\s\S]*)<\/body>/;
const MAIN_BLOCK_RE = /<main>[\s\S]*?<\/main>/;
const STYLE_RE = /<style>([\s\S]*?)<\/style>/;
const SCRIPT_TAG_RE = /<script/i;
const META_REFRESH_RE = /http-equiv\s*=\s*["']?refresh/i;
const INLINE_HANDLER_RE = /\son[a-z]+\s*=/i;
const DARK_SOURCE_RE =
  /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]*)">/;
const LIGHT_LOGO_RE = /<img class="logo" src="([^"]*)" alt="Closedloop">/;
const FONT_DATA_URL_RE = /^data:font\/woff2;base64,([A-Za-z0-9+/]*={0,2})$/;
const HEADING_COPY = "You're almost done!";
const MESSAGE_LINES = [
  "We're redirecting you to the desktop app.",
  "If you're not taken back to the desktop app, click the button below.",
];
const BUTTON_COPY = "Proceed to Closedloop Desktop";
const DARK_SCHEME_MEDIA = "(prefers-color-scheme: dark)";
const SHADOW_TOKEN = "--shadow-inset";
const BOLD_WEIGHT_TOKEN = "--font-weight-bold";
const WEIGHT_AXIS_TAG = "wght";

describe("browser sign-in handoff", () => {
  it("restores a minimized window and activates the application before focusing it", () => {
    const calls: string[] = [];
    activateAfterSignIn({
      window: {
        isDestroyed: () => false,
        isMinimized: () => true,
        restore: () => calls.push("restore"),
        focus: () => calls.push("focus"),
      },
      activateApp: () => calls.push("activate"),
    });
    expect(calls).toEqual(["restore", "activate", "focus"]);
  });

  it("does not activate a disposed window", () => {
    const activateApp = vi.fn();
    const focus = vi.fn();
    activateAfterSignIn({
      window: {
        isDestroyed: () => true,
        isMinimized: () => false,
        restore: vi.fn(),
        focus,
      },
      activateApp,
    });
    expect(activateApp).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("serves an offline branded page with a working fallback and no reflected credentials", async () => {
    const { html, headers } = await fetchHandoffPage(
      "?code=SECRET_AUTH_CODE&state=SECRET_STATE"
    );
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('alt="Closedloop"');
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).toContain("data:font/woff2;base64,");
    expect(html).toContain(
      '<a href="closedloop://">Proceed to Closedloop Desktop</a>'
    );
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("SECRET_AUTH_CODE");
    expect(html).not.toContain("SECRET_STATE");
    expect(html).not.toContain("https://");
  });
});

describe("browser sign-in handoff page served at /cb", () => {
  it("renders the supplied copy as one heading, one two-line message and one deep-link button, and nothing else", async () => {
    const { html } = await fetchHandoffPage();
    const main = html.match(MAIN_BODY_RE)?.[1] ?? "";
    const content = main.replace(PICTURE_RE, "");

    expect([...content.matchAll(H1_RE)].map((match) => match[1])).toEqual([
      HEADING_COPY,
    ]);
    const paragraphs = [...content.matchAll(PARAGRAPH_RE)].map(
      (match) => match[1]
    );
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0]?.split(LINE_BREAK_RE)).toEqual(MESSAGE_LINES);
    expect(
      [...content.matchAll(ANCHOR_RE)].map((match) => [match[1], match[2]])
    ).toEqual([[DESKTOP_DEEP_LINK_URL, BUTTON_COPY]]);

    const remainder = content
      .replace(H1_RE, "")
      .replace(PARAGRAPH_RE, "")
      .replace(ANCHOR_RE, "")
      .trim();
    expect(remainder).toBe("");
    expect(html.match(MAIN_TAG_COUNT_RE)).toHaveLength(1);
    const body = html.match(BODY_RE)?.[1] ?? "";
    expect(body).toMatch(MAIN_BLOCK_RE);
    expect(body.replace(MAIN_BLOCK_RE, "").trim()).toBe("");
  });

  it("centers one column with the logo above the heading", async () => {
    const { html } = await fetchHandoffPage();
    const main = ruleDeclarations(html, "main");
    expect(main.get("flex-direction")).toBe("column");
    expect(main.get("align-items")).toBe("center");
    expect(main.get("text-align")).toBe("center");
    const logo = ruleDeclarations(html, ".logo");
    expect(logo.has("align-self")).toBe(false);
    expect(
      [...logo.keys()].filter((property) => property.startsWith("margin"))
    ).toEqual(["margin-bottom"]);
    expect(html.indexOf("<picture>")).toBeGreaterThan(-1);
    expect(html.indexOf("<picture>")).toBeLessThan(html.indexOf("<h1>"));
    expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("<p>"));
    expect(html.indexOf("<p>")).toBeLessThan(html.indexOf("<a href"));
  });

  it("sizes the heading at 1.5rem in the bold weight token and the message at the 0.875rem body size in the muted color", async () => {
    const { html } = await fetchHandoffPage();
    const heading = ruleDeclarations(html, "h1");
    expect(heading.get("font-size")).toBe("1.5rem");
    expect(heading.get("font-weight")).toBe(`var(${BOLD_WEIGHT_TOKEN})`);
    expect(ruleDeclarations(html, "body").get("font-size")).toBe("0.875rem");
    const message = ruleDeclarations(html, "p");
    expect(message.get("color")).toBe("var(--muted-foreground)");
    expect(message.has("font-size")).toBe(false);
  });

  it("gives the button a 44px touch target, 4px corners, the primary fill and a regular-weight 0.875rem label", async () => {
    const { html } = await fetchHandoffPage();
    const button = ruleDeclarations(html, "a");
    const theme = lightThemeTokens();
    expect(button.get("min-height")).toBe("var(--tap-min)");
    expect(theme.get("--tap-min")).toBe("44px");
    expect(button.get("border-radius")).toBe("calc(var(--radius) - 4px)");
    expect(theme.get("--radius")).toBe("0.5rem");
    expect(button.get("background")).toBe("var(--primary)");
    expect(button.get("font-size")).toBe("0.875rem");
    expect(button.get("font-weight")).toBe("400");
  });

  it("shadows the button with the design-system token the bundled theme defines for light and dark", async () => {
    const { html } = await fetchHandoffPage();
    expect(ruleDeclarations(html, "a").get("box-shadow")).toBe(
      `var(${SHADOW_TOKEN})`
    );
    const themeShadows = customPropertyScopes(
      postcss.parse(AUTH_HANDOFF_ASSETS.theme),
      SHADOW_TOKEN
    );
    expect(themeShadows.map((entry) => entry.media)).toEqual([
      null,
      DARK_SCHEME_MEDIA,
    ]);
    expect(customPropertyScopes(pageStyles(html), SHADOW_TOKEN)).toEqual(
      themeShadows
    );
  });

  it("keeps the Closedloop theme, font and light and dark logos", async () => {
    const { html } = await fetchHandoffPage();
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain(AUTH_HANDOFF_ASSETS.theme);
    expect(AUTH_HANDOFF_ASSETS.theme).toContain(`@media ${DARK_SCHEME_MEDIA}`);
    const fontFace = fontFaceDeclarations(html);
    expect(fontFace.get("src")).toContain(`url("${AUTH_HANDOFF_ASSETS.font}")`);
    const bodyFamily = ruleDeclarations(html, "body").get("font-family");
    expect(bodyFamily?.split(",")[0]).toBe(fontFace.get("font-family"));
    expect(html.match(DARK_SOURCE_RE)?.[1]).toBe(AUTH_HANDOFF_ASSETS.logoDark);
    expect(html.match(LIGHT_LOGO_RE)?.[1]).toBe(AUTH_HANDOFF_ASSETS.logoLight);
    expect(AUTH_HANDOFF_ASSETS.logoLight).not.toBe(
      AUTH_HANDOFF_ASSETS.logoDark
    );
  });

  it("bundles a variable font whose weight axis covers the bold token, and declares that axis on @font-face", async () => {
    const { html } = await fetchHandoffPage();
    const weightAxis = readWoff2VariationAxes(
      fontDataUrlBytes(AUTH_HANDOFF_ASSETS.font)
    ).find((axis) => axis.tag === WEIGHT_AXIS_TAG);
    if (!weightAxis) {
      throw new Error("the bundled font has no weight axis");
    }
    const boldWeight = Number(lightThemeTokens().get(BOLD_WEIGHT_TOKEN));
    expect(boldWeight).toBeGreaterThanOrEqual(weightAxis.min);
    expect(boldWeight).toBeLessThanOrEqual(weightAxis.max);
    expect(fontFaceDeclarations(html).get("font-weight")).toBe(
      `${weightAxis.min} ${weightAxis.max}`
    );
  });

  it("stays static: no script, refresh or inline handler, under a script-less CSP", async () => {
    const { html, headers } = await fetchHandoffPage();
    expect(html).not.toMatch(SCRIPT_TAG_RE);
    expect(html).not.toMatch(META_REFRESH_RE);
    expect(html).not.toMatch(INLINE_HANDLER_RE);
    const policy = headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain("script-src");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("serves identical markup whatever the callback carries", async () => {
    const plain = await fetchHandoffPage();
    const withParams = await fetchHandoffPage(
      "?code=OTHER_CODE&state=OTHER_STATE&error=access_denied"
    );
    expect(withParams.html).toBe(plain.html);
    expect(withParams.html).not.toContain("OTHER_CODE");
    expect(withParams.html).not.toContain("access_denied");
  });
});

async function fetchHandoffPage(query = "") {
  const listener = await startDesktopLoopbackListener();
  try {
    const response = await fetch(`${listener.redirectUri}${query}`);
    return { html: await response.text(), headers: response.headers };
  } finally {
    await listener.close();
  }
}

function pageStyles(html: string): Root {
  const css = STYLE_RE.exec(html)?.[1];
  if (css === undefined) {
    throw new Error("handoff page has no <style> block");
  }
  return postcss.parse(css);
}

function ruleDeclarations(html: string, selector: string): Map<string, string> {
  const rules = pageStyles(html).nodes.filter(
    (node): node is Rule => node.type === "rule" && node.selector === selector
  );
  return declarationsOfOnlyBlock(rules, selector);
}

function fontFaceDeclarations(html: string): Map<string, string> {
  const faces = pageStyles(html).nodes.filter(
    (node): node is AtRule =>
      node.type === "atrule" && node.name === "font-face"
  );
  return declarationsOfOnlyBlock(faces, "@font-face");
}

function declarationsOfOnlyBlock(
  blocks: Array<Rule | AtRule>,
  label: string
): Map<string, string> {
  const [block] = blocks;
  if (!block || blocks.length !== 1) {
    throw new Error(
      `handoff page has ${blocks.length} top-level "${label}" blocks`
    );
  }
  const declarations = new Map<string, string>();
  block.each((child) => {
    if (child.type === "decl") {
      declarations.set(child.prop, child.value);
    }
  });
  return declarations;
}

function lightThemeTokens(): Map<string, string> {
  const roots = postcss
    .parse(AUTH_HANDOFF_ASSETS.theme)
    .nodes.filter(
      (node): node is Rule => node.type === "rule" && node.selector === ":root"
    );
  return declarationsOfOnlyBlock(roots, ":root");
}

/** Every declaration of `property`, with the media query wrapping its rule (null at top level). */
function customPropertyScopes(
  root: Root,
  property: string
): Array<{ media: string | null; value: string }> {
  const scopes: Array<{ media: string | null; value: string }> = [];
  root.walkDecls(property, (declaration) => {
    const wrapper = declaration.parent?.parent;
    const media =
      wrapper?.type === "atrule" && "params" in wrapper
        ? String(wrapper.params)
        : null;
    scopes.push({ media, value: declaration.value });
  });
  return scopes;
}

function fontDataUrlBytes(dataUrl: string): Buffer {
  const base64 = FONT_DATA_URL_RE.exec(dataUrl)?.[1];
  if (base64 === undefined) {
    throw new Error("the bundled font is not a base64 WOFF2 data URL");
  }
  return Buffer.from(base64, "base64");
}
