import {
  FilledStatusCircle,
  STATUS_APPEARANCE_NAMES,
  StatusAppearanceIcon,
  StatusDash,
  StatusRing,
} from "@repo/design-system/components/ui/status-icon-primitives";
import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";

/**
 * Generic, domain-agnostic building blocks for status icons. `StatusRing`
 * renders a percentage-complete arc + inner pie; `FilledStatusCircle` renders a
 * solid circle with a centered white glyph; `StatusDash` renders the muted dash
 * for a population with nothing to measure. Domain status-icon components
 * compose these to render their own status vocabularies.
 */
const meta = {
  title: "Composites v1.0/Feedback & Status/Status Icon Primitives",
  component: StatusRing,
  // Every story here is a side-by-side comparison swatch row, not one concept
  // per story — kept out of the AI manifest for that reason.
  tags: ["deprecated", "autodocs", "!manifest"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof StatusRing>;

export default meta;
type Story = StoryObj<typeof meta>;

function Swatch({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
      }}
    >
      {children}
      <span style={{ fontSize: 11 }}>{label}</span>
    </div>
  );
}

/** StatusRing at the standard percentage stops. */
export const Ring: Story = {
  args: { percentage: 50, color: "var(--progress-foreground)", label: "Ring" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="empty">
        <StatusRing
          color="var(--progress-foreground)"
          label="Empty"
          percentage={0}
        />
      </Swatch>
      <Swatch label="dashed">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Dashed"
          percentage={0}
        />
      </Swatch>
      <Swatch label="25%">
        <StatusRing
          color="var(--progress-foreground)"
          label="25%"
          percentage={25}
        />
      </Swatch>
      <Swatch label="50%">
        <StatusRing
          color="var(--progress-foreground)"
          label="50%"
          percentage={48.5}
        />
      </Swatch>
      <Swatch label="75%">
        <StatusRing
          color="var(--progress-foreground)"
          label="75%"
          percentage={73.5}
        />
      </Swatch>
      <Swatch label="100%">
        <StatusRing
          color="var(--progress-foreground)"
          label="100%"
          percentage={100}
        />
      </Swatch>
      <Swatch label="thinking">
        <StatusRing
          color="var(--progress-foreground)"
          label="Thinking"
          percentage={48.5}
          thinking
        />
      </Swatch>
    </div>
  ),
};

/** FilledStatusCircle for each glyph. */
export const Filled: Story = {
  args: {
    percentage: 100,
    color: "var(--progress-foreground)",
    label: "Filled",
  },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="check">
        <FilledStatusCircle fill="var(--success)" glyph="check" label="Check" />
      </Swatch>
      <Swatch label="x">
        <FilledStatusCircle fill="var(--foreground)" glyph="x" label="X" />
      </Swatch>
      <Swatch label="swap">
        <FilledStatusCircle fill="var(--ai)" glyph="swap" label="Swap" />
      </Swatch>
      <Swatch label="exclamation">
        <FilledStatusCircle
          fill="var(--warning)"
          glyph="exclamation"
          label="Exclamation"
        />
      </Swatch>
      <Swatch label="bolt">
        <FilledStatusCircle
          fill="var(--destructive)"
          glyph="bolt"
          label="Bolt"
        />
      </Swatch>
    </div>
  ),
};

/**
 * `StatusDash` - the mark for a population with nothing to measure (a zero
 * denominator), which is not the same as a real zero. It sits in a ring's slot
 * at the same box size, so a row keeps its geometry, and it separates from
 * every ring by silhouette rather than by fill, which is what survives 16px.
 */
export const Dash: Story = {
  args: { percentage: 0, color: "var(--progress-foreground)", label: "Dash" },
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
      <Swatch label="16px">
        <StatusDash label="Nothing to measure" size={16} />
      </Swatch>
      <Swatch label="20px">
        <StatusDash label="Nothing to measure" size={20} />
      </Swatch>
      <Swatch label="vs empty ring">
        <StatusRing
          color="var(--progress-foreground)"
          label="Empty ring"
          percentage={0}
          size={16}
        />
      </Swatch>
      <Swatch label="vs dashed ring">
        <StatusRing
          color="var(--progress-foreground)"
          dashed
          label="Dashed ring"
          percentage={0}
          size={16}
        />
      </Swatch>
    </div>
  ),
};

/**
 * Derived, not hand-listed: a copied array of a union typechecks while one
 * short, and this row is the review surface for whether two names are
 * separable at 16px. A silently incomplete row is a review surface that lies.
 */
const APPEARANCES = STATUS_APPEARANCE_NAMES;

/**
 * The named visual vocabulary every status-icon family resolves through. A
 * domain adapter maps each of its own statuses to one of these names and
 * supplies the label; this registry decides what the mark draws.
 *
 * Mounted as one row on purpose, because whether two of these separate at 16px
 * is only visible side by side. The three terminal glyphs part by shape. The
 * two empty rings do NOT — `blank-ring` and `empty-ring` are the same
 * silhouette about 1.5:1 apart on track tone, which is inherited and recorded
 * in the ledger rather than fixed here. Do not read this row as a guarantee
 * that every pair is separable.
 */
export const Appearances: Story = {
  args: { percentage: 50, color: "var(--progress-foreground)", label: "Ring" },
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {([16, 20] as const).map((size) => (
        <div
          key={size}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            flexWrap: "wrap",
          }}
        >
          {APPEARANCES.map((appearance) => (
            <Swatch key={appearance} label={appearance}>
              <StatusAppearanceIcon
                appearance={appearance}
                label={appearance}
                size={size}
              />
            </Swatch>
          ))}
        </div>
      ))}
    </div>
  ),
};

/** The spinner replaces a ring appearance's arc; a glyph appearance ignores it. */
export const AppearancesThinking: Story = {
  args: { percentage: 50, color: "var(--progress-foreground)", label: "Ring" },
  render: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        flexWrap: "wrap",
      }}
    >
      {APPEARANCES.map((appearance) => (
        <Swatch key={appearance} label={appearance}>
          <StatusAppearanceIcon
            appearance={appearance}
            label={appearance}
            size={20}
            thinking
          />
        </Swatch>
      ))}
    </div>
  ),
};
