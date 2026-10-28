import {
  CHART_SERIES_COLOR_LIMIT,
  CHART_SERIES_TOKEN_INDEXES,
} from "@repo/design-system/components/ui/chart-colors";
import type { Meta, StoryObj } from "@storybook/react";
import tailwindColors from "./tailwindcss-colors.json";
import {
  ColorPairGrid,
  ColorSwatchGrid,
  FoundationsPage,
  TokenSection,
} from "./token-table";

const SURFACE_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
] as const;

const ELEVATION_SURFACES = [
  "surface-0",
  "surface-1",
  "surface-2",
  "surface-3",
  "surface-4",
  "surface-5",
] as const;

const BRAND_TOKENS = [
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "link",
  "closedloop-violet",
] as const;

const STATUS_TOKENS = [
  "success",
  "warning",
  "destructive",
  "info",
  "progress",
  "thinking",
  "ai",
  "highlight",
] as const;

const SIDEBAR_TOKENS = [
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const;

const LINE_TOKENS = ["border", "input", "input-border", "ring"] as const;

const CHART_TOKENS = [
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "chart-6",
  "chart-7",
  "chart-8",
  "chart-9",
  "chart-10",
  "chart-axis",
  "chart-axis-label",
] as const;

// Derived from the module rather than retyped, so the order shown here is the
// order charts actually draw. `CHART_SERIES_TOKEN_INDEXES` is 0-based; the
// tokens are 1-based.
const CHART_SERIES_ORDER = CHART_SERIES_TOKEN_INDEXES.map(
  (index) => `chart-${index + 1}`
);

const CONTRAST_PAIRS = [
  { bg: "primary", fg: "primary-foreground" },
  { bg: "secondary", fg: "secondary-foreground" },
  { bg: "accent", fg: "accent-foreground" },
  { bg: "destructive", fg: "destructive-foreground" },
  { bg: "success", fg: "success-foreground" },
  { bg: "warning", fg: "warning-foreground" },
  { bg: "info", fg: "info-foreground" },
  { bg: "progress", fg: "progress-foreground" },
] as const;

const ColorsPage = () => (
  <FoundationsPage
    description="Every colour in the product resolves to one of these tokens. Values are read live from the running theme and shown as hex, so switching light/dark in the toolbar updates the numbers as well as the swatches. Never hardcode a hex — reach for the token that names the job."
    title="Colors"
  >
    <TokenSection
      note="The base canvas and the text that sits on it."
      title="Surface & text"
    >
      <ColorSwatchGrid tokens={SURFACE_TOKENS} />
    </TokenSection>

    <TokenSection
      note="A stepped elevation ramp. Higher numbers sit visually closer to the viewer."
      title="Elevation surfaces"
    >
      <ColorSwatchGrid tokens={ELEVATION_SURFACES} />
    </TokenSection>

    <TokenSection title="Brand & action">
      <ColorSwatchGrid tokens={BRAND_TOKENS} />
    </TokenSection>

    <TokenSection
      note="Meaning-carrying colours. Pick by what the state means, not by how it looks."
      title="Status"
    >
      <ColorSwatchGrid tokens={STATUS_TOKENS} />
    </TokenSection>

    <TokenSection
      note="Each pair is a background and the foreground designed to be used on it. Reach for them together rather than pairing a foreground with a surface it was not drawn against. Only the two sidebar pairs are currently measured by the contrast sweep (packages/app/test/a11y/theme-contrast-pairs.node.ts), so treat the rest as intent rather than as a verified ratio."
      title="Foreground pairings"
    >
      <ColorPairGrid pairs={CONTRAST_PAIRS} />
    </TokenSection>

    <TokenSection title="Sidebar">
      <ColorSwatchGrid tokens={SIDEBAR_TOKENS} />
    </TokenSection>

    <TokenSection title="Borders, inputs & focus">
      <ColorSwatchGrid tokens={LINE_TOKENS} />
    </TokenSection>

    <TokenSection
      note="The ten categorical tokens, plus the axis pair. This is the palette, not the order to use it in — see below."
      title="Data visualization"
    >
      <ColorSwatchGrid tokens={CHART_TOKENS} />
    </TokenSection>

    <TokenSection
      note={`Series order, and it is deliberately not chart-1..10. The natural order seats colour-vision-confusable hues next to each other and opens on the one token that is nearly invisible on the light surface. chartSeriesColor(i) uses an order chosen to keep adjacent series distinguishable instead. It caps at ${CHART_SERIES_COLOR_LIMIT} series and never wraps; past that, fold the remainder into a neutral "Other" band. Colour alone still separates only about one series across all pairs, so a chart this dense needs a second encoding too.`}
      title="Chart series order"
    >
      <ColorSwatchGrid tokens={CHART_SERIES_ORDER} />
    </TokenSection>
  </FoundationsPage>
);

// The primary colour library (Nerys, 2026-10-06): the Tailwind palette plus
// the brand colours, from Figma's Primitives collection
// (tailwindcss-colors.json). It is curated rather than kept as exported: the
// families run Base, Brand, Zinc, then the hues in Tailwind's order (the
// export put Lime before Yellow), and Zinc is the only grey, so Slate, Gray,
// Neutral and Stone are removed. The page renders the families in the file's
// order. Nothing reads these colours yet; the semantic tokens above will be
// drawn from them later.
type PrimitiveColor = { readonly $value: string };

const PRIMITIVE_FAMILIES = Object.entries(tailwindColors.Colors).map(
  ([family, steps]) => ({
    family,
    steps: Object.entries(steps as Record<string, PrimitiveColor>).map(
      ([step, color]) => ({ step, hex: color.$value })
    ),
  })
);

const PRIMITIVE_COUNT = PRIMITIVE_FAMILIES.reduce(
  (total, { steps }) => total + steps.length,
  0
);

// A Tailwind ramp has eleven steps (50 to 950) and reads best as one row;
// Base and Brand are short named sets and use the normal swatch grid.
const RAMP_STEP_COUNT = 11;

function PrimitiveSwatch({
  hex,
  name,
}: Readonly<{ hex: string; name: string }>) {
  return (
    <div className="min-w-0 space-y-1">
      <div
        className="h-12 rounded-md border"
        style={{ background: hex }}
        title={`${name} ${hex}`}
      />
      <p className="truncate font-medium text-xs">{name}</p>
      <p className="truncate font-mono text-muted-foreground text-xs">{hex}</p>
    </div>
  );
}

const PrimitiveColorsPage = () => (
  <FoundationsPage
    description={`The primary colour library: ${PRIMITIVE_COUNT} colours in ${PRIMITIVE_FAMILIES.length} families, from the Tailwind palette plus the ClosedLoop brand colours, from Figma (Primitives / tailwindcss-colors). Zinc is the one grey scale. Semantic tokens will be drawn from these; components should not use them directly. The same in light and dark.`}
    title="Primitives"
  >
    {PRIMITIVE_FAMILIES.map(({ family, steps }) => (
      <TokenSection key={family} title={family}>
        <div
          className={
            steps.length === RAMP_STEP_COUNT
              ? "grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-11"
              : "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
          }
        >
          {steps.map(({ step, hex }) => (
            <PrimitiveSwatch
              hex={hex}
              key={step}
              name={step.replaceAll("_", " ")}
            />
          ))}
        </div>
      </TokenSection>
    ))}
  </FoundationsPage>
);

/**
 * The full set of colour tokens the product draws from, read live from the
 * running theme, so you can check a token's value before hardcoding a hex.
 */
const meta = {
  title: "Foundations/Colors",
  tags: ["stable"],
  component: ColorsPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof ColorsPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Colors › Primitives: the colour library the semantic tokens draw from. */
export const Primitives: Story = {
  render: () => <PrimitiveColorsPage />,
};
