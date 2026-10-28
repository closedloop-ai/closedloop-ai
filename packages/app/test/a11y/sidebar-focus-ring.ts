/**
 * ISS-10104 — the browser-side read behind the sidebar focus-ring specs, and
 * the Node-side arithmetic they hold it to, in ONE module so the web
 * (`e2e/`) and Electron (`apps/desktop/test/e2e/`) lanes cannot disagree about
 * either. Both import `contrastRatio` from `./contrast`, which is the same
 * converter `sidebar-ring-contrast.test.ts` runs in Node — so a disagreement
 * between the three is a disagreement about what the BROWSER computed, which is
 * the whole point, rather than about the maths.
 *
 * Nothing here re-measures a token value or a call-site class string. ISS-10057
 * owns both, in `packages/app/test/a11y/sidebar-ring-contrast.test.ts` and
 * `packages/design-system/__tests__/sidebar.test.tsx`; a second copy of either
 * would be free to drift from the original.
 *
 * `readPaintedSidebarRing` is passed to `page.evaluate`, which serializes it to
 * source and runs it in the page — so it must close over NOTHING from this
 * module. The selectors are therefore inlined in its body rather than shared
 * with the constants below, which is the one duplication here that is load
 * bearing. It is also SELF-CHECKING in both directions rather than trusted: a
 * spec locates its button with the exported selector and then requires
 * `focusVisible`, which the inlined copy decides, so if the exported spelling
 * moves alone the read reports false and the spec reds, and if the inlined copy
 * moves alone the locator matches nothing and the spec times out.
 */

import {
  A11yTheme,
  contrastRatio,
  parseCssColor,
  RETIRED_LIGHT_SIDEBAR_RING,
  type RgbColor,
  resolveCompositedBackground,
} from "./contrast";

/** `data-slot` of the element `focus-visible:ring-2 ring-sidebar-ring` sits on. */
export const SIDEBAR_MENU_BUTTON_SELECTOR = '[data-slot="sidebar-menu-button"]';

/** `data-slot` of the element carrying `bg-sidebar` — the panel itself. */
export const SIDEBAR_PANEL_SELECTOR = '[data-slot="sidebar-inner"]';

/**
 * A ring colour that CANNOT clear the floor in the theme it is injected into,
 * per theme, so each lane's positive control is the same control.
 *
 * Light gets the exact value ISS-10057 retired, which is the ticket's stated
 * acceptance. Dark never carried that grey — against dark's near-black panel it
 * measures WELL ABOVE the floor, so a control built from it would prove the
 * opposite of what it claims — so dark's control is the panel token itself,
 * which paints the ring in its own surface's colour and can only ever measure
 * 1.00:1.
 */
export const FAILING_RING_BY_THEME: Record<A11yTheme, string> = {
  [A11yTheme.Light]: RETIRED_LIGHT_SIDEBAR_RING,
  [A11yTheme.Dark]: "var(--sidebar)",
};

export type PaintedSidebarRing = {
  /** Closest-first, from the focused button's PARENT — the ring is a spread
   * box-shadow drawn OUTSIDE the button's border box, so what it is painted on
   * is what sits behind and around the button, not the button's own fill. */
  backgroundsClosestFirst: string[];
  boxShadow: string;
  /** False when the read landed on something that is not a menu button, or on
   * an element the browser is not treating as keyboard-focused. */
  focusVisible: boolean;
  /** True when a `[data-slot="sidebar-inner"]` — the element carrying
   * `bg-sidebar` — is an ancestor of the focused button. */
  insideSidebarPanel: boolean;
  /** Chromium's resolved `--tw-ring-color`. Tailwind v4 paints `ring-2` as a
   * box-shadow whose colour is this custom property, so this is the token AFTER
   * the cascade and `var()` resolution — the leg no Node or jsdom suite runs. */
  ringColor: string;
  /**
   * How many CSS transitions over the ring or its surface were still RUNNING on
   * the focused button or an ancestor at the moment of the read — the proof
   * that the values above are the settled ones rather than a frame of an
   * interpolation.
   *
   * Asserted rather than waited on: nothing in this chain animates any of those
   * properties today (`SidebarMenuButton` transitions `[width,height,padding]`,
   * the panel `[left,right,width]`), so a non-zero count means a call site grew
   * a transition and OWES this spec a settle wait. A sleep here would instead
   * paper over that silently.
   *
   * `transition-property: all` needs no entry in the list this counts against:
   * Chromium materialises one `CSSTransition` PER CHANGING PROPERTY, each named
   * concretely, so `all` never reaches the read. `all` IS also the CSS initial
   * value of `transition-property`, which is why counting declared properties
   * rather than running transitions reports every element on the page.
   */
  runningRingTransitions: number;
};

/**
 * Read the ring the browser computed for `document.activeElement`.
 *
 * Runs IN THE PAGE. Self-contained by necessity — see the module docstring.
 */
export function readPaintedSidebarRing(): PaintedSidebarRing {
  const button = globalThis.document.activeElement;
  if (!(button instanceof HTMLElement)) {
    return {
      backgroundsClosestFirst: [],
      boxShadow: "none",
      focusVisible: false,
      insideSidebarPanel: false,
      ringColor: "",
      runningRingTransitions: 0,
    };
  }

  // The properties whose mid-flight value would make this measurement a lie: a
  // partly-faded ring colour, or a surface still crossfading, each reads as a
  // confident ratio about a frame no user sees for more than a few frames.
  // Inlined rather than shared with the module scope for the reason in the
  // module docstring — this function is serialized and run in the page.
  const ringTransitionProperties = [
    "box-shadow",
    "background-color",
    "--tw-ring-color",
  ];
  const countRunning = (element: Element) =>
    element.getAnimations({ subtree: false }).filter((animation) => {
      const property = String(
        Reflect.get(animation, "transitionProperty") ?? ""
      );
      return (
        animation.playState === "running" &&
        ringTransitionProperties.includes(property)
      );
    }).length;

  const style = getComputedStyle(button);
  const backgroundsClosestFirst: string[] = [];
  let runningRingTransitions = countRunning(button);
  let ancestor: Element | null = button.parentElement;
  while (ancestor) {
    backgroundsClosestFirst.push(getComputedStyle(ancestor).backgroundColor);
    runningRingTransitions += countRunning(ancestor);
    ancestor = ancestor.parentElement;
  }

  return {
    backgroundsClosestFirst,
    boxShadow: style.boxShadow,
    focusVisible:
      button.matches('[data-slot="sidebar-menu-button"]') &&
      button.matches(":focus-visible"),
    insideSidebarPanel: Boolean(button.closest('[data-slot="sidebar-inner"]')),
    ringColor: style.getPropertyValue("--tw-ring-color").trim(),
    runningRingTransitions,
  };
}

/**
 * The painted ring against the surface it is painted on, as a WCAG 1.4.11
 * ratio.
 *
 * BOTH halves of the pair refuse rather than default, because a token that
 * stopped resolving in the browser is the ticket's headline failure mode and it
 * can reach either half:
 *
 *  - the ring. Taken from the `box-shadow` Chromium actually painted, held to
 *    the resolved `--tw-ring-color` by `paintedRingColor` — see there for why
 *    the token alone was not evidence. `parseCssColor` rejects input it does
 *    not recognise, so an unresolved `--tw-ring-color` throws instead of
 *    arriving as a ratio.
 *  - the surface. `background-color: var(--sidebar)` on an unresolvable token is
 *    invalid-at-computed-value-time and computes to `transparent`, so the whole
 *    ancestor chain can come back with no opaque layer —
 *    `resolveCompositedBackground` would then hand back its OPAQUE WHITE
 *    fallback, against which `--primary` measures about 7:1 and the spec reports
 *    a confident pass about a colour nothing painted. `compositedSurface`
 *    refuses that case instead. The both-themes surface-differs guard in each
 *    spec catches it only when BOTH themes collapse; this catches one.
 */
export function paintedSidebarRingContrast(ring: PaintedSidebarRing): number {
  return contrastRatio(
    parseCssColor(paintedRingColor(ring)),
    parseCssColor(compositedSurface(ring))
  );
}

/** The surface the ring is painted on, composited, for a failure message. */
export function paintedSidebarRingSurface(ring: PaintedSidebarRing): string {
  return compositedSurface(ring);
}

/**
 * Composite the ancestor chain, refusing when nothing in it is fully opaque.
 *
 * An opaque base is what makes `resolveCompositedBackground`'s white fallback
 * unreachable; without one the returned colour is partly that fallback and the
 * ratio is partly about the page's imagined background rather than its real one.
 */
function compositedSurface(ring: PaintedSidebarRing): string {
  const hasOpaqueBase = ring.backgroundsClosestFirst.some(
    (layer) => parseCssColor(layer).alpha >= 1
  );
  if (!hasOpaqueBase) {
    throw new Error(
      `No ancestor of the focused menu button painted an opaque surface, so the ring has nothing measurable behind it: ${JSON.stringify(ring.backgroundsClosestFirst)}`
    );
  }
  return resolveCompositedBackground(ring.backgroundsClosestFirst);
}

/** A computed `box-shadow` layer's leading colour — Chromium serializes it first. */
const BOX_SHADOW_LAYER_COLOR_PATTERN = /^[a-z-]+\([^)]*\)/i;

/**
 * Two serializations of one colour, to the byte.
 *
 * A tolerance of one, because the two values reach `parseCssColor` by different
 * routes — Chromium may hand back the custom property in `oklch()` and the
 * shadow's colour already converted — and a colour-space round trip can land a
 * channel one off. Wider than that is a different colour.
 */
const COLOR_CHANNEL_TOLERANCE = 1;
const COLOR_ALPHA_TOLERANCE = 0.01;

/**
 * The colour the RING IS PAINTED IN, read off `box-shadow` and required to be
 * the resolved `--tw-ring-color`.
 *
 * `--tw-ring-color` is the token after the cascade, which is most of what this
 * ticket is about — but on its own it is not evidence that anything painted it.
 * Tailwind composes `ring-2` INTO `box-shadow`, so a Tailwind or CSS regression
 * that leaves some other fixed colour in that shadow keeps the custom property,
 * and every ratio derived from it, green about a colour no reader ever sees —
 * including the counterfactual, which moves `--sidebar-ring` and re-reads the
 * same property (davetho, PR #7316). So the ratio is taken from the SHADOW,
 * and the token is held to it rather than trusted in its place.
 *
 * Refuses rather than defaults, the same posture as `compositedSurface`: no
 * shadow layer painted in the token means the two have come apart, and that IS
 * the defect.
 */
function paintedRingColor(ring: PaintedSidebarRing): string {
  const token = parseCssColor(ring.ringColor);
  const painted = boxShadowLayerColors(ring.boxShadow).find((layer) => {
    const parsed = tryParseCssColor(layer);
    return parsed ? sameColor(parsed, token) : false;
  });

  if (!painted) {
    throw new Error(
      `No box-shadow layer is painted in the resolved --tw-ring-color (${ring.ringColor}), so the ring the reader sees is not the token this measures: ${ring.boxShadow}`
    );
  }

  return painted;
}

/** Each layer's colour, splitting only on the commas BETWEEN layers. */
function boxShadowLayerColors(boxShadow: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < boxShadow.length; index += 1) {
    const character = boxShadow[index];
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      layers.push(boxShadow.slice(start, index));
      start = index + 1;
    }
  }
  layers.push(boxShadow.slice(start));

  return layers
    .map((layer) => layerColor(layer.trim()))
    .filter((color) => color.length > 0);
}

function layerColor(layer: string): string {
  return (
    layer.match(BOX_SHADOW_LAYER_COLOR_PATTERN)?.[0] ??
    layer.split(" ")[0] ??
    ""
  );
}

/** `parseCssColor`, but a layer that is a length rather than a colour is skipped. */
function tryParseCssColor(value: string): RgbColor | undefined {
  try {
    return parseCssColor(value);
  } catch {
    return undefined;
  }
}

function sameColor(left: RgbColor, right: RgbColor): boolean {
  return (
    Math.abs(left.r - right.r) <= COLOR_CHANNEL_TOLERANCE &&
    Math.abs(left.g - right.g) <= COLOR_CHANNEL_TOLERANCE &&
    Math.abs(left.b - right.b) <= COLOR_CHANNEL_TOLERANCE &&
    Math.abs(left.alpha - right.alpha) <= COLOR_ALPHA_TOLERANCE
  );
}
