import type { Meta, StoryObj } from "@storybook/react";
import {
  FoundationsPage,
  TokenSection,
  useResolvedTokens,
} from "./token-table";

const DENSITY_TOKENS = [
  { note: "Dense tables and packed list rows.", token: "density-compact" },
  { note: "The default row rhythm.", token: "density-cozy" },
  { note: "Roomy rows, settings and forms.", token: "density-comfortable" },
] as const;

const TARGET_TOKENS = [
  { note: "Absolute floor for anything clickable.", token: "tap-min" },
  { note: "Preferred size for primary actions.", token: "tap-comfortable" },
] as const;

const ICON_TOKENS = [
  { note: "Inline with text.", token: "icon-sm" },
  { note: "Default control icon.", token: "icon-md" },
  { note: "Feature and empty-state icons.", token: "icon-lg" },
] as const;

const SCALE_STEPS = [1, 2, 3, 4, 6, 8, 12, 16] as const;

const MeasuredRows = ({
  rows,
}: Readonly<{
  rows: readonly { readonly note: string; readonly token: string }[];
}>) => {
  const values = useResolvedTokens(rows.map((row) => row.token));

  return (
    <div className="divide-y rounded-lg border bg-card">
      {rows.map(({ note, token }) => (
        <div className="flex items-center gap-4 p-4" key={token}>
          <div className="w-48 shrink-0 space-y-0.5">
            <p className="font-mono text-xs">--{token}</p>
            <p className="text-muted-foreground text-xs">{note}</p>
          </div>
          <div
            className="h-6 rounded bg-primary"
            style={{ width: `var(--${token})` }}
          />
          <p className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
            {values[token] || "not set"}
          </p>
        </div>
      ))}
    </div>
  );
};

const SpacingPage = () => (
  <FoundationsPage
    description="Spacing comes from a 4px base grid. The named tokens below exist because a few measurements carry rules with them — minimum tap targets, row density, icon sizing — and those should never be eyeballed."
    title="Spacing"
  >
    <TokenSection
      note="Tailwind's numeric scale, where each step is 4px. Use these for ordinary padding and gaps."
      title="Base grid"
    >
      <div className="divide-y rounded-lg border bg-card">
        {SCALE_STEPS.map((step) => (
          <div className="flex items-center gap-4 p-3" key={step}>
            <p className="w-24 shrink-0 font-mono text-xs">{step}</p>
            <div
              className="h-4 rounded bg-primary"
              style={{ width: `calc(var(--spacing, 0.25rem) * ${step})` }}
            />
            <p className="ml-auto shrink-0 font-mono text-muted-foreground text-xs">
              {step * 4}px
            </p>
          </div>
        ))}
      </div>
    </TokenSection>

    <TokenSection
      note="Row height presets. Pick one per surface and hold it for the whole table."
      title="Density"
    >
      <MeasuredRows rows={DENSITY_TOKENS} />
    </TokenSection>

    <TokenSection
      note="Accessibility floors for pointer targets. Anything interactive clears --tap-min."
      title="Tap targets"
    >
      <MeasuredRows rows={TARGET_TOKENS} />
    </TokenSection>

    <TokenSection title="Icon sizes">
      <MeasuredRows rows={ICON_TOKENS} />
    </TokenSection>
  </FoundationsPage>
);

const meta = {
  title: "Foundations/Spacing",
  component: SpacingPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof SpacingPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
