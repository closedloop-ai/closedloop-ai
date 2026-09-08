import type { Meta, StoryObj } from "@storybook/react";
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

const CONTRAST_PAIRS = [
  { bg: "primary", fg: "primary-foreground" },
  { bg: "secondary", fg: "secondary-foreground" },
  { bg: "accent", fg: "accent-foreground" },
  { bg: "destructive", fg: "destructive-foreground" },
  { bg: "success", fg: "success-foreground" },
  { bg: "warning", fg: "warning-foreground" },
  { bg: "info", fg: "info-foreground" },
  { bg: "progress", fg: "progress-foreground" },
  { bg: "ai", fg: "ai-foreground" },
] as const;

const ColorsPage = () => (
  <FoundationsPage
    description="Every colour in the product resolves to one of these tokens. Values are read live from the running theme, so switching light/dark in the toolbar updates the numbers as well as the swatches. Never hardcode a hex — reach for the token that names the job."
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
      note="Each pair is a background and the foreground guaranteed to be legible on it. Use them together."
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
      note="The categorical series used by charts, in order. Assign by index so series colours stay stable across a dashboard."
      title="Data visualization"
    >
      <ColorSwatchGrid tokens={CHART_TOKENS} />
    </TokenSection>
  </FoundationsPage>
);

const meta = {
  title: "Foundations/Colors",
  component: ColorsPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof ColorsPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
