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

// `token` rows resolve their value out of globals.css at runtime, exactly like
// every other row on these four pages; `value` rows are the two weights the
// product uses inline with no token behind them. Hardcoding the bold weight
// here let this page keep rendering 600 — and keep asserting there is no 700 —
// after a retune of `--font-weight-bold`, on the one page whose premise is
// that it cannot drift from globals.css.
const WEIGHTS = [
  { label: "Normal", value: "400" },
  { label: "Medium", value: "500" },
  { label: "Bold", token: "font-weight-bold" },
] as const;

const WEIGHT_TOKENS = WEIGHTS.flatMap((weight) =>
  "token" in weight ? [weight.token] : []
);

const WeightTable = () => {
  const values = useResolvedTokens(WEIGHT_TOKENS);

  return (
    <div className="divide-y rounded-lg border bg-card">
      {WEIGHTS.map((weight) => {
        const resolved =
          "token" in weight ? values[weight.token] : weight.value;
        const caption =
          "token" in weight
            ? `${weight.label} (--${weight.token})`
            : weight.label;

        return (
          <div
            className="flex flex-wrap items-baseline justify-between gap-3 p-4"
            key={caption}
          >
            <p
              className="text-lg"
              style={{ fontWeight: resolved || undefined }}
            >
              {SPECIMEN}
            </p>
            <p className="font-mono text-muted-foreground text-xs">
              {caption} · {resolved || "not set"}
            </p>
          </div>
        );
      })}
    </div>
  );
};

const TypographyPage = () => (
  <FoundationsPage
    description="The product runs on a deliberately short type scale for body copy — four tokenized sizes, two families, three weights. Headline and metric components additionally reach for Tailwind's default xl/2xl/3xl utilities outside this scale. Reach for weight and colour before you reach for a bigger size."
    title="Typography"
  >
    <TokenSection title="Type scale">
      <TypeScaleTable />
    </TokenSection>

    <TokenSection title="Families">
      <FamilyTable />
    </TokenSection>

    <TokenSection
      note="Three weights, and the last one is the heaviest the system has — there is nothing above the bold token. Its value is read live from globals.css, like every other number on these pages."
      title="Weights"
    >
      <WeightTable />
    </TokenSection>
  </FoundationsPage>
);

/**
 * The type scale, font families and weights the product uses, so you reach
 * for a size or weight instead of guessing one that breaks the rhythm.
 */
const meta = {
  title: "Foundations v1.0/Typography",
  tags: ["deprecated"],
  component: TypographyPage,
  parameters: {
    controls: { disable: true },
    layout: "fullscreen",
  },
} satisfies Meta<typeof TypographyPage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
