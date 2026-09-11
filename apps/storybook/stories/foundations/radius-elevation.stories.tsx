import type { Meta, StoryObj } from "@storybook/react";
import {
  FoundationsPage,
  TokenSection,
  useResolvedTokens,
} from "./token-table";

const RADIUS_TOKENS = [
  { note: "Chips, badges, small inputs.", token: "radius-sm" },
  { note: "Buttons and form controls.", token: "radius-md" },
  { note: "Cards and panels. This is --radius itself.", token: "radius-lg" },
  { note: "Modals and large containers.", token: "radius-xl" },
  { note: "Pills and avatars.", token: "radius-full" },
] as const;

const Z_TOKENS = [
  { note: "Ordinary page content.", token: "z-base" },
  { note: "Sticky headers and table headers.", token: "z-sticky" },
  { note: "Mobile bottom navigation.", token: "z-bottom-nav" },
  { note: "Popovers, dropdowns, tooltips.", token: "z-popover" },
  { note: "The dimmer behind a modal.", token: "z-overlay" },
  { note: "Dialogs and sheets.", token: "z-modal" },
  { note: "Toasts, above everything.", token: "z-toast" },
] as const;

const RadiusGrid = () => {
  const values = useResolvedTokens(RADIUS_TOKENS.map((row) => row.token));

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {RADIUS_TOKENS.map(({ note, token }) => (
        <div className="space-y-3 rounded-lg border bg-card p-4" key={token}>
          <div
            className="h-20 w-full border-2 border-primary bg-primary/10"
            style={{ borderRadius: `var(--${token})` }}
          />
          <div className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-mono text-xs">--{token}</p>
              <p className="font-mono text-muted-foreground text-xs">
                {values[token] || "not set"}
              </p>
            </div>
            <p className="text-muted-foreground text-xs">{note}</p>
          </div>
        </div>
      ))}
    </div>
  );
};

const ZTable = () => {
  const values = useResolvedTokens(Z_TOKENS.map((row) => row.token));

  return (
    <div className="divide-y rounded-lg border bg-card">
      {Z_TOKENS.map(({ note, token }) => (
        <div
          className="flex flex-wrap items-baseline justify-between gap-3 p-3"
          key={token}
        >
          <div className="space-y-0.5">
            <p className="font-mono text-xs">--{token}</p>
            <p className="text-muted-foreground text-xs">{note}</p>
          </div>
          <p className="font-mono text-muted-foreground text-xs">
            {values[token] || "not set"}
          </p>
        </div>
      ))}
    </div>
  );
};

const RadiusElevationPage = () => (
  <FoundationsPage
    description="Corner rounding scales with the size of the thing being rounded, and stacking order is a fixed ladder rather than a pile of ad-hoc z-index numbers. If you need something to sit above a modal, it belongs on the toast layer, not on z-index 9999."
    title="Radius & Elevation"
  >
    <TokenSection title="Corner radius">
      <RadiusGrid />
    </TokenSection>

    <TokenSection
      note="Every layer in the product maps to one of these. There are no other valid values."
      title="Stacking order"
    >
      <ZTable />
    </TokenSection>
  </FoundationsPage>
);

/**
 * Corner radius and z-index tokens for every layer in the product, so you
 * pick a rounding or stacking value from the scale instead of a one-off
 * number.
 */
const meta = {
  title: "Foundations/Radius & Elevation",
  component: RadiusElevationPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof RadiusElevationPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
