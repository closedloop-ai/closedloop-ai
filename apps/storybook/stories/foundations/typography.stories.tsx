import type { Meta, StoryObj } from "@storybook/react";
import {
  FoundationsPage,
  TokenSection,
  useResolvedTokens,
} from "./token-table";

const TYPE_SCALE = [
  { note: "Metadata, timestamps, dense table cells.", token: "text-xs" },
  { note: "Secondary copy and most supporting labels.", token: "text-sm" },
  { note: "Default body size for the product.", token: "text-base" },
  { note: "Section headings and emphasised copy.", token: "text-lg" },
] as const;

const FAMILY_TOKENS = ["font-sans", "font-mono"] as const;

const SPECIMEN = "Agent sessions across your synced compute targets";

const TypeScaleTable = () => {
  const values = useResolvedTokens(TYPE_SCALE.map((row) => row.token));

  return (
    <div className="divide-y rounded-lg border bg-card">
      {TYPE_SCALE.map(({ note, token }) => (
        <div className="space-y-2 p-4" key={token}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-muted-foreground text-xs">--{token}</p>
            <p className="font-mono text-muted-foreground text-xs">
              {values[token] || "not set"}
            </p>
          </div>
          <p style={{ fontSize: `var(--${token})` }}>{SPECIMEN}</p>
          <p className="text-muted-foreground text-xs">{note}</p>
        </div>
      ))}
    </div>
  );
};

const FamilyTable = () => {
  const values = useResolvedTokens(FAMILY_TOKENS);

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {FAMILY_TOKENS.map((token) => (
        <div className="space-y-2 rounded-lg border bg-card p-4" key={token}>
          <p className="font-mono text-muted-foreground text-xs">--{token}</p>
          <p className="text-lg" style={{ fontFamily: `var(--${token})` }}>
            {SPECIMEN}
          </p>
          <p
            className="text-muted-foreground text-xs"
            style={{ fontFamily: `var(--${token})` }}
          >
            ABCDEFGHIJKLM abcdefghijklm 0123456789
          </p>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {values[token] || "not set"}
          </p>
        </div>
      ))}
    </div>
  );
};

const WEIGHTS = [
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Bold (--font-weight-bold)", value: "600" },
] as const;

const TypographyPage = () => (
  <FoundationsPage
    description="The product runs on a deliberately short type scale — four sizes, two families, three weights. Reach for weight and colour before you reach for a bigger size."
    title="Typography"
  >
    <TokenSection title="Type scale">
      <TypeScaleTable />
    </TokenSection>

    <TokenSection title="Families">
      <FamilyTable />
    </TokenSection>

    <TokenSection
      note="600 is the heaviest weight in the system. There is no 700 or 800."
      title="Weights"
    >
      <div className="divide-y rounded-lg border bg-card">
        {WEIGHTS.map(({ label, value }) => (
          <div
            className="flex flex-wrap items-baseline justify-between gap-3 p-4"
            key={value}
          >
            <p className="text-lg" style={{ fontWeight: value }}>
              {SPECIMEN}
            </p>
            <p className="font-mono text-muted-foreground text-xs">
              {label} · {value}
            </p>
          </div>
        ))}
      </div>
    </TokenSection>
  </FoundationsPage>
);

const meta = {
  title: "Foundations/Typography",
  component: TypographyPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof TypographyPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
